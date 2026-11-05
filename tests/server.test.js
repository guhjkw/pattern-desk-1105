/* Server tests: a real HTTP server, TradingView-style webhooks, and a fake broker that records every
   request (no real Zerodha, Angel One or IBKR account is touched). Run: node tests/server.test.js */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('../src/backtest.js');
const T = require('../src/tvAlert.js');
const L = require('../server/lib.js');
const S = require('../server/server.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'sample.json'), 'utf8'));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); } };
const section = (t) => console.log('\n' + t);
const listen = (h) => new Promise((r) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => r(s)); });
function post(srv, p, body, headers) {
  return new Promise((resolve) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method: 'POST', path: p, headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, headers || {}) }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.end(data);
  });
}
function get(srv, p, headers) {
  return new Promise((resolve) => { http.get({ host: '127.0.0.1', port: srv.address().port, path: p, headers: headers || {} }, (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(c).toString() || 'null') })); }); });
}
function findSignal(symbol) {
  const sym = sample.symbols.find((s) => s.symbol === symbol);
  const s = B.runSymbol(sample, sym, 'day', {}, {}).signals[0];
  return { sym, s };
}
// each account logged in on the morning of the signal's day (the morning login routine)
function accountsLoggedIn(day) {
  return JSON.parse(JSON.stringify(sample.accounts)).map((a) => Object.assign(a, { session: Object.assign({}, a.session, { issuedAt: day + (a.broker === 'ibkr' ? 'T08:30:00-04:00' : 'T08:50:00+05:30') }) }));
}

(async function main() {
  section('1. login helpers');
  ok('1.1 TOTP matches RFC 6238 (T=59)', L.totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000, 8) === '94287082');
  ok('1.2 TOTP matches RFC 6238 (T=1111111109, T=1234567890)', L.totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1111111109000, 8) === '07081804' && L.totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1234567890000, 8) === '89005924');
  ok('1.3 Kite checksum is sha256(api_key + request_token + api_secret)', L.kiteChecksum('k', 'r', 's') === crypto.createHash('sha256').update('krs').digest('hex'));
  const ang = L.login.angelSession({ apiKey: 'AK', clientCode: 'C1', pin: '1234', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', localIp: '10.0.0.2', publicIp: '203.0.113.7', mac: 'aa:bb' }, 59000);
  ok('1.4 SmartAPI login sends client code, PIN and the current TOTP', ang.json.clientcode === 'C1' && ang.json.totp === '287082' && ang.headers['X-ClientPublicIP'] === '203.0.113.7');

  section('2. webhook in paper mode');
  const { sym: spy, s: spySig } = findSignal('SPY');
  const { sym: rel, s: relSig } = findSignal('RELIANCE');
  const spyBody = T.examplePayload(spySig, 'tv-secret-123', spy), relBody = T.examplePayload(relSig, 'tv-secret-123', rel);
  let clock = new Date(JSON.parse(spyBody).time + 30e3);
  let handled = [];
  const cfg = { mode: 'paper', secret: 'tv-secret-123', adminToken: 'admin-xyz', symbols: sample.symbols, accounts: accountsLoggedIn(spySig.day), pattern: {}, maxAlertAgeMs: 600000 };
  const app = S.createApp(cfg, { now: () => clock, onHandled: (e) => handled.push(e) });
  const srv = await listen(app);
  const health = await get(srv, '/health');
  ok('2.1 health says paper mode', health.status === 200 && health.json.mode === 'paper');
  const r1 = await post(srv, '/tv', spyBody);
  await new Promise((r) => setTimeout(r, 50));
  ok('2.2 TradingView gets its 200 straight away', r1.status === 200 && JSON.parse(r1.body).ok);
  const e1 = handled[0];
  ok('2.3 the SPY alert routes to IBKR only, in paper', e1 && e1.kind === 'signal' && e1.results.find((x) => x.account === 'ibkr-main').take && e1.results.find((x) => x.account === 'ibkr-main').paper && e1.results.filter((x) => x.take).length === 1, e1);
  await post(srv, '/tv', spyBody); await new Promise((r) => setTimeout(r, 30));
  ok('2.4 the same alert again is refused as a duplicate', handled[1].kind === 'refused' && /Duplicate/.test(handled[1].errors.join()));
  await post(srv, '/tv', spyBody.replace('tv-secret-123', 'guess')); await new Promise((r) => setTimeout(r, 30));
  ok('2.5 a wrong secret is refused (and still gets a fast answer)', handled[2].kind === 'refused' && /secret/.test(handled[2].errors.join()));
  ok('2.6 the journal needs the admin token', (await get(srv, '/journal')).status === 401 && (await get(srv, '/journal', { 'x-admin-token': 'admin-xyz' })).json.journal.length === 3);
  const big = await post(srv, '/tv', 'x'.repeat(20000));
  ok('2.7 an oversized body is refused', big.status === 413);
  clock = new Date(JSON.parse(relBody).time + 30e3);
  cfg.accounts.splice(0, cfg.accounts.length, ...accountsLoggedIn(relSig.day));
  await post(srv, '/tv', relBody); await new Promise((r) => setTimeout(r, 30));
  const e4 = handled[handled.length - 1];
  ok('2.8 the RELIANCE alert routes to Zerodha and Angel One', e4.kind === 'signal' && e4.results.filter((x) => x.take).map((x) => x.account).sort().join() === 'angel-main,zerodha-main', e4.results);
  const stale = JSON.parse(relBody); stale.id = 'stale-1';
  clock = new Date(stale.time + 30 * 60e3);
  await post(srv, '/tv', stale); await new Promise((r) => setTimeout(r, 30));
  ok('2.9 an alert that arrives 30 minutes late is not traded', /too late/.test(handled[handled.length - 1].errors.join()));
  ok('2.10 the kill switch needs the admin token', (await post(srv, '/kill', {})).status === 401);
  await post(srv, '/kill', {}, { 'x-admin-token': 'admin-xyz' });
  const k = JSON.parse(relBody); k.id = 'after-kill'; clock = new Date(k.time + 30e3);
  await post(srv, '/tv', k); await new Promise((r) => setTimeout(r, 30));
  ok('2.11 after the kill switch every account refuses', handled[handled.length - 1].results.every((x) => !x.take && /Kill switch/.test(x.reasons.join())));
  srv.close();

  section('3. live mode against a fake broker');
  const seen = [];
  const broker = await listen((req, res) => {
    const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(c).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.includes('iserver') ? [{ order_id: '1', order_status: 'Submitted' }] : { status: 'success', data: { order_id: '250102000000123' } }));
    });
  });
  const base = 'http://127.0.0.1:' + broker.address().port;
  const live = Object.assign({}, cfg, { mode: 'live', accounts: accountsLoggedIn(relSig.day), brokerBase: { zerodha: base, angel: base, ibkr: base } });
  handled = [];
  const creds = { 'zerodha-main': { apiKey: 'kiteKEY', accessToken: 'kiteTOKEN' }, 'angel-main': { apiKey: 'angKEY', jwt: 'angJWT', localIp: '10.0.0.2', publicIp: '203.0.113.7', mac: 'aa:bb:cc' }, 'ibkr-main': {} };
  clock = new Date(JSON.parse(relBody).time + 30e3);
  const srv2 = await listen(S.createApp(live, { now: () => clock, onHandled: (e) => handled.push(e), credentials: creds }));
  await post(srv2, '/tv', relBody); await new Promise((r) => setTimeout(r, 120));
  const kite = seen.find((x) => x.url === '/orders/regular'), smart = seen.find((x) => x.url.endsWith('/placeOrder'));
  ok('3.1 Zerodha: form-encoded POST /orders/regular with "token key:access_token"', kite && kite.headers.authorization === 'token kiteKEY:kiteTOKEN' && kite.headers['x-kite-version'] === '3' && /application\/x-www-form-urlencoded/.test(kite.headers['content-type']), kite);
  const kp = new URLSearchParams(kite ? kite.body : '');
  ok('3.2 Zerodha body: RELIANCE, NSE, the signal\'s side, LIMIT, MIS, quantity from the risk rules', kp.get('tradingsymbol') === 'RELIANCE' && kp.get('exchange') === 'NSE' && kp.get('transaction_type') === (relSig.side === 'long' ? 'BUY' : 'SELL') && kp.get('order_type') === 'LIMIT' && kp.get('product') === 'MIS' && +kp.get('quantity') > 0, Object.fromEntries(kp));
  ok('3.3 Angel One: JSON placeOrder with bearer JWT, API key and the static IP header', smart && smart.headers.authorization === 'Bearer angJWT' && smart.headers['x-privatekey'] === 'angKEY' && smart.headers['x-clientpublicip'] === '203.0.113.7' && JSON.parse(smart.body).symboltoken === '2885', smart && smart.headers);
  ok('3.4 the broker answers are kept in the journal', handled[0].results.filter((x) => x.take).every((x) => x.ok && x.status === 200));
  clock = new Date(JSON.parse(spyBody).time + 30e3);
  live.accounts.splice(0, live.accounts.length, ...accountsLoggedIn(spySig.day));
  await post(srv2, '/tv', spyBody); await new Promise((r) => setTimeout(r, 120));
  const ib = seen.find((x) => x.url.includes('/iserver/account/U1234567/orders'));
  const ibj = ib ? JSON.parse(ib.body) : {};
  ok('3.5 IBKR: one bracket POST with the parent and two children', ib && ibj.orders.length === 3 && ibj.orders[1].parentId === ibj.orders[0].cOID && ibj.orders[0].conid === 756733, ibj);
  ok('3.6 secrets never reach the journal', !JSON.stringify(handled).includes('kiteTOKEN') && !JSON.stringify(handled).includes('angJWT'));
  srv2.close(); broker.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exitCode = 1; });
