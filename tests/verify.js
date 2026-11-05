/* Node tests for src/ (the same files the page and the server load). Run: node tests/verify.js */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../src/patterns.js');
const B = require('../src/backtest.js');
const R = require('../src/router.js');
const T = require('../src/tvAlert.js');

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'sample.json'), 'utf8'));
const sym = (s) => sample.symbols.find((x) => x.symbol === s);
const acc = (id) => JSON.parse(JSON.stringify(sample.accounts.find((a) => a.id === id)));
let pass = 0, fail = 0;
function section(t) { console.log('\n' + t); }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}
// a hand-made bar series: flat, two equal highs, a neckline, then a break with volume
function bars(spec) {
  return spec.map((x, i) => ({ i, day: x.day || '2026-10-12', time: x.time || ('10:' + String(i).padStart(2, '0')), o: x.o, h: x.h, l: x.l, c: x.c, v: x.v || 1000 }));
}
function doubleTop(opts) {
  opts = opts || {};
  const s = [];
  const push = (h, l, c, v) => s.push({ o: c, h, l, c, v: v || 1000 });
  for (let i = 0; i < 25; i++) push(100.2 + (i % 2) * 0.05, 99.9, 100.0, 1000);   // base for the volume average
  const second = opts.low ? [100.4, 100.5, 100.6, 100.5, 100.45] : [100.7, 101.0, 101.18, 100.9, 100.6];   // the right-hand top: equal, or 0.6% lower
  [100.4, 100.8, 101.2, 101.0, 100.7, 100.5, 100.3, 100.2, 100.4].concat(second).concat([100.5]).forEach((h) => push(h, h - 0.4, h - 0.2, 1000));
  push(100.0, 99.4, 99.5, opts.breakVol || 2500);                                   // close below the neckline (~99.8)
  for (let i = 0; i < 15; i++) push(99.4 - i * 0.05, 98.9 - i * 0.08, 99.0 - i * 0.07, 1200);
  return bars(s.map((x, i) => Object.assign(x, { time: String(9 + Math.floor((15 + i * 5) / 60)).padStart(2, '0') + ':' + String((15 + i * 5) % 60).padStart(2, '0') })));
}

(function main() {
  section('1. pattern engine on a hand-made double top');
  const dt = doubleTop();
  const d1 = P.detect(dt, { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0.5 }, { symbol: 'TEST', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('1.1 one double top found and triggered', d1.signals.length === 1 && d1.signals[0].type === 'double_top' && d1.signals[0].side === 'short', d1.signals.map((x) => x.type));
  const s1 = d1.signals[0] || {};
  ok('1.2 entry is the breakout close, below the neckline', s1.entry === 99.5 && s1.neckline > s1.entry, s1);
  ok('1.3 stop above the entry, target below it', s1.stop > s1.entry && s1.target < s1.entry, s1);
  ok('1.4 the signal comes on the breakout bar, never earlier (no lookahead)', s1.barIndex === 40, s1.barIndex);
  ok('1.5 the two tops are named in the reason', /Double top at/.test(s1.reason) && s1.points.length === 2);
  const lowVol = P.detect(doubleTop({ breakVol: 1100 }), { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0.5 }, { symbol: 'TEST', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('1.6 a breakout on thin volume is skipped, with the reason', lowVol.signals.length === 0 && lowVol.patterns.some((p) => p.status === 'skipped' && /volume/.test(p.note)), lowVol.patterns.map((p) => p.note));
  const uneven = P.detect(doubleTop({ low: true }), { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0.5 }, { symbol: 'TEST', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('1.7 tops 0.6% apart are not a double top at 0.35% tolerance', uneven.signals.length === 0);
  const wide = P.detect(doubleTop({ low: true }), { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0.5, tolerancePct: 0.7 }, { symbol: 'TEST', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('1.8 ...but they are at 0.7% tolerance (settings change the answer)', wide.signals.length === 1);
  const late = doubleTop().map((b) => Object.assign({}, b, { time: b.i >= 40 ? '14:50' : b.time }));
  const dl = P.detect(late, { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0.5 }, { symbol: 'TEST', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('1.9 day mode: no new entries after the 14:45 cut-off', dl.signals.length === 0 && dl.patterns.some((p) => /cut-off/.test(p.note)));
  const longOnly = P.detect(dt, { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0.5, sides: 'long' }, { symbol: 'TEST', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('1.10 "long only" ignores double tops', longOnly.signals.length === 0);
  const mirror = bars(dt.map((b) => ({ day: b.day, time: b.time, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c, v: b.v })));
  const d2 = P.detect(mirror, { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0.5 }, { symbol: 'TEST', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('1.11 the mirror image is a double bottom, long, same bar', d2.signals.length === 1 && d2.signals[0].type === 'double_bottom' && d2.signals[0].side === 'long' && d2.signals[0].barIndex === 40, d2.signals);
  ok('1.12 stop modes: tops > last swing for a short (tighter structural stop)', (() => {
    const a = P.detect(dt, { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0, stop: 'tops' }, { symbol: 'T', market: 'NSE', tick: 0.05, mode: 'day' }).signals[0];
    const b = P.detect(dt, { minDepthPct: 0.3, volumeMult: 1.5, minRR: 0, stop: 'last_swing' }, { symbol: 'T', market: 'NSE', tick: 0.05, mode: 'day' }).signals[0];
    return a && b && a.stop > b.stop;
  })());

  section('2. on the 15 synthetic sessions');
  const rel = P.toBars(sample.bars.RELIANCE);
  ok('2.1 15 sessions x 75 five-minute bars for NSE', rel.length === 1125 && sample.days.length === 15);
  const h60 = P.aggregate(rel, 60);
  ok('2.2 60-minute bars: 7 per NSE session (last one 15:15-15:30)', h60.length === 105 && h60[6].time === '15:15', h60.slice(0, 7).map((b) => b.time));
  ok('2.3 aggregation keeps the high, low, volume and last close', h60[0].h === Math.max(...rel.slice(0, 12).map((b) => b.h)) && h60[0].v === rel.slice(0, 12).reduce((s, b) => s + b.v, 0) && h60[0].c === rel[11].c);
  const det = P.detect(rel, {}, { symbol: 'RELIANCE', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('2.4 every signal is inside one session and before the cut-off', det.signals.every((s) => s.time <= '14:45' && s.points.every((p) => p.day === s.day)), det.signals.map((s) => s.day + ' ' + s.time));
  ok('2.5 every pattern ends with a status and a reason', det.patterns.every((p) => ['triggered', 'cancelled', 'expired', 'skipped', 'open'].includes(p.status) && p.note));
  const cut = P.detect(rel.slice(0, 600), {}, { symbol: 'RELIANCE', market: 'NSE', tick: 0.05, mode: 'day' });
  ok('2.6 no lookahead: signals on the first 600 bars are the same with or without the later bars', JSON.stringify(cut.signals.map((s) => s.id)) === JSON.stringify(det.signals.filter((s) => s.barIndex < 600 - 1).map((s) => s.id)), [cut.signals.map((s) => s.id), det.signals.map((s) => s.id)]);

  section('3. backtest');
  const bt = B.run(sample, { mode: 'day' });
  ok('3.1 runs all 5 symbols over 15 days', bt.symbols.length === 5 && bt.days === 15 && bt.trades.length > 0, bt.stats);
  ok('3.2 stats add up: wins + losses = trades', bt.stats.wins + bt.stats.losses === bt.stats.trades);
  const sumR = Math.round(bt.trades.reduce((s, t) => s + t.r, 0) * 100) / 100;
  ok('3.3 total R equals the sum of the trades', Math.abs(sumR - bt.stats.totalR) < 0.011, [sumR, bt.stats.totalR]);
  ok('3.4 day trades never cross a session', bt.trades.every((t) => t.entryDay === t.exitDay));
  ok('3.5 exits are stop, target, square-off or session end, each named', bt.trades.every((t) => /stop|target|square-off|session end/.test(t.exitReason)));
  ok('3.6 a stop exit loses about 1R or a bit more after costs', bt.trades.filter((t) => t.exitReason === 'stop').every((t) => t.r < -0.9 && t.r > -1.6), bt.trades.filter((t) => t.exitReason === 'stop').map((t) => t.r));
  const bt0 = B.run(sample, { mode: 'day', backtest: { costPct: 0, slippageTicks: 0 } });
  ok('3.7 costs and slippage lower the result', bt0.stats.totalR > bt.stats.totalR, [bt0.stats.totalR, bt.stats.totalR]);
  const btNoVol = B.run(sample, { mode: 'day', pattern: { volumeMult: 0 } });
  ok('3.8 switching off the volume check gives more trades', btNoVol.stats.trades > bt.stats.trades, [btNoVol.stats.trades, bt.stats.trades]);
  const one = B.run(sample, { mode: 'day', symbols: ['SPY'] });
  ok('3.9 one symbol only', one.symbols.join() === 'SPY' && one.trades.every((t) => t.symbol === 'SPY'));
  const sw = B.run(sample, { mode: 'swing', pattern: P.SWING });
  ok('3.10 swing mode runs on 60-minute bars and can hold overnight', sw.mode === 'swing' && sw.patterns > 0 && sw.trades.every((t) => t.bars >= 1), sw.stats);
  ok('3.11 equity curve ends at the total', !bt.stats.curve.length || bt.stats.curve[bt.stats.curve.length - 1].equity === bt.stats.totalR);
  const pf = bt.stats.profitFactor;
  ok('3.12 profit factor = gross wins / gross losses', pf === null || Math.abs(pf - Math.round(bt.trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0) / -bt.trades.filter((t) => t.r <= 0).reduce((s, t) => s + t.r, 0) * 100) / 100) < 0.011);
  const same = B.run(sample, { mode: 'day' });
  ok('3.13 deterministic: same inputs, same result', JSON.stringify(same.stats) === JSON.stringify(bt.stats));

  section('4. router: one signal, three accounts');
  const nseSig = { id: 'RELIANCE-day-2026-11-02-1210-DB', symbol: 'RELIANCE', market: 'NSE', mode: 'day', type: 'double_bottom', side: 'long', day: '2026-11-02', time: '12:10', entry: 1454.75, stop: 1446.5, target: 1462.95 };
  const now = '2026-11-02T12:10:30+05:30';
  const accts = sample.accounts.map((a) => JSON.parse(JSON.stringify(a)));
  const dec = R.route(nseSig, sym('RELIANCE'), accts, {}, now);
  const z = dec.find((d) => d.broker === 'zerodha'), an = dec.find((d) => d.broker === 'angel'), ib = dec.find((d) => d.broker === 'ibkr');
  ok('4.1 an NSE signal goes to Zerodha and Angel One, not IBKR', z.take && an.take && !ib.take && /does not trade NSE/.test(ib.reasons.join()), dec.map((d) => [d.broker, d.take, d.reasons]));
  ok('4.2 Zerodha size: risk allows 303 shares, the 60% exposure cap makes it floor(₹300,000 / ₹1,454.75) = 206', z.size.qty === 206 && z.size.cappedByExposure && z.size.riskAmount <= 2500, z.size);
  ok('4.3 Angel One sizes from its own capital: floor(₹180,000 / ₹1,454.75) = 123', an.size.qty === 123, an.size);
  const free = R.size(Object.assign(acc('zerodha-main'), { maxExposurePct: 100 }), nseSig);
  ok('4.3b with the cap at 100%, risk decides: floor(₹2,500 / ₹8.25) = 303', free.qty === 303 && !free.cappedByExposure, free);
  const ko = z.orders;
  ok('4.4 Kite: LIMIT entry (MIS) + SL-M stop + LIMIT target, tagged', ko.length === 3 && ko[0].form.order_type === 'LIMIT' && ko[0].form.product === 'MIS' && ko[1].form.order_type === 'SL-M' && ko[1].form.trigger_price === 1446.5 && ko[2].form.price === 1462.95 && ko[0].form.tag.length <= 20, ko.map((o) => o.form));
  ok('4.5 Kite: exits are the opposite side', ko[0].form.transaction_type === 'BUY' && ko[1].form.transaction_type === 'SELL' && ko[2].form.transaction_type === 'SELL');
  const ao = an.orders;
  ok('4.6 SmartAPI: symbol token, INTRADAY, string quantities', ao[0].json.symboltoken === '2885' && ao[0].json.tradingsymbol === 'RELIANCE-EQ' && ao[0].json.producttype === 'INTRADAY' && ao[0].json.quantity === '123', ao[0].json);
  ok('4.7 the marketable limit sits 2 ticks above the entry for a buy', ko[0].form.price === 1454.85, ko[0].form.price);
  const usSig = { id: 'SPY-day-2026-11-02-1420-DB', symbol: 'SPY', market: 'US', mode: 'day', type: 'double_bottom', side: 'long', day: '2026-11-02', time: '14:20', entry: 680.08, stop: 678.28, target: 682.81 };
  const dUs = R.route(usSig, sym('SPY'), accts, {}, '2026-11-02T14:20:30-05:00');
  const ibk = dUs.find((d) => d.broker === 'ibkr');
  ok('4.8 a US signal goes to IBKR only', ibk.take && dUs.filter((d) => d.take).length === 1, dUs.map((d) => [d.broker, d.reasons]));
  const br = ibk.orders[0].json.orders;
  ok('4.9 IBKR: one bracket request, parent cOID with two children (STP + LMT)', br.length === 3 && br[0].cOID && br[1].parentId === br[0].cOID && br[2].parentId === br[0].cOID && br[1].orderType === 'STP' && br[2].orderType === 'LMT' && br[1].side === 'SELL', br);
  ok('4.10 IBKR size: risk allows 69, the exposure cap makes it floor($15,000 / $680.08) = 22', br[0].quantity === 22 && ibk.size.cappedByExposure, ibk.size);

  section('5. router: the rules that block an order');
  const noIp = accts.map((a) => Object.assign({}, a, a.broker === 'zerodha' ? { staticIpRegistered: false } : {}));
  ok('5.1 no registered static IP: Zerodha refuses (SEBI rule), Angel One still trades', (() => { const d = R.route(nseSig, sym('RELIANCE'), noIp, {}, now); return !d[0].take && /static IP/.test(d[0].reasons.join()) && d[1].take; })());
  ok('5.2 Kite token issued yesterday is dead after 6 AM IST', !R.sessionOk(acc('zerodha-main'), '2026-11-03T06:05:00+05:30').ok && R.sessionOk(acc('zerodha-main'), '2026-11-03T05:55:00+05:30').ok);
  ok('5.3 a token issued before 6 AM expires at 6 AM the same day', !R.sessionOk(Object.assign(acc('zerodha-main'), { session: { issuedAt: '2026-11-02T05:30:00+05:30' } }), '2026-11-02T07:00:00+05:30').ok);
  ok('5.4 SmartAPI session from yesterday must log in again', !R.sessionOk(acc('angel-main'), '2026-11-03T09:20:00+05:30').ok);
  ok('5.4b a login stamped after the signal does not count', !R.sessionOk(acc('zerodha-main'), '2026-10-30T10:00:00+05:30').ok);
  ok('5.5 kill switch blocks every account', R.route(nseSig, sym('RELIANCE'), accts, { killSwitch: true }, now).every((d) => !d.take && d.reasons.some((x) => /Kill switch/.test(x))));
  ok('5.6 daily loss limit reached: that account stops', (() => { const d = R.route(nseSig, sym('RELIANCE'), accts, { dayLoss: { 'zerodha-main': 7500 } }, now); return !d[0].take && /Daily loss limit/.test(d[0].reasons.join()) && d[1].take; })());
  ok('5.7 max open positions respected', !R.route(nseSig, sym('RELIANCE'), accts, { open: { 'angel-main': 2 } }, now)[1].take);
  const st = R.record({}, dec, nseSig);
  ok('5.8 the same signal never goes in twice', R.route(nseSig, sym('RELIANCE'), accts, st, now).every((d) => !d.take));
  const swShort = Object.assign({}, nseSig, { id: 'x-swing', mode: 'swing', side: 'short', type: 'double_top', entry: 1454.75, stop: 1462.0, target: 1440 });
  ok('5.9 NSE swing short refused: cash equity cannot be held short overnight', R.route(swShort, sym('RELIANCE'), accts, {}, now).filter((d) => d.broker !== 'ibkr').every((d) => !d.take && /short overnight/.test(d.reasons.join())));
  const swLong = Object.assign({}, nseSig, { id: 'x-swing-long', mode: 'swing' });
  const dsw = R.route(swLong, sym('RELIANCE'), accts, {}, now);
  ok('5.10 NSE swing long: CNC entry and a GTT OCO for stop and target', dsw[0].take && dsw[0].orders[0].form.product === 'CNC' && dsw[0].orders[1].url.endsWith('/gtt/triggers') && JSON.parse(dsw[0].orders[1].form.condition).trigger_values.join() === '1446.5,1462.95', dsw[0].orders);
  ok('5.11 after the square-off time no day entries', !R.route(Object.assign({}, nseSig, { id: 'late', time: '15:16' }), sym('RELIANCE'), accts, {}, now)[0].take);
  const tiny = Object.assign(acc('angel-main'), { capital: 1000 });
  ok('5.12 a risk budget smaller than one share is refused with the numbers', (() => { const d = R.route(nseSig, sym('RELIANCE'), [tiny], {}, now)[0]; return !d.take && /less than one share/.test(d.reasons.join()); })());

  section('6. TradingView alerts');
  const pine = T.pine({});
  ok('6.1 the Pine script is v6, sends JSON with alert(), and hides the secret', /^\/\/@version=6/.test(pine) && /alert\(msg, alert\.freq_once_per_bar_close\)/.test(pine) && /display = display\.none/.test(pine));
  ok('6.2 the script carries the engine\'s settings', /input\.int\(3, "Pivot bars each side"/.test(T.pine({ pivot: 3 })) && /input\.float\(0\.5, "Tops within %"/.test(T.pine({ tolerancePct: 0.5 })));
  const det2 = B.runSymbol(sample, sym('AAPL'), 'day', {}, {});
  const sig = det2.signals[0];
  const body = T.examplePayload(sig, 's3cret', sym('AAPL'));
  const seen = {};
  const pr = T.parse(body, { secret: 's3cret', symbols: sample.symbols, cfg: {}, seen });
  ok('6.3 an alert for a backtest signal parses to the same entry, stop, target and time', pr.ok && pr.signal.entry === sig.entry && pr.signal.stop === sig.stop && pr.signal.target === sig.target && pr.signal.time === sig.time && pr.signal.day === sig.day, [pr.signal, sig]);
  ok('6.4 the same alert twice is refused as a duplicate', !T.parse(body, { secret: 's3cret', symbols: sample.symbols, cfg: {}, seen }).ok);
  ok('6.5 wrong secret refused', /secret/.test(T.parse(body, { secret: 'other', symbols: sample.symbols, cfg: {} }).errors.join()));
  ok('6.6 not JSON refused', !T.parse('{bad', { secret: 'x', symbols: [] }).ok);
  const bad = JSON.parse(body); bad.close = bad.extreme + 1;
  ok('6.7 levels that are not a double top refused', /Levels do not make a double top/.test(T.parse(JSON.stringify(bad), { secret: 's3cret', symbols: sample.symbols, cfg: {} }).errors.join()));
  const unk = JSON.parse(body); unk.symbol = 'TSLA'; unk.id = 'u1';
  ok('6.8 symbol not on the watchlist refused', /not on the watchlist/.test(T.parse(JSON.stringify(unk), { secret: 's3cret', symbols: sample.symbols, cfg: {} }).errors.join()));
  const old = JSON.parse(body); old.id = 'old1';
  ok('6.9 a stale alert (TradingView delivered it late) is refused', /too late/.test(T.parse(JSON.stringify(old), { secret: 's3cret', symbols: sample.symbols, cfg: {}, nowMs: old.time + 20 * 60e3, maxAgeMs: 10 * 60e3 }).errors.join()));
  const loggedIn = accts.map((a) => Object.assign({}, a, { session: Object.assign({}, a.session, { issuedAt: pr.signal.day + 'T08:30:00-04:00' }) }));   // the morning login of that day
  const routed = R.route(pr.signal, sym('AAPL'), loggedIn, {}, pr.signal.day + 'T' + pr.signal.time + ':30-04:00');
  ok('6.10 a TradingView alert is routed by the same router', routed.find((d) => d.broker === 'ibkr').take);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
