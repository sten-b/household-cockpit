const ALPACA_BASE = 'https://paper-api.alpaca.markets';

async function alpacaFetch(endpoint) {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!keyId || !secretKey) throw new Error('Alpaca environment variables not set');

  const res = await fetch(ALPACA_BASE + endpoint, {
    headers: {
      'APCA-API-KEY-ID': keyId,
      'APCA-API-SECRET-KEY': secretKey,
      'Content-Type': 'application/json'
    }
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    if (action === 'portfolio') {
      const [accRes, posRes] = await Promise.all([
        alpacaFetch('/v2/account'),
        alpacaFetch('/v2/positions')
      ]);
      if (!accRes.ok) return res.status(accRes.status).json({ error: accRes.json?.message || 'Account fetch failed' });
      if (!posRes.ok) return res.status(posRes.status).json({ error: posRes.json?.message || 'Positions fetch failed' });
      return res.status(200).json({ account: accRes.json, positions: posRes.json });
    }
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('Alpaca error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
