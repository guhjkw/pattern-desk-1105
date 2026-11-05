"""Generates SYNTHETIC 5-minute bars for the demo: 15 sessions for three NSE stocks (traded through
Zerodha and Angel One) and two US symbols (traded through Interactive Brokers).

These are made-up prices, not market data. Double tops and double bottoms are planted at random
places (some follow through, some fail) on top of a random walk, so the detector has real work to do
and the backtest has winners and losers. Deterministic: the same seed gives the same file.

Run: python3 data/generate.py
"""
import datetime as dt
import json
import math
import pathlib
import random

ROOT = pathlib.Path(__file__).resolve().parent
rng = random.Random(1105)

# 15 weekdays (skips 20 Oct, Dussehra in 2026)
DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-21", "2026-10-22",
        "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02"]

SYMBOLS = [
    dict(symbol="RELIANCE", exchange="NSE", market="NSE", name="Reliance Industries", currency="INR", price=1420.0, vol=0.0009, tick=0.05, avgvol=42000,
         brokers={"zerodha": {"tradingsymbol": "RELIANCE"}, "angel": {"tradingsymbol": "RELIANCE-EQ", "symboltoken": "2885"}}),
    dict(symbol="HDFCBANK", exchange="NSE", market="NSE", name="HDFC Bank", currency="INR", price=1680.0, vol=0.0008, tick=0.05, avgvol=36000,
         brokers={"zerodha": {"tradingsymbol": "HDFCBANK"}, "angel": {"tradingsymbol": "HDFCBANK-EQ", "symboltoken": "1333"}}),
    dict(symbol="INFY", exchange="NSE", market="NSE", name="Infosys", currency="INR", price=1530.0, vol=0.0010, tick=0.05, avgvol=30000,
         brokers={"zerodha": {"tradingsymbol": "INFY"}, "angel": {"tradingsymbol": "INFY-EQ", "symboltoken": "1594"}}),
    dict(symbol="SPY", exchange="ARCA", market="US", name="SPDR S&P 500 ETF", currency="USD", price=680.0, vol=0.0006, tick=0.01, avgvol=520000,
         brokers={"ibkr": {"conid": 756733, "symbol": "SPY"}}),
    dict(symbol="AAPL", exchange="NASDAQ", market="US", name="Apple", currency="USD", price=268.0, vol=0.0008, tick=0.01, avgvol=310000,
         brokers={"ibkr": {"conid": 265598, "symbol": "AAPL"}}),
]

SESSIONS = {
    "NSE": dict(open="09:15", close="15:30", tz="Asia/Kolkata", utc_offset="+05:30"),
    "US": dict(open="09:30", close="16:00", tz="America/New_York", utc_offset="-04:00"),
}


def times(market):
    s = SESSIONS[market]
    h, m = map(int, s["open"].split(":"))
    ch, cm = map(int, s["close"].split(":"))
    t = h * 60 + m
    out = []
    while t < ch * 60 + cm:
        out.append("%02d:%02d" % (t // 60, t % 60))
        t += 5
    return out


def rnd(x, tick):
    return round(round(x / tick) * tick, 2)


def plant(path, start, length, kind, height, follow):
    """Shapes a double top (kind=+1) or bottom (kind=-1) into the drift path from `start`.
    follow=True keeps going through the neckline afterwards, False reverses (a failed pattern)."""
    # two peaks at 25% and 65% of the window, trough between, then the break
    pts = [(0.0, 0.0), (0.25, 1.0), (0.45, 0.42), (0.65, 0.985 + rng.uniform(-0.012, 0.012)), (0.82, 0.25), (1.0, -0.55 if follow else 0.9)]
    for i in range(length):
        f = i / (length - 1)
        for a, b in zip(pts, pts[1:]):
            if a[0] <= f <= b[0]:
                y = a[1] + (b[1] - a[1]) * (f - a[0]) / (b[0] - a[0])
                break
        path[start + i] += kind * height * y


bars = {}
for s in SYMBOLS:
    tlist = times(s["market"])
    n = len(tlist) * len(DAYS)
    shape = [0.0] * n
    # plant 5 intraday patterns per symbol (mix of tops/bottoms, some failing)
    per_day = len(tlist)
    used = set()
    planted = []
    for k in range(5):
        for _ in range(50):
            d = rng.randrange(len(DAYS))
            if d in used:
                continue
            used.add(d)
            length = rng.randint(26, 38)
            st = d * per_day + rng.randint(4, per_day - length - 12)
            kind = rng.choice([1, -1])
            follow = rng.random() < 0.6
            height = s["price"] * rng.uniform(0.008, 0.012)
            plant(shape, st, length, kind, height, follow)
            planted.append(dict(day=DAYS[d], start_bar=st % per_day, kind="double_top" if kind == 1 else "double_bottom", follows_through=follow))
            break
    # one bigger multi-day pattern for swing mode
    st = per_day * 5 + 10
    length = per_day * 6
    kind = rng.choice([1, -1])
    plant(shape, st, length, kind, s["price"] * 0.03, True)
    planted.append(dict(day=DAYS[5], start_bar=10, kind=("double_top" if kind == 1 else "double_bottom") + " (multi-day, swing)", follows_through=True))

    price = s["price"]
    out = []
    i = 0
    prev_shape = 0.0
    prev_close = None
    for d, day in enumerate(DAYS):
        gap = rng.gauss(0, s["vol"] * 2.5)
        price *= (1 + gap)
        for j, t in enumerate(tlist):
            # U-shaped intraday volatility and volume
            u = 1.0 + 0.9 * (math.exp(-j / 6.0) + math.exp(-(len(tlist) - 1 - j) / 6.0))
            o = prev_close if (prev_close is not None and j > 0) else price + prev_shape
            ret = rng.gauss(0, s["vol"] * u * 0.75)
            price *= (1 + ret)
            sh = shape[i]
            c = price + sh
            hi = max(o, c) + abs(rng.gauss(0, s["price"] * s["vol"] * 0.35))
            lo = min(o, c) - abs(rng.gauss(0, s["price"] * s["vol"] * 0.35))
            move = abs(c - o) / (s["price"] * s["vol"] + 1e-9)
            v = int(s["avgvol"] * u * rng.uniform(0.6, 1.4) * (1 + 0.35 * min(move, 4)))
            out.append([day, t, rnd(o, s["tick"]), rnd(hi, s["tick"]), rnd(lo, s["tick"]), rnd(c, s["tick"]), v])
            prev_shape = sh
            prev_close = c
            i += 1
    bars[s["symbol"]] = out
    s["planted"] = planted

accounts = [
    dict(id="zerodha-main", broker="zerodha", label="Zerodha (Kite Connect)", owner="Main account", currency="INR", capital=500000, riskPct=0.5, maxOpen=3, dailyLossPct=1.5,
         markets=["NSE"], enabled=True, staticIpRegistered=True, session=dict(kind="kite_access_token", issuedAt="2026-11-02T08:52:00+05:30"),
         productDay="MIS", productSwing="CNC", squareOff="15:15", maxExposurePct=60),
    dict(id="angel-main", broker="angel", label="Angel One (SmartAPI)", owner="Second account", currency="INR", capital=300000, riskPct=0.75, maxOpen=2, dailyLossPct=2.0,
         markets=["NSE"], enabled=True, staticIpRegistered=True, session=dict(kind="smartapi_jwt", issuedAt="2026-11-02T08:53:00+05:30"),
         productDay="INTRADAY", productSwing="DELIVERY", squareOff="15:15", maxExposurePct=60),
    dict(id="ibkr-main", broker="ibkr", label="Interactive Brokers (Web API)", owner="US account", currency="USD", capital=25000, riskPct=0.5, maxOpen=3, dailyLossPct=1.5,
         markets=["US"], enabled=True, staticIpRegistered=None, session=dict(kind="ibkr_gateway", issuedAt="2026-11-02T08:30:00-05:00", accountId="U1234567"),
         productDay="DAY", productSwing="GTC", squareOff="15:50", maxExposurePct=60),
]

sample = dict(
    _note="SYNTHETIC prices generated for a demo. Not market data. Accounts are examples, not real accounts.",
    days=DAYS, sessions=SESSIONS, symbols=SYMBOLS, accounts=accounts,
    bars_cols=["day", "time", "open", "high", "low", "close", "volume"], bars=bars,
)
(ROOT / "sample.json").write_text(json.dumps(sample, separators=(",", ":")), encoding="utf-8")
print("wrote sample.json:", {k: len(v) for k, v in bars.items()})
for s in SYMBOLS:
    print(s["symbol"], [p["kind"] + "@" + p["day"] + ("" if p["follows_through"] else " (fails)") for p in s["planted"]])
