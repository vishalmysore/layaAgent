// Agent page: run goals live (System 1 + System 2 / you), replay recorded runs before any download, inspect every
// decision, re-route stored decisions at other thresholds, what-if replays, session graph, export.
import { $, esc, pct, num, msText, settings, M, onModelsChanged, initModelCard, loadRecorded, loadTasks, loadNlp, loadS2, countTokens, download, bars } from "./common.js";
import { runAgent, split } from "./agent.js";
import { DEFAULTS, METRICS, score } from "./gate.js";
import { TOOL, TOOLS, FINISH } from "./tools/index.js";
import { memoryNotes } from "./tools/notes.js";
import { browserNotes } from "./notesdb.js";
import { renderTrace, renderSession, WHO } from "./graphs.js";
import { compactRun, reroute, stepQuestions, toTurtle } from "./trace.js";
import { evaluate } from "./metrics.js";
import { topOptions, ARG_PREFIX } from "./questions.js";
import { NONE, slotOptions } from "./candidates.js";

const PRESETS = [
  "What's the weather this weekend in the city where the Eiffel Tower is?",
  "What is the population of the country where Kyoto is?",
  "Who is the CEO of the company that makes the iPhone?",
  "What is 15% of the population of Iceland?",
  "What's 18% of 2,450?",
  "Convert 5 miles to kilometers",
  "What date is 3 weeks after March 4?",
  "Tell me about Marie Curie",
  "How tall is that iron tower in Paris?",
  "Weather in Springfield",
  "Remember my book club is on Thursdays",
  "When does my book club meet?",
  "Delete all my notes about the dentist",
  "Send Priya a message saying I'll be late",
];

const S = {
  runs: [], current: null, running: false, abort: null, recorded: null, tasks: null, evalRecords: null,
  gate: { ...DEFAULTS, ...settings.get("gate", {}) }, sel: null, cy: null, cySession: null, tab: "trace", forcedAt: null,
};
const gateOpts = () => ({ ...S.gate });

// ---- gate controls ----------------------------------------------------------------------------------------------
function initGate() {
  const m = $("metric");
  for (const [k, v] of Object.entries(METRICS)) m.add(new Option(v, k));
  const sync = () => {
    $("tauAction").value = S.gate.tauAction; $("tauArg").value = S.gate.tauArg; $("tauStop").value = S.gate.tauStop; $("tauStopVal").textContent = num(S.gate.tauStop); m.value = S.gate.metric;
    $("useGoalMet").checked = S.gate.useGoalMet; $("useRisk").checked = S.gate.useRisk; $("maxSteps").value = String(S.gate.maxSteps);
    $("tauActionVal").textContent = num(S.gate.tauAction); $("tauArgVal").textContent = num(S.gate.tauArg);
  };
  sync();
  const upd = () => {
    S.gate = { ...S.gate, tauAction: +$("tauAction").value, tauArg: +$("tauArg").value, tauStop: +$("tauStop").value, metric: m.value, useGoalMet: $("useGoalMet").checked, useRisk: $("useRisk").checked, maxSteps: +$("maxSteps").value };
    settings.set("gate", S.gate); sync(); renderAll(false);
  };
  for (const id of ["tauAction", "tauArg", "tauStop"]) $(id).addEventListener("input", upd);
  for (const id of ["metric", "useGoalMet", "useRisk", "maxSteps"]) $(id).addEventListener("change", upd);
  for (const id of ["autoS2", "shadow", "rewrite"]) { $(id).checked = settings.get(id, false); $(id).addEventListener("change", () => settings.set(id, $(id).checked)); }
}

// ---- dialogs: you as the fallback decider, the guard, ask_user ---------------------------------------------------
function dialog(el) { return new Promise((res) => { el.returnValue = ""; el.addEventListener("close", () => res(el.returnValue), { once: true }); el.showModal(); }); }

async function humanDecide({ reasons, s1View: view, proposal, candidates }) {
  const dlg = $("decideDlg"), sel = $("decAction");
  $("decideWhy").innerHTML = (reasons || []).map((r) => `<li>${esc(r)}</li>`).join("") || "<li>System 2 is not available</li>";
  const top = view.top_actions.map((a) => a.action);
  const order = [...top, ...TOOLS.map((t) => t.id).filter((id) => !top.includes(id))];
  sel.innerHTML = order.map((id) => { const p = view.top_actions.find((a) => a.action === id)?.p; return `<option value="${id}">${esc(id)}${p != null ? ` (Laya p ${p.toFixed(2)})` : ""} · ${esc(TOOL[id].whenToUse)}</option>`; }).join("");
  sel.value = proposal?.action || top[0];
  const cands = candidates || [];
  const drawArgs = () => {
    const t = TOOL[sel.value];
    $("decArgs").innerHTML = t.slots.map((s) => {
      const pre = sel.value === proposal?.action && proposal.args?.[s.name] && proposal.args[s.name] !== NONE ? proposal.args[s.name] : "";
      if (s.fixed) return `<div class="field"><label>${esc(s.instruction)}</label><select data-slot="${s.name}">${Object.entries(s.fixed).map(([k, l]) => `<option value="${esc(k)}"${k === pre ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;
      const opts = Object.keys(slotOptions(s, cands)).filter((k) => k !== NONE);
      return `<div class="field"><label>${esc(s.instruction)}</label><input type="text" data-slot="${s.name}" list="dl_${s.name}" value="${esc(pre)}" required><datalist id="dl_${s.name}">${opts.map((o) => `<option value="${esc(o)}">`).join("")}</datalist></div>`;
    }).join("") + (t.id === "ask_user" ? `<div class="field"><label>Question to ask</label><input type="text" data-slot="question" value="Could you be more specific?"></div>` : "");
  };
  sel.onchange = drawArgs; drawArgs();
  const v = await dialog(dlg);
  if (v !== "ok") return null;
  const args = {};
  for (const el of $("decArgs").querySelectorAll("[data-slot]")) args[el.dataset.slot] = el.value.trim();
  return { action: sel.value, args };
}

async function humanConfirm({ action, args, reason, decidedBy }) {
  $("confirmTxt").innerHTML = `<b>${esc(action)}</b>(${esc(Object.values(args || {}).join(", "))})<br><span class="hint">This ${esc(reason.replace(/^\S+\s/, ""))}.</span>`;
  $("confirmWho").textContent = `Chosen by ${WHO[decidedBy] || decidedBy}. The agent never runs tools that change something without asking.`;
  return (await dialog($("confirmDlg"))) === "yes";
}

async function askUser(q) {
  $("askQ").textContent = q; $("askA").value = "";
  return (await dialog($("askDlg"))) === "ok" ? $("askA").value.trim() || null : null;
}

// ---- running -------------------------------------------------------------------------------------------------------
function s2Wrapper() {
  const lazy = $("autoS2").checked && M.webgpu;
  if (!M.s2 && !lazy) return null;
  return {
    ready: () => !!M.s2 || lazy,
    async decide(p) { if (!M.s2) await loadS2(); if (!M.s2) throw new Error("System 2 did not load"); return M.s2.decide(p); },
    async rewrite(g, t, st) { if (!M.s2) throw new Error("no System 2"); return M.s2.rewrite(g, t, st); },
  };
}

function liveDeps(extra = {}) {
  return {
    laya: M.laya, nlp: M.nlp, countTokens: countTokens(), s2: s2Wrapper(),
    toolCtx: { notes: browserNotes, askUser },
    human: { decide: humanDecide, confirm: humanConfirm },
    ...extra,
  };
}

async function run({ goal, prefix, force, forcedAt } = {}) {
  goal = (goal ?? $("goal").value).trim();
  if (!goal || S.running) return;
  if (!M.laya) {
    const rec = S.recorded?.traces?.[goal];
    if (rec) return playback(rec);
    $("runHint").textContent = "Load System 1 above to run your own goal (the preset goals with ▶ replay recorded runs without it).";
    return;
  }
  S.running = true; S.abort = new AbortController(); setBusy(true);
  S.forcedAt = forcedAt ?? null;
  const current = { goal, steps: [], outcome: null, source: "live", live: true };
  S.current = current; S.runs.push(current); S.sel = null;
  $("runHint").textContent = force ? `What-if: replaying from step ${forcedAt + 1} with ${force.action}…` : "Running…";
  try {
    await loadNlp();
    const res = await runAgent(goal, liveDeps(), {
      ...gateOpts(), shadowRate: $("shadow").checked ? 0.1 : 0, rewrite: $("rewrite").checked, prefix, force, signal: S.abort.signal,
      onStep: (rec, steps) => { current.steps = steps.slice(); renderAll(true); },
    });
    Object.assign(current, res, { source: force ? "what-if" : "live" });
    $("runHint").textContent = `Done in ${msText(res.totalMs)}.`;
  } catch (e) {
    console.error(e); current.outcome = { kind: "error", text: String(e?.message || e) };
    $("runHint").textContent = "Error: " + (e?.message || e);
  } finally { S.running = false; setBusy(false); renderAll(true); refreshNotes(); }
}

async function playback(rec) {
  S.running = true; setBusy(true);
  const current = { ...rec, steps: [], outcome: null, source: "recorded" };
  S.current = current; S.runs.push(current); S.sel = null; S.forcedAt = null;
  $("runHint").textContent = "Replaying a run recorded from the same models (load System 1 to run it live).";
  for (const s of rec.steps) {
    if (!S.running) break;
    current.steps.push(s); renderAll(true);
    await new Promise((r) => setTimeout(r, 450));
  }
  current.outcome = rec.outcome; current.totalMs = rec.totalMs;
  S.running = false; setBusy(false); renderAll(true);
}

function setBusy(b) { $("runBtn").disabled = b; $("stopBtn").disabled = !b; }

async function whatIf(stepIndex, action) {
  if (!M.laya) { $("runHint").textContent = "What-if replays need System 1: load it above."; return; }
  if (S.running) return;
  const base = S.current;
  const prefix = base.steps.slice(0, stepIndex).map((s) => ({ ...s }));
  await run({ goal: base.goal, prefix, force: { action }, forcedAt: stepIndex });
}

// ---- rendering ------------------------------------------------------------------------------------------------------
function renderAll(traceChanged) {
  renderBanner(); renderEvalSummary();
  if (!S.current) return;
  renderAnswer(); renderSteps();
  if (S.tab === "trace") renderTraceGraph();
  if (S.tab === "session") renderSessionGraph();
  if (S.tab === "export") renderExport();
  if (S.sel != null) renderInspector(S.sel.kind, S.sel.step, S.sel.data);
}

function renderBanner() {
  const runs = S.runs.filter((r) => r.steps.length);
  const sp = split(runs);
  const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  const rows = [
    ["S1", "System 1 · Laya", "c-s1", sp.S1, med(sp.ms.S1)],
    ["S2", "System 2 · WebLLM", "c-s2", sp.S2, med(sp.ms.S2)],
    ["human", "You", "c-human", sp.human, null],
    ["guard", "Asked your OK", "c-block", sp.blocked, null],
  ];
  $("splitRows").innerHTML = rows.map(([k, label, c, n, ms]) => {
    const f = sp.total ? n / sp.total : 0;
    return `<div class="srow"><span class="who"><i class="${c}"></i>${label}</span><span class="tr"><span class="f ${c}" style="width:${(f * 100).toFixed(1)}%"></span></span><span class="v">${sp.total ? pct(f) : "–"}</span><span class="ms">${k === "S1" || k === "S2" ? (ms != null ? `median ${msText(ms)}` : "") : `${n} step${n === 1 ? "" : "s"}`}</span></div>`;
  }).join("");
  const rec = runs.filter((r) => r.source === "recorded").length;
  $("bannerScope").textContent = runs.length ? `· ${sp.total} steps in ${runs.length} run${runs.length > 1 ? "s" : ""} this tab${rec ? ` (${rec} recorded)` : ""}` : "· no runs yet";
  const rr = S.current ? reroute(S.current, gateOpts()).filter(Boolean) : [];
  const back = M.info ? `${M.info.backend === "webgpu" ? "WebGPU" : "WASM"} · ${M.info.variant}` : "recorded";
  $("bannerFoot").innerHTML = [
    `System 1 latency measured on ${esc(back)}`,
    sp.shadowN ? `Shadow checks: System 2 agreed on <b>${sp.shadowAgree}/${sp.shadowN}</b> automatic steps` : `Shadow checks: <b>off</b> or none yet`,
    rr.length ? `Current run at this gate: <b>${rr.filter((x) => x === "AUTO").length}</b> automatic, <b>${rr.filter((x) => x === "HOLD").length}</b> held` : "",
  ].filter(Boolean).map((t) => `<span>${t}</span>`).join("");
}

function renderEvalSummary() {
  const recs = S.evalRecords;
  if (!recs?.length) return;
  const test = recs.filter((r) => r.split === "test");
  const e = evaluate(test, gateOpts());
  const succ = e.routers.hybrid || e.routers.human;
  $("evalSummary").innerHTML = `<div class="row">
    <div><div class="l">handled by System 1</div><div class="big">${pct(e.split.S1)}</div></div>
    <div><div class="l">System 1 auto-step error</div><div class="big">${pct(e.autoError)}</div></div>
    <div><div class="l">task success, ${e.hasS2 ? "S1 + S2" : "S1 + you"}</div><div class="big">${pct(succ.rate)}</div></div>
    <div><div class="l">task success, S1 alone</div><div class="big">${pct(e.routers.s1.rate)}</div></div>
  </div><p class="hint">${e.n.tasks} test tasks, ${e.n.steps} steps, ${esc(S.evalMeta || "")}. ${e.hasS2 ? "" : "No System 2 answers in this recording: held steps count as decided by you (assumed correct). "}The split is only meaningful next to the error rate.</p>`;
}

function renderAnswer() {
  const o = S.current.outcome;
  $("answerCard").hidden = !o;
  if (!o) return;
  const label = { answered: "Answer", refused: "Stopped by the guard", stopped: "Stopped", budget: "Step budget reached", error: "Error" }[o.kind] || o.kind;
  $("answer").innerHTML = `<div class="answerbox ${esc(o.kind)}"><div class="k">${label}${o.rewrittenBy ? " · written by System 2" : o.kind === "answered" ? " · from tool results (template)" : ""}${S.current.source === "recorded" ? " · recorded run" : ""}</div>
    <div class="t">${esc(o.text || "")}</div>
    ${o.templated ? `<div class="src">Template answer: ${esc(o.templated)}</div>` : ""}
    ${o.sources?.length ? `<div class="src">Sources: ${o.sources.map((s) => `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(s.replace(/^https?:\/\//, ""))}</a>`).join(" · ")}</div>` : ""}</div>`;
}

function renderSteps() {
  const rr = reroute(S.current, gateOpts());
  $("stepList").innerHTML = S.current.steps.map((s, i) => `<li class="${esc(s.decidedBy)}${S.sel?.step === s.index ? " sel" : ""}" data-step="${s.index}">
    <div class="h"><b>#${s.index + 1}</b><span class="chip ${esc(s.decidedBy)}">${esc(WHO[s.decidedBy] || s.decidedBy)}</span>${s.route ? `<span class="chip ${s.route}">${s.route}</span>` : ""}${rr[i] && rr[i] !== s.route ? `<span class="chip ${rr[i]}">at this gate: ${rr[i]}</span>` : ""}${s.guard ? `<span class="chip guard">${s.guard.allowed ? "you allowed it" : "you refused"}</span>` : ""}${s.replayed ? `<span class="chip">replayed</span>` : ""}${s.s1?.layaMs ? `<span class="hint">S1 ${msText(s.s1.layaMs)}</span>` : ""}${s.s2?.ms ? `<span class="hint">S2 ${msText(s.s2.ms)}</span>` : ""}</div>
    <div class="call">${esc(s.action || "(stopped)")}(${esc(Object.values(s.args || {}).join(", "))})</div>
    ${s.reasons?.length ? `<ul class="reasons">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    ${s.observation ? `<div class="obs">${esc(s.observation)}</div>` : ""}</li>`).join("");
}

function renderTraceGraph() {
  $("traceEmpty").hidden = !!S.current?.steps.length;
  if (!S.current?.steps.length) return;
  S.cy?.destroy();
  S.cy = renderTrace($("traceCanvas"), S.current, { reroute: reroute(S.current, gateOpts()), forcedAt: S.forcedAt }, (kind, step, data) => {
    if (kind === "alt") { if (confirm(`Replay from step ${step + 1} with ${data.alt}? (runs System 1 again from there)`)) whatIf(step, data.alt); return; }
    S.sel = { kind, step, data }; renderInspector(kind, step, data); renderSteps();
  });
}

function renderSessionGraph() {
  const runs = S.runs.filter((r) => r.steps.length);
  $("sessionEmpty").hidden = !!runs.length;
  if (!runs.length) return;
  S.cySession?.destroy();
  S.cySession = renderSession($("sessionCanvas"), runs);
}

function renderExport() {
  const c = compactRun(S.current);
  $("expPreview").textContent = toTurtle(c).slice(0, 4000);
}

const kv = (pairs) => `<div class="kv">${pairs.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join("")}</div>`;

function renderInspector(kind, stepIndex) {
  const el = $("inspector");
  if (kind === "goal") { el.innerHTML = `<h3>Goal</h3><p>${esc(S.current.goal)}</p>`; return; }
  if (kind === "answer" || kind === "end") { el.innerHTML = `<h3>Outcome</h3><p>${esc(S.current.outcome?.text || "")}</p>`; return; }
  const s = S.current.steps.find((x) => x.index === stepIndex);
  if (!s) return;
  const a = s.s1?.answers || {};
  const rr = reroute(S.current, gateOpts())[S.current.steps.indexOf(s)];
  const parts = [`<h3>Step ${s.index + 1}: ${esc(s.action || "stopped")}</h3>`];
  parts.push(kv([
    ["decided by", esc(WHO[s.decidedBy] || s.decidedBy)], ["route", `${esc(s.route || "")}${rr && rr !== s.route ? ` (at the current gate: <b>${rr}</b>)` : ""}`],
    ["System 1", s.s1?.layaMs ? `${msText(s.s1.layaMs)} model time` : ""], ["call", `<code>${esc(s.action)}(${esc(JSON.stringify(s.args || {}))})</code>`],
  ]));
  if (s.reasons?.length) parts.push(`<div class="sec"><b>Why it was held</b><ul class="reasons">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`);
  if (a.next_action) {
    parts.push(`<div class="sec"><b>System 1 · next action</b> <span class="hint">score ${num(score(a.next_action, S.gate.metric))} (${esc(METRICS[S.gate.metric])}), entropy confidence ${num(a.next_action.confidence, 3)}${a.next_action.forced ? " · forced by what-if" : ""}</span>${bars(a.next_action.probabilities, a.next_action.choice)}</div>`);
    parts.push(`<div class="sec">${kv([["p(goal met)", num(a.goal_met?.noul, 3)], ["p(risky)", num(a.risky?.noul, 3)]])}</div>`);
    for (const [k, ans] of Object.entries(a).filter(([k]) => k.startsWith(ARG_PREFIX))) {
      parts.push(`<div class="sec"><b>System 1 · ${esc(k.slice(ARG_PREFIX.length))}</b> <span class="hint">score ${num(score(ans, S.gate.metric))}</span>${bars(ans.probabilities, ans.choice)}</div>`);
    }
    if (!s.replayed) {
      const alts = topOptions(a.next_action, 4).filter((o) => o.key !== s.action);
      parts.push(`<div class="sec"><b>What if</b><div class="alts">${alts.map((o) => `<button data-whatif="${esc(o.key)}">${esc(o.key)} · ${o.p.toFixed(2)}</button>`).join("")}</div><p class="hint">Re-runs the agent from this step with that action${M.laya ? "" : " (load System 1 first)"}.</p></div>`);
    }
  }
  if (s.s2) {
    parts.push(`<div class="sec"><b>System 2</b> ${kv([["reply", `<code>${esc(s.s2.action)}(${esc(JSON.stringify(s.s2.args || {}))})</code>`], ["reason", esc(s.s2.reason)], ["time", msText(s.s2.ms)], ["agreed with S1", s.s2.agreedWithS1 ? "yes" : "no"], ["problem", esc(s.s2.error || s.s2.parseError || "")]])}
      <details><summary>Prompt sent to System 2</summary><pre style="white-space:pre-wrap">${esc(prettyJson(s.s2.prompt))}</pre></details>
      <details><summary>Raw JSON reply</summary><pre style="white-space:pre-wrap">${esc(s.s2.raw || "")}</pre></details></div>`);
  }
  if (s.shadow) parts.push(`<div class="sec"><b>Shadow check</b> ${kv([["System 2 would do", `<code>${esc(s.shadow.action)}(${esc(JSON.stringify(s.shadow.args || {}))})</code>`], ["agreed", s.shadow.agreed ? "yes" : "no"]])}</div>`);
  if (s.guard) parts.push(`<div class="sec"><b>Guard</b> ${kv([["why", esc(s.guard.reason)], ["your answer", s.guard.allowed ? "allowed" : "refused"], ["Laya p(risky)", num(s.guard.layaRisky, 3)]])}</div>`);
  if (s.tool) parts.push(`<div class="sec"><b>Tool</b> ${kv([["time", msText(s.tool.ms)], ["ok", s.tool.ok ? "yes" : "no"], ["error", esc(s.tool.error || "")]])}</div>`);
  if (s.observation) parts.push(`<div class="sec"><b>Observation</b><p>${esc(s.observation)}</p></div>`);
  if (s.candidates?.length) parts.push(`<div class="sec"><b>Candidate spans</b> <span class="hint">(compromise + regex, no model)</span><div class="chips" style="margin-top:4px">${s.candidates.map((c) => `<span class="chip" title="${esc(c.kind)} · from ${esc(c.from)}">${esc(c.span)}</span>`).join("")}</div></div>`);
  if (s.state) parts.push(`<details><summary>State Laya read</summary><pre style="white-space:pre-wrap">${esc(JSON.stringify(s.state, null, 1))}</pre></details><details><summary>Typed questions</summary><pre style="white-space:pre-wrap">${esc(JSON.stringify(stepQuestions(s), null, 1))}</pre></details>`);
  el.innerHTML = parts.join("");
  el.querySelectorAll("[data-whatif]").forEach((b) => b.addEventListener("click", () => whatIf(s.index, b.dataset.whatif)));
}
const prettyJson = (t) => { try { return JSON.stringify(JSON.parse(t), null, 1); } catch { return t || ""; } };

// ---- notes ------------------------------------------------------------------------------------------------------------
async function refreshNotes() {
  const all = await browserNotes.all();
  $("noteCount").textContent = `· ${all.length} saved`;
  $("notesList").innerHTML = all.map((n) => `<li>${esc(n.text)}</li>`).join("") || `<li class="hint">No notes yet.</li>`;
}

// ---- recording hooks (used once to produce recorded.json; see README) -------------------------------------------------
globalThis.__la = {
  S, M,
  /** Run every preset non-interactively: gold decisions stand in for you, the guard is auto-allowed, notes are seeded. */
  async recordPresets({ onlyGoal = null } = {}) {
    await loadNlp();
    const out = {};
    for (const goal of PRESETS.filter((g) => !onlyGoal || g === onlyGoal)) {
      const task = S.tasks.tasks.find((t) => t.goal === goal);
      const gold = task?.steps || [];
      const deps = liveDeps({
        toolCtx: { notes: memoryNotes(S.tasks.seedNotes), askUser: async () => gold.find((g) => g.action === "ask_user")?.observation.match(/"(.*)"/)?.[1] || `I mean: ${goal}`, now: undefined },
        human: {
          decide: async ({ state }) => { const g = gold[state.steps_done.length]; return g ? { action: g.action, args: Object.fromEntries(Object.entries(g.args).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) } : null; },
          confirm: async () => true,
        },
      });
      const res = await runAgent(goal, deps, { ...gateOpts(), shadowRate: 0 });
      res.recordedWith = { s1: M.info?.variant, backend: M.info?.backend, s2: M.s2?.model || null, humanStandIn: "gold trace for held steps; confirmations allowed; ask_user answered from the gold trace or by restating the goal" };
      out[goal] = { ...compactRun(res), recordedWith: res.recordedWith };
      console.log("recorded", goal, res.outcome);
    }
    return out;
  },
};

// ---- init -------------------------------------------------------------------------------------------------------------
async function init() {
  initGate();
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== S.tab; });
    renderAll(true);
  }));
  $("runBtn").addEventListener("click", () => run());
  $("stopBtn").addEventListener("click", () => { S.abort?.abort(); S.running = false; });
  $("fitBtn").addEventListener("click", () => S.cy?.fit(undefined, 18));
  $("goal").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) run(); });
  $("expJson").addEventListener("click", () => S.current && download("layaagent-run.json", JSON.stringify(compactRun(S.current), null, 1)));
  $("expTtl").addEventListener("click", () => S.current && download("layaagent-run.ttl", toTurtle(compactRun(S.current)), "text/turtle"));
  $("expAll").addEventListener("click", () => download("layaagent-session.json", JSON.stringify(S.runs.filter((r) => r.steps.length).map(compactRun), null, 1)));
  $("seedNotes").addEventListener("click", async () => { for (const t of S.tasks?.seedNotes || []) await browserNotes.add(t); refreshNotes(); });
  $("clearNotes").addEventListener("click", async () => { if (confirm("Delete every note saved in this browser?")) { await browserNotes.clear(); refreshNotes(); } });
  onModelsChanged(() => { renderPresets(); renderBanner(); });
  initModelCard();
  refreshNotes();
  const [rec, tasks] = await Promise.all([loadRecorded(), loadTasks().catch(() => null)]);
  S.recorded = rec; S.tasks = tasks;
  const ev = rec?.eval;
  if (ev?.records?.length) { S.evalRecords = ev.records; S.evalMeta = `recorded with Laya ${ev.meta?.s1 || "?"} on ${ev.meta?.backend || "?"}${ev.meta?.s2 ? ` + ${ev.meta.s2}` : ""}`; }
  renderPresets(); renderAll(false);
  const first = PRESETS[0];
  $("goal").value = first;
}

function renderPresets() {
  const rec = S.recorded?.traces || {};
  $("presetHint").textContent = M.laya ? "(runs live)" : "(▶ = replays a recorded run)";
  $("presets").innerHTML = PRESETS.map((g) => `<button data-goal="${esc(g)}" title="${esc(g)}">${!M.laya && rec[g] ? "▶ " : ""}${esc(g.length > 44 ? g.slice(0, 43) + "…" : g)}</button>`).join("");
  $("presets").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { $("goal").value = b.dataset.goal; $("presets").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b)); run({ goal: b.dataset.goal }); }));
}

init();
