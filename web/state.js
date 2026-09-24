// The agent state Laya reads, rendered into a compact object with a fixed token budget per field (Laya's context is
// short and the option list takes part of it). Old observations are summarized by one-line templates, not by a model.
import { stepLine } from "./tools/index.js";

export const BUDGET = { goal: 80, history: 120, observation: 200 };
export const HISTORY_STEPS = 4;

/** Rough token count (~4 characters per token) for Node and for when no tokenizer is loaded. */
export const approxTokens = (s) => Math.ceil(String(s || "").length / 4);

/** Cut text to at most n tokens, on a word boundary, with an ellipsis if anything was dropped. */
export function truncateTokens(text, n, count = approxTokens) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (count(s) <= n) return s;
  const words = s.split(" ");
  let lo = 0, hi = words.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (count(words.slice(0, mid).join(" ") + "…") <= n) lo = mid; else hi = mid - 1; }
  return words.slice(0, lo).join(" ") + "…";
}

/**
 * @param goal     the user's goal
 * @param history  finished steps [{ action, args, observation }]
 * @param count    token counter (the Laya tokenizer in the page)
 * @returns { goal, steps_done: string[], last_observation: string }
 */
export function buildState(goal, history = [], count = approxTokens, budget = BUDGET) {
  const done = history.filter((h) => h.action !== "FINISH");
  const lines = done.slice(-HISTORY_STEPS).map((h) => stepLine(h.action, h.args, h.observation, 140));
  // keep the most recent lines that fit the history budget
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) { const t = count(lines[i]); if (used + t > budget.history) break; kept.unshift(lines[i]); used += t; }
  const last = done.at(-1);
  return {
    goal: truncateTokens(goal, budget.goal, count),
    steps_done: kept,
    last_observation: last ? truncateTokens(last.observation, budget.observation, count) : "",
  };
}
