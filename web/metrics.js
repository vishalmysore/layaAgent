// Scoring an evaluation run. The Evaluate page runs System 1 (and, if loaded, System 2) on every gold step of the
// task suite with the gold history as context ("teacher forcing"), and stores the raw answers. Everything below is
// a pure function of those records and the gate settings, so every slider re-scores instantly without a model.
//
// Task success is computed from the steps: with recorded tool outputs, a run follows the gold trace exactly when
// every decision matches it, so "all steps correct" is the same as "the free-running agent reaches the gold answer".
//
// Step record: { task, split, category, step, gold: {action,args,alt}, sideEffect, s1: { answers, gold, ms }, s2?: { action, args, ms } }
//   s1.answers  Laya answers: next_action, goal_met, risky, arg:<slot> for the action Laya picked
//   s1.gold     Laya answers for the GOLD tool's slots (same as above when Laya picked the gold tool) + gold options
import { route, proposal, DEFAULTS } from "./gate.js";
import { matchStep, goldOption } from "./gold.js";
import { TOOL, FINISH } from "./tools/index.js";
import { NONE } from "./candidates.js";
import { ARG_PREFIX } from "./questions.js";

const ratio = (a, b) => (b ? a / b : null);
export function percentile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
export function auroc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** Decide one step under the gate: who decides, what they decide, whether it is right. */
export function decideStep(r, prevGold, opts, mode = "hybrid") {
  const g = route(r.s1.answers, { stepIndex: r.step, previous: prevGold ? { action: prevGold.action, args: firstArgs(prevGold.args) } : null }, opts);
  const s1Decision = { action: g.proposal.action, args: g.proposal.args };
  const s1Ok = matchStep(r.gold, s1Decision).ok;
  const s2Ok = r.s2 ? matchStep(r.gold, r.s2).ok : null;
  let by;
  if (mode === "s1") by = "S1";
  else if (mode === "s2") by = "S2";
  else by = g.route === "AUTO" ? "S1" : mode === "human" ? "human" : "S2";
  const ok = by === "S1" ? s1Ok : by === "S2" ? s2Ok : true; // a person is assumed to get it right
  return { route: g.route, reasons: g.reasons, by, ok, s1Ok, s2Ok, s1Decision, actionScore: g.actionScore };
}
const firstArgs = (a = {}) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

/** Group records by task, in step order. */
export function byTask(records) {
  const m = new Map();
  for (const r of records) { if (!m.has(r.task)) m.set(r.task, []); m.get(r.task).push(r); }
  for (const rs of m.values()) rs.sort((a, b) => a.step - b.step);
  return m;
}

/** Task-level result under one router. mode: "s1" (no gate), "hybrid" (S1 + S2), "human" (S1 + person), "s2" (S2 only). */
export function taskResults(records, opts, mode) {
  const out = [];
  for (const [task, rs] of byTask(records)) {
    let ok = true, s1 = 0, s2 = 0, human = 0, ms = 0, known = true;
    rs.forEach((r, i) => {
      const d = decideStep(r, i ? rs[i - 1].gold : null, opts, mode);
      if (d.ok === null) known = false;
      if (!d.ok) ok = false;
      if (d.by === "S1") s1++; else if (d.by === "S2") s2++; else human++;
      if (mode !== "s2") ms += r.s1.ms || 0;
      if (d.by === "S2") ms += r.s2?.ms || 0;
    });
    out.push({ task, category: rs[0].category, split: rs[0].split, ok: known ? ok : null, steps: rs.length, s1, s2, human, ms });
  }
  return out;
}

export function successRate(tasks) {
  const k = tasks.filter((t) => t.ok !== null);
  return { rate: ratio(k.filter((t) => t.ok).length, k.length), n: k.length, of: tasks.length };
}

/** Everything the Evaluate page shows, at one gate setting. */
export function evaluate(records, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const tasks = byTask(records);
  const steps = [];
  for (const rs of tasks.values()) rs.forEach((r, i) => steps.push({ r, d: decideStep(r, i ? rs[i - 1].gold : null, o, "hybrid") }));
  const hasS2 = records.some((r) => r.s2);

  const auto = steps.filter((x) => x.d.route === "AUTO"), hold = steps.filter((x) => x.d.route === "HOLD");
  // action accuracy: Laya's argmax action vs gold (before goal_met / gate)
  const actOk = (r) => { const p = proposal(r.s1.answers, r.step, { ...o, useGoalMet: false }).picked; return matchStep(r.gold, { action: p, args: {} }).action; };
  const actOkGm = (r) => matchStep(r.gold, { action: proposal(r.s1.answers, r.step, o).action, args: {} }).action;
  // argument accuracy, slot by slot, on the GOLD tool's slots
  const slots = [];
  for (const { r } of steps) {
    for (const slot of TOOL[r.gold.action]?.slots || []) {
      const a = r.s1.gold?.answers?.[ARG_PREFIX + slot.name];
      if (!a) continue;
      const gOpt = r.s1.gold.options?.[slot.name] ?? goldOption(slot.name, a.probabilities, r.gold.args?.[slot.name]);
      slots.push({ slot: slot.name, fixed: !!slot.fixed, ok: a.choice === gOpt, goldInOptions: gOpt !== NONE, choseNone: a.choice === NONE, p: Math.max(...Object.values(a.probabilities)), task: r.task });
    }
  }
  const span = slots.filter((s) => !s.fixed);
  // risk flag (asked every step): positives are steps of tasks whose gold trace changes something
  const riskPos = steps.filter((x) => x.r.sideEffect).map((x) => x.r.s1.answers.risky?.noul ?? 0);
  const riskNeg = steps.filter((x) => !x.r.sideEffect).map((x) => x.r.s1.answers.risky?.noul ?? 0);
  // goal_met, from the second step on: positive when the gold step is FINISH
  const gm = steps.filter((x) => x.r.step > 0);
  const gmPos = gm.filter((x) => x.r.gold.action === FINISH).map((x) => x.r.s1.answers.goal_met?.noul ?? 0);
  const gmNeg = gm.filter((x) => x.r.gold.action !== FINISH).map((x) => x.r.s1.answers.goal_met?.noul ?? 0);

  const routers = {
    s1: successRate(taskResults(records, o, "s1")),
    human: successRate(taskResults(records, o, "human")),
    hybrid: hasS2 ? successRate(taskResults(records, o, "hybrid")) : null,
    s2: hasS2 ? successRate(taskResults(records, o, "s2")) : null,
  };
  const tHybrid = taskResults(records, o, hasS2 ? "hybrid" : "human");
  const tS2 = hasS2 ? taskResults(records, o, "s2") : null;
  const tS1 = taskResults(records, o, "s1");
  const med = (a) => percentile(a, 0.5);

  const cats = {};
  for (const t of tHybrid) (cats[t.category] ||= []).push(t);
  const byCategory = Object.entries(cats).map(([name, ts]) => {
    const st = steps.filter((x) => x.r.category === name);
    const au = st.filter((x) => x.d.route === "AUTO");
    return {
      name, tasks: ts.length, steps: st.length,
      s1Share: ratio(au.length, st.length), autoError: ratio(au.filter((x) => !x.d.s1Ok).length, au.length),
      actionAcc: ratio(st.filter((x) => actOk(x.r)).length, st.length),
      success: successRate(ts).rate, s1Success: successRate(tS1.filter((t) => t.category === name)).rate,
    };
  });

  return {
    n: { tasks: tasks.size, steps: steps.length }, hasS2, gate: o,
    split: { S1: ratio(auto.length, steps.length), escalated: ratio(hold.length, steps.length), autoN: auto.length, holdN: hold.length },
    autoError: ratio(auto.filter((x) => !x.d.s1Ok).length, auto.length),
    escalationPrecision: ratio(hold.filter((x) => !x.d.s1Ok).length, hold.length),
    s1StepAcc: ratio(steps.filter((x) => x.d.s1Ok).length, steps.length),
    s2StepAcc: hasS2 ? ratio(steps.filter((x) => x.d.s2Ok).length, steps.filter((x) => x.d.s2Ok !== null).length) : null,
    s2OnHoldAcc: hasS2 ? ratio(hold.filter((x) => x.d.s2Ok).length, hold.filter((x) => x.d.s2Ok !== null).length) : null,
    actionAcc: ratio(steps.filter((x) => actOk(x.r)).length, steps.length),
    actionAccWithGoalMet: ratio(steps.filter((x) => actOkGm(x.r)).length, steps.length),
    argAcc: ratio(slots.filter((s) => s.ok).length, slots.length),
    spanArgAcc: ratio(span.filter((s) => s.ok).length, span.length),
    fixedArgAcc: ratio(slots.filter((s) => s.fixed && s.ok).length, slots.filter((s) => s.fixed).length),
    extractorRecall: ratio(span.filter((s) => s.goldInOptions).length, span.length),
    noneRecall: ratio(span.filter((s) => !s.goldInOptions && s.choseNone).length, span.filter((s) => !s.goldInOptions).length),
    risk: {
      auroc: auroc(riskPos, riskNeg),
      recall: ratio(riskPos.filter((p) => p >= o.riskCutoff).length, riskPos.length),
      falseAlarm: ratio(riskNeg.filter((p) => p >= o.riskCutoff).length, riskNeg.length),
    },
    goalMet: {
      auroc: auroc(gmPos, gmNeg),
      recall: ratio(gmPos.filter((p) => p >= o.goalCutoff).length, gmPos.length),
      falseAlarm: ratio(gmNeg.filter((p) => p >= o.goalCutoff).length, gmNeg.length),
    },
    routers,
    calls: {
      hybridS2: hold.length, s2Only: steps.length,
      hybridMs: med(tHybrid.map((t) => t.ms)), s2Ms: tS2 ? med(tS2.map((t) => t.ms)) : null, s1Ms: med(tS1.map((t) => t.ms)),
    },
    latency: {
      s1: { p50: med(records.map((r) => r.s1.ms)), p95: percentile(records.map((r) => r.s1.ms), 0.95) },
      s2: hasS2 ? { p50: med(records.filter((r) => r.s2).map((r) => r.s2.ms)), p95: percentile(records.filter((r) => r.s2).map((r) => r.s2.ms), 0.95) } : null,
    },
    byCategory, steps,
  };
}

export const SWEEP = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9, 1.01];

/** Coverage vs accuracy as one threshold moves (applied to both the action and the argument questions). */
export function sweep(records, opts = {}, taus = SWEEP) {
  return taus.map((t) => {
    const e = evaluate(records, { ...opts, tauAction: t, tauArg: t });
    return { tau: t, s1Share: e.split.S1, autoAcc: e.autoError == null ? null : 1 - e.autoError, success: (e.routers.hybrid || e.routers.human).rate, s1Success: e.routers.s1.rate };
  });
}

/**
 * Pick the threshold on the dev split: the largest S1 share whose auto-step error stays at or below `maxError`.
 * Returns { tau, point } or null when no setting qualifies.
 */
export function tuneOnDev(records, opts = {}, maxError = 0.1) {
  const dev = records.filter((r) => r.split === "dev");
  const pts = sweep(dev, opts).filter((p) => p.s1Share > 0 && p.autoAcc != null && 1 - p.autoAcc <= maxError + 1e-9);
  if (!pts.length) return null;
  const best = pts.sort((a, b) => b.s1Share - a.s1Share || a.tau - b.tau)[0];
  return { tau: best.tau, point: best };
}
