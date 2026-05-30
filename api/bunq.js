import { createSign, generateKeyPairSync } from 'crypto';

const BUNQ_BASE = 'https://api.bunq.com';
const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const CTX_KEY   = 'bunq_ctx_v8';
const CTX_TTL   = 60 * 60 * 24 * 6; // 6 days

// ── Upstash helpers ───────────────────────────────────────────────────────────
async function kvGet(key) {
  try {
    const res  = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    const data = await res.json();
    if (!data.result) return null;
    // Upstash returns the raw stored string — parse it once
    return typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
  } catch (e) {
    console.warn('kvGet failed:', e.message);
    return null;
  }
}

async function kvSet(key, value, ttl = null) {
  try {
    // Use pipeline endpoint — handles any payload size
    const cmd = ttl
      ? ['SETEX', key, String(ttl), JSON.stringify(value)]
      : ['SET',   key, JSON.stringify(value)];
    const res = await fetch(`${KV_URL}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([cmd]),
    });
    const data = await res.json();
    if (!res.ok) console.warn('kvSet response:', JSON.stringify(data));
  } catch (e) {
    console.warn('kvSet failed:', e.message);
  }
}

async function kvDel(key) {
  try {
    await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
  } catch (e) {
    console.warn('kvDel failed:', e.message);
  }
}

// ── RSA ───────────────────────────────────────────────────────────────────────
function signBody(body, privateKeyPem) {
  const sign = createSign('SHA256');
  sign.update(body || '');
  sign.end();
  return sign.sign(privateKeyPem, 'base64');
}

// ── Bunq HTTP ─────────────────────────────────────────────────────────────────
async function bunqFetch(endpoint, method = 'GET', body = null, token = null, privateKey = null) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = {
    'Content-Type':          'application/json',
    'Cache-Control':         'no-cache',
    'User-Agent':            'HouseholdCockpit/1.0',
    'X-Bunq-Language':       'en_US',
    'X-Bunq-Region':         'en_US',
    'X-Bunq-Geolocation':   '0 0 0 0 NL',
    'X-Bunq-Client-Request-Id': crypto.randomUUID(),
  };
  if (token)               headers['X-Bunq-Client-Authentication'] = token;
  if (privateKey && bodyStr) headers['X-Bunq-Client-Signature']   = signBody(bodyStr, privateKey);

  const res  = await fetch(BUNQ_BASE + endpoint, {
    method, headers, ...(bodyStr ? { body: bodyStr } : {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { Error: [{ error_description: text }] }; }
  return { ok: res.ok, status: res.status, json };
}

// ── Session management ────────────────────────────────────────────────────────
async function buildSession(apiKey) {
  console.log('Building new Bunq session');

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength:      2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // 1. Installation
  const instRes = await bunqFetch('/v1/installation', 'POST', { client_public_key: publicKey });
  if (!instRes.ok) throw new Error('Installation failed: ' + (instRes.json?.Error?.[0]?.error_description || instRes.status));
  const installToken = instRes.json.Response?.find(r => r.Token)?.Token?.token;
  if (!installToken) throw new Error('No installation token');

  // 2. Device server
  const devRes = await bunqFetch('/v1/device-server', 'POST',
    { description: 'Household Cockpit', secret: apiKey, permitted_ips: ['*'] },
    installToken, privateKey
  );
  if (!devRes.ok && devRes.status !== 409)
    throw new Error('Device registration failed: ' + (devRes.json?.Error?.[0]?.error_description || devRes.status));

  // 3. Session
  const sessRes = await bunqFetch('/v1/session-server', 'POST', { secret: apiKey }, installToken, privateKey);
  if (!sessRes.ok) throw new Error('Session failed: ' + (sessRes.json?.Error?.[0]?.error_description || sessRes.status));

  const resp         = sessRes.json.Response || [];
  const sessionToken = resp.find(r => r.Token)?.Token?.token;
  const userApiKey   = resp.find(r => r.UserApiKey)?.UserApiKey;
  const userPerson   = resp.find(r => r.UserPerson)?.UserPerson;
  const userCompany  = resp.find(r => r.UserCompany)?.UserCompany;
  const userId       = userPerson?.id || userCompany?.id
    || userApiKey?.granted_by_user?.id || userApiKey?.id;

  if (!sessionToken || !userId) throw new Error('Could not extract session token or user ID');

  const ctx = { privateKey, installToken, sessionToken, userId, createdAt: Date.now() };
  await kvSet(CTX_KEY, ctx, CTX_TTL);
  console.log('Session saved — userId:', userId);
  return ctx;
}

async function getSession(apiKey) {
  // Try cached context
  const ctx = await kvGet(CTX_KEY);

  if (ctx && ctx.sessionToken && ctx.privateKey) {
    const ageHours = (Date.now() - (ctx.createdAt || 0)) / 3_600_000;
    if (ageHours < 23) {
      console.log('Reusing cached session');
      return ctx;
    }
    // Refresh session token only
    console.log('Refreshing session token');
    const sessRes = await bunqFetch('/v1/session-server', 'POST', { secret: apiKey }, ctx.installToken, ctx.privateKey);
    if (sessRes.ok) {
      const sessionToken = sessRes.json.Response?.find(r => r.Token)?.Token?.token;
      if (sessionToken) {
        const refreshed = { ...ctx, sessionToken, createdAt: Date.now() };
        await kvSet(CTX_KEY, refreshed, CTX_TTL);
        return refreshed;
      }
    }
    // Refresh failed — fall through to full rebuild
    console.log('Session refresh failed — rebuilding');
  }

  return buildSession(apiKey);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!KV_URL || !KV_TOKEN)
    return res.status(500).json({ error: 'KV_REST_API_URL or KV_REST_API_TOKEN not configured' });

  const apiKey = process.env.BUNQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'BUNQ_API_KEY not configured' });

  const { action, accountId } = req.query;

  try {
    const { sessionToken, userId, privateKey } = await getSession(apiKey);

    // ── Accounts ──────────────────────────────────────────────────────────────
    if (action === 'accounts') {
      const usersRes = await bunqFetch('/v1/user', 'GET', null, sessionToken, privateKey);
      if (!usersRes.ok) {
        if (usersRes.status === 401) await kvDel(CTX_KEY);
        return res.status(usersRes.status).json({
          error: usersRes.json?.Error?.[0]?.error_description || 'Failed to fetch users',
          expired: usersRes.status === 401,
        });
      }

      const users = (usersRes.json.Response || [])
        .map(r => r.UserPerson || r.UserCompany || r.UserLight || r.UserApiKey)
        .filter(Boolean)
        .map(u => ({ id: u.id, name: u.display_name || u.legal_name || 'User' }));

      const allAccounts = [];
      for (const user of users) {
        const { ok, json } = await bunqFetch(
          `/v1/user/${user.id}/monetary-account?count=50`,
          'GET', null, sessionToken, privateKey
        );
        if (!ok) continue;
        (json.Response || [])
          .map(r => r.MonetaryAccountBank || r.MonetaryAccountSavings || r.MonetaryAccountJoint
                 || r.MonetaryAccountLight || r.MonetaryAccountInvestment
                 || r.MonetaryAccountExternalSavings || r.MonetaryAccount || Object.values(r)[0])
          .filter(a => a?.status === 'ACTIVE')
          .forEach(a => allAccounts.push({
            id: a.id, userId: user.id, description: a.description,
            balance: a.balance, currency: a.currency, status: a.status,
            iban: a.alias?.find(al => al.type === 'IBAN')?.value,
          }));
      }

      return res.status(200).json({ accounts: allAccounts });
    }

    // ── Payments ──────────────────────────────────────────────────────────────
    if (action === 'payments') {
      if (!accountId) return res.status(400).json({ error: 'Missing accountId' });
      const paymentUserId = req.query.userId || userId;
      const cacheKey      = `payments_${accountId}`;

      // Load cache — guard against corrupted/non-array data
      const raw       = await kvGet(cacheKey);
      const cached    = Array.isArray(raw) ? raw : [];
      const cachedIds = new Set(cached.map(p => p.id));

      // Fetch fresh from Bunq (up to 12 months, 10 pages of 200)
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 12);
      const fresh = [];
      let endpoint = `/v1/user/${paymentUserId}/monetary-account/${accountId}/payment?count=200`;
      let pages    = 0;

      while (endpoint && pages < 10) {
        const { ok, json, status } = await bunqFetch(endpoint, 'GET', null, sessionToken, privateKey);
        if (!ok) {
          if (status === 401) await kvDel(CTX_KEY);
          return res.status(status).json({
            error: json?.Error?.[0]?.error_description || 'Failed',
            expired: status === 401,
          });
        }
        const page = (json.Response || []).map(r => r.Payment).filter(Boolean);
        if (!page.length) break;

        for (const p of page) {
          fresh.push({
            id: p.id, created: p.created, amount: p.amount,
            description: p.description, type: p.type,
            counterparty: p.counterparty_alias,
          });
        }

        if (new Date(page[page.length - 1].created) < cutoff) break;
        const older = json.Pagination?.older_url;
        endpoint = older ? older.replace('https://api.bunq.com', '') : null;
        pages++;
      }

      // Merge new into cache
      const newPayments = fresh.filter(p => !cachedIds.has(p.id));
      const merged      = [...newPayments, ...cached]
        .sort((a, b) => new Date(b.created) - new Date(a.created))
        .slice(0, 2000);

      if (newPayments.length > 0) {
        await kvSet(cacheKey, merged); // no TTL — permanent history
        console.log(`Account ${accountId}: ${merged.length} total (${newPayments.length} new)`);
      }

      return res.status(200).json({ payments: merged });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Bunq handler error:', err.message);
    await kvDel(CTX_KEY); // clear potentially corrupt context
    return res.status(500).json({ error: err.message });
  }
}
