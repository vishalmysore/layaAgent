"""Drive the pages in headless Chrome to produce web/recorded.json (and to run ad-hoc experiments).

    pip install playwright
    python scripts/drive.py eval    [--variant q4e8] [--backend webgpu] [--s2 Qwen2.5-1.5B-Instruct-q4f32_1-MLC] [--subset all] [--out .cache/eval.json]
    python scripts/drive.py presets [--variant q4e8] [--backend webgpu] [--s2 ...] [--out .cache/presets.json]
    python scripts/drive.py merge   --eval .cache/eval.json --presets .cache/presets.json     # -> web/recorded.json
    python scripts/drive.py js FILE.js [--page index.html] [--out result.json]                # FILE.js: an async function body, `return` a JSON value

Serves nothing itself: start `python serve.py 5193` first (or pass --base). Uses an installed Chrome (--chrome PATH)
with WebGPU enabled, and a persistent profile under .cache/ so the models download once. A long run in a headless
browser is not throttled the way a hidden tab is.
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
args = sys.argv[1:]
cmd = args[0] if args else "help"
opt = lambda k, d=None: args[args.index(k) + 1] if k in args else d
BASE = opt("--base", "http://localhost:5193/")
CHROME = opt("--chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe")
VARIANT, BACKEND, S2, SUBSET = opt("--variant", "q4e8"), opt("--backend", "webgpu"), opt("--s2"), opt("--subset", "all")

START_MODELS = """async ({ variant, backend, s2 }) => {
  const C = await import("./common.js");
  for (let i = 0; i < 600 && document.getElementById("loadBtn").disabled; i++) await new Promise((r) => setTimeout(r, 100));
  document.getElementById("variant").value = variant; document.getElementById("backend").value = backend;
  await C.loadS1();
  if (!C.M.laya) throw new Error("System 1 did not load: " + document.getElementById("status").textContent);
  if (s2) { document.getElementById("s2Model").value = s2; await C.loadS2(); if (!C.M.s2) throw new Error("System 2 did not load: " + document.getElementById("status").textContent); }
  return { s1: C.M.info.variant, backend: C.M.info.backend, s2: C.M.s2?.model || null };
}"""

JOBS = {
    "eval": ("eval.html", """async ({ subset, s2 }) => {
      document.getElementById("subset").value = subset;
      document.getElementById("withS2").checked = !!s2;
      await window.__la.runSuite();
      return window.__la.current();
    }""", lambda: document_text("#runCount")),
    "presets": ("index.html", """async () => window.__la.recordPresets()""", None),
}


def document_text(sel):
    return f"() => document.querySelector('{sel}')?.textContent || ''"


def run_job(page, js, arg, progress_js=None, every=15):
    page.evaluate("""([js, arg]) => { window.__job = { done: false }; (async () => (0, eval)('(' + js + ')')(arg))()
        .then((r) => { window.__job.result = r; }).catch((e) => { window.__job.error = String(e && e.stack || e); }).finally(() => { window.__job.done = true; }); }""", [js, arg])
    t0 = time.time()
    while not page.evaluate("() => window.__job.done"):
        time.sleep(every)
        msg = page.evaluate(progress_js) if progress_js else ""
        print(f"  {time.time() - t0:6.0f}s  {msg}", flush=True)
    err = page.evaluate("() => window.__job.error || null")
    if err:
        raise SystemExit("job failed: " + err)
    return page.evaluate("() => window.__job.result")


def open_page(ctx, name):
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on("pageerror", lambda e: print("PAGE ERROR:", e))
    page.on("console", lambda m: m.type in ("error", "warning") and print("console:", m.text[:300]))
    page.goto(BASE + name)
    page.wait_for_function("() => window.__la", timeout=60_000)
    return page


def launch(p):
    return p.chromium.launch_persistent_context(
        str(ROOT / ".cache" / "chrome-profile"), headless=True, executable_path=CHROME,
        args=["--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"], viewport={"width": 1440, "height": 960},
    )


def write(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print("wrote", path)


if cmd in JOBS:
    name, js, prog = JOBS[cmd]
    with sync_playwright() as p:
        ctx = launch(p)
        page = open_page(ctx, name)
        info = run_job(page, START_MODELS, {"variant": VARIANT, "backend": BACKEND, "s2": S2}, document_text("#status"), 10)
        print("models:", info)
        res = run_job(page, js, {"subset": SUBSET, "s2": S2}, prog() if prog else None)
        write(opt("--out", str(ROOT / ".cache" / f"{cmd}.json")), {"models": info, "result": res})
        ctx.close()
elif cmd == "js":
    body = Path(args[1]).read_text(encoding="utf-8")
    with sync_playwright() as p:
        ctx = launch(p)
        page = open_page(ctx, opt("--page", "index.html"))
        res = run_job(page, "async (arg) => {\n" + body + "\n}", None, "() => JSON.stringify(window.__progress ?? '')", 15)
        print(json.dumps(res, indent=1)[:4000])
        if opt("--out"): write(opt("--out"), res)
        ctx.close()
elif cmd == "merge":
    ev = json.loads(Path(opt("--eval")).read_text(encoding="utf-8"))
    pr = json.loads(Path(opt("--presets")).read_text(encoding="utf-8")) if opt("--presets") else None
    run = ev["result"]
    out = {
        "version": 1,
        "note": "Recorded with the same models the page loads (see eval.meta and each trace's recordedWith). Produced by scripts/drive.py.",
        "eval": {"meta": run["meta"], "records": run["records"]},
        "traces": pr["result"] if pr else {},
    }
    write(ROOT / "web" / "recorded.json", out)
else:
    print(__doc__)
