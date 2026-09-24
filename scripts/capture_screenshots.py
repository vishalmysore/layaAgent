"""Capture the screenshots used in docs/article.md from the deployed site.

    pip install playwright
    python scripts/capture_screenshots.py [--base https://vishalmysore.github.io/layaAgent/] [--no-model] [--chrome PATH]

The first shots use the recorded runs (no download). The live shots load System 1 (Laya int4, WebGPU) into a
persistent profile under .cache/ and run goals in the real page, including the guard's confirmation dialog.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"
OUT.mkdir(parents=True, exist_ok=True)
args = sys.argv[1:]
BASE = args[args.index("--base") + 1] if "--base" in args else "https://vishalmysore.github.io/layaAgent/"
WITH_MODEL = "--no-model" not in args
CHROME = args[args.index("--chrome") + 1] if "--chrome" in args else "C:/Program Files/Google/Chrome/Application/chrome.exe"


def shot(page, name, selector=None, full=False):
    path = OUT / f"{name}.png"
    if selector:
        page.locator(selector).first.screenshot(path=str(path))
    else:
        page.screenshot(path=str(path), full_page=full)
    print("saved", path.relative_to(ROOT), flush=True)


def open_page(page, name):
    page.goto(BASE + name)
    page.wait_for_function("() => window.__la && document.getElementById('modelPillText').textContent !== 'Starting…'", timeout=60_000)
    page.wait_for_timeout(1500)


def play(page, goal):
    """Click a preset (replays the recorded run when no model is loaded) and wait until the run ends."""
    page.evaluate("(g) => [...document.querySelectorAll('#presets button')].find(b => b.dataset.goal === g).click()", goal)
    page.wait_for_function("() => window.__la.S.current && !window.__la.S.running && window.__la.S.current.outcome", timeout=900_000)
    page.wait_for_timeout(900)
    page.evaluate("() => window.__la.S.cy && window.__la.S.cy.fit(undefined, 18)")
    page.wait_for_timeout(400)


def tab(page, name):
    page.click(f'.tabs button[data-tab="{name}"]')
    page.wait_for_timeout(900)


def tap_node(page, node_id):
    page.evaluate("(id) => window.__la.S.cy.$id(id).emit('tap')", node_id)
    page.wait_for_timeout(500)


with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        str(ROOT / ".cache" / "capture-profile"), headless=True, executable_path=CHROME, args=["--enable-unsafe-webgpu"],
        viewport={"width": 1440, "height": 1000}, device_scale_factor=1.25, color_scheme="light",
    )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.on("pageerror", lambda e: print("PAGE ERROR:", e))

    # ---- Agent page, recorded runs ------------------------------------------------------------------------------
    open_page(page, "index.html")
    shot(page, "01-agent-overview")
    play(page, "What's the weather this weekend in the city where the Eiffel Tower is?")
    shot(page, "02-trace-multihop", ".stage")
    held = page.evaluate("() => (window.__la.S.current.steps.find(s => s.route === 'HOLD') || {}).index")
    if held is not None:
        tap_node(page, f"d_{held}")
        shot(page, "03-inspector-held-step", "#inspector")
    tap_node(page, "d_0")
    shot(page, "04-inspector-laya-step", "#inspector")
    play(page, "Delete all my notes about the dentist")
    shot(page, "05-trace-guard", ".stage")
    play(page, "How tall is that iron tower in Paris?")
    shot(page, "06-trace-none-escalates", ".stage")
    for g in ["What's 18% of 2,450?", "Convert 5 miles to kilometers", "What is the population of the country where Kyoto is?", "Send Priya a message saying I'll be late"]:
        play(page, g)
    tab(page, "session")
    shot(page, "07-session-graph", ".stage")
    tab(page, "steps")
    shot(page, "08-steps-list", ".stage")
    tab(page, "trace")
    shot(page, "09-banner", ".banner")

    # ---- Evaluate page, recorded suite run -------------------------------------------------------------------------
    open_page(page, "eval.html")
    shot(page, "10-eval-headline", "main.main > section.card")
    shot(page, "11-eval-baselines-curve", "main.main > div.two")
    shot(page, "12-eval-parts-categories", "main.main > div.two >> nth=1")
    page.select_option("#fOk", "autobad")
    page.dispatch_event("#fOk", "change")
    page.wait_for_timeout(600)
    page.locator("#steps tr.claimrow").first.click()
    page.wait_for_timeout(600)
    page.evaluate("() => document.querySelector('#steps tr.detailrow').scrollIntoView({ block: 'center' })")
    shot(page, "13-eval-step-detail", "#steps")

    # ---- Live models -------------------------------------------------------------------------------------------------
    if WITH_MODEL:
        open_page(page, "index.html")
        page.select_option("#variant", "q4e8")
        page.select_option("#backend", "webgpu")
        page.click("#loadBtn")
        page.wait_for_function("() => window.__la.M.laya", timeout=900_000)
        page.wait_for_timeout(800)
        shot(page, "14-models-loaded", "#modelCard")
        page.evaluate("() => { document.getElementById('autoS2').checked = false; }")
        # a goal Laya handles alone
        page.fill("#goal", "Convert 42 kilometers to miles")
        page.click("#runBtn")
        page.wait_for_function("() => !window.__la.S.running && window.__la.S.current && window.__la.S.current.outcome", timeout=300_000)
        page.wait_for_timeout(800)
        shot(page, "15-live-s1-only", ".main")
        # the guard: a side-effect tool opens a confirmation, whoever chose it
        page.fill("#goal", "Remember that the plumber is coming on Tuesday")
        page.click("#runBtn")
        page.wait_for_function("() => document.getElementById('confirmDlg').open || document.getElementById('decideDlg').open", timeout=300_000)
        page.wait_for_timeout(600)
        if page.evaluate("() => document.getElementById('decideDlg').open"):
            shot(page, "16-live-you-decide")
            page.click("#decideForm button[value=ok]")
            page.wait_for_function("() => document.getElementById('confirmDlg').open", timeout=300_000)
            page.wait_for_timeout(600)
        shot(page, "17-live-guard-confirm")
        page.click("#confirmDlg button[value=yes]")
        page.wait_for_function("() => !window.__la.S.running && window.__la.S.current.outcome", timeout=300_000)
        page.wait_for_timeout(800)
        shot(page, "18-live-after-confirm", ".main")

    # ---- Dark mode, phone width -------------------------------------------------------------------------------------
    dark = ctx.new_page()
    dark.emulate_media(color_scheme="dark")
    dark.set_viewport_size({"width": 390, "height": 844})
    open_page(dark, "index.html")
    play(dark, "What is the population of the country where Kyoto is?")
    dark.evaluate("() => document.getElementById('answerCard').scrollIntoView()")
    dark.wait_for_timeout(500)
    shot(dark, "19-dark-mobile")
    dark.close()
    ctx.close()
print("done")
