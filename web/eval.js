// Evaluate page: run the models over the task suite, score against the gold traces, compare routers.
import { $, esc, pct, num, msText, settings, M, onModelsChanged, initModelCard, loadRecorded, loadTasks, loadNlp, countTokens, download, bars, yieldToBrowser } from "./common.js";
import { evalTask, questionsKey } from "./evalrun.js";
import { evaluate, sweep, tuneOnDev, SWEEP } from "./metrics.js";
import { DEFAULTS, METRICS, score } from "./gate.js";
import { ARG_PREFIX } from "./questions.js";
import { TOOL } from "./tools/index.js";

const S = {
  tasks: null, runs: new Map(), cur: null, running: false, stop: false, open: new Set(),
  gate: { ...DEFAULTS, ...settings.get("evalGate", settings.get("gate", {})) },
};

const CAT = { weather: "Weather (argument in text)", wiki: "Encyclopedia (argument in text)", fact: "Wikidata fact", calc: "Arithmetic", units: "Unit conversion", date: "Date math",
  multihop: "Multi-hop", memory: "Memory (save / search)", rewrite: "Needs rewriting", ambiguous: "Ambiguous (should ask)", risky: "Changes something" };

function records() {
  const run = S.runs.get(S.cur);
  if (!run) return [];
  const sp = $("scoreSplit").value;
  return run.records.filter((r) => sp === "all" || r.split === sp);
}

// ---- gate controls --------------------------------------------------------------------------------------------------
function initGate() {
  const m = $("metric");
  for (const [k, v] of Object.entries(METRICS)) m.add(new Option(v, k));
  const sync = () => {
    $("tauAction").value = S.gate.tauAction; $("tauArg").value = S.gate.tauArg; $("tauStop").value = S.gate.tauStop; $("tauStopVal").textContent = num(S.gate.tauStop); m.value = S.gate.metric;
    $("useGoalMet").checked = S.gate.useGoalMet; $("useRisk").checked = S.gate.useRisk;
    $("tauActionVal").textContent = num(S.gate.tauAction); $("tauArgVal").textContent = num(S.gate.tauArg);
  };
  S.syncGate = sync; sync();
  const upd = () => { S.gate = { ...S.gate, tauAction: +$("tauAction").value, tauArg: +$("tauArg").value, tauStop: +$("tauStop").value, metric: m.value, useGoalMet: $("useGoalMet").checked, useRisk: $("useRisk").checked }; settings.set("evalGate", S.gate); sync(); render(); };
  for (const id of ["tauAction", "tauArg", "tauStop"]) $(id).addEventListener("input", upd);
  for (const id of ["metric", "useGoalMet", "useRisk"]) $(id).addEventListener("change", upd);
  $("scoreSplit").addEventListener("change", render);
  $("tuneBtn").addEventListener("click", () => {
    const run = S.runs.get(S.cur); if (!run) return;
    const t = tuneOnDev(run.records, S.gate, +$("maxErr").value);
    if (!t) { $("tuneMsg").textContent = "No threshold keeps the dev split's automatic steps under that error cap."; return; }
    S.gate = { ...S.gate, tauAction: Math.min(1, t.tau), tauArg: Math.min(1, t.tau) }; settings.set("evalGate", S.gate); sync();
    $("tuneMsg").innerHTML = `Dev split: threshold <b>${num(t.tau)}</b> gives System 1 <b>${pct(t.point.s1Share)}</b> of steps at <b>${pct(1 - t.point.autoAcc)}</b> auto-step error. Now read the test split.`;
    $("scoreSplit").value = "test"; render();
  });
}

// ---- running ----------------------------------------------------------------------------------------------------------
function subset() {
  const all = S.tasks.tasks, w = $("subset").value;
  if (w === "quick") { const seen = new Set(); return all.filter((t) => !seen.has(t.category) && seen.add(t.category)); }
  return w === "all" ? all : all.filter((t) => t.split === w);
}

async function runSuite() {
  if (!M.laya) { $("runCount").textContent = "Load System 1 first."; return; }
  if (S.running) return;
  const withS2 = $("withS2").checked && !!M.s2;
  S.running = true; S.stop = false; $("runBtn").disabled = true; $("stopBtn").disabled = false;
  await loadNlp();
  const tasks = subset();
  const key = `browser · ${M.info.variant}/${M.info.backend}${withS2 ? " + " + M.s2.model.replace(/-q4f.*$/, "") : ""} · ${$("subset").value} · ${new Date().toLocaleTimeString()}`;
  const run = { key, source: "browser", meta: { s1: M.info.variant, backend: M.info.backend, s2: withS2 ? M.s2.model : null, questions: questionsKey(S.tasks.tasks), at: new Date().toISOString(), subset: $("subset").value }, records: [] };
  S.runs.set(key, run); S.cur = key; fillRunSel();
  const total = tasks.reduce((a, t) => a + t.steps.length, 0);
  let n = 0;
  const t0 = performance.now();
  try {
    for (const task of tasks) {
      if (S.stop) break;
      const recs = await evalTask(task, { laya: M.laya, nlp: M.nlp, s2: withS2 ? M.s2 : null, countTokens: countTokens(), onStep: async () => { n++; $("runBar").style.width = `${(100 * n) / total}%`; $("runCount").textContent = `${n} / ${total} steps · ${msText(performance.now() - t0)}`; await yieldToBrowser(); } });
      run.records.push(...recs);
      render();
    }
  } catch (e) { console.error(e); $("runCount").textContent = "Error: " + (e?.message || e); }
  finally { S.running = false; $("runBtn").disabled = false; $("stopBtn").disabled = true; render(); }
}

function fillRunSel() {
  const sel = $("runSel");
  sel.innerHTML = [...S.runs.values()].map((r) => `<option value="${esc(r.key)}">${esc(r.source === "recorded" ? "Recorded · " : "")}${esc(r.key)} (${r.records.length} steps)</option>`).join("");
  sel.value = S.cur || "";
}

// ---- rendering ---------------------------------------------------------------------------------------------------------
function render() {
  const recs = records();
  if (!recs.length) { $("kpis").innerHTML = `<p class="hint">No steps to score yet.</p>`; for (const id of ["baselines", "parts", "cats", "steps"]) $(id).innerHTML = ""; $("curve").innerHTML = ""; return; }
  const e = evaluate(recs, S.gate);
  const tile = (l, v, sub = "") => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}${sub ? ` <small>${sub}</small>` : ""}</div></div>`;
  const succ = e.routers.hybrid || e.routers.human;
  $("kpis").innerHTML = [
    tile("Steps handled by System 1 alone", pct(e.split.S1), `${e.split.autoN}/${e.n.steps}`),
    tile("System 1 auto-step error", pct(e.autoError)),
    tile(`Task success, ${e.hasS2 ? "S1 + S2" : "S1 + you"}`, pct(succ.rate), `of ${succ.n}`),
    tile("Task success, S1 alone (no gate)", pct(e.routers.s1.rate)),
    e.hasS2 ? tile("Task success, S2 alone", pct(e.routers.s2.rate)) : tile("Held steps where S1 was wrong", pct(e.escalationPrecision)),
    tile("System 1 latency p50 / p95", `${msText(e.latency.s1.p50)}`, `/ ${msText(e.latency.s1.p95)}`),
  ].join("");
  const run = S.runs.get(S.cur);
  $("kpiNote").innerHTML = `${e.n.tasks} tasks, ${e.n.steps} steps (${esc($("scoreSplit").value)} split). Laya ${esc(run.meta?.s1 || "?")} on ${esc(run.meta?.backend || "?")}${run.meta?.s2 ? `, System 2 ${esc(run.meta.s2)}` : ", no System 2 answers in this run"}. Gate: ${esc(METRICS[S.gate.metric])} ≥ ${num(S.gate.tauAction)} (action) / ${num(S.gate.tauArg)} (arguments).`;

  const R = [
    ["System 1 only, no gate", e.routers.s1, "0", e.calls.s1Ms],
    ["Hybrid: S1 + System 2", e.routers.hybrid, `${e.calls.hybridS2} (${pct(e.split.escalated)})`, e.hasS2 ? e.calls.hybridMs : null],
    ["Hybrid: S1 + you", e.routers.human, `${e.calls.hybridS2} steps for you`, null],
    ["System 2 only, every step", e.routers.s2, `${e.calls.s2Only} (100%)`, e.calls.s2Ms],
  ];
  $("baselines").innerHTML = `<tr><th>Router</th><th class="r">Task success</th><th class="r">System 2 calls</th><th class="r">Median time / task</th></tr>` +
    R.map(([n, r, calls, ms]) => `<tr><td>${n}</td><td class="r">${r ? pct(r.rate) : "<span class=hint>needs S2 run</span>"}</td><td class="r">${r ? calls : "–"}</td><td class="r">${ms != null ? msText(ms) : "–"}</td></tr>`).join("");

  $("parts").innerHTML = `<tr><th>Part</th><th class="r">Value</th></tr>` + [
    ["Action accuracy (Laya's top tool)", pct(e.actionAcc)],
    ["Action accuracy with goal_met stop", pct(e.actionAccWithGoalMet)],
    ["Argument accuracy (all slots, gold tool)", pct(e.argAcc)],
    ["· span slots (extraction by choice)", pct(e.spanArgAcc)],
    ["· fixed-list slots", pct(e.fixedArgAcc)],
    ["Extractor recall (gold span offered)", pct(e.extractorRecall)],
    ["Picked NONE when the span was missing", pct(e.noneRecall)],
    ["goal_met AUROC", num(e.goalMet.auroc)],
    ["goal_met recall / false alarm at 0.5", `${pct(e.goalMet.recall)} / ${pct(e.goalMet.falseAlarm)}`],
    ["Risk flag AUROC (tasks that change something)", num(e.risk.auroc)],
    ["Risk flag recall / false alarm at 0.5", `${pct(e.risk.recall)} / ${pct(e.risk.falseAlarm)}`],
    ["Held steps where S1 was actually wrong", pct(e.escalationPrecision)],
    ...(e.hasS2 ? [["System 2 step accuracy (all steps)", pct(e.s2StepAcc)], ["System 2 accuracy on held steps", pct(e.s2OnHoldAcc)], ["System 2 latency p50 / p95", `${msText(e.latency.s2.p50)} / ${msText(e.latency.s2.p95)}`]] : []),
  ].map(([k, v]) => `<tr><td>${k}</td><td class="r">${v}</td></tr>`).join("");

  $("cats").innerHTML = `<tr><th>Category</th><th class="r">Tasks</th><th class="r">S1 share</th><th class="r">Auto error</th><th class="r">Action acc.</th><th class="r">Success</th><th class="r">S1 alone</th></tr>` +
    e.byCategory.map((c) => `<tr><td>${esc(CAT[c.name] || c.name)}</td><td class="r">${c.tasks}</td><td class="r">${pct(c.s1Share)}</td><td class="r">${pct(c.autoError)}</td><td class="r">${pct(c.actionAcc)}</td><td class="r">${pct(c.success)}</td><td class="r">${pct(c.s1Success)}</td></tr>`).join("");

  renderCurve(recs);
  renderSteps(e);
}

function renderCurve(recs) {
  const pts = sweep(recs, S.gate);
  const W = 460, H = 260, L = 44, B = 34, T = 10, Rr = 12;
  const x = (v) => L + (W - L - Rr) * v, y = (v) => T + (H - T - B) * (1 - v);
  const cur = pts.reduce((b, p) => (Math.abs(p.tau - S.gate.tauAction) < Math.abs(b.tau - S.gate.tauAction) ? p : b), pts[0]);
  const line = (key) => pts.filter((p) => p[key] != null && p.s1Share != null).map((p, i) => `${i ? "L" : "M"}${x(p.s1Share).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  $("curve").innerHTML = `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Coverage vs accuracy">
    ${ticks.map((t) => `<line x1="${L}" x2="${W - Rr}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t * 100}%</text><text x="${x(t)}" y="${H - B + 16}" text-anchor="middle">${t * 100}%</text>`).join("")}
    <text x="${(L + W) / 2}" y="${H - 4}" text-anchor="middle">steps handled by System 1 alone</text>
    <path d="${line("autoAcc")}" fill="none" stroke="var(--s1)" stroke-width="2"/>
    <path d="${line("success")}" fill="none" stroke="var(--auto)" stroke-width="2" stroke-dasharray="5 4"/>
    ${pts.filter((p) => p.autoAcc != null).map((p) => `<circle class="pt" cx="${x(p.s1Share)}" cy="${y(p.autoAcc)}" r="${p === cur ? 6 : 4}" fill="${p === cur ? "var(--s1)" : "var(--card)"}" stroke="var(--s1)" stroke-width="2" data-tau="${p.tau}"><title>threshold ${num(p.tau)}: S1 share ${pct(p.s1Share)}, auto accuracy ${pct(p.autoAcc)}, task success ${pct(p.success)}</title></circle>`).join("")}
  </svg><div class="legendrow" style="display:flex;gap:14px;font-size:12px;color:var(--ink2)"><span><i style="display:inline-block;width:14px;height:2px;background:var(--s1);vertical-align:3px"></i> System 1 auto-step accuracy</span><span><i style="display:inline-block;width:14px;border-top:2px dashed var(--auto);vertical-align:3px"></i> task success (${esc(S.runs.get(S.cur)?.meta?.s2 ? "S1 + S2" : "S1 + you")})</span></div>`;
  $("curve").querySelectorAll(".pt").forEach((c) => c.addEventListener("click", () => { const t = Math.min(1, +c.dataset.tau); S.gate = { ...S.gate, tauAction: t, tauArg: t }; settings.set("evalGate", S.gate); S.syncGate(); render(); }));
}

function renderSteps(e) {
  const fc = $("fCat").value, fr = $("fRoute").value, fo = $("fOk").value;
  const rows = e.steps.filter(({ r, d }) => (!fc || r.category === fc) && (!fr || d.route === fr) && (!fo || (fo === "bad" ? !d.s1Ok : !d.s1Ok && d.route === "AUTO")));
  const fmt = (x) => `${esc(x.action)}(${esc(Object.values(x.args || {}).map((v) => (Array.isArray(v) ? v[0] : v)).join(", "))})`;
  $("steps").innerHTML = `<tr><th>Task</th><th>#</th><th>Gold</th><th>System 1</th><th class="r">score</th><th>Route</th><th>S1</th>${e.hasS2 ? "<th>S2</th>" : ""}</tr>` + rows.map(({ r, d }) => {
    const id = `${r.task}:${r.step}`;
    const open = S.open.has(id);
    const main = `<tr class="claimrow" data-id="${id}"><td title="${esc(r.goal)}">${esc(r.task)} · ${esc(r.goal.length > 48 ? r.goal.slice(0, 47) + "…" : r.goal)}</td><td>${r.step + 1}</td><td><code>${fmt(r.gold)}</code></td><td><code>${fmt(d.s1Decision)}</code></td><td class="r">${num(d.actionScore)}</td><td><span class="chip ${d.route}">${d.route}</span></td><td><span class="chip ${d.s1Ok ? "ok" : "bad"}">${d.s1Ok ? "right" : "wrong"}</span></td>${e.hasS2 ? `<td>${r.s2 ? `<span class="chip ${d.s2Ok ? "ok" : "bad"}" title="${esc(r.s2.action)}(${esc(JSON.stringify(r.s2.args))})">${d.s2Ok ? "right" : "wrong"}</span>` : ""}</td>` : ""}</tr>`;
    if (!open) return main;
    const a = r.s1.answers;
    const argBlocks = Object.entries(r.s1.gold.answers || {}).map(([k, ans]) => `<div><b>${esc(k.slice(ARG_PREFIX.length))}</b> <span class="hint">gold option: ${esc(r.s1.gold.options?.[k.slice(ARG_PREFIX.length)] ?? "?")}</span>${bars(ans.probabilities, ans.choice, { gold: r.s1.gold.options?.[k.slice(ARG_PREFIX.length)] })}</div>`).join("");
    return main + `<tr class="detailrow"><td colspan="${e.hasS2 ? 8 : 7}"><div class="two"><div><b>next_action</b> <span class="hint">p(goal met) ${num(a.goal_met?.noul, 3)} · p(risky) ${num(a.risky?.noul, 3)} · ${msText(r.s1.ms)}</span>${bars(a.next_action.probabilities, a.next_action.choice, { gold: r.gold.action })}</div><div>${argBlocks || '<span class="hint">no arguments</span>'}</div></div>${d.reasons.length ? `<ul class="reasons">${d.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${r.s2 ? `<p class="hint">System 2: <code>${esc(r.s2.action)}(${esc(JSON.stringify(r.s2.args))})</code> · ${esc(r.s2.reason || "")} · ${msText(r.s2.ms)}${r.s2.parseError ? " · " + esc(r.s2.parseError) : ""}</p>` : ""}</td></tr>`;
  }).join("");
  $("steps").querySelectorAll(".claimrow").forEach((tr) => tr.addEventListener("click", () => { const id = tr.dataset.id; if (S.open.has(id)) S.open.delete(id); else S.open.add(id); renderSteps(e); }));
}

// ---- recording hook ---------------------------------------------------------------------------------------------------
globalThis.__la = { S, M, current: () => S.runs.get(S.cur), runSuite };

async function init() {
  initGate();
  $("runBtn").addEventListener("click", runSuite);
  $("stopBtn").addEventListener("click", () => { S.stop = true; });
  $("runSel").addEventListener("change", () => { S.cur = $("runSel").value; render(); });
  $("dlRun").addEventListener("click", () => { const r = S.runs.get(S.cur); if (r) download("layaagent-eval.json", JSON.stringify(r, null, 1)); });
  for (const id of ["fCat", "fRoute", "fOk"]) $(id).addEventListener("change", render);
  onModelsChanged(() => { $("withS2").disabled = !M.s2; if (M.s2) $("withS2").checked = true; });
  $("withS2").disabled = true;
  initModelCard();
  const [tasks, rec] = await Promise.all([loadTasks(), loadRecorded()]);
  S.tasks = tasks;
  const n = (s) => tasks.tasks.filter((t) => t.split === s).length;
  $("suiteInfo").textContent = `${tasks.tasks.length} synthetic goals (${n("dev")} dev / ${n("test")} test), ${tasks.tasks.reduce((a, t) => a + t.steps.length, 0)} gold steps in ${Object.keys(CAT).length} categories. Tool outputs recorded ${tasks.recordedAt.slice(0, 10)}.`;
  for (const [k, v] of Object.entries(CAT)) $("fCat").add(new Option(v, k));
  const qk = questionsKey(tasks.tasks);
  if (rec?.eval?.records?.length) {
    const stale = rec.eval.meta?.questions && rec.eval.meta.questions !== qk;
    const key = `Laya ${rec.eval.meta?.s1 || "?"}/${rec.eval.meta?.backend || "?"}${rec.eval.meta?.s2 ? " + " + rec.eval.meta.s2.replace(/-q4f.*$/, "") : ""}${stale ? " (questions changed since)" : ""}`;
    S.runs.set(key, { key, source: "recorded", meta: rec.eval.meta, records: rec.eval.records });
    S.cur = key;
  }
  fillRunSel(); render();
}
init();
