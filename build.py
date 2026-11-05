"""Builds index.html (embeds data/sample.json and the last test summaries) and downloads/pattern-desk.zip."""
import json, pathlib, re, zipfile
root = pathlib.Path(__file__).resolve().parent
def summary(path):
    last = [l for l in (root / path).read_text(encoding="utf-8").splitlines() if l.strip()][-1]
    m = re.fullmatch(r"(\d+) passed, (\d+) failed", last.strip())
    assert m and m.group(2) == "0", path + " is not green: " + last
    return int(m.group(1))
parts = ["%d engine" % summary("tests/test-output.txt"), "%d server" % summary("tests/server-output.txt")]
bo = root / "tests" / "browser-output.txt"
if bo.exists():
    try: parts.append("%d browser" % summary("tests/browser-output.txt"))
    except AssertionError: pass
tests = " + ".join(parts) + " checks passing"
blob = json.dumps(json.loads((root / "data" / "sample.json").read_text()), separators=(",", ":")).replace("</", "<\\/")
src = (root / "index.src.html").read_text(encoding="utf-8")
assert src.count("__FALLBACK__") == 1 and src.count("__TESTS__") == 1
(root / "index.html").write_text(src.replace("__FALLBACK__", blob).replace("__TESTS__", tests), encoding="utf-8")
dl = root / "downloads"; dl.mkdir(exist_ok=True)
with zipfile.ZipFile(dl / "pattern-desk.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for base in ["src", "server", "tests", "data", "tradingview"]:
        for p in sorted((root / base).rglob("*")):
            if p.is_dir() or p.name in (".DS_Store",) or "screenshots" in p.parts or p.suffix == ".png" or p.name == "journal.jsonl":
                continue
            z.write(p, "pattern-desk/" + str(p.relative_to(root)))
    z.write(root / "README.md", "pattern-desk/README.md")
print("index.html %d bytes; %s" % ((root / "index.html").stat().st_size, tests))
