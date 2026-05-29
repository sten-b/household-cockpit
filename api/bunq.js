import { createSign, generateKeyPairSync } from 'crypto';

const BUNQ_BASE = 'https://api.bunq.com';
const KV_URL    = process.env.KV_REST_API_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN;
const CTX_KEY   = 'bunq_context';
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

async function kvSet(key, value, ttl) {
  await fetch(`${KV_URL}/set/${key}/${encodeURIComponent(JSON.stringify(value))}${ttl ? `/ex/${ttl}` : ''}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
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
  const userObj      = resp.find(r => r.UserPerson || r.UserCompany || r.UserApiKey);
  const user         = userObj?.UserPerson || userObj?.UserCompany || userObj?.UserApiKey;
  const userId       = user?.id;
  if (!sessionToken || !userId) throw new Error('Could not extract session token or user ID');

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
      const { ok, json, status } = await bunqFetch(`/v1/user/${userId}/monetary-account`, 'GET', null, sessionToken, privateKey);
      if (!ok) {
        if (status === 401) await kvDel(CTX_KEY);
        return res.status(status).json({ error: json?.Error?.[0]?.error_description || 'Failed', expired: status === 401 });
      }
      console.log('Bunq full response keys:', JSON.stringify((json.Response || []).map(r => ({ type: Object.keys(r)[0], id: Object.values(r)[0]?.id, desc: Object.values(r)[0]?.description, status: Object.values(r)[0]?.status }))));
      const accounts = (json.Response || [])
        .map(r => r.MonetaryAccountBank || r.MonetaryAccountSavings || r.MonetaryAccountJoint || r.MonetaryAccountLight || r.MonetaryAccountInvestment || r.MonetaryAccountExternalSavings || r.MonetaryAccount || Object.values(r)[0])
        .filter(Boolean)
        // .filter(a => a.status === 'ACTIVE') // temporarily disabled to debug
        .map(a => ({
          id: a.id, description: a.description, balance: a.balance,
          currency: a.currency, status: a.status,
          iban: a.alias?.find(al => al.type === 'IBAN')?.value,
        }));
      return res.status(200).json({ accounts });
    }

    if (action === 'payments') {
      if (!accountId) return res.status(400).json({ error: 'Missing accountId' });
      const { ok, json, status } = await bunqFetch(
        `/v1/user/${userId}/monetary-account/${accountId}/payment?count=50`,
        'GET', null, sessionToken, privateKey
      );
      if (!ok) {
        if (status === 401) await kvDel(CTX_KEY);
        return res.status(status).json({ error: json?.Error?.[0]?.error_description || 'Failed', expired: status === 401 });
      }
      const payments = (json.Response || [])
        .map(r => r.Payment).filter(Boolean)
        .map(p => ({
          id: p.id, created: p.created, amount: p.amount,
          description: p.description, type: p.type, counterparty: p.counterparty_alias,
        }));
      return res.status(200).json({ payments });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Bunq error:', err.message);
    try { await kvDel(CTX_KEY); } catch {}
    return res.status(500).json({ error: err.message });
  }
}
