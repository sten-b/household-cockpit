/**
 * Vercel serverless function — Bunq API proxy
 * Forwards requests to api.bunq.com, adding the API key server-side.
 * Handles the full Bunq auth flow: installation → device-server → session → data
 */

const BUNQ_BASE = 'https://api.bunq.com';

async function bunqFetch(endpoint, method = 'GET', body = null, token = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'User-Agent': 'HouseholdCockpit/1.0',
    'X-Bunq-Language': 'en_US',
    'X-Bunq-Region': 'en_US',
    'X-Bunq-Geolocation': '0 0 0 0 NL',
  };
  if (token) headers['X-Bunq-Client-Authentication'] = token;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(BUNQ_BASE + endpoint, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function getBunqSession(apiKey) {
  // Step 1: Installation (always try, ignore if exists)
  await bunqFetch('/v1/installation', 'POST', {
    client_public_key: generateFakePublicKey()
  }).catch(() => {});

  // Step 2: Register device
  await bunqFetch('/v1/device-server', 'POST', {
    description: 'Household Cockpit',
    secret: apiKey,
    permitted_ips: ['*']
  }, apiKey).catch(() => {});

  // Step 3: Create session
  const sess = await bunqFetch('/v1/session-server', 'POST', {
    secret: apiKey
  }, apiKey);

  if (!sess.ok) {
    throw new Error(sess.json?.Error?.[0]?.error_description || `Session failed: ${sess.status}`);
  }

  const resp = sess.json.Response || [];
  const token = resp.find(r => r.Token)?.Token?.token;
  const userObj = resp.find(r => r.UserPerson || r.UserCompany || r.UserApiKey);
  const user = userObj?.UserPerson || userObj?.UserCompany || userObj?.UserApiKey;
  const userId = user?.id;

  if (!token || !userId) throw new Error('Could not extract session token or user ID');
  return { token, userId };
}

// Bunq requires an RSA public key for installation.
// For a read-only cockpit we use a minimal valid key placeholder.
function generateFakePublicKey() {
  return [
    '-----BEGIN PUBLIC KEY-----',
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2a2rwplBQLF29amygykE',
    'MmYz0+Kcj3bKBp29hNnz1EMFBHlRmSBhFZeKGzAqBYMoGkWxBhOEGljBXQxQH7N',
    'KCNGMszGjGFMZ4Jig/Sq1sMBqXTNbGOGlnGEJFqN7f4m5FvdYYHMaJHGqP7QiYv',
    'E7nDkKuGmPNTOubHpL5KqYVF1g8HCjnQi+0MZx5T+iBfwXQhp+IQBJ1Q1XZHMA',
    'j+Z7WGQK9c0L6f3Fx7R5sS8XsPWz9DQkOi+lJVEzHX3m5fR4KDpFf4NUVHK/+4',
    'dP6TJ/jMIwBHMD8FDKPo4JQZQZ8lYbMRqM5eFQK5Q0FQIIB/tjQAjCEGBwIDAQAB',
    '-----END PUBLIC KEY-----'
  ].join('\n');
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bunq-Api-Key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = req.headers['x-bunq-api-key'];
  if (!apiKey) return res.status(400).json({ error: 'Missing X-Bunq-Api-Key header' });

  const { action } = req.query;

  try {
    const { token, userId } = await getBunqSession(apiKey);

    if (action === 'accounts') {
      const { ok, json, status } = await bunqFetch(`/v1/user/${userId}/monetary-account`, 'GET', null, token);
      if (!ok) return res.status(status).json({ error: json?.Error?.[0]?.error_description || 'Failed to fetch accounts' });

      const accounts = (json.Response || [])
        .map(r => r.MonetaryAccountBank || r.MonetaryAccountSavings || r.MonetaryAccount)
        .filter(Boolean)
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
      const accountId = req.query.accountId;
      if (!accountId) return res.status(400).json({ error: 'Missing accountId' });

      const { ok, json, status } = await bunqFetch(
        `/v1/user/${userId}/monetary-account/${accountId}/payment?count=50`,
        'GET', null, token
      );
      if (!ok) return res.status(status).json({ error: json?.Error?.[0]?.error_description || 'Failed to fetch payments' });

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

    return res.status(400).json({ error: `Unknown action: ${action}. Use 'accounts' or 'payments'` });

  } catch (err) {
    console.error('Bunq proxy error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
