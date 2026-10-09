const WebSocket = require('ws');

const DERIV_URL = process.env.DERIV_WS_URL || 'wss://api.derivws.com/trading/v1/options/ws/public';
const POLL_MS = 15000;
const PING_MS = 30000;
const DEAD_AFTER_MS = 90000;
const ADHOC_TTL_MS = 2 * 60 * 1000;
const PRICE_FRESH_MS = 20000;

const MARKET_NAMES = {
  synthetic_index: 'Synthetic indices',
  forex: 'Forex',
  cryptocurrency: 'Crypto',
  indices: 'Stock indices',
  commodities: 'Commodities'
};

function createAlertWatcher({ supabase, sendPush, log }) {
  log = log || console;
  let ws = null;
  let connected = false;
  let stopped = false;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let pingTimer = null;
  let pollTimer = null;
  let symbols = [];
  let symbolSet = new Set();
  let resolveSymbols;
  const symbolsReady = new Promise((r) => { resolveSymbols = r; });
  const prices = {};
  const subs = new Map();
  const adhoc = new Map();
  const priceWaiters = new Map();
  let alerts = [];
  let lastTickAt = 0;
  let lastPongAt = 0;
  let lastPollAt = 0;
  const firing = new Set();

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function isWanted(sym) {
    if ((adhoc.get(sym) || 0) > Date.now()) return true;
    return alerts.some((a) => a.symbol === sym);
  }

  function wantedSymbols() {
    const set = new Set(alerts.map((a) => a.symbol));
    adhoc.forEach((exp, sym) => { if (exp > Date.now()) set.add(sym); });
    return set;
  }

  function syncSubscriptions() {
    if (!connected) return;
    wantedSymbols().forEach((sym) => {
      if (!subs.has(sym) && symbolSet.has(sym)) {
        subs.set(sym, null);
        send({ ticks: sym, subscribe: 1 });
      }
    });
  }

  function handleSymbols(list) {
    symbols = (list || [])
      .map((s) => ({
        symbol: s.underlying_symbol,
        name: s.underlying_symbol_name,
        market: s.market,
        marketName: MARKET_NAMES[s.market] || s.market,
        pip: s.pip_size,
        open: s.exchange_is_open === 1
      }))
      .filter((s) => s.symbol && s.name);
    symbolSet = new Set(symbols.map((s) => s.symbol));
    resolveSymbols();
    syncSubscriptions();
  }

  function resolveWaiters(sym, value) {
    const waiters = priceWaiters.get(sym);
    if (!waiters) return;
    priceWaiters.delete(sym);
    waiters.forEach((r) => r(value));
  }

  async function fire(alert, quote) {
    if (firing.has(alert.id)) return;
    firing.add(alert.id);
    try {
      const { data, error } = await supabase
        .from('price_alerts')
        .update({ status: 'triggered', triggered_at: new Date().toISOString(), triggered_price: quote })
        .eq('id', alert.id)
        .eq('status', 'active')
        .select('id');
      if (error) {
        log.error('alert update failed:', error.message);
        firing.delete(alert.id);
        return;
      }
      alerts = alerts.filter((a) => a.id !== alert.id);
      if (!data || !data.length) { firing.delete(alert.id); return; }
      const name = alert.symbol_name || alert.symbol;
      const delivered = await sendPush(alert.user_id, {
        title: `${name} hit ${alert.target}`,
        body: `${name} is now ${quote}. Your ${alert.direction === 'above' ? 'above' : 'below'} ${alert.target} alert triggered.`,
        tag: `alert-${alert.id}`,
        url: '/'
      });
      log.log(`alert ${alert.id} fired (${alert.symbol} ${alert.direction} ${alert.target} @ ${quote}), delivered to ${delivered} device(s)`);
    } catch (err) {
      log.error('alert fire error:', err.message);
    } finally {
      firing.delete(alert.id);
    }
  }

  function handleTick(d) {
    const t = d.tick;
    if (!t || typeof t.quote !== 'number') return;
    const sym = t.symbol;
    prices[sym] = { quote: t.quote, pip: t.pip_size, at: Date.now() };
    lastTickAt = Date.now();
    if (d.subscription && d.subscription.id) subs.set(sym, d.subscription.id);
    resolveWaiters(sym, prices[sym]);

    if (!isWanted(sym)) {
      const id = subs.get(sym);
      if (id) { send({ forget: id }); subs.delete(sym); }
      return;
    }
    alerts.forEach((a) => {
      if (a.symbol !== sym) return;
      const hit = a.direction === 'above' ? t.quote >= a.target : t.quote <= a.target;
      if (hit) fire(a, t.quote);
    });
  }

  function onMessage(raw) {
    let d;
    try { d = JSON.parse(raw.toString()); } catch (e) { return; }
    if (d.error) {
      const sym = d.echo_req && d.echo_req.ticks;
      log.warn('deriv error:', d.error.code, d.error.message, sym || '');
      if (sym) { subs.set(sym, 'error'); resolveWaiters(sym, null); }
      return;
    }
    if (d.msg_type === 'active_symbols') handleSymbols(d.active_symbols);
    else if (d.msg_type === 'tick') handleTick(d);
    else if (d.msg_type === 'ping') lastPongAt = Date.now();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocket(DERIV_URL);
    ws.on('open', () => {
      connected = true;
      reconnectDelay = 1000;
      lastPongAt = Date.now();
      subs.clear();
      send({ active_symbols: 'brief' });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ ping: 1 }), PING_MS);
      log.log('connected to Deriv feed');
    });
    ws.on('message', onMessage);
    ws.on('error', (e) => log.error('deriv ws error:', e.message));
    ws.on('close', () => {
      connected = false;
      clearInterval(pingTimer);
      subs.clear();
      log.warn('Deriv feed closed, reconnecting');
      scheduleReconnect();
    });
  }

  async function pollAlerts() {
    if (Date.now() - lastPollAt < 2000) return;
    lastPollAt = Date.now();
    if (connected && Date.now() - lastPongAt > DEAD_AFTER_MS && ws) {
      log.warn('Deriv feed unresponsive, restarting connection');
      try { ws.terminate(); } catch (e) { /* closing anyway */ }
    }
    const { data, error } = await supabase
      .from('price_alerts')
      .select('id,user_id,symbol,symbol_name,target,direction')
      .eq('status', 'active')
      .limit(5000);
    if (error) { log.error('alert poll failed:', error.message); return; }
    alerts = (data || []).map((a) => ({ ...a, target: Number(a.target) }));
    syncSubscriptions();
  }

  async function getSymbols() {
    await Promise.race([symbolsReady, new Promise((r) => setTimeout(r, 10000))]);
    return symbols;
  }

  async function getPrice(symbol) {
    if (!symbolSet.has(symbol)) return null;
    adhoc.set(symbol, Date.now() + ADHOC_TTL_MS);
    const cached = prices[symbol];
    if (cached && Date.now() - cached.at < PRICE_FRESH_MS && subs.has(symbol)) return cached;
    syncSubscriptions();
    const fresh = await new Promise((resolve) => {
      const list = priceWaiters.get(symbol) || [];
      list.push(resolve);
      priceWaiters.set(symbol, list);
      setTimeout(() => resolve(null), 8000);
    });
    return fresh || cached || null;
  }

  function getStatus() {
    return {
      connected,
      lastTickAt,
      lastPongAt,
      watching: Array.from(subs.keys()),
      activeAlerts: alerts.length
    };
  }

  function start() {
    connect();
    pollAlerts();
    pollTimer = setInterval(pollAlerts, POLL_MS);
  }

  function stop() {
    stopped = true;
    clearInterval(pollTimer);
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    if (ws) { try { ws.terminate(); } catch (e) { /* already closed */ } }
  }

  return { start, stop, getStatus, getSymbols, getPrice, refresh: pollAlerts };
}

module.exports = { createAlertWatcher };
