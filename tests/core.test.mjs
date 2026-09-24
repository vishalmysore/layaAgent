// Node unit tests: tools (no network), candidate extraction, state budget, gate, agent loop with a mock Laya,
// metrics, the task suite and recorded.json. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import nlp from "compromise";
import dates from "compromise-dates";
import { evaluateExpression } from "../web/tools/calculator.js";
import { parseQuantity, convert } from "../web/tools/units.js";
import datemath, { parseDate, parseOffset } from "../web/tools/datemath.js";
import { dayIndices } from "../web/tools/weather.js";
import { memoryNotes, searchNotes } from "../web/tools/notes.js";
import { currentStatements } from "../web/tools/wikidata.js";
import { firstSentences } from "../web/tools/wiki.js";
import { TOOL, TOOLS, isSideEffect } from "../web/tools/index.js";
import { extractCandidates, slotOptions, NONE } from "../web/candidates.js";
import { buildState, truncateTokens } from "../web/state.js";
import { route, guard, score, DEFAULTS } from "../web/gate.js";
import { actionQuestions, argQuestions } from "../web/questions.js";
import { runAgent } from "../web/agent.js";
import { argMatch, goldOption, matchStep } from "../web/gold.js";
import { evaluate, taskResults, tuneOnDev } from "../web/metrics.js";
import { parseReply, STEP_SCHEMA } from "../web/system2.js";
import { questionsKey } from "../web/evalrun.js";
import { toTurtle, compactRun, reroute } from "../web/trace.js";

nlp.plugin(dates);
const tasks = JSON.parse(fs.readFileSync(new URL("../web/tasks.json", import.meta.url), "utf8"));

// ---- tools ------------------------------------------------------------------------------------------------------------
test("calculator: natural spans and precedence, no eval", () => {
  assert.equal(evaluateExpression("18% of 2,450"), 441);
  assert.equal(evaluateExpression("(45 + 55) * 3"), 300);
  assert.equal(evaluateExpression("2^16"), 65536);
  assert.equal(evaluateExpression("7,200 divided by 16"), 450);
  assert.equal(evaluateExpression("1,250 times 12"), 15000);
  assert.throws(() => evaluateExpression("alert(1)"));
});

test("units: parse and convert", () => {
  assert.deepEqual(parseQuantity("20 degrees Fahrenheit"), { value: 20, unit: "F" });
  assert.deepEqual(parseQuantity("1,000 meters"), { value: 1000, unit: "m" });
  assert.ok(Math.abs(convert(5, "mi", "km") - 8.04672) < 1e-9);
  assert.ok(Math.abs(convert(100, "F", "C") - 37.7778) < 1e-3);
  assert.throws(() => convert(1, "kg", "km"));
});

test("date math is relative to ctx.now", async () => {
  const now = "2026-09-24T12:00:00Z";
  assert.equal(parseDate("March 4", now).toISOString().slice(0, 10), "2026-03-04");
  assert.deepEqual(parseOffset("10 days before"), { n: 10, unit: "day", sign: -1 });
  const r = await datemath.run({ date: "March 4", offset: "3 weeks after" }, { now });
  assert.equal(r.data.date, "2026-03-25");
  // 2026-09-24 is a Thursday: the weekend is days +2 and +3
  assert.deepEqual(dayIndices("weekend", now), [2, 3]);
});

test("notes: lexical search and the in-memory store", async () => {
  const n = memoryNotes(["My book club meets on Thursdays at 7pm", "Gym locker code is 4417"]);
  const hits = searchNotes(await n.all(), "book club");
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /book club/);
  const r = await TOOL.note_delete.run({ query: "all notes" }, { notes: n });
  assert.equal(r.data.deleted, 2);
});

test("wikidata: current statements and wikipedia sentences", () => {
  const st = (v, rank = "normal", q = []) => ({ rank, value: { type: "value", content: v }, qualifiers: q, property: { data_type: "string" } });
  const t = (y) => [{ property: { id: "P585" }, value: { content: { time: `+${y}-01-01T00:00:00Z` } } }];
  assert.deepEqual(currentStatements([st("a", "normal", t(2010)), st("b", "normal", t(2020))]).map((s) => s.value.content), ["b"]);
  assert.deepEqual(currentStatements([st("old", "normal", [{ property: { id: "P582" }, value: { content: { time: "+1900" } } }]), st("new")]).map((s) => s.value.content), ["new"]);
  assert.deepEqual(currentStatements([st("x"), st("y", "preferred")]).map((s) => s.value.content), ["y"]);
  assert.equal(firstSentences("It spans a (1.6 km) strait. It opened in 1937. More.", 2), "It spans a (1.6 km) strait. It opened in 1937.");
});

test("registry: side effects, 12 options, short option texts", () => {
  assert.equal(TOOLS.length, 12);
  assert.deepEqual(TOOLS.filter((t) => t.sideEffect).map((t) => t.id).sort(), ["note_delete", "note_save", "send_message"]);
  for (const t of TOOLS) assert.ok(t.whenToUse.split(" ").length <= 18, `${t.id}: whenToUse too long for the shared head`);
  assert.equal(guard("send_message").confirm, true);
  assert.equal(guard("weather").confirm, false);
});

// ---- extraction and state -------------------------------------------------------------------------------------------
test("candidates: multi-hop spans from the observation, NONE always offered", () => {
  const c = extractCandidates(nlp, "What is the population of the country where Kyoto is?", "Kyoto (City in the Kansai region of Japan): Kyoto is the capital city of Kyoto Prefecture.");
  const ent = slotOptions(TOOL.wikidata_fact.slots[0], c);
  assert.ok("Japan" in ent);
  assert.ok(NONE in ent);
  assert.ok(!Object.keys(ent).some((k) => /[():]/.test(k)), "spans are split at brackets and colons");
  const calc = slotOptions(TOOL.calculator.slots[0], extractCandidates(nlp, "What's 18% of 2,450?"));
  assert.ok("18% of 2,450" in calc);
  const msg = extractCandidates(nlp, "Send Priya a message saying I'll be late");
  assert.ok("Priya" in slotOptions(TOOL.send_message.slots[0], msg));
  assert.ok("I'll be late" in slotOptions(TOOL.send_message.slots[1], msg));
  assert.ok(Object.keys(ent).length <= 20);
});

test("state: fixed token budget per field", () => {
  const long = "word ".repeat(500);
  const s = buildState("goal", [{ action: "wiki_lookup", args: { topic: "X" }, observation: long }]);
  assert.ok(s.last_observation.length < long.length);
  assert.ok(s.last_observation.endsWith("…"));
  assert.equal(truncateTokens("short", 10), "short");
  assert.deepEqual(buildState("g").steps_done, []);
});

// ---- gate -----------------------------------------------------------------------------------------------------------
const choice = (probs) => { const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0]; return { type: "choice", choice, probabilities: probs, confidence: 0.1 }; };
const noul = (p) => ({ type: "noul", noul: p, confidence: Math.max(p, 1 - p) });

test("gate: AUTO when confident, HOLD with reasons otherwise", () => {
  const base = { next_action: choice({ weather: 0.8, wiki_lookup: 0.2 }), goal_met: noul(0.1), risky: noul(0.1), "arg:place": choice({ Lisbon: 0.9, NONE: 0.1 }), "arg:when": choice({ tomorrow: 0.7, today: 0.3 }) };
  assert.equal(route(base, { stepIndex: 0 }).route, "AUTO");
  const none = { ...base, "arg:place": choice({ NONE: 0.9, Paris: 0.1 }) };
  const r = route(none, { stepIndex: 0 });
  assert.equal(r.route, "HOLD");
  assert.match(r.reasons.join(), /none of the spans/);
  const low = { ...base, next_action: choice({ weather: 0.25, wiki_lookup: 0.2, calculator: 0.2 }) };
  assert.match(route(low, { stepIndex: 0 }).reasons.join(), /action score/);
  // goal met disagreeing with the next action is itself a HOLD signal
  assert.match(route({ ...base, goal_met: noul(0.9) }, { stepIndex: 1 }, { strictGoalMet: true }).reasons.join(), /goal met/);
  // by default goal_met owns the stop decision
  const stop = route({ ...base, goal_met: noul(0.9) }, { stepIndex: 1 });
  assert.equal(stop.route, "AUTO");
  assert.equal(stop.proposal.action, "FINISH");
  // loop guard
  assert.match(route(base, { stepIndex: 1, previous: { action: "weather", args: { place: "Lisbon", when: "tomorrow" } } }).reasons.join(), /loop guard/);
  // risky goal but a read-only action
  assert.match(route({ ...base, risky: noul(0.8) }, { stepIndex: 0 }).reasons.join(), /risky/);
  assert.equal(score(choice({ a: 0.6, b: 0.3, c: 0.1 }), "margin").toFixed(2), "0.30");
});

// ---- agent loop with a mock System 1 ---------------------------------------------------------------------------------
function mockLaya(script) {
  // script: per step, { action, p, args: { slot: [value, p] }, goalMet, risky }
  let step = -1;
  return {
    async systemOne(state, qs) {
      const answers = {};
      if (qs.risky) return { answers: { risky: noul(script[0].risky ?? 0.1) }, latency_ms: 1 };
      if (qs.next_action) {
        step = state.steps_done.length;
        const s = script[step];
        const keys = Object.keys(qs.next_action.criteria);
        const rest = (1 - s.p) / (keys.length - 1);
        answers.next_action = choice(Object.fromEntries(keys.map((k) => [k, k === s.action ? s.p : rest])));
        if (qs.goal_met) answers.goal_met = noul(s.goalMet ?? 0.1);
      }
      for (const [k, q] of Object.entries(qs)) {
        if (!k.startsWith("arg:")) continue;
        const [v, p] = script[step].args?.[k.slice(4)] || [NONE, 0.9];
        const keys = Object.keys(q.criteria);
        const pick = keys.includes(v) ? v : NONE;
        answers[k] = choice(Object.fromEntries(keys.map((o) => [o, o === pick ? p : (1 - p) / Math.max(1, keys.length - 1)])));
      }
      return { answers, latency_ms: 5 };
    },
  };
}
const fakeTools = { now: "2026-09-24T12:00:00Z", notes: memoryNotes([]) };

test("agent: confident steps run on System 1, the goal is answered", async () => {
  const laya = mockLaya([{ action: "calculator", p: 0.9, args: { expression: ["18% of 2,450", 0.95] } }, { action: "FINISH", p: 0.9, goalMet: 0.9 }]);
  const human = { decide: async () => assert.fail("no human needed"), confirm: async () => assert.fail("no confirm needed") };
  const run = await runAgent("What's 18% of 2,450?", { laya, nlp, human, toolCtx: fakeTools });
  assert.equal(run.outcome.kind, "answered");
  assert.match(run.outcome.text, /441/);
  assert.deepEqual(run.steps.map((s) => s.decidedBy), ["S1", "S1"]);
});

test("agent: HOLD goes to System 2, or to the person when there is none", async () => {
  const script = [{ action: "wikidata_fact", p: 0.9, args: { entity: [NONE, 0.8], property: ["height", 0.9] } }, { action: "FINISH", p: 0.9, goalMet: 0.9 }];
  const s2 = { ready: () => true, decide: async () => ({ action: "calculator", args: { expression: "2+2" }, reason: "test", ms: 1 }) };
  const human = { decide: async () => ({ action: "calculator", args: { expression: "3+3" } }), confirm: async () => true };
  const a = await runAgent("How tall is that iron tower in Paris?", { laya: mockLaya(script), nlp, human, s2, toolCtx: fakeTools });
  assert.equal(a.steps[0].decidedBy, "S2");
  assert.equal(a.steps[0].s2.agreedWithS1, false);
  const b = await runAgent("How tall is that iron tower in Paris?", { laya: mockLaya(script), nlp, human, toolCtx: fakeTools });
  assert.equal(b.steps[0].decidedBy, "human");
  assert.match(b.outcome.text, /= 6/);
});

test("agent: tools that change something need the user's OK; refusing stops the run", async () => {
  const script = [{ action: "send_message", p: 0.95, args: { to: ["Priya", 0.9], text: ["I'll be late", 0.9] }, risky: 0.9 }, { action: "FINISH", p: 0.9, goalMet: 0.9 }];
  let asked = 0;
  const refuse = await runAgent("Send Priya a message saying I'll be late", { laya: mockLaya(script), nlp, human: { decide: async () => null, confirm: async () => { asked++; return false; } }, toolCtx: fakeTools });
  assert.equal(asked, 1);
  assert.equal(refuse.outcome.kind, "refused");
  assert.equal(refuse.steps[0].guard.allowed, false);
  const allow = await runAgent("Send Priya a message saying I'll be late", { laya: mockLaya(script), nlp, human: { decide: async () => null, confirm: async () => true }, toolCtx: fakeTools });
  assert.equal(allow.outcome.kind, "answered");
  assert.match(allow.outcome.text, /nothing was actually sent/);
});

test("agent: what-if replay reuses the prefix and forces the action", async () => {
  const script = [{ action: "calculator", p: 0.9, args: { expression: ["18% of 2,450", 0.95] } }, { action: "FINISH", p: 0.9, goalMet: 0.9 }];
  const human = { decide: async () => null, confirm: async () => true };
  const first = await runAgent("What's 18% of 2,450?", { laya: mockLaya(script), nlp, human, toolCtx: fakeTools });
  const again = await runAgent("What's 18% of 2,450?", { laya: mockLaya(script), nlp, human, toolCtx: fakeTools }, { prefix: first.steps.slice(0, 1), force: { action: "FINISH" } });
  assert.equal(again.steps[0].replayed, true);
  assert.equal(again.steps[1].action, "FINISH");
  assert.equal(again.steps[1].s1.answers.next_action.forced, true);
  const rr = reroute(first, { ...DEFAULTS, tauAction: 0.99 });
  assert.deepEqual(rr, ["HOLD", "HOLD"]);
  assert.match(toTurtle(compactRun(first)), /la:decidedBy la:S1/);
});

// ---- gold matching and metrics ----------------------------------------------------------------------------------------
test("gold: alternatives, numeric expressions, quantities", () => {
  assert.ok(argMatch("expression", "0.18 * 2450", "18% of 2,450"));
  assert.ok(argMatch("quantity", "330 meters", "330 m"));
  assert.ok(argMatch("entity", "Apple Inc", ["Apple Inc.", "Apple"]));
  assert.ok(!argMatch("entity", NONE, "Japan"));
  assert.equal(goldOption("entity", { Kyoto: null, Japan: null, NONE: "x" }, "Japan"), "Japan");
  assert.equal(goldOption("entity", { Paris: null, NONE: "x" }, "Eiffel Tower"), NONE);
  const step = { action: "wiki_lookup", args: { topic: "Kyoto" }, alt: [{ action: "wikidata_fact", args: { entity: "Kyoto", property: "country" } }] };
  assert.ok(matchStep(step, { action: "wikidata_fact", args: { entity: "Kyoto", property: "country" } }).ok);
  assert.ok(!matchStep(step, { action: "wikidata_fact", args: { entity: "Kyoto", property: "capital" } }).ok);
});

function rec(task, stepI, gold, s1, extra = {}) {
  return { task, split: extra.split || "test", category: extra.category || "calc", step: stepI, goal: "g", gold, sideEffect: !!extra.sideEffect, s1: { answers: s1, gold: { answers: s1, options: extra.options || {} }, ms: 10 }, ...(extra.s2 ? { s2: { ...extra.s2, ms: 100 } } : {}) };
}

test("metrics: split, auto-step error, task success for each router", () => {
  const good = { next_action: choice({ calculator: 0.9, FINISH: 0.1 }), goal_met: noul(0.1), risky: noul(0.1), "arg:expression": choice({ "2+2": 0.9, NONE: 0.1 }) };
  const fin = { next_action: choice({ FINISH: 0.9, calculator: 0.1 }), goal_met: noul(0.9), risky: noul(0.1) };
  const unsure = { next_action: choice({ calculator: 0.2, wiki_lookup: 0.19, weather: 0.18 }), goal_met: noul(0.1), risky: noul(0.1), "arg:expression": choice({ "2+2": 0.9, NONE: 0.1 }) };
  const wrong = { next_action: choice({ weather: 0.9, calculator: 0.1 }), goal_met: noul(0.1), risky: noul(0.1), "arg:place": choice({ Paris: 0.9, NONE: 0.1 }), "arg:when": choice({ today: 0.9, tomorrow: 0.1 }) };
  const g1 = { action: "calculator", args: { expression: "2+2" } }, gF = { action: "FINISH", args: {} };
  const s2ok = { action: "calculator", args: { expression: "2 + 2" } };
  const records = [
    rec("a", 0, g1, good, { s2: s2ok }), rec("a", 1, gF, fin, { s2: gF }),
    rec("b", 0, g1, unsure, { s2: s2ok }), rec("b", 1, gF, fin, { s2: gF }),
    rec("c", 0, g1, wrong, { s2: s2ok }), rec("c", 1, gF, fin, { s2: gF }),
  ];
  const e = evaluate(records, { tauAction: 0.3, tauArg: 0.5 });
  assert.equal(e.split.autoN, 5);           // "unsure" is held
  assert.equal(e.autoError, 1 / 5);          // "wrong" runs automatically and is wrong
  assert.equal(e.routers.s1.rate, 2 / 3);    // no gate: b and a right (b's argmax is calculator), c wrong
  assert.equal(e.routers.hybrid.rate, 2 / 3);
  assert.equal(e.routers.s2.rate, 1);
  assert.equal(e.escalationPrecision, 0);    // the held step was actually right
  const t = taskResults(records, { tauAction: 0.3, tauArg: 0.5 }, "hybrid");
  assert.deepEqual(t.map((x) => x.s2), [0, 1, 0]);
  assert.ok(tuneOnDev(records.map((r) => ({ ...r, split: "dev" })), {}, 0.5));
});

// ---- task suite and recordings ---------------------------------------------------------------------------------------
test("tasks.json: valid gold traces", () => {
  assert.ok(tasks.tasks.length >= 100);
  for (const t of tasks.tasks) {
    assert.equal(t.steps.at(-1).action, "FINISH", `${t.id} must end with FINISH`);
    for (const s of t.steps) {
      assert.ok(TOOL[s.action], `${t.id}: unknown action ${s.action}`);
      for (const slot of TOOL[s.action].slots) {
        const v = s.args[slot.name];
        assert.ok(v != null, `${t.id}: ${s.action} is missing ${slot.name}`);
        if (slot.fixed) assert.ok(v in slot.fixed, `${t.id}: ${slot.name}=${v} is not an option`);
      }
      if (s.action !== "FINISH") assert.ok(s.observation && !/failed:/.test(s.observation), `${t.id}: ${s.action} has no good recorded observation`);
    }
  }
  const sides = tasks.tasks.filter((t) => t.steps.some((s) => isSideEffect(s.action)));
  assert.ok(sides.length >= 10);
  assert.ok(tasks.tasks.some((t) => t.split === "dev") && tasks.tasks.some((t) => t.split === "test"));
});

test("questions fit Laya's head: every option gets a marker", () => {
  const q = actionQuestions();
  assert.equal(Object.keys(q.next_action.criteria).length, 12);
  const a = argQuestions(TOOL.wikidata_fact, []);
  assert.equal(Object.keys(a["arg:property"].criteria).length, 11);
});

test("system 2: reply parsing and schema", () => {
  const r = parseReply('{"action":"unit_convert","args":{"quantity":"5 miles","to_unit":"kilometers","extra":"x"},"reason":"r"}');
  assert.deepEqual(r.args, { quantity: "5 miles", to_unit: "km" });
  assert.deepEqual(STEP_SCHEMA.properties.action.enum, TOOLS.map((t) => t.id));
  assert.throws(() => parseReply("no json here"));
});

test("recorded.json matches the current questions and suite", () => {
  const p = new URL("../web/recorded.json", import.meta.url);
  if (!fs.existsSync(p)) return;
  const r = JSON.parse(fs.readFileSync(p, "utf8"));
  if (r.eval?.meta?.questions) assert.equal(r.eval.meta.questions, questionsKey(tasks.tasks), "questions or tasks changed: re-record the evaluation (see README)");
});
