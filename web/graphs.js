// Graph views (Cytoscape.js + dagre, vendored and loaded as globals by the page). Adapted from layaForWorkflows.
//   renderTrace    one run: a decision diamond per step, colored by who decided, the tool call, its observation.
//                  HOLD steps show System 1's diamond with an amber escalation edge to System 2 / the person;
//                  dashed "alternative" edges show the next two actions System 1 considered (click one: what-if).
//   renderSession  every run in this tab merged: which tools follow which, and where escalations cluster.
import { topOptions } from "./questions.js";
import { FINISH } from "./tools/index.js";

const cytoscape = globalThis.cytoscape;
if (cytoscape && globalThis.cytoscapeDagre && !cytoscape.__dagre) { cytoscape.use(globalThis.cytoscapeDagre); cytoscape.__dagre = true; }

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export function palette() {
  const n = ["bg", "card", "ink", "ink2", "ink3", "line", "soft", "accent", "accent-soft", "s1", "s1-soft", "s2", "s2-soft", "task", "task-soft",
    "auto", "auto-soft", "human", "human-soft", "block", "block-soft"];
  return Object.fromEntries(n.map((k) => [k.replace(/-(\w)/g, (_, c) => c.toUpperCase()), css("--" + k)]));
}
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const argText = (args) => Object.values(args || {}).filter((v) => v != null && v !== "").map((v) => trunc(v, 28)).join(", ");
export const WHO = { S1: "System 1 · Laya", S2: "System 2 · WebLLM", human: "You", budget: "Step budget" };

let tipEl = null;
function tip(cy) {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; tipEl.hidden = true; document.body.appendChild(tipEl); }
  cy.on("mouseover", "node, edge", (e) => { const t = e.target.data("tip"); if (!t) return; tipEl.textContent = t; tipEl.hidden = false; });
  cy.on("mousemove", (e) => { if (tipEl.hidden || !e.originalEvent) return; tipEl.style.left = e.originalEvent.clientX + 12 + "px"; tipEl.style.top = e.originalEvent.clientY + 12 + "px"; });
  cy.on("mouseout", "node, edge", () => { tipEl.hidden = true; });
}

function baseStyle(P) {
  return [
    { selector: "node", style: {
      label: "data(label)", "text-wrap": "wrap", "text-max-width": 150, "font-size": 10.5, color: P.ink, "text-valign": "center", "text-halign": "center",
      "background-color": P.card, "border-width": 1.5, "border-color": P.line, "font-family": "system-ui, sans-serif" } },
    { selector: "edge", style: {
      width: 1.8, "line-color": P.ink3, "target-arrow-color": P.ink3, "target-arrow-shape": "triangle", "arrow-scale": 0.9, "curve-style": "bezier",
      label: "data(label)", "font-size": 9.5, color: P.ink2, "text-background-color": P.bg, "text-background-opacity": 0.92, "text-background-padding": 2, "text-rotation": "none" } },
    { selector: "node:selected", style: { "underlay-color": P.accent, "underlay-opacity": 0.22, "underlay-padding": 8 } },
  ];
}

/** Route of a step at the CURRENT gate (may differ from how it was decided, when a slider moved). */
function stepLabel(s, rerouted) {
  const who = s.decidedBy === "S1" ? "S1" : s.decidedBy === "S2" ? "S2" : s.decidedBy === "human" ? "you" : s.decidedBy;
  // a FINISH from System 1 comes from its "goal met" question, so show that probability, not the FINISH option's
  const gm = s.action === FINISH ? s.s1?.answers?.goal_met?.noul : null;
  const p = s.s1?.answers?.next_action?.probabilities?.[s.action];
  const score = s.decidedBy !== "S1" ? "" : gm != null ? ` · goal met ${gm.toFixed(2)}` : p != null ? ` · p ${p.toFixed(2)}` : "";
  return `#${s.index + 1} ${s.action || "stop"}\n${who}${score}${rerouted ? `\nnow: ${rerouted}` : ""}`;
}

export function traceElements(run, opts = {}) {
  const els = [];
  const cls = { S1: "s1", S2: "s2", human: "human", budget: "budget" };
  els.push({ data: { id: "goal", label: trunc(run.goal, 90), tip: run.goal, kind: "goal" }, classes: "goal" });
  let prev = "goal";
  run.steps.forEach((s) => {
    const i = s.index;
    const held = s.route === "HOLD";
    const a = s.s1?.answers;
    // System 1's own diamond (only when it was overruled / escalated)
    if (held && a) {
      const pk = s.proposal?.action ?? a.next_action?.choice;
      els.push({ data: { id: `s1_${i}`, label: `#${i + 1} S1 proposed\n${pk}${a.next_action?.probabilities?.[pk] != null ? ` · p ${a.next_action.probabilities[pk].toFixed(2)}` : ""}`, tip: `System 1 was not sure:\n${(s.reasons || []).join("\n")}`, step: i, kind: "s1" }, classes: "dec s1 held" });
      els.push({ data: { id: `${prev}->s1_${i}`, source: prev, target: `s1_${i}`, label: "" }, classes: "flow" });
      els.push({ data: { id: `s1_${i}->d_${i}`, source: `s1_${i}`, target: `d_${i}`, label: "HOLD", tip: (s.reasons || []).join("\n") }, classes: "escalate" });
    }
    const re = opts.reroute?.[i];
    els.push({ data: { id: `d_${i}`, label: stepLabel(s, re && re !== s.route ? re : null), tip: `${WHO[s.decidedBy] || s.decidedBy} decided: ${s.action}(${argText(s.args)})${s.reasons?.length ? "\nwhy it was held: " + s.reasons.join("; ") : ""}`, step: i, kind: "decision" }, classes: `dec ${cls[s.decidedBy] || "budget"}${s.replayed ? " replayed" : ""}${opts.forcedAt === i ? " forced" : ""}` });
    if (!held || !a) els.push({ data: { id: `${prev}->d_${i}`, source: prev, target: `d_${i}`, label: "" }, classes: "flow" });
    // alternatives System 1 considered
    if (a?.next_action) {
      const from = held ? `s1_${i}` : `d_${i}`;
      topOptions(a.next_action, 3).filter((o) => o.key !== (s.proposal?.action ?? s.action)).slice(0, 2).forEach((o, k) => {
        els.push({ data: { id: `alt_${i}_${k}`, label: `${o.key}\n${(o.p * 100).toFixed(0)}%`, tip: `System 1 gave ${o.key} p = ${o.p.toFixed(3)}.\nClick to replay the run from here with this action (needs System 1 loaded).`, step: i, alt: o.key, kind: "alt" }, classes: "alt" });
        els.push({ data: { id: `${from}->alt_${i}_${k}`, source: from, target: `alt_${i}_${k}`, label: "" }, classes: "altedge" });
      });
    }
    let tail = `d_${i}`;
    if (s.guard) {
      els.push({ data: { id: `g_${i}`, label: s.guard.allowed ? "you allowed it" : "you refused", tip: `Guard: ${s.guard.reason}`, step: i, kind: "guard" }, classes: `guard ${s.guard.allowed ? "ok" : "no"}` });
      els.push({ data: { id: `${tail}->g_${i}`, source: tail, target: `g_${i}`, label: "confirm?" }, classes: "flow" });
      tail = `g_${i}`;
      if (!s.guard.allowed) { prev = tail; return; }
    }
    if (!s.action) { prev = tail; return; }
    if (s.action === FINISH) {
      const out = run.outcome;
      els.push({ data: { id: "answer", label: trunc(out?.text || "done", 120), tip: out?.text || "", kind: "answer" }, classes: "answer" });
      els.push({ data: { id: `${tail}->answer`, source: tail, target: "answer", label: "" }, classes: "flow" });
      prev = "answer"; return;
    }
    els.push({ data: { id: `t_${i}`, label: `${s.action}(${argText(s.args)})${s.tool ? `\n${Math.round(s.tool.ms)} ms` : ""}`, tip: `${s.action}(${JSON.stringify(s.args)})${s.tool?.error ? "\nerror: " + s.tool.error : ""}`, step: i, kind: "tool" }, classes: `tool${s.tool && !s.tool.ok ? " fail" : ""}` });
    els.push({ data: { id: `${tail}->t_${i}`, source: tail, target: `t_${i}`, label: "" }, classes: "flow" });
    els.push({ data: { id: `o_${i}`, label: trunc(s.observation, 110), tip: s.observation, step: i, kind: "obs" }, classes: "obs" });
    els.push({ data: { id: `t_${i}->o_${i}`, source: `t_${i}`, target: `o_${i}`, label: "" }, classes: "flow" });
    prev = `o_${i}`;
  });
  if (run.outcome && run.outcome.kind !== "answered" && !run.steps.some((s) => s.action === FINISH)) {
    els.push({ data: { id: "end", label: run.outcome.text || run.outcome.kind, kind: "end" }, classes: "end" });
    els.push({ data: { id: `${prev}->end`, source: prev, target: "end", label: "" }, classes: "flow" });
  }
  return els;
}

function traceStyle(P) {
  return [
    ...baseStyle(P),
    { selector: ".goal", style: { shape: "round-rectangle", width: 230, height: 50, "background-color": P.accentSoft, "border-color": P.accent, "border-width": 2, "text-max-width": 214, "font-weight": 600 } },
    { selector: ".dec", style: { shape: "diamond", width: 150, height: 92, "border-width": 2.5, "text-max-width": 96, "font-size": 10 } },
    { selector: ".dec.s1", style: { "background-color": P.s1Soft, "border-color": P.s1 } },
    { selector: ".dec.s2", style: { "background-color": P.s2Soft, "border-color": P.s2 } },
    { selector: ".dec.human", style: { "background-color": P.humanSoft, "border-color": P.human } },
    { selector: ".dec.budget", style: { "background-color": P.soft, "border-color": P.ink3 } },
    { selector: ".dec.held", style: { "border-style": "dashed", opacity: 0.85 } },
    { selector: ".dec.replayed", style: { opacity: 0.6 } },
    { selector: ".dec.forced", style: { "underlay-color": P.human, "underlay-opacity": 0.25, "underlay-padding": 6 } },
    { selector: ".tool", style: { shape: "round-rectangle", width: 200, height: 42, "background-color": P.taskSoft, "border-color": P.task, "text-max-width": 186, "font-family": "ui-monospace, Menlo, Consolas, monospace", "font-size": 9.5 } },
    { selector: ".tool.fail", style: { "border-color": P.block, "background-color": P.blockSoft } },
    { selector: ".obs", style: { shape: "cut-rectangle", width: 230, height: 58, "background-color": P.bg, "border-color": P.line, "text-max-width": 216, "font-size": 9.5, color: P.ink2 } },
    { selector: ".guard", style: { shape: "hexagon", width: 120, height: 40, "border-width": 2.5, "font-weight": 600, "font-size": 10 } },
    { selector: ".guard.ok", style: { "background-color": P.humanSoft, "border-color": P.block } },
    { selector: ".guard.no", style: { "background-color": P.blockSoft, "border-color": P.block } },
    { selector: ".answer", style: { shape: "round-rectangle", width: 240, height: 56, "background-color": P.autoSoft, "border-color": P.auto, "border-width": 2.5, "text-max-width": 226, "font-weight": 600 } },
    { selector: ".end", style: { shape: "round-rectangle", width: 200, height: 40, "background-color": P.blockSoft, "border-color": P.block, "border-width": 2 } },
    { selector: ".alt", style: { shape: "diamond", width: 84, height: 54, "background-color": P.card, "border-style": "dashed", "border-color": P.ink3, color: P.ink2, "font-size": 9, "text-max-width": 70, cursor: "pointer" } },
    { selector: ".alt:active, .alt:selected", style: { "border-color": P.accent, color: P.ink } },
    { selector: "edge.flow", style: { width: 2.5, "line-color": P.accent, "target-arrow-color": P.accent } },
    { selector: "edge.escalate", style: { width: 2.5, "line-style": "dashed", "line-color": P.human, "target-arrow-color": P.human, color: P.human, "font-weight": 700 } },
    { selector: "edge.altedge", style: { width: 1.2, "line-style": "dashed", "line-color": P.ink3, "target-arrow-shape": "none", opacity: 0.8 } },
  ];
}

/** Render one run. onSelect(kind, stepIndex, extra) fires on node taps. */
export function renderTrace(container, run, opts = {}, onSelect) {
  const P = palette();
  const cy = cytoscape({ container, elements: traceElements(run, opts), style: traceStyle(P), wheelSensitivity: 0.25, minZoom: 0.15, maxZoom: 2.5, boxSelectionEnabled: false, autoungrabify: true });
  runLayout(cy, { name: "dagre", rankDir: "TB", nodeSep: 22, rankSep: 30, edgeSep: 10 });
  tip(cy);
  cy.on("tap", "node", (e) => onSelect?.(e.target.data("kind"), e.target.data("step"), e.target.data()));
  return cy;
}

/** Merge runs: START -> tool -> ... -> outcome, edge width = how often, amber halo = share of held steps. */
export function renderSession(container, runs, onSelect) {
  const P = palette();
  const nodes = new Map(), edges = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { id, n: 0, S1: 0, S2: 0, human: 0, held: 0, blocked: 0 }); return nodes.get(id); };
  const edge = (a, b) => { const k = `${a}->${b}`; edges.set(k, (edges.get(k) || 0) + 1); };
  node("START").n = runs.length;
  for (const r of runs) {
    let prev = "START";
    for (const s of r.steps) {
      if (!s.action) continue;
      const id = s.action === FINISH ? "FINISH" : s.action;
      const x = node(id); x.n++; x[s.decidedBy] = (x[s.decidedBy] || 0) + 1; if (s.route === "HOLD") x.held++; if (s.guard) x.blocked++;
      edge(prev, id); prev = id;
    }
    const end = r.outcome?.kind === "answered" ? "answered" : r.outcome?.kind || "stopped";
    node("◼ " + end).n++; edge(prev, "◼ " + end);
  }
  const maxE = Math.max(1, ...edges.values());
  const els = [];
  for (const x of nodes.values()) {
    const isEnd = x.id.startsWith("◼") || x.id === "START";
    const s1 = x.S1 || 0, tot = (x.S1 || 0) + (x.S2 || 0) + (x.human || 0);
    const label = isEnd ? `${x.id}\n${x.n}` : `${x.id}\n${x.n} call${x.n > 1 ? "s" : ""}${tot ? ` · S1 ${Math.round((100 * s1) / tot)}%` : ""}${x.held ? ` · ${x.held} held` : ""}`;
    els.push({ data: { id: x.id, label, heat: x.n ? x.held / x.n : 0, tip: `${x.id}: ${x.n}\nSystem 1 ${x.S1 || 0} · System 2 ${x.S2 || 0} · you ${x.human || 0}\nheld for escalation: ${x.held}${x.blocked ? `\nconfirmations asked: ${x.blocked}` : ""}` }, classes: isEnd ? "end" : x.id === "FINISH" ? "fin" : "toolnode" });
  }
  for (const [k, c] of edges) { const [a, b] = k.split("->"); els.push({ data: { id: k, source: a, target: b, label: String(c), w: 1.5 + 8 * (c / maxE) } }); }
  const style = [
    ...baseStyle(P),
    { selector: ".toolnode", style: { shape: "round-rectangle", width: 170, height: 46, "background-color": P.s1Soft, "border-color": P.s1, "border-width": 2, "underlay-color": P.human, "underlay-opacity": "data(heat)", "underlay-padding": 7 } },
    { selector: ".fin", style: { shape: "diamond", width: 120, height: 70, "background-color": P.autoSoft, "border-color": P.auto, "border-width": 2 } },
    { selector: ".end", style: { shape: "round-rectangle", width: 120, height: 36, "background-color": P.soft, "border-color": P.ink3 } },
    { selector: "edge", style: { width: "data(w)", "line-color": P.accent, "target-arrow-color": P.accent, opacity: 0.8 } },
  ];
  const cy = cytoscape({ container, elements: els, style, wheelSensitivity: 0.25, minZoom: 0.15, maxZoom: 2.5, boxSelectionEnabled: false, autoungrabify: true });
  runLayout(cy, { name: "dagre", rankDir: "LR", nodeSep: 26, rankSep: 70 });
  tip(cy);
  cy.on("tap", "node", (e) => onSelect?.(e.target.id()));
  return cy;
}

function runLayout(cy, opts) {
  // fit, but never blow a one- or two-node graph up past natural size
  const fit = () => { if (cy.destroyed()) return; cy.resize(); cy.fit(undefined, 18); if (cy.zoom() > 1.1) { cy.zoom(1.1); cy.center(); } };
  cy.one("layoutstop", () => requestAnimationFrame(fit));
  cy.layout({ padding: 16, fit: true, ...opts }).run();
}
