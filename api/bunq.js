import { createSign, generateKeyPairSync } from 'crypto';

const BUNQ_BASE = 'https://api.bunq.com';
const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const CTX_KEY   = 'bunq_context_v7'; // bump version to invalidate old cached context
const CTX_TTL   = 60 * 60 * 24 * 6; // 6 days in seconds

// ── Upstash REST helpers ──────────────────────────────────────────────────────
async function kvGet(key) {
  const res  = await fetch(`${KV_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const json = await res.json();
  if (!json.result) return null;
  return JSON.parse(json.result);
}

async function kvSet(key, value, ttl = null) {
  // Upstash REST pipeline — handles large payloads reliably
  const serialised = JSON.stringify(value);
  const commands = ttl
    ? [['SET', key, serialised, 'EX', ttl]]
    : [['SET', key, serialised]];
  await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
}

async function kvDel(key) {
  await fetch(`${KV_URL}/del/${key}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
}

// ── RSA signing ───────────────────────────────────────────────────────────────
function signBody(body, privateKeyPem) {
  const sign = createSign('SHA256');
  sign.update(body || '');
  sign.end();
  return sign.sign(privateKeyPem, 'base64');
}

// ── Raw Bunq HTTP ─────────────────────────────────────────────────────────────
async function bunqFetch(endpoint, method = 'GET', body = null, token = null, privateKeyPem = null) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'User-Agent': 'HouseholdCockpit/1.0',
    'X-Bunq-Language': 'en_US',
    'X-Bunq-Region': 'en_US',
    'X-Bunq-Geolocation': '0 0 0 0 NL',
    'X-Bunq-Client-Request-Id': crypto.randomUUID(),
  };
  if (token)         headers['X-Bunq-Client-Authentication'] = token;
  if (privateKeyPem && bodyStr) headers['X-Bunq-Client-Signature'] = signBody(bodyStr, privateKeyPem);

  const res  = await fetch(BUNQ_BASE + endpoint, { method, headers, ...(bodyStr ? { body: bodyStr } : {}) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { Error: [{ error_description: text }] }; }
  return { ok: res.ok, status: res.status, json };
}

// ── Build or reuse Bunq context ───────────────────────────────────────────────
async function getContext(apiKey) {
  // Try cache first
  const cached = await kvGet(CTX_KEY);
  if (cached) {
    console.log('Reusing Bunq context from Upstash');
    return cached;
  }

  console.log('Running Bunq installation flow');

  // Generate RSA key pair
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // 1. Installation
  const instRes = await bunqFetch('/v1/installation', 'POST', { client_public_key: publicKey });
  if (!instRes.ok) throw new Error('Installation failed: ' + (instRes.json?.Error?.[0]?.error_description || instRes.status));
  const installToken = instRes.json.Response?.find(r => r.Token)?.Token?.token;
  if (!installToken) throw new Error('No installation token received');

  // 2. Device server
  const devRes = await bunqFetch('/v1/device-server', 'POST',
    { description: 'Household Cockpit', secret: apiKey, permitted_ips: ['*'] },
    installToken, privateKey
  );
  if (!devRes.ok && devRes.status !== 409) throw new Error('Device registration failed: ' + (devRes.json?.Error?.[0]?.error_description || devRes.status));

  // 3. Session
  const sessRes = await bunqFetch('/v1/session-server', 'POST', { secret: apiKey }, installToken, privateKey);
  if (!sessRes.ok) throw new Error('Session failed: ' + (sessRes.json?.Error?.[0]?.error_description || sessRes.status));

  const resp         = sessRes.json.Response || [];
  const sessionToken = resp.find(r => r.Token)?.Token?.token;

  // Bunq returns UserApiKey which contains a reference to the real user.
  // The real user ID is what we need for monetary-account calls.
  const userApiKey   = resp.find(r => r.UserApiKey)?.UserApiKey;
  const userPerson   = resp.find(r => r.UserPerson)?.UserPerson;
  const userCompany  = resp.find(r => r.UserCompany)?.UserCompany;

  // UserApiKey has a granted_by_user object with the real user ID
  const realUserId   = userPerson?.id
    || userCompany?.id
    || userApiKey?.granted_by_user?.id
    || userApiKey?.id;

  const userId = realUserId;
  if (!sessionToken || !userId) throw new Error('Could not extract session token or user ID');

  // Note: privateKey stored in Upstash — acceptable for a personal single-user app.
  const ctx = { privateKey, installToken, sessionToken, userId, createdAt: Date.now() };
  await kvSet(CTX_KEY, ctx, CTX_TTL);
  console.log('Bunq context saved to Upstash');
  return ctx;
}

async function getValidSession(apiKey) {
  let ctx = await getContext(apiKey);

  // Refresh session if older than 23 hours
  const ageHours = (Date.now() - ctx.createdAt) / 3600000;
  if (ageHours > 23) {
    console.log('Refreshing Bunq session token');
    const sessRes = await bunqFetch('/v1/session-server', 'POST', { secret: apiKey }, ctx.installToken, ctx.privateKey);
    if (sessRes.ok) {
      const sessionToken = sessRes.json.Response?.find(r => r.Token)?.Token?.token;
      if (sessionToken) {
        ctx = { ...ctx, sessionToken, createdAt: Date.now() };
        await kvSet(CTX_KEY, ctx, CTX_TTL);
      }
    }
  }
  return ctx;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'KV_REST_API_URL or KV_REST_API_TOKEN not set' });

  const apiKey = process.env.BUNQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'BUNQ_API_KEY environment variable not set' });

  const { action, accountId } = req.query;

  try {
    const { sessionToken, userId, privateKey } = await getValidSession(apiKey);

    if (action === 'accounts') {
      // First get all users associated with this API key
      const usersRes = await bunqFetch('/v1/user', 'GET', null, sessionToken, privateKey);
      if (!usersRes.ok) {
        if (usersRes.status === 401) await kvDel(CTX_KEY);
        return res.status(usersRes.status).json({ error: usersRes.json?.Error?.[0]?.error_description || 'Failed to fetch users', expired: usersRes.status === 401 });
      }

      // Extract all user IDs (personal + business)
      const users = (usersRes.json.Response || [])
        .map(r => r.UserPerson || r.UserCompany || r.UserLight || r.UserApiKey)
        .filter(Boolean)
        .map(u => ({ id: u.id, type: u.display_name || u.legal_name || 'User' }));


      // Fetch accounts from ALL users
      const allAccounts = [];
      for (const user of users) {
        const { ok, json } = await bunqFetch(`/v1/user/${user.id}/monetary-account?count=50`, 'GET', null, sessionToken, privateKey);
        if (!ok) continue;
        const accounts = (json.Response || [])
          .map(r => r.MonetaryAccountBank || r.MonetaryAccountSavings || r.MonetaryAccountJoint || r.MonetaryAccountLight || r.MonetaryAccountInvestment || r.MonetaryAccountExternalSavings || r.MonetaryAccount || Object.values(r)[0])
          .filter(Boolean)
          .filter(a => a.status === 'ACTIVE')
          .map(a => ({
            id: a.id,
            userId: user.id,
            description: a.description,
            balance: a.balance,
            currency: a.currency,
            status: a.status,
            iban: a.alias?.find(al => al.type === 'IBAN')?.value,
          }));
        allAccounts.push(...accounts);
      }

      return res.status(200).json({ accounts: allAccounts });
    }

    if (action === 'payments') {
      if (!accountId) return res.status(400).json({ error: 'Missing accountId' });
      const paymentUserId = req.query.userId || userId;
      const cacheKey = `payments_${accountId}`;

      // ── Step 1: Load existing cache from Redis ──
      let cached = [];
      try {
        const hit = await kvGet(cacheKey);
        if (hit) cached = hit;
      } catch {}
      const cachedIds = new Set(cached.map(p => p.id));

      // ── Step 2: Fetch fresh payments from Bunq (up to 12 months) ──
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 12);
      const fresh = [];
      let endpoint = `/v1/user/${paymentUserId}/monetary-account/${accountId}/payment?count=200`;
      let pages = 0;
      const MAX_PAGES = 10;

      while (endpoint && pages < MAX_PAGES) {
        const { ok, json, status } = await bunqFetch(endpoint, 'GET', null, sessionToken, privateKey);
        if (!ok) {
          if (status === 401) await kvDel(CTX_KEY);
          return res.status(status).json({ error: json?.Error?.[0]?.error_description || 'Failed', expired: status === 401 });
        }
        const page = (json.Response || []).map(r => r.Payment).filter(Boolean);
        if (!page.length) break;
        for (const p of page) {
          fresh.push({ id: p.id, created: p.created, amount: p.amount, description: p.description, type: p.type, counterparty: p.counterparty_alias });
        }
        const oldest = new Date(page[page.length - 1].created);
        if (oldest < cutoff) break;
        const pagination = json.Pagination;
        endpoint = pagination?.older_url ? pagination.older_url.replace('https://api.bunq.com', '') : null;
        pages++;
      }

      // ── Step 3: Merge — add any fresh payments not already in cache ──
      const newPayments = fresh.filter(p => !cachedIds.has(p.id));
      const merged = [...newPayments, ...cached]
        .sort((a, b) => new Date(b.created) - new Date(a.created));

      // ── Step 4: Persist merged result to Redis (no expiry — keep forever) ──
      if (newPayments.length > 0) {
        try {
          // Store in chunks of 500 if large, Upstash has 5MB per key limit
          const MAX_PER_KEY = 2000;
          await kvSet(cacheKey, merged.slice(0, MAX_PER_KEY));
          console.log(`Stored ${merged.length} payments for account ${accountId} (${newPayments.length} new)`);
        } catch (e) {
          console.warn('Failed to cache payments:', e.message);
        }
      }

      return res.status(200).json({ payments: merged, cached: cached.length, fresh: fresh.length, new: newPayments.length });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Bunq error:', err.message);
    try { await kvDel(CTX_KEY); } catch {}
    return res.status(500).json({ error: err.message });
  }
}
