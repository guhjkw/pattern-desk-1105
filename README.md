# Pattern Desk: multi-account pattern trading (Zerodha, Angel One, IBKR, TradingView)

A working first version built from an Upwork post: double top and double bottom strategies for day and swing trading, a 15-day backtest, TradingView alerts by webhook, and one signal routed to Zerodha (Kite Connect), Angel One (SmartAPI) and Interactive Brokers (Web API) with per-account sizing and risk checks.

The prices are synthetic and the accounts are examples. The engine, the server and their tests are real.

## Try it
Open `index.html` (served or straight off disk).
- **Strategy & chart:** pick a symbol and session; change any setting and the patterns, signals and trades are found again from the bars.
- **Backtest:** 15 sessions, all symbols, costs and slippage, per account in its own currency. Click a trade to see it on the chart.
- **Accounts & orders:** one signal, three accounts. Untick a static IP, press the kill switch, send the same signal twice, or pick an NSE swing short.
- **TradingView alerts:** the Pine Script v6 indicator built from your settings, and a box to send a test webhook (wrong secret, unknown symbol and bad levels are refused).

## Files
    src/patterns.js       pivots and double top / bottom detection, day and swing, no lookahead
    src/backtest.js       stops, targets, square-off, max hold, costs, slippage, stats
    src/router.js         per-account checks (SEBI static IP, Kite 6 AM token expiry, limits, kill switch), sizing, Kite / SmartAPI / IBKR requests
    src/tvAlert.js        Pine Script v6 indicator and webhook parser
    server/server.js      POST /tv (answers first, works after), paper / live, kill switch, journal
    server/lib.js         TOTP (RFC 6238) for the SmartAPI login, Kite checksum, sending
    server/config.example.json
    tradingview/pattern-desk-alerts.pine
    data/generate.py      makes the synthetic bars (data/sample.json)
    tests/verify.js       engine tests     tests/server.test.js   server tests     tests/browser-check.py   page tests

## Tests
    node tests/verify.js          -> 65 passed, 0 failed
    node tests/server.test.js     -> 21 passed, 0 failed (real HTTP server, a fake broker records each request)
    python3 build.py && python3 tests/browser-check.py

The page, the server and the tests load the same `src/` files: one source of truth.

## Run the server
    TV_SECRET=... ADMIN_TOKEN=... CONFIG=server/config.json node server/server.js

`mode: "paper"` (the default) logs every order request without sending it. Live mode needs, per account: a Kite Connect app and the morning request-token exchange, SmartAPI keys with TOTP, an IBKR account with the Client Portal gateway running, and a VPS whose static IP is registered with Zerodha and Angel One.

## How the logic works
| Step | Rule |
|---|---|
| Swing high / low | highest high (lowest low) of `pivot` bars each side, known only `pivot` bars later |
| Double top | two swing highs within `tolerancePct`, `minGap`-`maxGap` bars apart, nothing above them in between, neckline at least `minDepthPct` below |
| Signal | first close through the neckline within `maxBarsToBreak` bars, volume at least `volumeMult` x the 20-bar average, reward:risk at least `minRR`; a close beyond the tops first cancels it |
| Stop / target | last swing, the tops, or mid-pattern; measured move or a fixed R |
| Day mode | 5-minute bars, one session, no entries after 14:45 IST / 15:15 ET, flat by 15:15 IST / 15:50 ET |
| Swing mode | 60-minute bars across sessions, maximum hold about five sessions; NSE shorts are skipped for cash accounts |
| Sizing | floor(capital x risk % / (entry - stop)), capped by the account's exposure % |

## Status
Broker requests are written against the current Kite Connect, SmartAPI and IBKR Web API docs and tested against a fake broker; none has been sent to a real account yet. The SmartAPI stop-order values and the Pine Script (not yet compiled in TradingView) are checked on the client's accounts in the build. Not investment advice.

Built by Taiwo, Pathfinder Automation Solutions.
