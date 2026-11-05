/* PatternEngine: finds double tops and double bottoms bar by bar, with no lookahead.

   A swing high (or low) is only known `pivot` bars after it happens, so the engine waits for that
   confirmation exactly as it would live. Once the second top is confirmed, the pattern "arms":
   a close through the neckline (with a volume check) inside `maxBarsToBreak` bars is the signal;
   a close beyond the tops first cancels it.

   Day mode works on 5-minute bars inside one session (nothing carries overnight, no entries after
   the cut-off). Swing mode works on 60-minute bars across sessions.
   The same file runs in the browser page, the node tests and the server. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PatternEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    pivot: 3,              // bars on each side that make a swing high or low
    tolerancePct: 0.35,    // the two tops (or bottoms) must be within this % of each other
    minGap: 6,             // bars between the two tops, at least...
    maxGap: 40,            // ...and at most
    minDepthPct: 0.35,     // the neckline must sit at least this % away from the tops
    maxBarsToBreak: 18,    // the neckline must break within this many bars after the 2nd top is confirmed
    volumeMult: 1.2,       // breakout bar volume vs the 20-bar average (0 turns the check off)
    stop: 'last_swing',    // 'last_swing' = beyond the highest high (lowest low) between the 2nd top and the break;
                           // 'tops' = beyond the higher top (lower bottom); 'mid' = halfway between neckline and tops
    stopBufferPct: 0.05,   // extra room beyond the stop level, in %
    target: 'measured',    // 'measured' = pattern height projected from the neckline; 'r' = targetR x risk
    targetMult: 1.0,
    targetR: 2,
    minRR: 1.0,            // skip signals with less reward than this x risk
    cutoff: { NSE: '14:45', US: '15:15' },   // day mode: no new entries after this time
    sides: 'both'          // 'both', 'long' (bottoms only) or 'short' (tops only)
  };

  // swing mode starts from wider settings, because 60-minute bars are fewer and bigger
  var SWING = { pivot: 2, minGap: 4, maxGap: 30, maxBarsToBreak: 12, minDepthPct: 0.8, tolerancePct: 0.6, volumeMult: 0 };   // hourly volume swings with the time of day, so the volume check starts off

  function cfgOf(over) {
    var c = {}, k;
    for (k in DEFAULTS) c[k] = DEFAULTS[k];
    if (over) for (k in over) if (over[k] !== undefined && over[k] !== null && over[k] !== '') c[k] = over[k];
    return c;
  }
  function roundTick(x, tick) { var t = tick || 0.01; return Math.round(Math.round(x / t) * t * 100) / 100; }

  /* rows [[day, time, o, h, l, c, v], ...] -> bar objects */
  function toBars(rows) {
    return rows.map(function (r, i) { return { i: i, day: r[0], time: r[1], o: r[2], h: r[3], l: r[4], c: r[5], v: r[6] }; });
  }

  /* 5-minute bars -> N-minute bars, anchored at each session's first bar (09:15 or 09:30) */
  function aggregate(bars, minutes) {
    var out = [], cur = null, startMin = null, day = null;
    function mins(t) { var p = t.split(':'); return +p[0] * 60 + +p[1]; }
    bars.forEach(function (b) {
      if (b.day !== day) { day = b.day; startMin = mins(b.time); cur = null; }
      var bucket = Math.floor((mins(b.time) - startMin) / minutes);
      if (!cur || cur.bucket !== bucket || cur.day !== b.day) {
        cur = { day: b.day, time: b.time, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, bucket: bucket };
        out.push(cur);
      } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
    });
    return out.map(function (b, i) { return { i: i, day: b.day, time: b.time, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; });
  }

  /* Swing highs and lows, each stamped with the bar at which it became known. */
  function pivots(bars, k, sameDay) {
    var highs = [], lows = [];
    for (var p = k; p < bars.length - k; p++) {
      var isH = true, isL = true;
      for (var j = p - k; j <= p + k; j++) {
        if (j === p) continue;
        if (sameDay && bars[j].day !== bars[p].day) { isH = false; isL = false; break; }
        if (bars[j].h >= bars[p].h && (j > p || bars[j].h > bars[p].h)) isH = false;
        if (bars[j].l <= bars[p].l && (j > p || bars[j].l < bars[p].l)) isL = false;
      }
      if (isH) highs.push({ i: p, price: bars[p].h, known: p + k });
      if (isL) lows.push({ i: p, price: bars[p].l, known: p + k });
    }
    return { highs: highs, lows: lows };
  }

  function avgVol(bars, t, n) {
    var s = 0, c = 0;
    for (var j = Math.max(0, t - n); j < t; j++) { s += bars[j].v; c++; }
    return c ? s / c : 0;
  }
  function hhmm(t) { return t; }

  /* opts: { symbol, market, tick, mode: 'day'|'swing' } -> { pivots, patterns, signals } */
  function detect(bars, over, opts) {
    var cfg = cfgOf(over), mode = opts.mode || 'day', sameDay = mode === 'day';
    var k = Math.max(1, Math.floor(cfg.pivot));
    var pv = pivots(bars, k, sameDay);
    var patterns = [], signals = [], armed = [];
    var usedTop = {}, usedBottom = {};
    var cutoff = mode === 'day' ? (cfg.cutoff[opts.market] || '23:59') : null;
    var tick = opts.tick || 0.01;
    var hiIdx = 0, loIdx = 0, knownHighs = [], knownLows = [];

    for (var t = 0; t < bars.length; t++) {
      var b = bars[t];
      // 1. pivots that become known on this bar
      while (hiIdx < pv.highs.length && pv.highs[hiIdx].known === t) { knownHighs.push(pv.highs[hiIdx]); tryForm('top', pv.highs[hiIdx], t); hiIdx++; }
      while (loIdx < pv.lows.length && pv.lows[loIdx].known === t) { knownLows.push(pv.lows[loIdx]); tryForm('bottom', pv.lows[loIdx], t); loIdx++; }
      // 2. armed patterns: break, cancel or expire on this bar's close
      for (var a = armed.length - 1; a >= 0; a--) {
        var P = armed[a];
        if (t <= P.armedAt) continue;
        var top = P.type === 'double_top';
        if (sameDay && b.day !== bars[P.p2.i].day) { finish(P, 'expired', 'session ended before the neckline broke', t); armed.splice(a, 1); continue; }
        if (top ? b.c > P.extreme : b.c < P.extreme) { finish(P, 'cancelled', 'price closed ' + (top ? 'above the tops' : 'below the bottoms') + ' first', t); armed.splice(a, 1); continue; }
        if (top ? b.c < P.neckline : b.c > P.neckline) {
          var av = avgVol(bars, t, 20), vr = av ? b.v / av : 0;
          var why = null;
          if (cfg.volumeMult > 0 && vr < cfg.volumeMult) why = 'breakout volume ' + vr.toFixed(2) + 'x is under ' + cfg.volumeMult + 'x';
          if (!why && cutoff && b.time > cutoff) why = 'breakout at ' + b.time + ' is after the ' + cutoff + ' cut-off';
          var entry = b.c, level;
          if (cfg.stop === 'tops') level = P.extreme;
          else if (cfg.stop === 'mid') level = (P.extreme + P.neckline) / 2;
          else { level = top ? -Infinity : Infinity; for (var q2 = P.p2.i + 1; q2 < t; q2++) level = top ? Math.max(level, bars[q2].h) : Math.min(level, bars[q2].l); if (!isFinite(level)) level = P.extreme; }
          var stop = top ? level * (1 + cfg.stopBufferPct / 100) : level * (1 - cfg.stopBufferPct / 100);
          if (top ? stop <= entry : stop >= entry) stop = top ? P.extreme * (1 + cfg.stopBufferPct / 100) : P.extreme * (1 - cfg.stopBufferPct / 100);
          var risk = Math.abs(stop - entry);
          var target = cfg.target === 'r' ? (top ? entry - cfg.targetR * risk : entry + cfg.targetR * risk)
            : (top ? P.neckline - P.height * cfg.targetMult : P.neckline + P.height * cfg.targetMult);
          var rr = risk > 0 ? Math.abs(target - entry) / risk : 0;
          if (!why && rr < cfg.minRR) why = 'reward is ' + rr.toFixed(2) + 'x risk, under the ' + cfg.minRR + 'x minimum';
          if (why) { finish(P, 'skipped', why, t); armed.splice(a, 1); continue; }
          var sig = {
            id: (opts.symbol || 'X') + '-' + mode + '-' + b.day + '-' + b.time.replace(':', '') + '-' + (top ? 'DT' : 'DB'),
            symbol: opts.symbol, market: opts.market, mode: mode, type: P.type, side: top ? 'short' : 'long',
            day: b.day, time: b.time, barIndex: t,
            entry: roundTick(entry, tick), stop: roundTick(stop, tick), target: roundTick(target, tick), rr: Math.round(rr * 100) / 100, stopLevel: level,
            neckline: roundTick(P.neckline, tick), height: roundTick(P.height, tick), volumeRatio: Math.round(vr * 100) / 100,
            points: [{ i: P.p1.i, price: P.p1.price, day: bars[P.p1.i].day, time: bars[P.p1.i].time }, { i: P.p2.i, price: P.p2.price, day: bars[P.p2.i].day, time: bars[P.p2.i].time }],
            neckIndex: P.neckIdx,
            reason: (top ? 'Double top' : 'Double bottom') + ' at ' + roundTick(P.p1.price, tick) + ' / ' + roundTick(P.p2.price, tick) + ', ' + (top ? 'close below' : 'close above') + ' the neckline ' + roundTick(P.neckline, tick) + ' on ' + vr.toFixed(1) + 'x volume'
          };
          if (signals.some(function (x) { return x.id === sig.id; })) { finish(P, 'skipped', 'same breakout bar as another ' + P.type.replace('_', ' '), t); armed.splice(a, 1); continue; }
          signals.push(sig); P.signal = sig.id;
          finish(P, 'triggered', 'neckline broke at ' + b.time, t); armed.splice(a, 1); continue;
        }
        if (t - P.armedAt > cfg.maxBarsToBreak) { finish(P, 'expired', 'no break within ' + cfg.maxBarsToBreak + ' bars', t); armed.splice(a, 1); }
      }
    }
    armed.forEach(function (P) { finish(P, 'open', 'still waiting for the neckline at the end of the data', bars.length - 1); });
    return { pivots: pv, patterns: patterns, signals: signals, cfg: cfg };

    function finish(P, status, note, t) { P.status = status; P.note = note; P.endedAt = t; }

    function tryForm(kind, p2, t) {
      var top = kind === 'top';
      if (cfg.sides === 'long' && top) return;
      if (cfg.sides === 'short' && !top) return;
      var used = top ? usedTop : usedBottom;
      if (used[p2.i]) return;
      var list = top ? knownHighs : knownLows, best = null;
      for (var q = list.length - 2; q >= 0; q--) {
        var p1 = list[q], gap = p2.i - p1.i;
        if (gap < cfg.minGap) continue;
        if (gap > cfg.maxGap) break;
        if (used[p1.i]) continue;
        if (sameDay && bars[p1.i].day !== bars[p2.i].day) continue;
        var diffPct = Math.abs(p2.price - p1.price) / p1.price * 100;
        if (diffPct > cfg.tolerancePct) continue;
        var extreme = top ? Math.max(p1.price, p2.price) : Math.min(p1.price, p2.price);
        // nothing between the two may poke past them, and the neckline is the opposite extreme between them
        var neck = top ? Infinity : -Infinity, neckIdx = -1, poke = false;
        for (var j = p1.i + 1; j < p2.i; j++) {
          if (top ? bars[j].h > extreme : bars[j].l < extreme) { poke = true; break; }
          if (top ? bars[j].l < neck : bars[j].h > neck) { neck = top ? bars[j].l : bars[j].h; neckIdx = j; }
        }
        if (poke || neckIdx < 0) continue;
        var depthPct = Math.abs(extreme - neck) / extreme * 100;
        if (depthPct < cfg.minDepthPct) continue;
        // the price must not already be through the neckline when the pattern becomes known
        var nowC = bars[t].c;
        if (top ? nowC < neck : nowC > neck) continue;
        var cand = { p1: p1, p2: p2, diffPct: diffPct, extreme: extreme, neckline: neck, neckIdx: neckIdx, height: Math.abs(extreme - neck) };
        if (!best || cand.diffPct < best.diffPct) best = cand;
      }
      if (!best) return;
      used[best.p1.i] = used[best.p2.i] = 1;
      var P = { type: top ? 'double_top' : 'double_bottom', p1: best.p1, p2: best.p2, extreme: best.extreme, neckline: best.neckline, neckIdx: best.neckIdx,
        height: best.height, diffPct: Math.round(best.diffPct * 1000) / 1000, armedAt: t, day: bars[best.p2.i].day, status: 'armed' };
      patterns.push(P); armed.push(P);
    }
  }

  function defaultsFor(mode) { var c = cfgOf(null); if (mode === 'swing') for (var k in SWING) c[k] = SWING[k]; return c; }

  return { DEFAULTS: DEFAULTS, SWING: SWING, defaultsFor: defaultsFor, cfgOf: cfgOf, toBars: toBars, aggregate: aggregate, pivots: pivots, detect: detect, roundTick: roundTick };
});
