// Tonnage — /api/analyze
// Inputs: { zip, access, crew, hazmat, appliances, electronics, tires, photo_base64, photo_mime }
// Output: { cubic_yards, labor_hours, dump_fee_low, dump_fee_high, bid_low, bid_high, bid_recommended, load_type, surcharges[], rationale }

// No npm deps — uses native fetch + Turso HTTP API.

const SYSTEM_PROMPT = `You are a calibrated junk-removal bid estimator. Given a single photo of a load and basic context, estimate volume and load characteristics.

Output STRICT JSON only. No prose. No markdown. No code fences.

Schema:
{
  "cubic_yards": number,            // estimated load volume (1.0 - 30.0 typical)
  "cubic_yards_low": number,        // lower bound of plausible range
  "cubic_yards_high": number,       // upper bound of plausible range
  "load_type": string,              // one of: "household mixed", "construction debris", "yard waste", "appliances", "furniture", "office cleanout", "garage cleanout", "estate cleanout", "hoarder cleanout", "mostly empty", "other"
  "detected_surcharges": [string],  // ZERO OR MORE OF: "mattress", "appliance (freon)", "electronics/e-waste", "tires", "hazmat/paint", "construction debris (extra fee)"
  "load_confidence": "high"|"medium"|"low",
  "notes": string                   // 1-2 sentences explaining how you sized it (reference visual cues)
}

Calibration anchors:
- A standard pickup-truck bed full ≈ 2.5 cubic yards
- A full single-car garage ≈ 8-12 cubic yards
- A small couch + loveseat + 5 boxes ≈ 3 cubic yards
- A 10 cu-yd dumpster full ≈ 10 cubic yards (the visual baseline)

Rules:
- Be conservative on volume if the photo is partial or angled.
- If you cannot see the pile clearly, set load_confidence = "low" and widen the range.
- Always detect mattresses, appliances (anything with a compressor: fridge, freezer, AC), electronics (CRTs, TVs, computers, monitors), tires, and visible hazmat/paint.`;

// Curated dump fee book (per cubic yard) — top US metros approximated.
const ZIP_DUMP_FEES = {
  // Denver / Front Range
  '80': { city: 'Denver Metro, CO', perYard: 22, mattressFee: 35, applianceFee: 45 },
  // LA / SoCal
  '90': { city: 'Los Angeles, CA',   perYard: 32, mattressFee: 50, applianceFee: 60 },
  '91': { city: 'Los Angeles, CA',   perYard: 32, mattressFee: 50, applianceFee: 60 },
  '92': { city: 'San Diego, CA',     perYard: 30, mattressFee: 45, applianceFee: 55 },
  '93': { city: 'Central Coast, CA', perYard: 28, mattressFee: 40, applianceFee: 50 },
  '94': { city: 'Bay Area, CA',      perYard: 38, mattressFee: 55, applianceFee: 65 },
  '95': { city: 'Bay Area, CA',      perYard: 36, mattressFee: 50, applianceFee: 60 },
  // NYC / NJ
  '10': { city: 'NYC, NY',           perYard: 40, mattressFee: 60, applianceFee: 70 },
  '11': { city: 'NYC Outer, NY',     perYard: 38, mattressFee: 55, applianceFee: 65 },
  '07': { city: 'NJ Metro, NJ',      perYard: 35, mattressFee: 50, applianceFee: 60 },
  // Boston
  '02': { city: 'Boston, MA',        perYard: 34, mattressFee: 50, applianceFee: 60 },
  // Chicago
  '60': { city: 'Chicago, IL',       perYard: 26, mattressFee: 40, applianceFee: 50 },
  // Texas
  '75': { city: 'Dallas-Fort Worth, TX', perYard: 22, mattressFee: 35, applianceFee: 45 },
  '77': { city: 'Houston, TX',       perYard: 22, mattressFee: 35, applianceFee: 45 },
  '78': { city: 'Austin/San Antonio, TX', perYard: 24, mattressFee: 35, applianceFee: 45 },
  // Atlanta
  '30': { city: 'Atlanta, GA',       perYard: 22, mattressFee: 35, applianceFee: 45 },
  // Seattle
  '98': { city: 'Seattle, WA',       perYard: 30, mattressFee: 45, applianceFee: 55 },
  // Portland
  '97': { city: 'Portland, OR',      perYard: 28, mattressFee: 40, applianceFee: 50 },
  // Florida
  '33': { city: 'Miami/SE FL',       perYard: 26, mattressFee: 40, applianceFee: 50 },
  '32': { city: 'North/Central FL',  perYard: 22, mattressFee: 35, applianceFee: 45 },
  // Arizona
  '85': { city: 'Phoenix, AZ',       perYard: 22, mattressFee: 35, applianceFee: 45 },
  // Nevada
  '89': { city: 'Las Vegas, NV',     perYard: 24, mattressFee: 35, applianceFee: 45 },
  // DC / VA
  '20': { city: 'DC/Northern VA',    perYard: 32, mattressFee: 45, applianceFee: 55 },
  '22': { city: 'Northern VA',       perYard: 30, mattressFee: 45, applianceFee: 55 },
  // National default
  '__default': { city: 'US National Avg', perYard: 25, mattressFee: 40, applianceFee: 50 }
};

function lookupZip(zip) {
  if (!zip || zip.length < 2) return ZIP_DUMP_FEES.__default;
  const prefix2 = zip.substring(0, 2);
  return ZIP_DUMP_FEES[prefix2] || ZIP_DUMP_FEES.__default;
}

const LABOR_RATE_PER_HOUR_PER_PERSON = 85; // blended cost+margin
const ACCESS_LABOR_MULT = { easy: 1.0, walk: 1.25, hard: 1.6 };
const MARGIN_FLOOR = 0.30; // 30% min margin
const MARGIN_TARGET = 0.45; // 45% target margin on recommended

function calibrateLaborHours(cubicYards, crew, access) {
  // Empirical: 1 yard = ~12 minutes for 2-person crew on easy access
  const baseMinutesPerYardPerPerson = 6; // 2-person crew = 12 mins/yard
  const total = cubicYards * baseMinutesPerYardPerPerson * 2; // total person-minutes
  const accessMult = ACCESS_LABOR_MULT[access] || 1.0;
  const adjustedMinutes = total * accessMult;
  // hours for the calendar duration (one crew working in parallel)
  const wallHours = (adjustedMinutes / 60) / Math.max(crew, 1);
  return Math.max(0.5, wallHours);
}

function computeDumpFee(cubicYards, dumpData, surcharges) {
  const surcharge_set = new Set(surcharges || []);
  let mattressCount = 0, applianceCount = 0;
  if (surcharge_set.has('mattress')) mattressCount = 1;
  if (surcharge_set.has('appliance (freon)')) applianceCount = 1;

  const base = cubicYards * dumpData.perYard;
  const mattress = mattressCount * dumpData.mattressFee;
  const appliance = applianceCount * dumpData.applianceFee;
  const constructionPremium = surcharge_set.has('construction debris (extra fee)') ? cubicYards * 8 : 0;
  const hazmatPremium = surcharge_set.has('hazmat/paint') ? 75 : 0;
  const total = base + mattress + appliance + constructionPremium + hazmatPremium;
  // Range = ±15% to account for facility variation
  return { low: Math.round(total * 0.85), high: Math.round(total * 1.15) };
}

async function callGemini(photoB64, mime, apiKey, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: SYSTEM_PROMPT },
        { inline_data: { mime_type: mime || 'image/jpeg', data: photoB64 } },
        { text: 'Analyze this photo. Return JSON only.' }
      ]
    }],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.3
    }
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${txt.slice(0, 240)}`);
  }
  const data = await resp.json();
  const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!txt) throw new Error('Empty Gemini response');
  // Strip code fences if model returned any
  const cleaned = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return JSON.parse(cleaned);
}

async function logBid(env, record) {
  if (!env.TURSO_DB_URL || !env.TURSO_DB_TOKEN) return;
  try {
    await fetch(`${env.TURSO_DB_URL.replace('libsql://', 'https://')}/v2/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.TURSO_DB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            type: 'execute',
            stmt: {
              sql: 'INSERT INTO tonnage_bids (zip, cubic_yards, labor_hours, dump_fee_low, dump_fee_high, bid_low, bid_high, bid_recommended, load_type, surcharges, rationale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              args: [
                { type: 'text',    value: String(record.zip || '') },
                { type: 'float',   value: Number(record.cubic_yards || 0) },
                { type: 'float',   value: Number(record.labor_hours || 0) },
                { type: 'float',   value: Number(record.dump_fee_low || 0) },
                { type: 'float',   value: Number(record.dump_fee_high || 0) },
                { type: 'float',   value: Number(record.bid_low || 0) },
                { type: 'float',   value: Number(record.bid_high || 0) },
                { type: 'float',   value: Number(record.bid_recommended || 0) },
                { type: 'text',    value: String(record.load_type || '') },
                { type: 'text',    value: JSON.stringify(record.surcharges || []) },
                { type: 'text',    value: String(record.rationale || '') }
              ]
            }
          },
          { type: 'close' }
        ]
      })
    });
  } catch (e) {
    console.error('[tonnage] log failed', e);
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  const env = {
    GEMINI_API_KEY: Netlify.env.get('GEMINI_API_KEY'),
    TURSO_DB_URL:   Netlify.env.get('TURSO_DB_URL'),
    TURSO_DB_TOKEN: Netlify.env.get('TURSO_DB_TOKEN')
  };

  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'Server not configured (GEMINI_API_KEY missing).' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }

  const { zip, access = 'easy', crew = 2,
          hazmat = false, appliances = false, electronics = false, tires = false,
          photo_base64, photo_mime } = body;

  if (!photo_base64) return new Response(JSON.stringify({ error: 'photo_base64 required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  if (!zip || !/^\d{5}$/.test(zip)) return new Response(JSON.stringify({ error: 'Valid 5-digit ZIP required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  // Vision call with timeout
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 22000);

  let vision;
  try {
    vision = await callGemini(photo_base64, photo_mime, env.GEMINI_API_KEY, ctrl.signal);
  } catch (e) {
    clearTimeout(timer);
    console.error('[tonnage] vision error', e);
    return new Response(JSON.stringify({ error: 'Vision sizing failed. Try a clearer whole-pile photo.' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  } finally {
    clearTimeout(timer);
  }

  // Combine model-detected surcharges with user-checked ones
  const surcharges = new Set(Array.isArray(vision.detected_surcharges) ? vision.detected_surcharges : []);
  if (hazmat)      surcharges.add('hazmat/paint');
  if (appliances)  surcharges.add('appliance (freon)');
  if (electronics) surcharges.add('electronics/e-waste');
  if (tires)       surcharges.add('tires');

  const cubicYards = Math.max(0.5, Number(vision.cubic_yards) || 1);
  const dumpData = lookupZip(zip);
  const dump = computeDumpFee(cubicYards, dumpData, [...surcharges]);
  const laborHours = calibrateLaborHours(cubicYards, crew, access);
  const laborCost = laborHours * crew * LABOR_RATE_PER_HOUR_PER_PERSON;

  // Cost basis = dump + labor. Add ~10% misc (gas, tarps, dump-station tipping)
  const costLow  = dump.low  + laborCost * 0.85 + 25;
  const costHigh = dump.high + laborCost * 1.15 + 50;

  // Bid range applies the margin floor → bid_low covers cost+floor; bid_high covers cost+target+overhead
  const bidLow  = Math.round(costLow  / (1 - MARGIN_FLOOR));
  const bidHigh = Math.round(costHigh / (1 - MARGIN_TARGET));
  const bidRec  = Math.round((bidLow + bidHigh) / 2);

  // Round nicely (nearest $5 for low, nearest $25 for high & recommended)
  const round5  = (n) => Math.round(n / 5) * 5;
  const round25 = (n) => Math.round(n / 25) * 25;

  const rationale = buildRationale({
    yards: cubicYards, ydLow: vision.cubic_yards_low, ydHigh: vision.cubic_yards_high,
    loadType: vision.load_type, dump, laborHours, laborCost, dumpData, surcharges: [...surcharges],
    notes: vision.notes
  });

  const out = {
    cubic_yards: Number(cubicYards.toFixed(1)),
    labor_hours: Number(laborHours.toFixed(1)),
    dump_fee_low:  dump.low,
    dump_fee_high: dump.high,
    bid_low:  round5(bidLow),
    bid_high: round25(bidHigh),
    bid_recommended: round25(bidRec),
    load_type: vision.load_type || 'mixed',
    surcharges: [...surcharges],
    rationale,
    dump_market: dumpData.city,
    confidence: vision.load_confidence || 'medium'
  };

  // Fire-and-forget log
  logBid(env, { zip, ...out }).catch(() => {});

  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function buildRationale(c) {
  const surchargesText = c.surcharges.length
    ? `Surcharges added: ${c.surcharges.join(', ')}.`
    : 'No surcharges detected.';
  return `Sized at ~${c.yards.toFixed(1)} yd³ (${c.loadType}). ${c.notes || ''} Dump fees in ${c.dumpData.city} run $${c.dumpData.perYard}/yd × ${c.yards.toFixed(1)} = ${'$' + c.dump.low}-${'$' + c.dump.high} (incl. surcharges). Labor: ${c.laborHours.toFixed(1)} crew-hours at $${LABOR_RATE_PER_HOUR_PER_PERSON}/hr/person ≈ $${Math.round(c.laborCost)}. ${surchargesText} Bid built on 30% floor / 45% target margin.`;
}

export const config = { path: '/api/analyze' };
