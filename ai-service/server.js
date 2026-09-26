const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID;
const MAX_SCREENSHOTS = 4;

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

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

const CHART_SCHEMA = {
  type: 'OBJECT',
  properties: {
    hasSetup: { type: 'BOOLEAN' },
    direction: { type: 'STRING', enum: ['long', 'short', 'none'] },
    pattern: { type: 'STRING' },
    confidence: { type: 'STRING', enum: ['A', 'B', 'C', 'D'] },
    reasoning: { type: 'STRING' },
    indicatorsNoted: { type: 'STRING' },
    invalidation: { type: 'STRING' },
    keyLevels: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          label: { type: 'STRING' },
          price: { type: 'STRING' },
          y: { type: 'NUMBER' }
        }
      }
    },
    entry: {
      type: 'OBJECT',
      properties: { price: { type: 'STRING' }, y: { type: 'NUMBER' } }
    },
    stopLoss: {
      type: 'OBJECT',
      properties: { price: { type: 'STRING' }, y: { type: 'NUMBER' } }
    },
    targets: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          rr: { type: 'STRING' },
          price: { type: 'STRING' },
          y: { type: 'NUMBER' }
        }
      }
    }
  },
  required: ['hasSetup', 'reasoning']
};

async function fetchFundamentals(ticker) {
  if (!ALPHA_VANTAGE_API_KEY || !ticker) return null;
  try {
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(ticker)}&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const r = await fetch(url);
    const d = await r.json().catch(() => null);
    if (!d || !d.Symbol) return null;
    const pct = (v) => (v && v !== 'None' ? `${(parseFloat(v) * 100).toFixed(1)}%` : null);
    const lines = [
      `Ticker: ${d.Symbol}${d.Name ? ' (' + d.Name + ')' : ''}`,
      d.Sector ? `Sector: ${d.Sector}` : null,
      d.PERatio && d.PERatio !== 'None' ? `P/E ratio: ${d.PERatio}` : null,
      d.EPS && d.EPS !== 'None' ? `EPS: ${d.EPS}` : null,
      pct(d.ProfitMargin) ? `Profit margin: ${pct(d.ProfitMargin)}` : null,
      pct(d.QuarterlyRevenueGrowthYOY) ? `Revenue growth (YoY): ${pct(d.QuarterlyRevenueGrowthYOY)}` : null,
      pct(d.QuarterlyEarningsGrowthYOY) ? `Earnings growth (YoY): ${pct(d.QuarterlyEarningsGrowthYOY)}` : null
    ].filter(Boolean);
    return lines.length > 1 ? lines.join('\n') : null;
  } catch (err) {
    console.error('fetchFundamentals failed:', err.message);
    return null;
  }
}

function buildChartPrompt(assetType, fundamentalsText) {
  const assetLine = assetType
    ? `The trader says this is a ${assetType} chart — factor in typical volatility, session behavior, and price precision for that asset class.`
    : 'The asset type wasn\'t specified — infer what you can from the chart and keep guidance general if unsure.';

  const fundamentalsBlock = fundamentalsText
    ? ['', 'Fundamental context for reference — weigh visible chart structure more heavily than this, but factor it in qualitatively (e.g. note if a weak technical setup is compounded by weak fundamentals, or vice versa):', fundamentalsText]
    : [];

  return [
    'You are an expert technical analyst reviewing a single chart screenshot for a possible trading opportunity, visible right now at the right-hand edge of the chart.',
    assetLine,
    'Judge only what is visibly supported by the chart: trend structure, support/resistance, candle patterns, and price action. Note any visible indicators or overlays (moving averages, VWAP, Bollinger Bands, RSI, volume, order-flow/footprint data) and factor them into your read — describe what you used in indicatorsNoted, or leave it an empty string if nothing extra is visible. Do not invent a setup if the chart is choppy, unclear, or shows no meaningful pattern.',
    '',
    'Identify up to 3 key support/resistance zones visible on the chart, if any, as keyLevels — each with a short label such as "Resistance" or "Demand zone".',
    '',
    'If there is NO clear, reasonably confident setup: set hasSetup to false, direction to "none", pattern to "None", confidence to "D", and briefly explain why in reasoning (1-2 sentences).',
    '',
    'If there IS a clear setup: set hasSetup to true, pick direction ("long" or "short"), name the specific chart pattern if one clearly applies (e.g. "Bull flag", "Head and shoulders", "Ascending triangle", "Trend continuation" — otherwise "None"), and grade your confidence as a letter: "A" (strong, textbook), "B" (decent, some noise), or "C" (marginal, low conviction). Never use "D" when hasSetup is true. Then provide:',
    '- entry: the level where a trader would enter',
    '- stopLoss: a sensible invalidation level for the setup',
    '- invalidation: one plain-language sentence describing the specific price action that would prove this setup wrong (not just the stop price restated)',
    '- targets: exactly three take-profit levels corresponding to risk:reward ratios of approximately 1:2, 1:3, and 1:5 (set "rr" to those exact labels)',
    '',
    'For entry, stopLoss, every target, and every keyLevel, set "y" to a normalized vertical position from 0 (top of the image) to 1 (bottom of the image), estimating where that price level sits on THIS image based on the visible price axis and candle positions — this is used to draw a horizontal line at that height, so accuracy matters. Set "price" to a readable price label if you can read one off the axis, otherwise null.',
    '',
    'Keep reasoning under 120 words, plain text, no markdown, in everyday language a non-expert trader can follow. Respond only with JSON matching the required schema.',
    ...fundamentalsBlock
  ].join('\n');
}

async function analyzeChartImage({ imageBase64, mimeType, assetType, ticker }) {
  const cleanBase64 = imageBase64.includes(',') ? imageBase64.split(',').pop() : imageBase64;
  const fundamentalsText = assetType === 'stock' && ticker ? await fetchFundamentals(ticker) : null;

  const parts = [
    { text: buildChartPrompt(assetType, fundamentalsText) },
    { inline_data: { mime_type: mimeType || 'image/jpeg', data: cleanBase64 } }
  ];

  const raw = await callGemini(parts, {
    responseMimeType: 'application/json',
    responseSchema: CHART_SCHEMA
  });

  try {
    return JSON.parse(raw);
  } catch (parseErr) {
    throw new Error('AI returned an unreadable response. Try again.');
  }
}

app.post('/analyze-chart', async (req, res) => {
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

    const { imageBase64, mimeType, assetType, ticker } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: 'Missing chart image.' });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return res.status(401).json({ error: 'Not signed in.' });
    }

    const result = await analyzeChartImage({ imageBase64, mimeType, assetType, ticker });
    return res.json({ result });
  } catch (err) {
    console.error('analyze-chart error:', err);
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
});

app.post('/telegram-webhook', (req, res) => {
  res.sendStatus(200);
  handleTelegramUpdate(req.body || {}).catch((err) => console.error('telegram handling error:', err));
});

async function handleTelegramUpdate(update) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat && msg.chat.id;
  const fromId = msg.from && msg.from.id;
  if (!chatId) return;

  if (TELEGRAM_ALLOWED_USER_ID && String(fromId) !== String(TELEGRAM_ALLOWED_USER_ID)) {
    await telegramSend(chatId, 'This bot is private.');
    return;
  }
  if (!TELEGRAM_ALLOWED_USER_ID) {
    await telegramSend(chatId, `Your Telegram user ID is ${fromId}. Add this as TELEGRAM_ALLOWED_USER_ID in Render to lock this bot to just you.`);
  }

  const photos = msg.photo;
  if (!photos || !photos.length) {
    await telegramSend(chatId, 'Send me a chart screenshot as a photo and I\'ll scan it for a setup. For stocks, add the ticker as the photo caption (e.g. "AAPL") to include fundamentals.');
    return;
  }

  try {
    await telegramSend(chatId, 'Scanning chart…');
    const fileId = photos[photos.length - 1].file_id;
    const { base64, mimeType } = await telegramDownloadPhoto(fileId);
    const caption = (msg.caption || '').trim();
    const ticker = /^[A-Za-z.]{1,6}$/.test(caption) ? caption.toUpperCase() : null;
    const assetType = ticker ? 'stock' : '';
    const result = await analyzeChartImage({ imageBase64: base64, mimeType, assetType, ticker });
    await telegramSend(chatId, formatChartResultForTelegram(result), true);
  } catch (err) {
    console.error('telegram analyze error:', err);
    await telegramSend(chatId, 'Could not scan that chart: ' + (err.message || 'unknown error'));
  }
}

async function telegramDownloadPhoto(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error('Could not fetch that photo from Telegram.');
  const filePath = info.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  const imgRes = await fetch(fileUrl);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { base64: buf.toString('base64'), mimeType };
}

async function telegramSend(chatId, text, useHtml) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: useHtml ? 'HTML' : undefined })
  });
}

function escTelegramHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function formatChartResultForTelegram(result) {
  if (!result || !result.hasSetup) {
    return 'No clear trade here.\n\n' + escTelegramHtml((result && result.reasoning) || 'No meaningful pattern or signal was visible in this chart.');
  }
  const lines = [
    `<b>${escTelegramHtml((result.direction || '').toUpperCase())}</b> — ${escTelegramHtml(result.pattern || '')} (confidence ${escTelegramHtml(result.confidence || '')})`,
    '',
    result.entry ? `Entry: ${escTelegramHtml(result.entry.price || 'n/a')}` : null,
    result.stopLoss ? `Stop: ${escTelegramHtml(result.stopLoss.price || 'n/a')}` : null,
    ...(result.targets || []).map((t) => `${escTelegramHtml(t.rr || 'Target')}: ${escTelegramHtml(t.price || 'n/a')}`),
    '',
    escTelegramHtml(result.reasoning || ''),
    result.invalidation ? `\nInvalidation: ${escTelegramHtml(result.invalidation)}` : null
  ].filter((l) => l !== null);
  return lines.join('\n');
}

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

async function callGemini(parts, generationConfig) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = { contents: [{ parts }] };
  if (generationConfig) body.generationConfig = generationConfig;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
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
