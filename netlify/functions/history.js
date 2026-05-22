// Tonnage — /api/history
// Returns the most recent N anonymized bids.

export default async (req) => {
  const TURSO_DB_URL = Netlify.env.get('TURSO_DB_URL');
  const TURSO_DB_TOKEN = Netlify.env.get('TURSO_DB_TOKEN');
  if (!TURSO_DB_URL || !TURSO_DB_TOKEN) {
    return new Response(JSON.stringify({ bids: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '10', 10)));

  const dbUrl = `${TURSO_DB_URL.replace('libsql://', 'https://')}/v2/pipeline`;
  try {
    const r = await fetch(dbUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TURSO_DB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            type: 'execute',
            stmt: {
              sql: 'SELECT zip, cubic_yards, load_type, bid_recommended, created_at FROM tonnage_bids ORDER BY created_at DESC LIMIT ?',
              args: [{ type: 'integer', value: String(limit) }]
            }
          },
          { type: 'close' }
        ]
      })
    });
    if (!r.ok) {
      console.error('[history] turso error', r.status);
      return new Response(JSON.stringify({ bids: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const data = await r.json();
    const rows = data?.results?.[0]?.response?.result?.rows || [];
    const bids = rows.map(row => ({
      zip:             row[0]?.value || '',
      cubic_yards:     Number(row[1]?.value || 0),
      load_type:       row[2]?.value || 'mixed',
      bid_recommended: Number(row[3]?.value || 0),
      created_at:      row[4]?.value || ''
    }));
    return new Response(JSON.stringify({ bids }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15' }
    });
  } catch (e) {
    console.error('[history] err', e);
    return new Response(JSON.stringify({ bids: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/history' };
