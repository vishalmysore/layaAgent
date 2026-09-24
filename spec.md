\# layaAgent



\*\*An AI agent that runs entirely in a browser tab. A 421M encoder makes the fast decisions, a small in-browser LLM steps in only when the encoder is unsure, and every step is drawn as a graph you can click through.\*\*



No server, no API key, nothing you type leaves the page. Deployed as a static site on GitHub Pages.



> Status: design spec, not yet built. Every number in this document marked \*\*(target)\*\* or \*\*(to measure)\*\* is a goal for the build, not a result. The published headline must come from the Evaluate page, not from this file.



\---



\## 1. The idea in one paragraph



Most agents send every step to a large generative model: pick a tool, write the arguments, decide whether to stop. layaAgent splits that work the way Kahneman splits thinking. \*\*System 1\*\* is Laya, a typed-decision encoder (ModernBERT-large + 2-layer head, 421M parameters) that reads the situation once and scores a fixed set of options. It is fast, deterministic and returns a calibrated confidence. \*\*System 2\*\* is a small instruction-tuned LLM running in the tab through WebLLM (Qwen2.5 or Llama 3.2, WebGPU). It is slower but can reason and write. Each step goes to System 1 first. If System 1 is confident, the step runs. If not, the step is escalated to System 2 (or to the user when no WebGPU is available). The screen shows the split live, per step and per session.



\*\*Why it matters:\*\* it answers a practical question nobody has measured in the open: \*how much of an agent's work actually needs a generative model?\* If most steps can be handled by a small encoder, agents get cheaper, faster, more predictable and easier to audit.



\---



\## 2. Headline metric (what the page displays)



A live banner, updated after every step:



```

&#x20;System 1 (Laya 421M)   ██████████████████████░░░   N% of steps   median X ms

&#x20;System 2 (WebLLM)      ███░░░░░░░░░░░░░░░░░░░░░░   M% of steps   median Y ms

&#x20;Human                  ░░░░░░░░░░░░░░░░░░░░░░░░░   K% of steps

&#x20;S1 auto-step error rate (shadow-checked): E%       Task success: T%

```



Target shape for the article headline: \*"88% of agent steps handled by a 421M encoder in the tab; 12% escalated to an in-browser LLM"\* — \*\*only if the Evaluate page produces numbers in that range.\*\*



Two honesty rules built into the metric:



1\. \*\*Latency is measured, never quoted.\*\* Laya on WASM/CPU (int8, 512 tokens) is likely hundreds of milliseconds per pass, not \~30 ms; \~30 ms is only plausible on WebGPU with short inputs. The banner shows the measured median and p95 on the visitor's own device, labeled with the backend (WASM / WebGPU) and build (q8e8 / q4e8).

2\. \*\*The split is useless without the error rate.\*\* A high S1 share is easy to fake with a low threshold. The page therefore reports the \*\*S1 auto-step error rate\*\*, measured on the labeled task suite and, live, by \*shadow mode\* (see §7.3). The article should quote the split and the error rate together.



\---



\## 3. What a user sees



\*\*Main view: Agent\*\*

\- A goal box ("What's the weather this weekend in the city where the Eiffel Tower is?") and a Run button, plus 10–15 preset goals.

\- The \*\*trace DAG\*\* (Cytoscape + dagre) grows step by step as the agent runs. Nodes are colored by who decided: S1 (blue), S2 (purple), human (amber), blocked (red).

\- A side panel for the selected node: the exact typed questions sent to Laya, the probabilities for every option, the confidence and threshold, and, for escalated steps, the prompt and JSON reply from System 2.

\- The \*\*split banner\*\* from §2.

\- A \*\*threshold slider\*\*. Moving it re-routes stored decisions without calling the models again (same trick as layaForWorkflows Analytics), so the viewer sees how the S1/S2 split and error rate trade off.



\*\*Evaluate view\*\* (same pattern as `rag-eval.html` in layaAsRagJudge)

\- Runs the whole task suite, scores against gold labels, draws the coverage vs accuracy curve, and reports all metrics in §7.



\*\*Playback before download\*\*

\- Laya is 290–440 MB and a WebLLM model is 0.4–1 GB. Until the visitor chooses to load them, the page replays recorded runs from `web/recorded.json` so the demo works instantly (same approach as the earlier Laya projects).



\---



\## 4. Architecture



```

&#x20;                ┌───────────────────────────────────────────────────────────┐

&#x20;goal ─────────► │ Agent state: goal, step history, last observation, notes  │

&#x20;                └──────────────┬────────────────────────────────────────────┘

&#x20;                               │ state text (budgeted to ≤ 512 tokens)

&#x20;                               ▼

&#x20;                ┌───────────────────────────────┐

&#x20;                │ SYSTEM 1: Laya decision pass  │  one forward pass, several typed questions:

&#x20;                │  next\_action  (choice)        │   - which tool, or FINISH

&#x20;                │  goal\_met     (yes/no)        │   - is the goal answered

&#x20;                │  risky        (yes/no)        │   - does this action need confirmation

&#x20;                └──────────────┬────────────────┘

&#x20;                               │

&#x20;                    ┌──────────▼──────────┐

&#x20;                    │ Candidate extractor │  compromise.js + regex over goal + observations

&#x20;                    │ (no model)          │  → places, people, orgs, topics, dates, URLs, numbers

&#x20;                    └──────────┬──────────┘

&#x20;                               ▼

&#x20;                ┌───────────────────────────────┐

&#x20;                │ SYSTEM 1: argument pass       │  one choice question per tool slot;

&#x20;                │  slot → pick one span / NONE  │  options = candidate spans + "none of these"

&#x20;                └──────────────┬────────────────┘

&#x20;                               ▼

&#x20;                       ┌───────────────┐

&#x20;                       │  Gate         │  per decision: confidence ≥ τ ?

&#x20;                       └──┬─────┬───┬──┘

&#x20;                  AUTO    │     │   │  BLOCK (risky \& confident)

&#x20;             (run it)     │  HOLD   └──────────► ask user to confirm / refuse

&#x20;                          │     │

&#x20;                          │     ▼

&#x20;                          │  ┌────────────────────────────────┐

&#x20;                          │  │ SYSTEM 2: WebLLM (JSON schema) │ same options + free-text slot

&#x20;                          │  │ or HUMAN if no WebGPU          │ allowed when S1 chose NONE

&#x20;                          │  └──────────────┬─────────────────┘

&#x20;                          ▼                 ▼

&#x20;                    ┌─────────────────────────────┐

&#x20;                    │ Tool executor (browser only)│ ──► observation ──► back to state

&#x20;                    └─────────────────────────────┘

&#x20;                               │

&#x20;                               ▼

&#x20;                    Trace recorder ─► Cytoscape DAG, metrics, recorded.json

```



\### 4.1 Design rule inherited from the other Laya projects



Laya never writes. Something else proposes the options (the tool registry, compromise.js, regex, the observation text), Laya picks one, and the confidence gate sends the rest to System 2 or a person. This keeps System 1 deterministic and auditable.



\### 4.2 Why two Laya passes per step, not one



Action selection and argument selection need different option sets. The action pass's options are the tools; the argument pass's options are spans that only make sense once the tool (and so its slot types) is known. Both passes are short, and slots for the same tool are asked together in one `systemOne` call.



\---



\## 5. Components



\### 5.1 Tool registry (all callable from a static page)



Each tool declares its slots, the candidate types each slot accepts, and a result template. Keep the registry under \~12 tools so the action question stays well inside Laya's \~20-option limit.



| Tool | Slots (candidate type) | Backend | Notes |

|---|---|---|---|

| `wiki\_lookup` | `topic` (entity / noun phrase) | Wikipedia REST summary API (CORS, no key) | Returns the lead paragraph; main source of multi-hop facts |

| `wikidata\_fact` | `entity`, `property` (fixed list: capital, population, founded, CEO…) | Wikidata API | Property is a Laya choice over a fixed list; population etc. returned as data, never reasoned by Laya |

| `weather` | `place`, `when` (date span / "today" / "this weekend") | Geocoding + forecast from Open-Meteo (CORS, no key) | Dates normalized by compromise-dates |

| `calculator` | `expression` (regex-extracted arithmetic) | Local JS (safe parser, no `eval`) | Laya is weak with numbers, so all arithmetic goes here |

| `unit\_convert` | `quantity`, `to\_unit` (fixed list) | Local JS | |

| `date\_math` | `date`, `offset` | Local JS | "3 weeks after March 4" |

| `note\_save` | `text` (clause after "remember/note that") | IndexedDB | Agent memory across sessions in the same browser |

| `note\_search` | `query` (noun phrase) | MiniLM embeddings over notes (from layaAsRagJudge) | |

| `verify\_claim` | `claim` (sentence) | layaAsRagJudge pipeline over notes / fetched text | Lets the agent check its own answer before finishing |

| `open\_url` | `url` | fetch through CORS only; shows a notice if blocked | Optional; many sites will be blocked by CORS |

| `ask\_user` | `question` (S2 or template) | UI prompt | Always available |

| `FINISH` | — | Compose answer (§5.6) | |



\### 5.2 State serialization (the 512-token budget)



Laya reads at most 512 tokens of state. The agent state is rendered into a compact JSON object with a fixed budget:



```js

const state = {

&#x20; goal: "What's the weather this weekend in the city where the Eiffel Tower is?",

&#x20; steps\_done: \[                        // last 4 steps only, one line each

&#x20;   "wiki\_lookup(Eiffel Tower) -> located in Paris, France"

&#x20; ],

&#x20; last\_observation: "The Eiffel Tower is a wrought-iron lattice tower in Paris, France…", // truncated to \~180 tokens

&#x20; notes\_hit: null

};

```



Budget, in tokens: goal ≤ 80, history ≤ 120, last observation ≤ 200, the rest for question text. Older observations are summarized by the tool's result template (not by an LLM), so System 1 stays model-free for state handling.



\### 5.3 System 1: decision pass



```js

const actionQuestions = {

&#x20; next\_action: {

&#x20;   type: "choice",

&#x20;   instructions: "Which step should the assistant take next to achieve the goal?",

&#x20;   criteria: Object.fromEntries(tools.map(t => \[t.id, t.whenToUse]))   // e.g. weather: "Get the forecast for a place and time"

&#x20; },

&#x20; goal\_met: { type: "noul", instructions: "The information gathered so far fully answers the goal" },

&#x20; risky:    { type: "noul", instructions: "The next step would save, send or change something on the user's behalf" }

};

const d = await laya.systemOne(state, actionQuestions);

// d.next\_action = { choice: "weather", probabilities: {...}, confidence: 0.71 }

```



\- `criteria` descriptions matter more than names. Write them as short "use this when…" phrases and tune them on the dev split of the task suite.

\- `goal\_met` above its cutoff forces `FINISH` even if `next\_action` disagrees; a disagreement between the two is itself a HOLD signal.



\### 5.4 Candidate extraction and the argument pass ("extraction by choice")



Laya can't write an argument, but it can choose one from a list. The extractor builds the list from the goal plus the last observation:



```js

import nlp from "compromise";

import datePlugin from "compromise-dates";

nlp.plugin(datePlugin);



function candidates(text) {

&#x20; const doc = nlp(text);

&#x20; return dedupe(\[

&#x20;   ...doc.places().out("array").map(s => ({ span: s, kind: "place" })),

&#x20;   ...doc.people().out("array").map(s => ({ span: s, kind: "person" })),

&#x20;   ...doc.organizations().out("array").map(s => ({ span: s, kind: "org" })),

&#x20;   ...doc.topics().out("array").map(s => ({ span: s, kind: "topic" })),

&#x20;   ...doc.nouns().out("array").map(s => ({ span: s, kind: "noun" })),

&#x20;   ...doc.dates().out("array").map(s => ({ span: s, kind: "date" })),

&#x20;   ...doc.urls().out("array").map(s => ({ span: s, kind: "url" })),

&#x20;   ...extractArithmetic(text).map(s => ({ span: s, kind: "expression" }))   // regex

&#x20; ]).slice(0, 19);                                                             // + NONE = 20 options

}

```



Then one choice question per slot of the chosen tool:



```js

const argQuestions = {

&#x20; place: {

&#x20;   type: "choice",

&#x20;   instructions: "Which place should the weather forecast be for?",

&#x20;   criteria: { ...Object.fromEntries(cands.filter(c => placeLike(c)).map((c, i) => \[`c${i}`, c.span])),

&#x20;               NONE: "None of these is the right place" }

&#x20; },

&#x20; when: { /\* same shape, date candidates + "today" + "this weekend" + NONE \*/ }

};

```



Rules:

\- Filter candidates by the slot's accepted kinds before asking, so Laya chooses among plausible spans only.

\- Always include `NONE`. If Laya picks `NONE` confidently, the slot needs a value that is not in the text (for example a rewritten search query), which is exactly System 2's job.

\- More than 19 candidates: rank by MiniLM similarity to the slot description and keep the top 19.



\### 5.5 The gate



Per decision, confidence = 1 − normalized entropy (as in layaForWeb). Separate thresholds for action and argument decisions, both adjustable live:



| Condition | Route |

|---|---|

| `risky` = true with confidence ≥ τ\_risk | \*\*BLOCK\*\*: user must confirm (fails closed, like the guardrail workflow) |

| action conf ≥ τ\_action \*\*and\*\* every slot conf ≥ τ\_arg \*\*and\*\* no slot = NONE | \*\*AUTO\*\* (System 1 runs the step) |

| otherwise | \*\*HOLD\*\* → System 2; if WebGPU is unavailable or S2 is not loaded → human |



Notes carried over from layaAsRagJudge: this checkpoint's probabilities are compressed, so sensible thresholds will be low (the RAG judge's default gate was 0.10 entropy-confidence, not 0.9). Pick τ from the coverage vs accuracy curve on the dev split, then freeze it for the test split.



Also HOLD when:

\- the same tool with the same arguments was just run (loop guard),

\- `goal\_met` and `next\_action` disagree,

\- the step count exceeds a budget (default 8).



\### 5.6 System 2: WebLLM



```js

import { CreateMLCEngine } from "@mlc-ai/web-llm";



const s2 = await CreateMLCEngine("Qwen2.5-1.5B-Instruct-q4f16\_1-MLC", { initProgressCallback });



const reply = await s2.chat.completions.create({

&#x20; temperature: 0,

&#x20; messages: \[

&#x20;   { role: "system", content: S2\_SYSTEM\_PROMPT },

&#x20;   { role: "user", content: JSON.stringify({

&#x20;       goal: state.goal, history: state.steps\_done, observation: state.last\_observation,

&#x20;       tools: tools.map(t => ({ id: t.id, use: t.whenToUse, slots: t.slots })),

&#x20;       system1\_view: { top3\_actions: top3(d.next\_action), slot\_candidates: argQuestions } }) }

&#x20; ],

&#x20; response\_format: { type: "json\_object", schema: JSON.stringify(STEP\_SCHEMA) }   // constrained decoding

});

```



\- `STEP\_SCHEMA` = `{ action: enum(tool ids), args: { slot: string }, reason: string }`. Constrained JSON keeps S2 inside the same action space as S1, so both can be compared step by step.

\- S2 sees S1's top-3 options and probabilities. That keeps the prompt short and lets the article show \*where the two systems disagree\*.

\- S2 is also the only component allowed to write free text: a rewritten search query when S1 chose `NONE`, the `ask\_user` question, and the final answer when the tool templates aren't enough.

\- Model choice is a setting: Qwen2.5-0.5B (fastest, weakest), Qwen2.5-1.5B (default), Llama-3.2-1B. Check the current WebLLM prebuilt model list when building; IDs change between releases.

\- No WebGPU: S2 is disabled, HOLD goes to the user, and the banner says so. The agent still works; it just asks more.



\### 5.7 Composing the final answer



`FINISH` builds the answer from tool result templates (for example `"Forecast for {{place}}, {{when}}: {{summary}}"`) plus the list of sources used. If S2 is loaded, a toggle lets it rewrite the templated answer into one paragraph, and the node is marked "written by S2". Optionally run `verify\_claim` on the final answer before showing it (the agent checking itself with the RAG judge).



\### 5.8 Trace recorder and DAG



Every step writes a record:



```js

{

&#x20; step: 2, decidedBy: "S1" | "S2" | "human" | "blocked",

&#x20; action: { choice: "weather", probabilities: {...}, confidence: 0.64 },

&#x20; args:   { place: { choice: "Paris", confidence: 0.58, candidates: \[...] }, when: {...} },

&#x20; s2: null | { prompt, reply, agreedWithS1: true },

&#x20; tool:   { id: "weather", input: {...}, ms: 412, ok: true },

&#x20; observation: "Sat 19°C light rain, Sun 22°C sunny",

&#x20; latency: { s1\_ms: 380, s2\_ms: null }

}

```



Graph mapping, reusing `graphs.js` from layaForWorkflows:

\- \*\*Decision node\*\* (diamond) per step, colored by `decidedBy`; size = confidence.

\- \*\*Tool node\*\* (box) with the call and its latency.

\- \*\*Observation node\*\* (note shape), truncated, full text on click.

\- \*\*Alternative edges\*\*: the next two actions S1 considered, dashed, labeled with their probability. Clicking one runs a \*\*what-if replay\*\* from that step with that choice (the replay logic exists in `engine.js`).

\- \*\*Escalation edges\*\* in amber from the S1 diamond to the S2 node when HOLD fired.

\- A second tab, \*\*Session graph\*\*, merges all runs so heavily used paths and common escalation points stand out (like the Traffic mode in layaForWorkflows).

\- Export the trace as JSON and as RDF with the existing `ontology.js` (a `Run` with `Decision`s, extended with a `decidedBy` property), so traces can be queried with SPARQL elsewhere.



\---



\## 6. Repository layout



| Path | What it is | Source |

|---|---|---|

| `web/index.html`, `main.js`, `styles.css` | Agent page | new |

| `web/eval.html`, `eval.js` | Evaluate page | pattern from layaAsRagJudge `rag-eval.\*` |

| `web/agent.js` | Agent loop: state → S1 → gate → S2/human → tool → observation. No DOM | new |

| `web/state.js` | State serialization and token budgeting | new |

| `web/candidates.js` | compromise.js + regex extraction, slot filtering | new |

| `web/tools/\*.js` | One file per tool; each exports `{ id, whenToUse, slots, run, template }` | new |

| `web/system2.js` | WebLLM loader, prompt, JSON schema, WebGPU detection | new |

| `web/gate.js` | AUTO / HOLD / BLOCK logic and thresholds | from layaForWorkflows / layaAsRagJudge |

| `web/trace.js` | Trace records, replay, recorded-run compaction | new, replay from `engine.js` |

| `web/graphs.js` | Cytoscape trace and session graphs | from layaForWorkflows |

| `web/ontology.js` | Trace to Turtle / JSON-LD | from layaForWorkflows |

| `web/laya-core.js`, `web/model.js` | Laya inference and model download/cache | unchanged from layaForWeb |

| `web/embedder.js`, `web/store.js`, `web/judge.js` | MiniLM, IndexedDB, claim verifier | from layaAsRagJudge |

| `web/metrics.js` | Metrics in §7 | extended from layaAsRagJudge |

| `web/tasks.json` | Task suite with gold traces | new |

| `web/recorded.json` | Recorded runs for playback | generated |

| `web/coi.js`, `coi-sw.js` | COOP/COEP service worker for threaded WASM on Pages | from existing projects |

| `tests/\*.test.mjs` | Node unit tests: gate, state budget, candidates, tools with mocked fetch, metrics | new |

| `scripts/prepare\_site.mjs` | Assemble `dist/` with vendored libs | from existing projects |

| `.github/workflows/deploy.yml` | Test, build, publish to Pages | from existing projects |



Vendored libraries: ONNX Runtime Web, Tokenizers.js, Cytoscape.js, cytoscape-dagre, compromise, compromise-dates, @mlc-ai/web-llm. Record each license in `NOTICE.md` and `licenses/`, as in the other repos.



\---



\## 7. Evaluation



\### 7.1 Task suite (`web/tasks.json`)



About 120 synthetic goals, split 40 dev / 80 test, each with a gold trace (tool sequence and argument values). All examples synthetic and general-purpose (no finance, no personal data).



| Category | Example | Tests |

|---|---|---|

| Single tool, argument in text | "Weather in Lisbon tomorrow" | Action + extraction by choice |

| Multi-hop | "Population of the country where Kyoto is" | Using an observation span as the next argument |

| Arithmetic | "What's 18% of 2,450?" | Routing numbers to the calculator |

| Memory | "Remember my book club is on Thursdays" → later "When is book club?" | note\_save / note\_search |

| Needs rewriting | "That tall tower in Paris, how tall is it?" | S1 should pick NONE / escalate |

| Ambiguous | "Weather in Springfield" | Should HOLD or ask\_user, not guess |

| Should refuse or confirm | "Delete all my notes" | risky → BLOCK |

| Stop correctly | Goals answered after one step | goal\_met, no extra steps |



\### 7.2 Metrics



| Metric | Definition |

|---|---|

| S1 share | Steps decided by S1 / all steps |

| S2 share, human share | Same for S2 and human |

| \*\*S1 auto-step error rate\*\* | S1 AUTO steps whose action or arguments differ from gold |

| Action accuracy, argument accuracy | Per step, split by who decided |

| Task success | Final answer matches gold (exact values for tool outputs; recorded tool responses to keep it deterministic) |

| Steps per task, loop rate | Efficiency and loop guard triggers |

| Escalation precision | Of HOLD steps, share where S1's top pick was actually wrong (were escalations needed?) |

| Latency | p50 / p95 per system, per backend (WASM, WebGPU), per build |

| Coverage vs accuracy curve | As τ moves: S1 share on x, S1 auto-step accuracy on y |

| Baselines | (a) S2 only, every step; (b) S1 only, no gate; (c) hybrid. Report success and latency for all three |



The baseline comparison is the result that makes the article: \*hybrid success within a few points of S2-only, at a fraction of the S2 calls and time\* \*\*(target)\*\*.



\### 7.3 Shadow mode (live, on the main page)



Optional toggle: on a random 10% of S1 AUTO steps, also ask S2 (without using its answer) and record agreement. The banner shows the live S1/S2 agreement rate, so visitors can see that System 1's automatic steps are checked, not just trusted.



\### 7.4 Determinism



For the Evaluate page, tool responses are recorded (`tasks.json` stores the API payloads), so results do not change when Wikipedia or the weather does. A "live tools" switch reruns against real APIs.



\---



\## 8. Deployment on GitHub Pages



\- `deploy.yml`: `npm ci` → `npm test` → `node scripts/prepare\_site.mjs` → publish `dist/` (Settings → Pages → Source: GitHub Actions).

\- Models are not in the repo. Laya loads from `VishalMysore/layaForWebTrained` on Hugging Face (override with `?modelBase=`). WebLLM loads its weights from its own Hugging Face repos. Both are cached by the browser after the first visit.

\- `coi-sw.js` adds COOP/COEP headers so ONNX Runtime can use threads.

\- \*\*Memory budget:\*\* Laya q8e8 (\~440 MB) + Qwen2.5-1.5B q4 (\~1 GB of GPU memory) + MiniLM (\~23 MB). Offer the q4e8 Laya build and the 0.5B S2 model as a "light" mode, and load S2 lazily on the first HOLD, not at page load.

\- Browser support: full hybrid needs WebGPU (recent Chrome / Edge; others vary). Without it the page runs System 1 + human.

\- CORS: only tools whose APIs send CORS headers work without a backend. That is why the registry sticks to Wikipedia, Wikidata and Open-Meteo.



\---



\## 9. Build plan



| Milestone | Deliverable | Done when |

|---|---|---|

| M1: skeleton | Page, model loading, playback, 4 tools (wiki, weather, calculator, notes) | A preset goal runs end to end with S1 only |

| M2: extraction by choice | `candidates.js`, argument pass, NONE handling | Argument accuracy measured on dev split |

| M3: gate + System 2 | WebLLM loader, JSON schema, HOLD → S2, BLOCK → confirm | Escalated steps complete; no-WebGPU fallback works |

| M4: trace DAG | Cytoscape trace, alternatives, what-if replay, session graph | Every step clickable with probabilities and S2 prompt |

| M5: Evaluate page | Task suite, metrics, baselines, coverage curve | Test-split numbers frozen |

| M6: polish + publish | Recorded runs, README, article with screenshots, Pages deploy | Live URL, numbers in README match the Evaluate page |



\---



\## 10. Risks and how the design handles them



| Risk | Mitigation |

|---|---|

| Laya is weak with numbers and contradictions (seen in layaForWorkflows and layaAsRagJudge) | All arithmetic goes to tools; numeric facts come from Wikidata; Laya only chooses \*which\* tool |

| Compressed probabilities make thresholds hard to pick | Tune τ on dev from the coverage curve; show the curve on the page |

| Candidate extractor misses the right span | `NONE` option → S2; measure extractor recall separately so its errors aren't blamed on Laya |

| 512-token state limit | Fixed budget per state field, template summaries of old observations |

| Tool descriptions drive action accuracy | Tune `whenToUse` text on dev only; report on test |

| Large downloads scare visitors | Playback first, explicit Load buttons, light mode, cached after first visit |

| The headline split looks cherry-picked | Always publish it with the S1 error rate, the baselines and the threshold used |

| WebLLM model IDs or APIs change | Pin the WebLLM version in `package.json`; keep the model list in one config file |



\---



\## 11. Article outline



\*\*Working title:\*\* \*How much of an AI agent needs an LLM? I split one in half inside a browser tab.\*



1\. The question: agents call a big model for every step, including trivial ones.

2\. System 1 / System 2, in one diagram.

3\. Extraction by choice: getting tool arguments from a model that can't write.

4\. The gate and why the confidence scale is compressed (link back to the RAG judge article).

5\. Results: the split, the S1 error rate, hybrid vs S2-only vs S1-only, latency on WASM vs WebGPU.

6\. Where System 1 fails and why (with trace screenshots).

7\. Try it: live link, no key, nothing leaves your browser.



\*\*Series link:\*\* layaForWeb (the model) → layaForWorkflows (decisions as a graph) → layaAsRagJudge (decisions as a judge) → \*\*layaAgent (decisions as an agent)\*\*.



\---



\## 12. License and credits



Apache License 2.0. The decision model is a modified derivative of Laya by ConvAI Innovations (Apache-2.0), built on ModernBERT-large by Answer.AI and LightOn. System 2 models are loaded at runtime under their own licenses (check the Qwen and Llama licenses before listing defaults). Ships ONNX Runtime Web (MIT), Tokenizers.js (Apache-2.0), Cytoscape.js (MIT), cytoscape-dagre (MIT), compromise (MIT) and WebLLM (Apache-2.0). Unofficial project, not affiliated with ConvAI Innovations.

