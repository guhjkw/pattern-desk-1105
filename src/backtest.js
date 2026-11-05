/* Backtest: plays the 15 days of bars forward, takes every signal PatternEngine gives, and manages
   the trade on the bars that follow: stop, target, the intraday square-off (day mode) or a maximum
   hold (swing mode). One open trade per symbol at a time. Costs and slippage are charged on both sides.
   If a bar touches both the stop and the target, the stop is assumed to come first (the cautious read). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./patterns.js'));
  else root.Backtest = factory(root.PatternEngine);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  var DEFAULTS = {
    costPct: 0.03,          // per side, % of price (brokerage, exchange and tax charges as one figure; tune per broker)
    slippageTicks: 1,       // per side
    squareOff: { NSE: '15:15', US: '15:50' },   // day mode: flat by this bar's close
    maxHoldBars: 35,        // swing mode: about 5 sessions of 60-minute bars
    swingMinutes: 60
  };
  function cfgOf(over) { var c = {}, k; for (k in DEFAULTS) c[k] = DEFAULTS[k]; if (over) for (k in over) if (over[k] !== undefined) c[k] = over[k]; return c; }
  function r2(x) { return Math.round(x * 100) / 100; }

  /* Bars for a symbol in the chosen mode */
  function barsFor(sample, symbol, mode, minutes) {
    var b = P.toBars(sample.bars[symbol]);
    return mode === 'swing' ? P.aggregate(b, minutes || 60) : b;
  }

  /* Simulates one symbol. Returns { trades, signals, detection } */
  function runSymbol(sample, sym, mode, patCfg, btCfg) {
    var c = cfgOf(btCfg);
    var bars = barsFor(sample, sym.symbol, mode, c.swingMinutes);
    var det = P.detect(bars, patCfg, { symbol: sym.symbol, market: sym.market, tick: sym.tick, mode: mode });
    var trades = [], busyUntil = -1, slip = c.slippageTicks * sym.tick;
    det.signals.forEach(function (s) {
      if (s.barIndex <= busyUntil) { s.skipped = 'already in a trade on ' + sym.symbol; return; }
      var long = s.side === 'long', dir = long ? 1 : -1;
      var entry = s.entry + dir * slip, risk = Math.abs(entry - s.stop);
      if (risk <= 0) { s.skipped = 'no room for a stop'; return; }
      var exit = null, why = null, t;
      for (t = s.barIndex + 1; t < bars.length; t++) {
        var b = bars[t];
        if (mode === 'day' && b.day !== s.day) { t--; exit = bars[t].c; why = 'session end'; break; }
        var hitStop = long ? b.l <= s.stop : b.h >= s.stop;
        var hitTarget = long ? b.h >= s.target : b.l <= s.target;
        if (hitStop) { exit = long ? Math.min(s.stop, b.o) : Math.max(s.stop, b.o); why = hitTarget ? 'stop (stop and target in one bar, stop counted)' : 'stop'; break; }
        if (hitTarget) { exit = long ? Math.max(s.target, b.o) : Math.min(s.target, b.o); why = 'target'; break; }
        if (mode === 'day' && b.time >= (c.squareOff[sym.market] || '23:59')) { exit = b.c; why = 'square-off ' + b.time; break; }
        if (mode === 'swing' && t - s.barIndex >= c.maxHoldBars) { exit = b.c; why = 'max hold'; break; }
      }
      if (exit === null) { t = bars.length - 1; exit = bars[t].c; why = 'end of data'; }
      exit = exit - dir * slip;
      var gross = (exit - entry) * dir;
      var costs = (entry + exit) * c.costPct / 100;
      var net = gross - costs;
      trades.push({ id: s.id, symbol: sym.symbol, market: sym.market, currency: sym.currency, mode: mode, type: s.type, side: s.side,
        entryDay: s.day, entryTime: s.time, exitDay: bars[t].day, exitTime: bars[t].time, entry: r2(entry), stop: s.stop, target: s.target, exit: r2(exit),
        exitReason: why, perShare: r2(net), costsPerShare: r2(costs), r: r2(net / risk), riskPerShare: r2(risk), bars: t - s.barIndex });
      busyUntil = t;
    });
    return { trades: trades, signals: det.signals, detection: det, bars: bars };
  }

  function stats(trades) {
    var n = trades.length, wins = trades.filter(function (t) { return t.r > 0; });
    var sumPos = 0, sumNeg = 0, eq = 0, peak = 0, dd = 0, curve = [];
    trades.slice().sort(function (a, b) { return (a.entryDay + a.entryTime) < (b.entryDay + b.entryTime) ? -1 : 1; }).forEach(function (t) {
      if (t.r > 0) sumPos += t.r; else sumNeg += t.r;
      eq += t.r; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak);
      curve.push({ day: t.entryDay, time: t.entryTime, symbol: t.symbol, r: t.r, equity: r2(eq) });
    });
    return { trades: n, wins: wins.length, losses: n - wins.length, winRate: n ? r2(wins.length / n * 100) : 0, totalR: r2(eq), avgR: n ? r2(eq / n) : 0,
      profitFactor: sumNeg ? r2(sumPos / -sumNeg) : (sumPos ? null : 0), maxDrawdownR: r2(dd), avgWinR: wins.length ? r2(sumPos / wins.length) : 0,
      avgLossR: n - wins.length ? r2(sumNeg / (n - wins.length)) : 0, curve: curve };
  }

  /* All symbols. opts: { mode, symbols: [..] (default all), pattern: {...}, backtest: {...} } */
  function run(sample, opts) {
    opts = opts || {};
    var mode = opts.mode || 'day';
    var syms = sample.symbols.filter(function (s) { return !opts.symbols || !opts.symbols.length || opts.symbols.indexOf(s.symbol) >= 0; });
    var per = {}, all = [], signals = [], patterns = 0;
    syms.forEach(function (s) {
      var r = runSymbol(sample, s, mode, opts.pattern, opts.backtest);
      per[s.symbol] = { trades: r.trades, stats: stats(r.trades), signals: r.signals.length, patterns: r.detection.patterns.length };
      all = all.concat(r.trades); signals = signals.concat(r.signals); patterns += r.detection.patterns.length;
    });
    var byType = {};
    ['double_top', 'double_bottom'].forEach(function (k) { byType[k] = stats(all.filter(function (t) { return t.type === k; })); });
    return { mode: mode, days: sample.days.length, from: sample.days[0], to: sample.days[sample.days.length - 1], symbols: syms.map(function (s) { return s.symbol; }),
      patterns: patterns, signals: signals.length, trades: all.sort(function (a, b) { return (a.entryDay + a.entryTime) < (b.entryDay + b.entryTime) ? -1 : 1; }),
      stats: stats(all), perSymbol: per, byType: byType };
  }

  return { DEFAULTS: DEFAULTS, cfgOf: cfgOf, barsFor: barsFor, runSymbol: runSymbol, stats: stats, run: run };
});
