const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const MAX_SCREENSHOTS = 4;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'trade-tape-ai-service' });
});

app.post('/analyze-trade', async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: 'Server is missing Supabase configuration.' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing the Gemini API key.' });
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Not signed in.' });

    const { tradeId } = req.body || {};
    if (!tradeId) return res.status(400).json({ error: 'Missing tradeId.' });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: trade, error: tradeErr } = await supabase
      .from('trades')
      .select('*')
      .eq('id', tradeId)
      .single();

    if (tradeErr || !trade) {
      return res.status(404).json({ error: 'Trade not found.' });
    }

    const { data: shots } = await supabase
      .from('trade_screenshots')
      .select('url')
      .eq('trade_id', tradeId)
      .limit(MAX_SCREENSHOTS);

    const parts = [{ text: buildPrompt(trade) }];

    for (const shot of shots || []) {
      const imagePart = await fetchImagePart(shot.url);
      if (imagePart) parts.push(imagePart);
    }

    const analysis = await callGemini(parts);
    return res.json({ analysis });
  } catch (err) {
    console.error('analyze-trade error:', err);
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
});

function buildPrompt(trade) {
  const isShort = String(trade.side || '').toLowerCase() === 'short';
  const gross = isShort ? (trade.entry - trade.exit) : (trade.exit - trade.entry);
  const pnl = gross * (trade.qty || 0) - (trade.fees || 0);

  const lines = [
    `Symbol: ${trade.symbol || 'n/a'}`,
    `Side: ${trade.side || 'n/a'}`,
    `Entry: ${trade.entry}`,
    `Exit: ${trade.exit}`,
    `Quantity: ${trade.qty}`,
    `Fees: ${trade.fees || 0}`,
    trade.stop_loss != null ? `Stop loss: ${trade.stop_loss}` : null,
    trade.take_profit != null ? `Take profit: ${trade.take_profit}` : null,
    trade.strategy ? `Strategy tag: ${trade.strategy}` : null,
    trade.emotion ? `Emotion during trade: ${trade.emotion}` : null,
    `Result: ${pnl >= 0 ? 'profit' : 'loss'} of $${Math.abs(pnl).toFixed(2)}`,
    `Trader's notes: ${trade.notes ? trade.notes : '(none provided)'}`
  ].filter(Boolean);

  return [
    'You are a trading coach reviewing a single trade from a trader\'s personal journal.',
    'Be direct, specific, and concise (under 200 words, plain text, no markdown headers).',
    'Cover: what went right, what went wrong, and one clear, actionable improvement.',
    'If chart screenshots are attached below, refer to specific price action or levels you see in them.',
    '',
    'Trade details:',
    lines.join('\n')
  ].join('\n');
}

async function fetchImagePart(url) {
  try {
    const imgRes = await fetch(url);
    if (!imgRes.ok) return null;
    const mimeType = imgRes.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return { inline_data: { mime_type: mimeType, data: buf.toString('base64') } };
  } catch (err) {
    console.error('Failed to fetch screenshot:', url, err.message);
    return null;
  }
}

async function callGemini(parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }] })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Gemini request failed (${res.status}).`;
    throw new Error(msg);
  }

  const text = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts.map((p) => p.text).join('\n');

  if (!text) throw new Error('Gemini returned no analysis.');
  return text.trim();
}

app.listen(PORT, () => {
  console.log(`Trade Tape AI service listening on port ${PORT}`);
});
