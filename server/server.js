'use strict';
/* Pattern Desk server: runs on a VPS with a static IP (registered with Zerodha and Angel One).

   POST /tv        TradingView webhook. Answers 200 at once (TradingView gives up after ~3 s and never
                   retries), then: secret check, parse to a signal, risk checks per account, size, and
                   send the orders (live) or log them (paper, the default).
   GET  /health    liveness + mode, for an uptime monitor
   GET  /journal   today's decisions (behind the admin token)

   The same src/ files as the demo page decide everything; this file only moves data in and out. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const P = require('../src/patterns.js');
const R = require('../src/router.js');
const T = require('../src/tvAlert.js');
const L = require('./lib.js');

function createApp(cfg, deps = {}) {
  const state = deps.state || { open: {}, dayLoss: {}, routed: {}, killSwitch: false };
  const seen = {};
  const journal = [];
  const now = deps.now || (() => new Date());
  const log = (entry) => {
    const e = Object.assign({ at: now().toISOString() }, entry);
    journal.push(e);
    if (cfg.journalFile) fs.appendFileSync(cfg.journalFile, JSON.stringify(e) + '\n');
    return e;
  };

  async function handleAlert(body) {
    const p = T.parse(body, { secret: cfg.secret, symbols: cfg.symbols, cfg: cfg.pattern, seen, nowMs: now().getTime(), maxAgeMs: cfg.maxAlertAgeMs || 10 * 60e3 });
    if (!p.ok) return log({ kind: 'refused', errors: p.errors });
    const sig = p.signal, sym = cfg.symbols.find((s) => s.symbol === sig.symbol);
    const decisions = R.route(sig, sym, cfg.accounts, state, now().toISOString());
    R.record(state, decisions, sig);
    const results = [];
    for (const d of decisions) {
      if (!d.take) { results.push({ account: d.account, take: false, reasons: d.reasons }); continue; }
      if (cfg.mode !== 'live') { results.push({ account: d.account, take: true, qty: d.size.qty, paper: true, orders: d.orders.length }); continue; }
      // live: send the entry now; exits are sent when the entry fill comes back (order updates), except IBKR's bracket
      const acc = cfg.accounts.find((a) => a.id === d.account);
      const creds = (deps.credentials || {})[d.account] || {};
      const first = L.materialize(d.orders[0], creds, cfg.brokerBase && cfg.brokerBase[acc.broker]);
      try {
        const r = await L.send(first, deps.fetch);
        results.push({ account: d.account, take: true, qty: d.size.qty, sent: d.orders[0].label, status: r.status, ok: r.ok, response: r.body });
      } catch (e) { results.push({ account: d.account, take: true, qty: d.size.qty, error: e.message }); }
    }
    return log({ kind: 'signal', signal: sig, results });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, mode: cfg.mode === 'live' ? 'live' : 'paper', killSwitch: state.killSwitch, signalsToday: journal.filter((e) => e.kind === 'signal').length });
    if (req.method === 'GET' && url.pathname === '/journal') {
      if (!L.safeEqual(req.headers['x-admin-token'], cfg.adminToken)) return json(401, { error: 'admin token required' });
      return json(200, { journal });
    }
    if (req.method === 'POST' && url.pathname === '/tv') {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size <= 16384) chunks.push(c); });
      req.on('end', () => {
        if (size > 16384) return json(413, { error: 'too large' });
        json(200, { ok: true });                                      // answer TradingView first
        const done = handleAlert(Buffer.concat(chunks).toString('utf8')).catch((e) => log({ kind: 'error', error: e.message }));
        if (deps.onHandled) done.then(deps.onHandled);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/kill') {
      if (!L.safeEqual(req.headers['x-admin-token'], cfg.adminToken)) return json(401, { error: 'admin token required' });
      state.killSwitch = true; log({ kind: 'kill-switch', on: true }); return json(200, { killSwitch: true });
    }
    json(404, { error: 'not found' });
  };
}

function loadConfig(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  c.secret = process.env.TV_SECRET || c.secret;
  c.adminToken = process.env.ADMIN_TOKEN || c.adminToken;
  c.pattern = Object.assign(P.cfgOf(null), c.pattern || {});
  return c;
}

if (require.main === module) {
  const cfg = loadConfig(process.env.CONFIG || path.join(__dirname, 'config.example.json'));
  cfg.journalFile = process.env.JOURNAL || path.join(__dirname, 'journal.jsonl');
  http.createServer(createApp(cfg)).listen(Number(process.env.PORT || 8080), () => console.log('pattern desk listening, mode', cfg.mode));
}

module.exports = { createApp, loadConfig };
