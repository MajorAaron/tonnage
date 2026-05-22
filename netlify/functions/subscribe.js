// Tonnage — /api/subscribe
// Stores email in Turso subscribers table, tags source as "tonnage".

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  const TURSO_DB_URL = Netlify.env.get('TURSO_DB_URL');
  const TURSO_DB_TOKEN = Netlify.env.get('TURSO_DB_TOKEN');
  if (!TURSO_DB_URL || !TURSO_DB_TOKEN) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  let payload;
  try { payload = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const email = (payload.email || '').toString().trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'Valid email required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const url = `${TURSO_DB_URL.replace('libsql://', 'https://')}/v2/pipeline`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TURSO_DB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            type: 'execute',
            stmt: {
              sql: 'INSERT INTO subscribers (email, source) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET source = excluded.source',
              args: [
                { type: 'text', value: email },
                { type: 'text', value: 'tonnage' }
              ]
            }
          },
          { type: 'close' }
        ]
      })
    });
    if (!r.ok) {
      const txt = await r.text();
      console.error('[subscribe] turso error', r.status, txt);
      return new Response(JSON.stringify({ error: 'Subscribe failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[subscribe] err', e);
    return new Response(JSON.stringify({ error: 'Subscribe failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/subscribe' };
