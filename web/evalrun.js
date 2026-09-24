// Runs the models over the task suite, one gold step at a time with the gold history as context, and returns the
// step records metrics.js scores. Shared by the Evaluate page and the recorder; no DOM.
import { TOOL, isSideEffect } from "./tools/index.js";
import { buildState, approxTokens } from "./state.js";
import { extractCandidates } from "./candidates.js";
import { actionQuestions, argQuestions, emptySlotAnswers, riskQuestion, riskState, ARG_PREFIX } from "./questions.js";
import { goldOption } from "./gold.js";
import { s1View, yieldTask } from "./agent.js";

const GOLD_PREFIX = "gold:";
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const first = (v) => (Array.isArray(v) ? v[0] : v);

/** Keep what scoring and the detail view need, rounded (recorded.json stays small). */
export function compactAnswer(a) {
  if (!a) return a;
  if (a.type === "noul") return { type: "noul", noul: r4(a.noul), confidence: r4(a.confidence) };
  return { type: a.type, choice: a.choice, probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([k, v]) => [k, r4(v)])), confidence: r4(a.confidence), ...(a.noCandidates ? { noCandidates: true } : {}) };
}

/** Records for every gold step of one task. deps: { laya, nlp, s2?, countTokens? } */
export async function evalTask(task, deps) {
  const count = deps.countTokens || approxTokens;
  const sideEffect = task.steps.some((s) => isSideEffect(s.action));
  const out = [];
  const rk = await deps.laya.systemOne(riskState(task.goal), riskQuestion());
  for (let i = 0; i < task.steps.length; i++) {
    await yieldTask();
    const gold = task.steps[i];
    const history = task.steps.slice(0, i).map((s) => ({ action: s.action, args: Object.fromEntries(Object.entries(s.args).map(([k, v]) => [k, first(v)])), observation: s.observation }));
    const state = buildState(task.goal, history, count);
    const cands = extractCandidates(deps.nlp, task.goal, history.at(-1)?.observation || "");
    const aq = actionQuestions(undefined, i);
    const r1 = await deps.laya.systemOne(state, aq);
    const picked = r1.answers.next_action.choice;
    const pickedQs = argQuestions(TOOL[picked], cands);
    const goldQs = picked === gold.action ? {} : Object.fromEntries(Object.entries(argQuestions(TOOL[gold.action], cands)).map(([k, q]) => [GOLD_PREFIX + k, q]));
    let r2 = null;
    if (Object.keys(pickedQs).length + Object.keys(goldQs).length) r2 = await deps.laya.systemOne(state, { ...pickedQs, ...goldQs });
    const gEmpty = Object.fromEntries(Object.entries(emptySlotAnswers(TOOL[gold.action], cands)).map(([k, a]) => [GOLD_PREFIX + k, a]));
    const all = { ...r1.answers, risky: rk.answers.risky, ...(r2?.answers || {}), ...emptySlotAnswers(TOOL[picked], cands), ...(picked === gold.action ? {} : gEmpty) };
    const answers = {}, goldAnswers = {}, options = {};
    for (const [k, a] of Object.entries(all)) {
      if (k.startsWith(GOLD_PREFIX)) goldAnswers[k.slice(GOLD_PREFIX.length)] = compactAnswer(a);
      else answers[k] = compactAnswer(a);
    }
    if (picked === gold.action) for (const k of Object.keys(pickedQs)) goldAnswers[k] = answers[k];
    for (const slot of TOOL[gold.action]?.slots || []) {
      const a = goldAnswers[ARG_PREFIX + slot.name];
      if (a) options[slot.name] = goldOption(slot.name, a.probabilities, gold.args?.[slot.name]);
    }
    const rec = {
      task: task.id, split: task.split, category: task.category, step: i, goal: task.goal,
      gold: { action: gold.action, args: gold.args, ...(gold.alt ? { alt: gold.alt } : {}) }, sideEffect,
      s1: { answers, gold: { answers: goldAnswers, options }, ms: Math.round((r1.latency_ms || 0) + (r2?.latency_ms || 0) + (i === 0 ? rk.latency_ms || 0 : 0)), tokens: (r1.usage?.input_tokens || 0) + (r2?.usage?.input_tokens || 0) },
    };
    if (deps.s2) {
      const d = await deps.s2.decide({ goal: task.goal, state, s1View: s1View(answers, pickedQs) });
      rec.s2 = { action: d.action, args: d.args, reason: d.reason, ms: Math.round(d.ms), ...(d.parseError ? { parseError: d.parseError, raw: d.raw } : {}) };
    }
    out.push(rec);
    await deps.onStep?.(rec);
  }
  return out;
}

/** Everything that identifies a run's model outputs (not the gate, which is applied afterwards). */
export function runKey({ variant, s2Model, questionsKey }) {
  return [variant || "?", s2Model || "no-s2", questionsKey].join("|");
}

/** Fingerprint of the question wording + registry + suite, so stale recordings are ignored. */
export function questionsKey(tasks) {
  const s = JSON.stringify({ a: actionQuestions(), r: riskQuestion(), t: Object.values(TOOL).map((t) => [t.id, t.whenToUse, t.slots]), g: tasks.map((t) => [t.id, t.goal, t.steps.map((s) => [s.action, s.args])]) });
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
