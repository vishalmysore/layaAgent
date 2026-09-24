// The typed questions System 1 (Laya) answers. Laya never writes: every question is a choice among options that
// something else proposed (the tool registry, the candidate extractor, a fixed list) or a yes/no.
import { TOOLS } from "./tools/index.js";
import { slotOptions, NONE } from "./candidates.js";

export const ARG_PREFIX = "arg:";

/**
 * Decision pass. next_action every step; goal_met from the second step on (nothing is gathered before that).
 * The risk question is about the GOAL, so it is asked once per run, on the goal alone (riskQuestion), which is cheap.
 */
export function actionQuestions(tools = TOOLS, stepIndex = 1) {
  const q = {
    next_action: {
      type: "choice",
      instructions: "Which tool should the assistant use next for this goal?",
      criteria: Object.fromEntries(tools.map((t) => [t.id, t.whenToUse])),
    },
  };
  if (stepIndex > 0) q.goal_met = { type: "noul", instructions: "The last observation contains the final answer to the goal" };
  return q;
}

export const riskQuestion = () => ({ risky: { type: "noul", instructions: "The goal asks to save, send, delete or change something for the user" } });
export const riskState = (goal) => ({ goal });

/**
 * Argument pass: one choice question per slot of the chosen tool (options = spans + NONE, or a fixed list).
 * A slot with no candidate span at all is not asked (Laya needs at least two options); it is answered NONE directly.
 */
export function argQuestions(tool, cands) {
  const qs = {};
  for (const slot of tool?.slots || []) {
    const criteria = slotOptions(slot, cands);
    if (Object.keys(criteria).length >= 2) qs[ARG_PREFIX + slot.name] = { type: "choice", instructions: slot.instruction, criteria };
  }
  return qs;
}

/** Answers for slots that had no candidate span (see argQuestions). */
export function emptySlotAnswers(tool, cands) {
  const out = {};
  for (const slot of tool?.slots || []) {
    if (Object.keys(slotOptions(slot, cands)).length < 2) out[ARG_PREFIX + slot.name] = { type: "choice", choice: NONE, probabilities: { [NONE]: 1 }, confidence: 1, noCandidates: true };
  }
  return out;
}

/** Top-n options of a choice answer, best first: [{ key, p }]. */
export function topOptions(answer, n = 3) {
  return Object.entries(answer?.probabilities || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, p]) => ({ key, p }));
}
