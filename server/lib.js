'use strict';
/* Server helpers: TOTP for the SmartAPI morning login, the Kite login checksum, credential
   substitution into the router's order requests, and sending them. */
const crypto = require('crypto');

/* RFC 6238 TOTP (SHA-1, 30 s, 6 digits): what the authenticator app shows for a base32 secret. */
function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = '';
  for (const ch of clean) { const v = alpha.indexOf(ch); if (v < 0) throw new Error('Not a base32 secret'); bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secretBase32, timeMs, digits = 6, step = 30) {
  const counter = Math.floor((timeMs === undefined ? Date.now() : timeMs) / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/* Kite Connect: exchanging the morning request_token needs sha256(api_key + request_token + api_secret). */
function kiteChecksum(apiKey, requestToken, apiSecret) { return crypto.createHash('sha256').update(apiKey + requestToken + apiSecret).digest('hex'); }

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Fills the router's placeholders with the account's live credentials and points it at baseUrl (tests). */
function materialize(order, creds, baseUrl) {
  const fill = (v) => typeof v === 'string' ? v
    .replace('<api_key>:<access_token>', (creds.apiKey || '') + ':' + (creds.accessToken || ''))
    .replace('Bearer <jwt from loginByPassword + TOTP>', 'Bearer ' + (creds.jwt || ''))
    .replace('<api_key>', creds.apiKey || '').replace('<server ip>', creds.localIp || '').replace('<registered static ip>', creds.publicIp || '')
    .replace('<server mac>', creds.mac || '') : v;
  const headers = {};
  Object.keys(order.headers || {}).forEach((k) => { headers[k] = fill(order.headers[k]); });
  let url = order.url;
  if (baseUrl) url = url.replace(/^https:\/\/[^/]+/, baseUrl);
  return { method: order.method, url, headers, form: order.form, json: order.json };
}

async function send(req, fetchImpl) {
  const f = fetchImpl || fetch;
  const opts = { method: req.method, headers: Object.assign({}, req.headers) };
  if (req.form) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(Object.entries(req.form).map(([k, v]) => [k, String(v)])).toString(); }
  else if (req.json) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(req.json); }
  const res = await f(req.url, opts);
  let body = null; try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, ok: res.ok, body };
}

/* Morning logins (run by the scheduler before the open). Credentials come from the secret store. */
const login = {
  kiteUrl: (apiKey) => 'https://kite.zerodha.com/connect/login?v=3&api_key=' + encodeURIComponent(apiKey),
  kiteSession: (apiKey, requestToken, apiSecret, base) => ({ method: 'POST', url: (base || 'https://api.kite.trade') + '/session/token', headers: { 'X-Kite-Version': '3' },
    form: { api_key: apiKey, request_token: requestToken, checksum: kiteChecksum(apiKey, requestToken, apiSecret) } }),
  angelSession: (c, nowMs, base) => ({ method: 'POST', url: (base || 'https://apiconnect.angelone.in') + '/rest/auth/angelbroking/user/v1/loginByPassword',
    headers: { 'X-PrivateKey': c.apiKey, 'X-UserType': 'USER', 'X-SourceID': 'WEB', 'X-ClientLocalIP': c.localIp, 'X-ClientPublicIP': c.publicIp, 'X-MACAddress': c.mac, Accept: 'application/json' },
    json: { clientcode: c.clientCode, password: c.pin, totp: totp(c.totpSecret, nowMs) } }),
  ibkrTickle: (base) => ({ method: 'POST', url: (base || 'https://localhost:5000') + '/v1/api/tickle', headers: {} }),
  ibkrStatus: (base) => ({ method: 'POST', url: (base || 'https://localhost:5000') + '/v1/api/iserver/auth/status', headers: {} })
};

module.exports = { totp, base32Decode, kiteChecksum, safeEqual, materialize, send, login };
