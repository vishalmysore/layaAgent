// Comparing a decision (from Laya, System 2 or a person) with a gold step of the task suite.
// Gold arguments may list alternatives (["Apple Inc.", "Apple"]); calculator expressions match by value and
// quantities by value + unit, so "18% of 2,450" equals "0.18 * 2450".
import { TOOL } from "./tools/index.js";
import { evaluateExpression } from "./tools/calculator.js";
import { parseQuantity } from "./tools/units.js";
import { clean, NONE } from "./candidates.js";

const norm = (s) => clean(String(s ?? "")).toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, " ").trim();
const alts = (v) => (Array.isArray(v) ? v : [v]);

export function argMatch(slotName, predicted, gold) {
  if (predicted == null || predicted === NONE) return false;
  for (const g of alts(gold)) {
    if (slotName === "expression") { try { const a = evaluateExpression(predicted), b = evaluateExpression(g); if (Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b))) return true; } catch { /* fall through */ } }
    if (slotName === "quantity") { try { const a = parseQuantity(predicted), b = parseQuantity(g); if (a.unit === b.unit && Math.abs(a.value - b.value) < 1e-9) return true; } catch { /* fall through */ } }
    if (norm(predicted) === norm(g)) return true;
  }
  return false;
}

/** The option key (among a slot question's options) that is correct for this gold value, or NONE if none is. */
export function goldOption(slotName, options, gold) {
  for (const k of Object.keys(options)) if (k !== NONE && argMatch(slotName, k, gold)) return k;
  return NONE;
}

/** Every acceptable { action, args } for a gold step (the primary one first). */
export const goldChoices = (step) => [{ action: step.action, args: step.args || {} }, ...(step.alt || [])];

/** Does a decision match the gold step (primary or an alternative)? Returns { ok, action, args, which }. */
export function matchStep(step, decision) {
  let best = { ok: false, action: false, args: false, which: -1 };
  goldChoices(step).forEach((g, which) => {
    if (decision?.action !== g.action) return;
    const slots = TOOL[g.action]?.slots || [];
    const args = slots.every((s) => argMatch(s.name, decision.args?.[s.name], g.args?.[s.name]));
    if (!best.action || (args && !best.args)) best = { ok: args, action: true, args, which };
  });
  return best;
}
