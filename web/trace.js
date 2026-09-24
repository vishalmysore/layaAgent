// Trace records: compaction for recorded.json, the questions a step asked (rebuilt, not stored), re-routing a stored
// run at new thresholds (no model call), and export as JSON or RDF Turtle.
import { TOOL } from "./tools/index.js";
import { actionQuestions, argQuestions } from "./questions.js";
import { route } from "./gate.js";
import { compactAnswer } from "./evalrun.js";

/** The exact questions a step sent to Laya (rebuilt from its candidates, so recordings need not store them). */
export function stepQuestions(step) {
  const picked = step.s1?.answers?.next_action?.forced ? step.s1.answers.next_action.choice : step.s1?.answers?.next_action?.choice;
  return { ...actionQuestions(), ...argQuestions(TOOL[picked], step.candidates || []) };
}

/** Where each step WOULD go at another gate setting (S1's answers are stored; nothing is re-run). */
export function reroute(run, opts) {
  return run.steps.map((s, i) => {
    if (!s.s1?.answers?.next_action || s.replayed) return null;
    const prev = run.steps[i - 1];
    return route(s.s1.answers, { stepIndex: s.index, previous: prev ? { action: prev.action, args: prev.args } : null }, opts).route;
  });
}

export function compactRun(run) {
  return {
    goal: run.goal, at: run.at, totalMs: Math.round(run.totalMs), thresholds: run.thresholds, outcome: run.outcome, source: "recorded",
    steps: run.steps.map((s) => ({
      index: s.index, state: s.state, candidates: (s.candidates || []).map(({ span, kind, from }) => ({ span, kind, from })),
      s1: s.s1?.answers ? { answers: Object.fromEntries(Object.entries(s.s1.answers).map(([k, a]) => [k, { ...compactAnswer(a), ...(a.forced ? { forced: true } : {}) }])), layaMs: Math.round(s.s1.layaMs || 0), ms: Math.round(s.s1.ms || 0) } : {},
      route: s.route, reasons: s.reasons, proposal: s.proposal, decidedBy: s.decidedBy,
      ...(s.s2 ? { s2: { action: s.s2.action, args: s.s2.args, reason: s.s2.reason, ms: Math.round(s.s2.ms || 0), raw: s.s2.raw, prompt: s.s2.prompt, error: s.s2.error || null, agreedWithS1: s.s2.agreedWithS1 } } : {}),
      ...(s.shadow ? { shadow: { action: s.shadow.action, args: s.shadow.args, agreed: s.shadow.agreed, ms: Math.round(s.shadow.ms || 0) } } : {}),
      ...(s.guard ? { guard: s.guard } : {}),
      action: s.action, args: s.args, observation: s.observation,
      ...(s.tool ? { tool: { ...s.tool, ms: Math.round(s.tool.ms) } } : {}),
      ...(s.result ? { result: { answer: s.result.answer, ok: s.result.ok, source: s.result.source } } : {}),
    })),
  };
}

// ---- RDF export ---------------------------------------------------------------------------------------------
const lit = (s) => `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
const num = (x) => `"${Number(x).toFixed(4)}"^^xsd:decimal`;

/** A run as Turtle: la:Run with la:Step nodes, each with who decided, the action, arguments and S1's probabilities. */
export function toTurtle(run, id = "run1") {
  const L = ["@prefix la: <https://vishalmysore.github.io/layaAsAgenticGaurd/ontology#> .", "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .", "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .", ""];
  L.push(`la:${id} a la:Run ;`, `  la:goal ${lit(run.goal)} ;`, `  la:outcome ${lit(run.outcome?.kind)} ;`, `  la:answer ${lit(run.outcome?.text)} ;`);
  L.push(`  la:hasStep ${run.steps.map((s) => `la:${id}_s${s.index}`).join(", ")} .`, "");
  for (const s of run.steps) {
    const n = `la:${id}_s${s.index}`;
    const a = s.s1?.answers;
    L.push(`${n} a la:Step ;`, `  la:index ${s.index} ;`, `  la:decidedBy la:${s.decidedBy || "none"} ;`, `  la:route ${lit(s.route)} ;`, `  la:action ${lit(s.action)} ;`);
    for (const [k, v] of Object.entries(s.args || {})) L.push(`  la:arg [ rdfs:label ${lit(k)} ; la:value ${lit(v)} ] ;`);
    if (a?.next_action) for (const [k, p] of Object.entries(a.next_action.probabilities)) L.push(`  la:actionOption [ rdfs:label ${lit(k)} ; la:probability ${num(p)} ] ;`);
    if (a?.goal_met) L.push(`  la:pGoalMet ${num(a.goal_met.noul)} ;`);
    if (a?.risky) L.push(`  la:pRisky ${num(a.risky.noul)} ;`);
    if (s.guard) L.push(`  la:confirmedByUser ${s.guard.allowed ? "true" : "false"} ;`);
    if (s.reasons?.length) L.push(`  la:holdReason ${s.reasons.map(lit).join(", ")} ;`);
    L.push(`  la:observation ${lit(s.observation)} .`, "");
  }
  return L.join("\n");
}
