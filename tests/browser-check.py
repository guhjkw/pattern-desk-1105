"""Playwright check of the real page, served over http and opened off disk.
Run: python3 tests/browser-check.py   (after python3 build.py)   last line: "N passed, 0 failed" """
import pathlib, socket, subprocess, sys, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "screenshots"; SHOTS.mkdir(exist_ok=True)
passed = failed = 0
def ok(name, cond, detail=""):
    global passed, failed
    if cond: passed += 1; print("PASS " + name)
    else: failed += 1; print("FAIL " + name + ("  -> " + str(detail)[:400] if detail != "" else ""))
s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = "http://127.0.0.1:%d/" % port
for _ in range(50):
    try: urllib.request.urlopen(base, timeout=1); break
    except Exception: time.sleep(0.1)
errors = []
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        for _ in range(3):
            page.goto(base)
            try: page.wait_for_selector("svg.pd-chart", timeout=15000); break
            except Exception: print("retrying load", errors)
        def tab(t): page.locator('.pd-tabs [data-act="tab"][data-arg="%s"]' % t).click()
        def setcfg(k, v):
            loc = page.locator('[data-cfg="%s"]' % k).first
            if loc.evaluate("e => e.tagName") == "SELECT": loc.select_option(str(v))
            else: loc.fill(str(v)); loc.dispatch_event("change")

        # 1. strategy lab
        ok("1.1 chart and pattern list render", page.locator("svg.pd-chart rect").count() > 50 and "EVERY PATTERN THE ENGINE SAW" in page.inner_text(".pd-view").upper())
        pats0 = page.locator(".pd-view .pd-tbl").last.locator("tbody tr").count()
        setcfg("tolerancePct", 0.02)
        pats1 = page.locator(".pd-view .pd-tbl").last.locator("tbody tr").count() if page.locator(".pd-view .pd-tbl").count() else 0
        ok("1.2 a tighter tolerance finds fewer patterns", pats1 < pats0, [pats0, pats1])
        page.locator('[data-act="resetcfg"]').click()
        setcfg("volumeMult", 3)
        ok("1.3 volume at 3x: breakouts skipped with the reason", "volume" in page.inner_text(".pd-view") and "under 3x" in page.inner_text(".pd-view"))
        page.locator('[data-act="resetcfg"]').click()
        page.select_option('select[data-bind="mode"]', "swing")
        ok("1.4 swing mode draws 60-minute bars across sessions", "60-minute bars, all 15 sessions" in page.inner_text(".pd-view"))
        page.select_option('select[data-bind="mode"]', "day")
        page.select_option('select[data-bind="symbol"]', "INFY")
        ok("1.5 switching symbol re-runs on that symbol's bars", "INFY" in page.locator("svg.pd-chart").first.inner_html())
        page.screenshot(path=str(SHOTS / "lab.png"))

        # 2. backtest
        tab("backtest")
        def kpi(i): return page.locator(".pd-kpi .val").nth(i).inner_text()
        t0, tot0 = kpi(0), kpi(2)
        ok("2.1 backtest shows trades and stats", int(t0) > 0 and "R" in tot0, [t0, tot0])
        page.locator('[data-bt="costPct"]').fill("0"); page.locator('[data-bt="costPct"]').dispatch_event("change")
        page.locator('[data-bt="slippageTicks"]').fill("0"); page.locator('[data-bt="slippageTicks"]').dispatch_event("change")
        tot1 = kpi(2)
        ok("2.2 no costs or slippage: the total goes up", float(tot1.replace("R", "").replace("+", "")) > float(tot0.replace("R", "").replace("+", "")), [tot0, tot1])
        page.locator('[data-bt="costPct"]').fill("-1"); page.locator('[data-bt="costPct"]').dispatch_event("change")
        ok("2.3 a negative cost is refused with a reason", "must be 0 or more" in page.inner_text("#toast") and page.locator('[data-bt="costPct"]').input_value() == "0")
        page.locator('input[data-bind="btsym"][value="SPY"]').uncheck()
        ok("2.4 removing SPY changes the trade count and the table", "SPY" not in page.locator(".pd-tbl").last.inner_text() and kpi(0) != t0)
        ok("2.5 per-account results in rupees and dollars", "₹" in page.inner_text(".pd-view") and "$" in page.inner_text(".pd-view"))
        page.locator('input[data-bind="btsym"][value="SPY"]').check()
        first = page.locator('tr[data-act="opentrade"]').first
        sym = first.locator("td").nth(1).inner_text()
        first.click()
        ok("2.6 clicking a trade opens it on the chart", page.locator('select[data-bind="symbol"]').input_value() == sym and "TRADES ON THIS SESSION (1" in page.inner_text(".pd-view").upper(), sym)
        page.screenshot(path=str(SHOTS / "backtest-trade.png"))

        # 3. accounts and orders
        tab("accounts")
        ok("3.1 three account cards with live sessions", page.locator(".pd-acct").count() == 3)
        nse = [o for o in page.locator('select[data-bind="sigSel"] option').all() if "INFY" in o.inner_text() and "day" in o.inner_text() and "long" in o.inner_text()]
        page.select_option('select[data-bind="sigSel"]', nse[0].get_attribute("value"))
        decs = page.locator(".pd-dec").all_inner_texts()
        ok("3.2 an NSE day signal: Zerodha and Angel One take it, IBKR skips it", "takes it" in decs[0] and "takes it" in decs[1] and "does not trade NSE" in decs[2], decs)
        page.locator('[data-acc="staticIpRegistered"][data-i="0"]').uncheck()
        ok("3.3 without a registered static IP Zerodha refuses (SEBI rule)", "static IP" in page.locator(".pd-dec").first.inner_text())
        page.locator('[data-acc="staticIpRegistered"][data-i="0"]').check()
        page.locator('[data-acc="loginRan"][data-i="1"]').uncheck()
        ok("3.3b without the morning login Angel One refuses (session from yesterday)", "log in again" in page.locator(".pd-dec").nth(1).inner_text())
        page.locator('[data-acc="loginRan"][data-i="1"]').check()
        page.locator('[data-act="sendpaper"]').click()
        ok("3.4 send (paper) logs it in the journal, nothing sent", "none sent" in page.inner_text(".pd-view"))
        ok("3.5 the same signal again is refused", "Already routed" in page.locator(".pd-dec").first.inner_text())
        page.locator('[data-act="resetpaper"]').click()
        page.locator('[data-act="kill"]').click()
        ok("3.6 kill switch: every account refuses", all("Kill switch" in d for d in page.locator(".pd-dec").all_inner_texts()))
        page.locator('[data-act="kill"]').click()
        page.locator('[data-acc="capital"][data-i="1"]').fill("500"); page.locator('[data-acc="capital"][data-i="1"]').dispatch_event("change")
        ok("3.7 a capital too small for one share: refused with the numbers", "less than one share" in page.locator(".pd-dec").nth(1).inner_text())
        page.locator('[data-acc="capital"][data-i="1"]').fill("-5"); page.locator('[data-acc="capital"][data-i="1"]').dispatch_event("change")
        ok("3.8 a negative capital is refused", "0 or more" in page.inner_text("#toast"))
        page.locator('[data-acc="capital"][data-i="1"]').fill("300000"); page.locator('[data-acc="capital"][data-i="1"]').dispatch_event("change")
        swing_short = [o for o in page.locator('select[data-bind="sigSel"] option').all() if "swing" in o.inner_text() and "short" in o.inner_text() and any(x in o.inner_text() for x in ["RELIANCE", "HDFCBANK", "INFY"])]
        if swing_short:
            page.select_option('select[data-bind="sigSel"]', swing_short[0].get_attribute("value"))
            ok("3.9 an NSE swing short is refused for cash accounts", "short overnight" in page.locator(".pd-dec").first.inner_text())
        else:
            ok("3.9 (no NSE swing short in this data, rule covered by node test 5.9)", True)
        page.screenshot(path=str(SHOTS / "accounts.png"))

        # 4. TradingView
        tab("tv")
        ok("4.1 the Pine Script is shown", "//@version=6" in page.inner_text("#pine"))
        page.locator('[data-act="tvsend"]').click()
        ok("4.2 a test alert is accepted and routed", "Accepted" in page.inner_text(".pd-view") and page.locator(".pd-dec").count() == 3)
        page.locator('[data-act="tvsend"]').click()
        ok("4.3 the same alert twice is refused as a duplicate", "Duplicate" in page.inner_text(".pd-view"))
        page.locator('[data-act="tvbreak"][data-arg="secret"]').click(); page.locator('[data-act="tvsend"]').click()
        ok("4.4 a wrong secret is refused", "Wrong or missing secret" in page.inner_text(".pd-view"))
        page.locator('[data-act="tvbreak"][data-arg="symbol"]').click(); page.locator('[data-act="tvsend"]').click()
        ok("4.5 a symbol off the watchlist is refused", "not on the watchlist" in page.inner_text(".pd-view"))
        page.fill("#tvtext", "{not json"); page.locator('[data-act="tvsend"]').click()
        ok("4.6 a body that is not JSON is refused", "not valid JSON" in page.inner_text(".pd-view"))

        # 5. offer, code
        tab("offer")
        off = page.inner_text(".pd-view")
        ok("5.1 three tiers with the featured $2,400 and 4 milestones", "$1,200" in off and "$2,400" in off and "$3,900" in off and off.count("Week ") >= 4)
        ok("5.2 honest scope footer", "Honest scope" in off and "taken down about 30 days" in off and "investment advice" in off)
        page.screenshot(path=str(SHOTS / "offer.png"), full_page=True)
        z = urllib.request.urlopen(base + "downloads/pattern-desk.zip")
        ok("5.3 the code zip downloads", z.status == 200 and int(z.headers["Content-Length"]) > 50000)
        tab("built")
        ok("5.4 architecture and the production proof are shown", "ALREADY RUNNING IN PRODUCTION" in page.inner_text(".pd-view").upper() and page.locator("svg.pd-arch").count() == 1)

        # 6. phone and off disk
        m = browser.new_page(viewport={"width": 390, "height": 844})
        m.on("pageerror", lambda e: errors.append("mobile: " + str(e)))
        m.goto(base); m.wait_for_selector("svg.pd-chart")
        w1 = m.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth + 1")
        m.locator('.pd-tabs [data-arg="accounts"]').click()
        w2 = m.evaluate("document.scrollingElement.scrollWidth <= window.innerWidth + 1")
        m.screenshot(path=str(SHOTS / "mobile.png"))
        ok("6.1 no sideways scroll at phone width", w1 and w2, [w1, w2])
        f = browser.new_page(); f.on("pageerror", lambda e: errors.append("file: " + str(e)))
        f.goto((ROOT / "index.html").as_uri()); f.wait_for_selector("svg.pd-chart")
        ok("6.2 opened off disk it still works (embedded data)", f.locator("svg.pd-chart rect").count() > 50)
        ok("6.3 no console or page errors", not errors, errors)
        browser.close()
finally:
    server.terminate()
print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
