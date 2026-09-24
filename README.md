# layaAgent

**An AI agent that runs entirely in a browser tab.** A 421M typed-decision encoder (Laya, *System 1*) makes the routine decisions, a small in-browser LLM (WebLLM, *System 2*) steps in only when Laya is unsure, and every step that changes something (saving or deleting notes, sending a message) needs your OK. Every step is drawn as a graph you can click through.

No server, no API key. The tools call Wikipedia, Wikidata and Open-Meteo straight from your browser; nothing else leaves the page, and messages are simulated, never sent.

Repository: `layaAsAgenticGaurd`. Design spec: [`layaAgent.md`](layaAgent.md). Fourth in the series layaForWeb (the model) → [layaForWorkflows](https://github.com/vishalmysore/layaForWorkflows) (decisions as a graph) → [layaAsRagJudge](https://github.com/vishalmysore/layaAsRagJudge) (decisions as a judge) → **layaAgent (decisions as an agent)**.

__RESULTS__

## How a step works

```
goal ──► state { goal, steps_done (last 4, one line each), last_observation }   fixed token budget per field
     ──► System 1 decision pass    next_action (choice over 12 tools)  ·  goal_met (yes/no, from step 2 on)
                                   risky (yes/no, asked once per run on the goal alone)
     ──► candidate extractor       compromise + regex over goal + last observation: places, people, orgs,
         (no model)                nouns, dates, durations, quantities, arithmetic, clauses to save or send
     ──► System 1 argument pass    one choice question per slot: the candidate spans + NONE, or a fixed list
     ──► gate                      AUTO: System 1's step runs
                                   HOLD: System 2 decides (JSON-schema constrained, same action space),
                                         or you do when System 2 is not loaded / no WebGPU
     ──► guard                     tools that change something always ask you first, whoever picked them
     ──► tool ──► observation ──► next step        FINISH composes the answer from tool results (templates)
```

**Laya never writes.** Something else proposes the options (the tool registry, the extractor, a fixed list), Laya picks one and reports probabilities, and the gate sends the rest to System 2 or a person. Tool arguments come from *extraction by choice*: Laya cannot type "Japan", but it can pick "Japan" out of the spans found in the last observation. When the right argument is not written anywhere ("that iron tower in Paris"), Laya should pick NONE, which holds the step for System 2, the only component allowed to write.

### The gate

A step is **held** when any of these is true (all thresholds live on sliders, and moving them re-routes stored decisions without calling a model):

| Rule | Why |
|---|---|
| p(chosen tool) < τ_action | Laya is unsure which tool |
| p(chosen span) < τ_arg for any argument, or any argument is NONE | unsure, or the value is not in the text |
| a FINISH with p(goal met) < τ_stop | Laya's stop signal is weak on multi-hop goals (see results) |
| same tool as the previous step | Laya tends to repeat its last tool; the loop guard also catches identical calls |
| the goal reads as risky (p ≥ 0.5) but the chosen tool is read-only | fail closed: "delete my notes" should not quietly become a search |
| step budget reached | stops runaway loops |

**Gate score.** Laya's native confidence is 1 − normalized entropy, but this checkpoint's probabilities are compressed (seen in layaForWorkflows and layaAsRagJudge): a 12-option question reads 0.1–0.3 even when right. The default score is therefore the probability of the chosen option; margin and entropy are selectable.

**The guard** is separate from the gate: `note_save`, `note_delete` and `send_message` are declared side-effect tools and always open a confirmation, whether Laya, System 2 or you chose them. Laya's own `risky` reading is used to *hold* suspicious read-only steps, and its accuracy is measured on the Evaluate page.

## Tools

| Tool | Arguments (how they are chosen) | Backend |
|---|---|---|
| `wiki_lookup` | topic (span) | Wikipedia title search + page summary |
| `wikidata_fact` | entity (span), property (fixed list of 11: population, capital, country, head of government, CEO, founded, founder, official language, currency, area, height) | Wikidata entity search + REST statements API (current value: preferred rank, no end date, latest point in time) |
| `weather` | place (span), when (today / tomorrow / weekend / next few days) | Open-Meteo geocoding + forecast |
| `calculator` | expression (arithmetic span, e.g. "18% of 2,450") | local recursive-descent parser, no `eval` |
| `unit_convert` | quantity (span), target unit (fixed list) | local tables |
| `date_math` | date (span or "today"), offset (span, e.g. "3 weeks after") | local |
| `note_save` ⚠ | text (clause after "remember / note that") | IndexedDB |
| `note_search` | query (span) | lexical match over saved notes |
| `note_delete` ⚠ | query (span or "all notes") | IndexedDB |
| `send_message` ⚠ | to (person), text (clause after "saying / that") | **simulated**: nothing is sent |
| `ask_user` | question (written by System 2, or a template) | a dialog |
| `FINISH` | – | composes the answer from the tool results |

⚠ = side effect: always confirmed by you.

Deviations from the spec, on purpose: `verify_claim` and `open_url` were replaced by `note_delete` and a simulated `send_message`, so the guard has real side effects to guard; note search is lexical rather than MiniLM, so the page ships one model runtime.

## What you see

**Agent page** (`index.html`): a goal box with 14 presets, the *who decided* banner (System 1 / System 2 / you / confirmations, with median latency measured on your device), the suite numbers at the current gate, the **trace graph** (a diamond per step colored by who decided; held steps show Laya's own proposal with an amber escalation edge; dashed diamonds are the next actions Laya considered, and clicking one replays the run from there with that action), a step list, a **session graph** of every run in the tab, and export as JSON or RDF Turtle. The inspector shows the exact state and typed questions Laya read, every option's probability, the gate's reasons, and System 2's prompt and raw JSON reply.

**Evaluate page** (`eval.html`): runs the task suite, then reports the split, the System 1 auto-step error, task success for four routers (System 1 alone, S1 + System 2, S1 + you, System 2 alone), the parts of System 1 (action, argument, extractor recall, NONE use, goal_met and risk AUROC), the coverage vs accuracy curve, a per-category table and every step with its probabilities. "Tune on dev" picks the threshold on the dev split under an error cap; read the result on test.

**Playback before download.** Laya is 278–422 MB and a WebLLM model 0.4–1.1 GB. Until you load them, the presets replay runs recorded from the same models and the Evaluate page shows the recorded suite run (`web/recorded.json`).

## The task suite

`web/tasks.json`: 107 synthetic goals (36 dev / 71 test, 238 gold steps) in 11 categories: weather, encyclopedia, Wikidata facts, arithmetic, unit conversion, date math, multi-hop (an observation span becomes the next argument), memory (save / search), needs rewriting (the argument is not in the text), ambiguous (should ask), and changes something (should be confirmed). Every task ends with FINISH, so stopping correctly is scored everywhere. Gold arguments may list alternatives; calculator expressions match by value and quantities by value and unit.

`scripts/build_tasks.mjs` ran the **real tools** once for every gold step and stored their outputs, so scores do not move when Wikipedia, Wikidata or the weather change. Evaluation runs each gold step with the gold history as context; with recorded tools, a task is solved exactly when every one of its steps is decided correctly, which is how task success is computed.

## Run locally

```bash
npm ci
```

```bash
npm test
```

```bash
node scripts/prepare_site.mjs
```

```bash
python serve.py
```

Then open http://localhost:8000. `serve.py` sends the COOP/COEP headers so ONNX Runtime can use several WASM threads; on GitHub Pages `coi.js` registers a service worker that adds them. `?threads=N` changes the WASM thread count (4 was fastest on our 20-core laptop; 10 was slower).

## Re-recording `recorded.json`

A unit test fails when the question wording, the tool registry or the suite changes, because the recording carries a fingerprint of them. To refresh it (needs Chrome and `pip install playwright`), start `python serve.py 5193`, then:

```bash
python scripts/drive.py eval --variant q4e8 --backend webgpu --s2 Qwen2.5-1.5B-Instruct-q4f16_1-MLC --out .cache/eval.json
```

```bash
python scripts/drive.py presets --variant q4e8 --backend webgpu --s2 Qwen2.5-1.5B-Instruct-q4f16_1-MLC --out .cache/presets.json
```

```bash
python scripts/drive.py merge --eval .cache/eval.json --presets .cache/presets.json
```

`drive.py` runs the pages in headless Chrome with WebGPU enabled; a long run there is not throttled the way a hidden browser tab is. In the preset recordings, steps that would go to you are answered from the task's gold trace and confirmations are auto-allowed (each trace says so in `recordedWith`).

## Deploy

`.github/workflows/deploy.yml` runs the unit tests, assembles `dist/` (pages plus vendored ONNX Runtime Web, Tokenizers.js, Cytoscape.js, compromise and WebLLM, about 36 MB) and publishes it to GitHub Pages. No model is bundled.

## License

Apache-2.0. See `NOTICE.md` for the models, data sources and third-party code.
