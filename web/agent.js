// The agent loop. No DOM: everything it touches is injected, so the page, the recorder and the Node tests share it.
//
//   state -> System 1 decision pass (next_action, goal_met, risky) -> candidates -> System 1 argument pass
//         -> gate: AUTO (S1's step runs) | HOLD (System 2 decides, or a person if S2 is not loaded)
//         -> guard: tools that change something need the user's OK -> tool -> observation -> next step
//
// deps: { laya, nlp, toolCtx, s2?, human, countTokens? }
//   laya.systemOne(state, questions)            the Laya model (or a mock / recorded answers)
//   s2.decide({ goal, state, s1View }) -> { action, args, reason, ms, prompt, raw }      (optional)
//   human.decide({ goal, state, s1View, reasons }) -> { action, args } | null (stop)
//   human.confirm({ action, args, reason }) -> true | false
// opts: gate thresholds (see gate.js) + { maxSteps, shadowRate, onStep, prefix, force, rng, rewrite }
import { TOOL, FINISH, stepLine } from "./tools/index.js";
import { buildState, approxTokens } from "./state.js";
import { extractCandidates, NONE } from "./candidates.js";
import { actionQuestions, argQuestions, emptySlotAnswers, riskQuestion, riskState, topOptions, ARG_PREFIX } from "./questions.js";
import { route, guard, DEFAULTS, sameArgs } from "./gate.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
// Let the page paint and handle input between model calls (MessageChannel: background tabs clamp setTimeout to >= 1 s).
export const yieldTask = () => new Promise((r) => { if (typeof MessageChannel === "undefined") return r(); const ch = new MessageChannel(); ch.port1.onmessage = () => { ch.port1.close(); r(); }; ch.port2.postMessage(0); });

/** What System 2 and the human see of System 1's view: top actions and the candidate spans for each slot. */
export function s1View(answers, argQs) {
  return {
    top_actions: topOptions(answers.next_action, 3).map((o) => ({ action: o.key, p: +o.p.toFixed(3) })),
    goal_met: +(answers.goal_met?.noul ?? 0).toFixed(3),
    risky: +(answers.risky?.noul ?? 0).toFixed(3),
    slot_candidates: Object.fromEntries(Object.entries(argQs).map(([k, q]) => [k.slice(ARG_PREFIX.length), Object.keys(q.criteria).filter((o) => o !== NONE)])),
  };
}

/** Check a decision from System 2 or a person against the registry; returns an error string or null. */
export function validateDecision(d) {
  if (!d || !TOOL[d.action]) return `unknown action "${d?.action}"`;
  for (const slot of TOOL[d.action].slots) {
    const v = d.args?.[slot.name];
    if (v == null || String(v).trim() === "" || v === NONE) return `missing ${slot.name}`;
    if (slot.fixed && !(v in slot.fixed)) return `${slot.name} must be one of ${Object.keys(slot.fixed).join(", ")}`;
  }
  return null;
}

/** Compose the final answer from the tool results (templates, not a model). */
export function composeAnswer(steps) {
  const done = steps.filter((s) => s.action !== FINISH && s.result && s.result.ok !== false && s.result.answer);
  if (!done.length) return { text: "I could not find an answer.", sources: [] };
  const last = done.at(-1);
  const sources = [...new Set(done.map((s) => s.result.source).filter(Boolean))];
  return { text: last.result.answer, sources, from: done.map((s) => s.index) };
}

export async function runAgent(goal, deps, opts = {}) {
  const o = { ...DEFAULTS, shadowRate: 0, ...opts };
  const count = deps.countTokens || approxTokens;
  const rng = o.rng || Math.random;
  const steps = [];
  const t0 = now();
  let outcome = null;
  const prefix = o.prefix || [];
  let risk = null; // asked once per run, on the goal alone

  for (let i = 0; i < o.maxSteps + 1; i++) {
    await yieldTask();
    if (o.signal?.aborted) { outcome = { kind: "stopped", text: "Stopped." }; break; }
    // what-if replay: earlier steps are reused verbatim, no model or tool calls
    if (i < prefix.length) { const p = { ...prefix[i], replayed: true }; steps.push(p); await o.onStep?.(p, steps); if (p.action === FINISH) break; continue; }

    const history = steps.map((s) => ({ action: s.action, args: s.args, observation: s.observation }));
    const state = buildState(goal, history, count);
    const lastObs = history.at(-1)?.observation || "";
    const cands = extractCandidates(deps.nlp, goal, lastObs);
    const rec = { index: i, state, candidates: cands, s1: {}, decidedBy: null, reasons: [] };

    if (i >= o.maxSteps) {
      rec.decidedBy = "budget"; rec.action = FINISH; rec.args = {}; rec.reasons = [`step budget of ${o.maxSteps} reached`];
      steps.push(rec); await o.onStep?.(rec, steps); outcome = { kind: "budget" }; break;
    }

    // ---- System 1: decision pass, then the argument pass for the tool it picked
    const aq = actionQuestions(undefined, i);
    const s0 = now();
    let rk = null;
    if (!risk) { rk = await deps.laya.systemOne(riskState(goal), riskQuestion()); risk = rk.answers.risky; }
    const r1 = await deps.laya.systemOne(state, aq);
    let answers = { ...r1.answers, risky: risk };
    const picked = o.force && i === prefix.length ? o.force.action : answers.next_action.choice;
    if (o.force && i === prefix.length) { answers.next_action = { ...answers.next_action, forced: true, choice: picked }; }
    const argQs = argQuestions(TOOL[picked], cands);
    let r2 = null;
    if (Object.keys(argQs).length) { r2 = await deps.laya.systemOne(state, argQs); answers = { ...answers, ...r2.answers }; }
    answers = { ...answers, ...emptySlotAnswers(TOOL[picked], cands) };
    rec.s1 = { answers, questions: { ...aq, ...argQs }, ms: now() - s0, layaMs: (r1.latency_ms || 0) + (r2?.latency_ms || 0) + (rk?.latency_ms || 0) };

    const prev = steps.at(-1);
    const g = route(answers, { stepIndex: i, previous: prev ? { action: prev.action, args: prev.args } : null }, o);
    if (o.force && i === prefix.length) { g.reasons = g.reasons.filter((r) => !r.startsWith("action score")); g.route = g.reasons.length ? "HOLD" : "AUTO"; }
    rec.route = g.route; rec.reasons = g.reasons; rec.proposal = g.proposal;
    const view = s1View(answers, argQs);

    // ---- decide
    let decision = null;
    if (g.route === "AUTO") {
      decision = { action: g.proposal.action, args: g.proposal.args };
      rec.decidedBy = "S1";
      if (deps.s2?.ready?.() && o.shadowRate > 0 && rng() < o.shadowRate) {
        try {
          const sh = await deps.s2.decide({ goal, state, s1View: view });
          rec.shadow = { ...sh, agreed: sh.action === decision.action && sameArgs(sh.args, decision.args), actionAgreed: sh.action === decision.action };
        } catch (e) { rec.shadow = { error: String(e?.message || e) }; }
      }
    } else if (deps.s2?.ready?.()) {
      try {
        const d = await deps.s2.decide({ goal, state, s1View: view, reasons: g.reasons });
        const err = validateDecision(d);
        rec.s2 = { ...d, error: err, agreedWithS1: d.action === g.proposal.action && sameArgs(d.args, g.proposal.args) };
        if (!err) { decision = { action: d.action, args: d.args }; rec.decidedBy = "S2"; }
      } catch (e) { rec.s2 = { error: String(e?.message || e) }; }
    }
    if (!decision) {
      const h = await deps.human.decide({ goal, state, s1View: view, reasons: g.reasons, proposal: g.proposal, s2: rec.s2, candidates: cands });
      if (!h) { rec.decidedBy = "human"; rec.action = null; steps.push(rec); await o.onStep?.(rec, steps); outcome = { kind: "stopped", text: "Stopped by the user." }; break; }
      decision = h; rec.decidedBy = "human";
    }
    rec.action = decision.action; rec.args = decision.args || {};

    // ---- guard: anything that changes state needs the user's OK
    const gd = guard(rec.action);
    if (gd.confirm) {
      const ok = await deps.human.confirm({ action: rec.action, args: rec.args, reason: gd.reason, decidedBy: rec.decidedBy });
      rec.guard = { reason: gd.reason, allowed: !!ok, layaRisky: answers.risky?.noul ?? null };
      if (!ok) {
        rec.observation = `The user refused ${rec.action}.`;
        steps.push(rec); await o.onStep?.(rec, steps);
        outcome = { kind: "refused", text: `Not done: you declined to let the agent run ${rec.action}.` };
        break;
      }
    }

    // ---- act
    if (rec.action === FINISH) {
      rec.observation = "";
      steps.push(rec); await o.onStep?.(rec, steps);
      outcome = { kind: "answered", ...composeAnswer(steps) };
      break;
    }
    const t1 = now();
    try {
      const res = await TOOL[rec.action].run(rec.args, deps.toolCtx || {});
      rec.result = res; rec.observation = res.observation; rec.tool = { id: rec.action, input: rec.args, ms: now() - t1, ok: res.ok !== false };
    } catch (e) {
      rec.tool = { id: rec.action, input: rec.args, ms: now() - t1, ok: false, error: String(e?.message || e) };
      rec.observation = `${rec.action} failed: ${rec.tool.error}`;
      rec.result = { ok: false, observation: rec.observation };
    }
    rec.line = stepLine(rec.action, rec.args, rec.observation);
    steps.push(rec); await o.onStep?.(rec, steps);
  }
  if (!outcome) outcome = { kind: "budget", text: "Step budget reached." };
  if (outcome.kind === "answered" && o.rewrite && deps.s2?.ready?.() && deps.s2.rewrite) {
    try { const r = await deps.s2.rewrite(goal, outcome.text, steps); outcome = { ...outcome, templated: outcome.text, text: r.text, rewrittenBy: "S2", rewriteMs: r.ms }; } catch { /* keep the template */ }
  }
  return { goal, steps, outcome, totalMs: now() - t0, at: new Date().toISOString(), thresholds: pickGate(o) };
}

export const pickGate = (o) => ({ metric: o.metric, tauAction: o.tauAction, tauArg: o.tauArg, goalCutoff: o.goalCutoff, riskCutoff: o.riskCutoff, useGoalMet: o.useGoalMet, useRisk: o.useRisk });

/** Share of steps by who decided them, for the banner. */
export function split(runs) {
  const c = { S1: 0, S2: 0, human: 0, blocked: 0, total: 0 };
  const ms = { S1: [], S2: [] };
  let shadowN = 0, shadowAgree = 0;
  for (const r of runs) for (const s of r.steps) {
    if (!s.decidedBy || s.replayed || s.decidedBy === "budget") continue;
    c.total++; c[s.decidedBy] = (c[s.decidedBy] || 0) + 1;
    if (s.guard) c.blocked++;
    if (s.s1?.layaMs) ms.S1.push(s.s1.layaMs);
    if (s.s2?.ms) ms.S2.push(s.s2.ms);
    if (s.shadow && !s.shadow.error) { shadowN++; if (s.shadow.agreed) shadowAgree++; }
  }
  return { ...c, ms, shadowN, shadowAgree };
}
