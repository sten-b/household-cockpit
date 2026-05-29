import { createSign, generateKeyPairSync } from 'crypto';
import { kv } from '@vercel/kv';

const BUNQ_BASE = 'https://api.bunq.com';

function signBody(body, privateKeyPem) {
  const sign = createSign('SHA256');
  sign.update(body || '');
  sign.end();
  return sign.sign(privateKeyPem, 'base64');
}

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
  if (token) headers['X-Bunq-Client-Authentication'] = token;
  if (privateKeyPem && bodyStr) {
    headers['X-Bunq-Client-Signature'] = signBody(bodyStr, privateKeyPem);
  }
  const opts = { method, headers };
  if (bodyStr) opts.body = bodyStr;
  const res = await fetch(BUNQ_BASE + endpoint, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { Error: [{ error_description: text }] }; }
  return { ok: res.ok, status: res.status, json };
}

async function getContext(apiKey) {
  const kvKey = `bunq_context`;

  let ctx = await kv.get(kvKey);
  if (ctx) {
    console.log('Reusing Bunq context from KV');
    return ctx;
  }

  console.log('Running full Bunq installation flow');

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Step 1: Installation
  const installRes = await bunqFetch('/v1/installation', 'POST', { client_public_key: publicKey });
  if (!installRes.ok) {
    throw new Error('Installation failed: ' + (installRes.json?.Error?.[0]?.error_description || installRes.status));
  }
  const installToken = installRes.json.Response?.find(r => r.Token)?.Token?.token;
  if (!installToken) throw new Error('No installation token received');

  // Step 2: Device server
  const deviceRes = await bunqFetch('/v1/device-server', 'POST', {
    description: 'Household Cockpit',
    secret: apiKey,
    permitted_ips: ['*']
  }, installToken, privateKey);
  if (!deviceRes.ok && deviceRes.status !== 409) {
    throw new Error('Device registration failed: ' + (deviceRes.json?.Error?.[0]?.error_description || deviceRes.status));
  }

  // Step 3: Session
  const sessRes = await bunqFetch('/v1/session-server', 'POST', { secret: apiKey }, installToken, privateKey);
  if (!sessRes.ok) {
    throw new Error('Session failed: ' + (sessRes.json?.Error?.[0]?.error_description || sessRes.status));
  }

  const sessResp = sessRes.json.Response || [];
  const sessionToken = sessResp.find(r => r.Token)?.Token?.token;
  const userObj = sessResp.find(r => r.UserPerson || r.UserCompany || r.UserApiKey);
  const user = userObj?.UserPerson || userObj?.UserCompany || userObj?.UserApiKey;
  const userId = user?.id;
  if (!sessionToken || !userId) throw new Error('Could not extract session token or user ID');

  ctx = { privateKey, installToken, sessionToken, userId, createdAt: Date.now() };
  await kv.set(kvKey, ctx, { ex: 60 * 60 * 24 * 6 });
  console.log('Bunq context saved to KV');
  return ctx;
}

async function getValidSession(apiKey) {
  const kvKey = `bunq_context`;
  let ctx = await getContext(apiKey);

  const ageHours = (Date.now() - ctx.createdAt) / 1000 / 60 / 60;
  if (ageHours > 23) {
    console.log('Refreshing Bunq session');
    const sessRes = await bunqFetch('/v1/session-server', 'POST', { secret: apiKey }, ctx.installToken, ctx.privateKey);
    if (sessRes.ok) {
      const sessionToken = sessRes.json.Response?.find(r => r.Token)?.Token?.token;
      if (sessionToken) {
        ctx.sessionToken = sessionToken;
        ctx.createdAt = Date.now();
        await kv.set(kvKey, ctx, { ex: 60 * 60 * 24 * 6 });
      }
    }
  }
  return ctx;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Read API key from environment variable — not from browser
  const apiKey = process.env.BUNQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'BUNQ_API_KEY environment variable not set' });

  const { action, accountId } = req.query;

  try {
    const { sessionToken, userId, privateKey } = await getValidSession(apiKey);

    if (action === 'accounts') {
      const { ok, json, status } = await bunqFetch(
        `/v1/user/${userId}/monetary-account`,
        'GET', null, sessionToken, privateKey
      );
      if (!ok) {
        if (status === 401) await kv.del('bunq_context');
        return res.status(status).json({
          error: json?.Error?.[0]?.error_description || 'Failed to fetch accounts',
          expired: status === 401
        });
      }
      const accounts = (json.Response || [])
        .map(r => r.MonetaryAccountBank || r.MonetaryAccountSavings || r.MonetaryAccount)
        .filter(Boolean)
        .filter(a => a.status === 'ACTIVE')
        .map(a => ({
          id: a.id,
          description: a.description,
          balance: a.balance,
          currency: a.currency,
          status: a.status,
          iban: a.alias?.find(al => al.type === 'IBAN')?.value
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
        if (status === 401) await kv.del('bunq_context');
        return res.status(status).json({
          error: json?.Error?.[0]?.error_description || 'Failed to fetch payments',
          expired: status === 401
        });
      }
      const payments = (json.Response || [])
        .map(r => r.Payment)
        .filter(Boolean)
        .map(p => ({
          id: p.id,
          created: p.created,
          amount: p.amount,
          description: p.description,
          type: p.type,
          counterparty: p.counterparty_alias
        }));
      return res.status(200).json({ payments });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('Bunq error:', err.message);
    try { await kv.del('bunq_context'); } catch {}
    return res.status(500).json({ error: err.message });
  }
}
