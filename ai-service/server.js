const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
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
    trade_found: { type: 'BOOLEAN' },
    direction: { type: 'STRING', enum: ['long', 'short', 'none'] },
    strategy_name: { type: 'STRING' },
    confidence_score: { type: 'NUMBER' },
    timeframe_confluence: { type: 'ARRAY', items: { type: 'STRING' } },
    statement: { type: 'STRING' },
    invalidation: { type: 'STRING' },
    indicatorsNoted: { type: 'STRING' },
    annotations: {
      type: 'OBJECT',
      properties: {
        trendlines: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              x1: { type: 'NUMBER' }, y1: { type: 'NUMBER' },
              x2: { type: 'NUMBER' }, y2: { type: 'NUMBER' },
              label: { type: 'STRING' }, price: { type: 'STRING' }, color: { type: 'STRING' }
            }
          }
        },
        zones: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              x: { type: 'NUMBER' }, y: { type: 'NUMBER' },
              width: { type: 'NUMBER' }, height: { type: 'NUMBER' },
              label: { type: 'STRING' }, price: { type: 'STRING' }, color: { type: 'STRING' }
            }
          }
        }
      }
    }
  },
  required: ['trade_found', 'statement', 'confidence_score']
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

function buildChartPrompt(assetType, fundamentalsText, imageLabels) {
  const assetLine = assetType
    ? `The trader says this is a ${assetType} chart — factor in typical volatility, session behavior, and price precision for that asset class.`
    : 'The asset type wasn\'t specified — infer what you can from the chart(s) and keep guidance general if unsure.';

  const imagesLine = imageLabels.length > 1
    ? `You have been given ${imageLabels.length} chart images of the SAME instrument at different timeframes, in this order: ${imageLabels.map((l, i) => `image ${i + 1} = ${l}`).join(', ')}.`
    : 'You have been given a single chart image (image 1).';

  const fundamentalsBlock = fundamentalsText
    ? ['', 'Fundamental context for reference — weigh visible chart structure more heavily than this, but factor it in qualitatively:', fundamentalsText]
    : [];

  return [
    'You are the core backend AI engine for a high-performance, multi-strategy algorithmic trading app. Your job is to perform strict Multi-Timeframe (MTF) visual chart analysis on the attached chart image(s), identify only highly valid trading setups, apply a rigorous filter to reject weak setups, and return precise graphical coordinates alongside an execution statement.',
    imagesLine,
    assetLine,
    '',
    'Analysis pipeline — evaluate market structure in this strict sequence:',
    '1. Macro Trend Filter (highest timeframe available): determine the dominant direction (bullish, bearish, or sideways range).',
    '2. Intermediate Setup Detection: scan for valid chart patterns and structures (support/resistance flips, breakout triangles, moving-average crosses, order blocks, channels). The pattern MUST align with the macro trend direction.',
    '3. Micro Trigger Validation: inspect the lowest-timeframe image (or the only image, if just one) for exact entry confirmation from candles, wicks, and volume.',
    'Note any visible indicators/overlays you used (moving averages, VWAP, Bollinger Bands, RSI, volume, order-flow) in indicatorsNoted, or leave it an empty string if none.',
    '',
    'Grade overall setup quality as confidence_score, a number from 1 to 10 based on confluence (how many timeframes/indicators agree):',
    '- Timeframe mismatch or weak confluence (score below 7): if a lower-timeframe pattern trades directly into major higher-timeframe resistance/support, or the pattern lacks volume/wick confirmation, you MUST reject it — set trade_found to false, direction to "none", and clear annotations to {}.',
    '- Strong confluence (score 7 or above): set trade_found to true and generate full execution annotations.',
    '',
    'When trade_found is true, also set: direction ("long" or "short"), strategy_name (e.g. "S/R Flip Breakout", "Bull Flag Continuation"), timeframe_confluence (short strings naming what aligned, e.g. ["4H trend alignment", "15m entry confirmation"]), invalidation (one plain-language sentence describing exactly what price action would prove the setup wrong), and statement (a clear, punchy, human-readable paragraph covering the market structure, why the timeframes agree, and the risk:reward parameters).',
    '',
    'Coordinate system for annotations.trendlines and annotations.zones: map the PRIMARY chart (image 1, the entry-timeframe chart) onto a normalized 1000x1000 grid, x from 0 (left) to 1000 (right) and y from 0 (top) to 1000 (bottom) of that image. All coordinates must be relative to image 1 only, even if other images were provided for context.',
    '- trendlines: straight lines from (x1,y1) to (x2,y2) — use these for the macro resistance/support line, trendlines/channel edges, entry line, stop-loss line, and each take-profit target. Provide exactly three take-profit trendlines at risk:reward ratios of approximately 1:2, 1:3, and 1:5 (label them "TP 1:2", "TP 1:3", "TP 1:5"). Label the entry line "Entry" and the stop line "Stop". Use color "blue" for entry, "red" for stop/resistance, "green" for targets/support, "gray" for other structure lines.',
    '- zones: rectangles (x, y = top-left corner, width, height) — use these for demand/supply zones or an entry zone rather than a single line, when that fits the structure better.',
    '- Draw a chart the way a professional analyst would actually mark one up, not just the bare minimum. Beyond entry/stop/3 targets, ALWAYS include at least one or two additional trendlines or zones that show the structure driving your call — e.g. the macro trend/channel line, the specific swing high or low that defines it, or the support/resistance level that flipped roles. A setup with no visible structural reasoning behind it is not a valid setup.',
    '- EVERY trendline and zone, with no exceptions, must have a real "price" value read off the visible price axis at that level (a plain number/string like "2528.14") — never leave price null or empty if any axis is visible. This is what a trader will act on, so it must be a concrete, specific figure, not a vague description.',
    'If trade_found is false, annotations must be {} (empty, no trendlines or zones).',
    '',
    'Respond only with JSON matching the required schema — no markdown, no text outside the JSON.',
    ...fundamentalsBlock
  ].join('\n');
}

async function analyzeChartImage({ images, assetType, ticker }) {
  const imgs = images && images.length ? images : [];
  if (!imgs.length) throw new Error('No chart image provided.');

  const fundamentalsText = assetType === 'stock' && ticker ? await fetchFundamentals(ticker) : null;
  const imageLabels = imgs.map((img, i) => img.label || `chart ${i + 1}`);

  const parts = [{ text: buildChartPrompt(assetType, fundamentalsText, imageLabels) }];
  imgs.forEach((img, i) => {
    parts.push({ text: `Image ${i + 1} (${imageLabels[i]}):` });
    const cleanBase64 = img.imageBase64.includes(',') ? img.imageBase64.split(',').pop() : img.imageBase64;
    parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: cleanBase64 } });
  });

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

    const { images, assetType, ticker } = req.body || {};
    if (!images || !images.length) return res.status(400).json({ error: 'Missing chart image.' });
    if (images.length > 3) return res.status(400).json({ error: 'Send at most 3 chart images.' });

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return res.status(401).json({ error: 'Not signed in.' });
    }

    const result = await analyzeChartImage({ images, assetType, ticker });
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
    const result = await analyzeChartImage({ images: [{ imageBase64: base64, mimeType, label: 'entry timeframe' }], assetType, ticker });
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
  if (!result || !result.trade_found) {
    return 'No trade.\n\n' + escTelegramHtml((result && result.statement) || 'No meaningful pattern or signal was visible in this chart.');
  }
  const ann = result.annotations || {};
  const levelLines = [...(ann.trendlines || []), ...(ann.zones || [])]
    .filter((a) => a.label)
    .map((a) => `${escTelegramHtml(a.label)}: ${escTelegramHtml(a.price || 'n/a')}`);

  const lines = [
    `<b>${escTelegramHtml((result.direction || '').toUpperCase())}</b> — ${escTelegramHtml(result.strategy_name || '')} (confidence ${escTelegramHtml(result.confidence_score)}/10)`,
    (result.timeframe_confluence || []).length ? escTelegramHtml(result.timeframe_confluence.join(', ')) : null,
    '',
    ...levelLines,
    '',
    escTelegramHtml(result.statement || ''),
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

async function callGemini(parts, generationConfig, attempt) {
  attempt = attempt || 1;
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
    if (res.status === 503 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return callGemini(parts, generationConfig, attempt + 1);
    }
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
