/* Router: one signal in, one decision per account out.

   For every connected account (Zerodha, Angel One, Interactive Brokers) it decides whether the
   account takes the trade and why not if it doesn't, sizes it from the account's own capital and
   risk %, and builds the exact order requests for that broker's API: entry plus a protective stop
   and a target. In paper mode (the default) the requests are built and logged, never sent.

   Rules that come from the brokers and the regulator, not from the strategy:
   - Zerodha and Angel One only accept API orders from a registered static IP (SEBI's retail algo
     framework, in force since 1 April 2026).
   - A Kite Connect access token expires at 6 AM IST the next day, so each account logs in every morning.
   - Indian cash equity can't be sold short overnight: a swing double top on NSE is skipped for
     CNC/DELIVERY accounts (it would need futures).
   - Kite has no bracket orders, so the stop and target go in as separate orders (SL-M + LIMIT for
     intraday, a GTT OCO for delivery). IBKR takes a native bracket (parent + children). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Router = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MARKET_HOURS = { NSE: { open: '09:15', close: '15:30', tz: '+05:30' }, US: { open: '09:30', close: '16:00', tz: '-04:00' } };

  function r2(x) { return Math.round(x * 100) / 100; }
  function money(n, ccy) { var s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return (n < 0 ? '-' : '') + (ccy === 'INR' ? '₹' : '$') + s; }
  function tag(signal) { return ('pd' + signal.id.replace(/[^A-Za-z0-9]/g, '')).slice(-20); }   // Kite: alphanumeric, max 20

  /* Is the broker session usable at `nowIso`? */
  function sessionOk(account, nowIso) {
    var s = account.session || {};
    if (!s.issuedAt) return { ok: false, reason: 'Not logged in today' };
    var issued = Date.parse(s.issuedAt), now = Date.parse(nowIso);
    if (issued > now) return { ok: false, reason: 'Not logged in yet for this session (the login on file is from later)' };
    if (account.broker === 'zerodha') {
      // valid until 06:00 IST the day after it was issued
      var d = new Date(issued + 5.5 * 3600e3); // IST wall clock
      var expiry = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (d.getUTCHours() >= 6 ? 1 : 0), 6, 0, 0) - 5.5 * 3600e3;
      return now < expiry ? { ok: true, expires: new Date(expiry).toISOString() } : { ok: false, reason: 'Kite access token expired at 6 AM IST; log in again' };
    }
    if (account.broker === 'angel') {
      var di = new Date(issued + 5.5 * 3600e3), dn = new Date(now + 5.5 * 3600e3);
      return di.toISOString().slice(0, 10) === dn.toISOString().slice(0, 10) ? { ok: true } : { ok: false, reason: 'SmartAPI session is from another day; log in again with TOTP' };
    }
    if (account.broker === 'ibkr') {
      if (s.authenticated === false) return { ok: false, reason: 'IBKR gateway session is not authenticated' };
      return now - issued < 24 * 3600e3 ? { ok: true } : { ok: false, reason: 'IBKR gateway session needs a daily re-login' };
    }
    return { ok: false, reason: 'Unknown broker' };
  }

  /* Quantity from the account's capital, risk % and exposure cap */
  function size(account, signal) {
    var riskPerShare = Math.abs(signal.entry - signal.stop);
    if (!(riskPerShare > 0)) return { qty: 0, why: 'no distance between entry and stop' };
    var riskBudget = account.capital * account.riskPct / 100;
    var byRisk = Math.floor(riskBudget / riskPerShare);
    var byExposure = Math.floor(account.capital * (account.maxExposurePct || 100) / 100 / signal.entry);
    var qty = Math.max(0, Math.min(byRisk, byExposure));
    return { qty: qty, riskBudget: r2(riskBudget), riskAmount: r2(qty * riskPerShare), positionValue: r2(qty * signal.entry), cappedByExposure: byExposure < byRisk, riskPerShare: r2(riskPerShare) };
  }

  /* Every reason this account must not take this signal. state: { killSwitch, open: {accountId: n}, dayLoss: {accountId: amount}, routed: {key: true} } */
  function checks(account, signal, symbol, state, nowIso) {
    var why = [];
    state = state || {};
    if (!account.enabled) why.push('Account is switched off');
    if (state.killSwitch) why.push('Kill switch is on: no new orders anywhere');
    if (account.markets.indexOf(symbol.market) < 0) why.push(account.label + ' does not trade ' + symbol.market + ' (' + symbol.symbol + ')');
    if (!symbol.brokers || !symbol.brokers[account.broker]) why.push('No ' + account.broker + ' instrument mapping for ' + symbol.symbol);
    if (account.markets.indexOf(symbol.market) >= 0) {
      if ((account.broker === 'zerodha' || account.broker === 'angel') && !account.staticIpRegistered) why.push('SEBI rule: API orders must come from a registered static IP, and none is registered for this account');
      var ses = sessionOk(account, nowIso);
      if (!ses.ok) why.push(ses.reason);
      if (signal.mode === 'swing' && signal.side === 'short' && symbol.market === 'NSE') why.push('Indian cash equity can\'t be held short overnight (' + account.productSwing + '); a swing double top needs futures');
      var mh = MARKET_HOURS[symbol.market];
      if (mh && (signal.time < mh.open || signal.time >= mh.close)) why.push('Signal at ' + signal.time + ' is outside ' + symbol.market + ' market hours');
      if (signal.mode === 'day' && account.squareOff && signal.time >= account.squareOff) why.push('Signal at ' + signal.time + ' is after this account\'s ' + account.squareOff + ' square-off');
      var open = (state.open && state.open[account.id]) || 0;
      if (open >= account.maxOpen) why.push('Already ' + open + ' open positions (limit ' + account.maxOpen + ')');
      var lost = (state.dayLoss && state.dayLoss[account.id]) || 0, limit = account.capital * account.dailyLossPct / 100;
      if (lost >= limit) why.push('Daily loss limit reached (' + money(lost, account.currency) + ' of ' + money(limit, account.currency) + ')');
      if (state.routed && state.routed[account.id + '|' + signal.id]) why.push('Already routed: the same signal never goes in twice');
    }
    return why;
  }

  /* The exact requests for each broker (secrets shown as placeholders) */
  function orders(account, signal, symbol, qty) {
    var long = signal.side === 'long', buy = long ? 'BUY' : 'SELL', sell = long ? 'SELL' : 'BUY';
    var day = signal.mode === 'day', m = symbol.brokers[account.broker], tick = symbol.tick || 0.05;
    var limit = r2(Math.round((signal.entry + (long ? 2 : -2) * tick) / tick) * tick);   // marketable limit, 2 ticks of room
    var t = tag(signal);
    if (account.broker === 'zerodha') {
      var product = day ? account.productDay : account.productSwing;
      var base = { tradingsymbol: m.tradingsymbol, exchange: 'NSE', quantity: qty, product: product, validity: 'DAY', tag: t };
      var list = [{ label: 'Entry', method: 'POST', url: 'https://api.kite.trade/orders/regular', headers: { 'X-Kite-Version': '3', Authorization: 'token <api_key>:<access_token>' },
        form: Object.assign({ transaction_type: buy, order_type: 'LIMIT', price: limit }, base) }];
      if (day) {
        list.push({ label: 'Stop (after the entry fills)', method: 'POST', url: 'https://api.kite.trade/orders/regular', headers: { 'X-Kite-Version': '3', Authorization: 'token <api_key>:<access_token>' },
          form: Object.assign({ transaction_type: sell, order_type: 'SL-M', trigger_price: signal.stop }, base) });
        list.push({ label: 'Target (after the entry fills; the engine cancels the other leg when one fills)', method: 'POST', url: 'https://api.kite.trade/orders/regular', headers: { 'X-Kite-Version': '3', Authorization: 'token <api_key>:<access_token>' },
          form: Object.assign({ transaction_type: sell, order_type: 'LIMIT', price: signal.target }, base) });
      } else {
        list.push({ label: 'Stop and target as one GTT OCO (after the entry fills)', method: 'POST', url: 'https://api.kite.trade/gtt/triggers', headers: { 'X-Kite-Version': '3', Authorization: 'token <api_key>:<access_token>' },
          form: { type: 'two-leg', condition: JSON.stringify({ exchange: 'NSE', tradingsymbol: m.tradingsymbol, trigger_values: [signal.stop, signal.target], last_price: signal.entry }),
            orders: JSON.stringify([{ exchange: 'NSE', tradingsymbol: m.tradingsymbol, transaction_type: sell, quantity: qty, order_type: 'LIMIT', product: product, price: signal.stop },
              { exchange: 'NSE', tradingsymbol: m.tradingsymbol, transaction_type: sell, quantity: qty, order_type: 'LIMIT', product: product, price: signal.target }]) } });
      }
      return list;
    }
    if (account.broker === 'angel') {
      var pt = day ? account.productDay : account.productSwing;
      var h = { Authorization: 'Bearer <jwt from loginByPassword + TOTP>', 'X-PrivateKey': '<api_key>', 'X-UserType': 'USER', 'X-SourceID': 'WEB',
        'X-ClientLocalIP': '<server ip>', 'X-ClientPublicIP': '<registered static ip>', 'X-MACAddress': '<server mac>', 'Content-Type': 'application/json', Accept: 'application/json' };
      var url = 'https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/placeOrder';
      var b = { tradingsymbol: m.tradingsymbol, symboltoken: m.symboltoken, exchange: 'NSE', producttype: pt, duration: 'DAY', quantity: String(qty), ordertag: t };
      return [
        { label: 'Entry', method: 'POST', url: url, headers: h, json: Object.assign({ variety: 'NORMAL', transactiontype: buy, ordertype: 'LIMIT', price: String(limit), squareoff: '0', stoploss: '0' }, b) },
        { label: 'Stop (after the entry fills; values checked against your SmartAPI account in milestone 3)', method: 'POST', url: url, headers: h, json: Object.assign({ variety: 'STOPLOSS', transactiontype: sell, ordertype: 'STOPLOSS_MARKET', triggerprice: String(signal.stop), price: '0' }, b) },
        { label: 'Target (after the entry fills)', method: 'POST', url: url, headers: h, json: Object.assign({ variety: 'NORMAL', transactiontype: sell, ordertype: 'LIMIT', price: String(signal.target) }, b) }
      ];
    }
    if (account.broker === 'ibkr') {
      var acct = (account.session && account.session.accountId) || '<accountId>', tif = day ? account.productDay : account.productSwing;
      return [{ label: 'Bracket: entry with stop and target children (one request; answer any confirmation via /iserver/reply/{replyId})', method: 'POST',
        url: 'https://localhost:5000/v1/api/iserver/account/' + acct + '/orders', headers: { 'Content-Type': 'application/json' },
        json: { orders: [
          { acctId: acct, conid: m.conid, cOID: t, orderType: 'LMT', side: buy, price: limit, quantity: qty, tif: tif },
          { acctId: acct, conid: m.conid, parentId: t, orderType: 'STP', side: sell, price: signal.stop, quantity: qty, tif: tif },
          { acctId: acct, conid: m.conid, parentId: t, orderType: 'LMT', side: sell, price: signal.target, quantity: qty, tif: tif }
        ] } }];
    }
    return [];
  }

  /* signal + symbol + accounts -> [{ account, take, reasons, size, orders }] */
  function route(signal, symbol, accounts, state, nowIso) {
    return accounts.map(function (acc) {
      var reasons = checks(acc, signal, symbol, state, nowIso);
      var sz = null, list = [];
      if (!reasons.length) {
        sz = size(acc, signal);
        if (sz.qty < 1) reasons.push('Risk budget ' + money(sz.riskBudget || 0, acc.currency) + ' is less than one share of risk (' + money(sz.riskPerShare || 0, acc.currency) + ')');
        else list = orders(acc, signal, symbol, sz.qty);
      }
      return { account: acc.id, label: acc.label, broker: acc.broker, currency: acc.currency, take: !reasons.length, reasons: reasons, size: sz, orders: list };
    });
  }

  /* Records a routed signal in the paper state (open positions and the never-twice guard) */
  function record(state, decisions, signal) {
    state.open = state.open || {}; state.routed = state.routed || {};
    decisions.forEach(function (d) { if (d.take) { state.open[d.account] = (state.open[d.account] || 0) + 1; state.routed[d.account + '|' + signal.id] = true; } });
    return state;
  }

  return { MARKET_HOURS: MARKET_HOURS, sessionOk: sessionOk, size: size, checks: checks, orders: orders, route: route, record: record, money: money, tag: tag };
});
