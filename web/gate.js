// The gate: decides, per step, whether System 1's proposal runs as is (AUTO), goes to System 2 or a person (HOLD),
// and whether the step needs the user's confirmation before it runs (the guard).
//
// Gate score. Laya's own confidence is 1 - normalized entropy, but on this checkpoint the probabilities are compressed
// (layaForWorkflows, layaAsRagJudge): a 12-option question reads 0.1-0.3 even when right. So the default score is the
// probability of the chosen option; "margin" (top minus runner-up) and "entropy" are available on the Evaluate page.
// All of this is pure and recomputed from stored answers, so moving a threshold never calls a model.
import { TOOL, FINISH, isSideEffect } from "./tools/index.js";
import { ARG_PREFIX } from "./questions.js";
import { NONE } from "./candidates.js";

export const METRICS = { prob: "p(chosen option)", margin: "margin over the runner-up", entropy: "1 − normalized entropy" };

export const DEFAULTS = {
  metric: "prob",
  tauAction: 0.3,     // gate score needed on the action question
  tauArg: 0.5,        // gate score needed on every argument question
  goalCutoff: 0.5,    // p(goal met) at which FINISH is proposed
  tauStop: 0.7,       // p(goal met) needed to FINISH without asking (it is weak on multi-hop goals: see README)
  riskCutoff: 0.5,    // p(risky) at which a read-only proposal is held (fail closed)
  useGoalMet: true,   // after the first step, p(goal met) >= goalCutoff means FINISH
  strictGoalMet: false, // also hold when goal_met and next_action disagree
  useRisk: true,
  holdRepeat: true,   // hold when Laya picks the same tool as the previous step (it tends to repeat itself)
  maxSteps: 8,
};

/** Gate score of one choice answer under a metric. */
export function score(answer, metric = "prob") {
  if (!answer) return 0;
  if (metric === "entropy") return answer.confidence ?? 0;
  const p = Object.values(answer.probabilities || {}).sort((a, b) => b - a);
  if (metric === "margin") return (p[0] ?? 0) - (p[1] ?? 0);
  return p[0] ?? 0;
}

/**
 * System 1's proposal from its raw answers.
 * @param answers  { next_action, goal_met, risky, "arg:slot": ... }
 * @param stepIndex 0 for the first step (goal_met is ignored there: nothing has been gathered yet)
 */
export function proposal(answers, stepIndex, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const picked = answers.next_action.choice;
  const goalMet = answers.goal_met?.noul ?? 0;
  const goalSaysDone = o.useGoalMet && stepIndex > 0 && goalMet >= o.goalCutoff;
  const action = goalSaysDone ? FINISH : picked;
  const args = {};
  for (const slot of TOOL[action]?.slots || []) args[slot.name] = answers[ARG_PREFIX + slot.name]?.choice ?? null;
  return { action, picked, args, goalMet, risky: answers.risky?.noul ?? 0 };
}

/**
 * AUTO or HOLD, with the reasons for a HOLD.
 * @param answers   S1 answers for this step (args asked for the PICKED action)
 * @param ctx       { stepIndex, previous: { action, args } | null }
 */
export function route(answers, ctx = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const step = ctx.stepIndex ?? 0;
  const p = proposal(answers, step, o);
  const reasons = [];
  const sa = score(answers.next_action, o.metric);
  if (p.action === FINISH && p.picked !== FINISH) {
    // the stop decision came from the goal_met question (next_action barely reads the steps done: see README)
    if (p.goalMet < o.tauStop) reasons.push(`stop score ${p.goalMet.toFixed(2)} < ${o.tauStop.toFixed(2)}`);
    if (o.strictGoalMet) reasons.push(`goal met (p ${p.goalMet.toFixed(2)}) but next action is ${p.picked}`);
  } else {
    if (sa < o.tauAction) reasons.push(`action score ${sa.toFixed(2)} < ${o.tauAction.toFixed(2)}`);
    for (const slot of TOOL[p.action]?.slots || []) {
      const a = answers[ARG_PREFIX + slot.name];
      if (!a) { reasons.push(`no answer for ${slot.name}`); continue; }
      if (a.choice === NONE) reasons.push(a.noCandidates ? `${slot.name}: no candidate span in the text` : `${slot.name}: none of the spans fits`);
      else { const s = score(a, o.metric); if (s < o.tauArg) reasons.push(`${slot.name} score ${s.toFixed(2)} < ${o.tauArg.toFixed(2)}`); }
    }
    if (o.useGoalMet && step > 0 && p.picked === FINISH && p.goalMet < o.goalCutoff) reasons.push(`FINISH picked but goal not met (p ${p.goalMet.toFixed(2)})`);
  }
  if (step === 0 && p.action === FINISH) reasons.push("FINISH before any step");
  if (o.useRisk && p.risky >= o.riskCutoff && !isSideEffect(p.action) && p.action !== "ask_user" && p.action !== FINISH) reasons.push(`goal looks risky (p ${p.risky.toFixed(2)}) but ${p.action} is read-only`);
  if (ctx.previous && ctx.previous.action === p.action && p.action !== FINISH) {
    if (sameArgs(ctx.previous.args, p.args)) reasons.push("same call as the previous step (loop guard)");
    else if (o.holdRepeat) reasons.push(`same tool as the previous step (${p.action})`);
  }
  return { route: reasons.length ? "HOLD" : "AUTO", reasons, proposal: p, actionScore: sa };
}

export function sameArgs(a = {}, b = {}) {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) if (String(a[k] ?? "").trim().toLowerCase() !== String(b[k] ?? "").trim().toLowerCase()) return false;
  return true;
}

/** The guard: tools that change something always need the user's OK, whoever picked them. */
export function guard(action) {
  const t = TOOL[action];
  return t?.sideEffect ? { confirm: true, reason: `${action} ${t.sideEffect}` } : { confirm: false, reason: null };
}
