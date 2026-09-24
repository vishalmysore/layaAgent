import fs from "node:fs";
import { evaluate, sweep, tuneOnDev } from "./web/metrics.js";
import { DEFAULTS } from "./web/gate.js";
const run = JSON.parse(fs.readFileSync(".cache/eval.json", "utf8")).result;
const all = run.records; console.log("records", all.length, run.meta);
const pr = (name, recs, o = {}) => { const e = evaluate(recs, { ...DEFAULTS, ...o });
  console.log(`\n== ${name} n=${e.n.tasks}/${e.n.steps}`, JSON.stringify({ S1: e.split.S1, autoErr: e.autoError, escPrec: e.escalationPrecision, s1Acc: e.s1StepAcc, s2Acc: e.s2StepAcc, s2Hold: e.s2OnHoldAcc, act: e.actionAcc, actGM: e.actionAccWithGoalMet, arg: e.argAcc, span: e.spanArgAcc, fixed: e.fixedArgAcc, extr: e.extractorRecall, none: e.noneRecall, gm: e.goalMet, risk: e.risk, routers: Object.fromEntries(Object.entries(e.routers).map(([k, v]) => [k, v && +v.rate.toFixed(3)])), calls: e.calls, lat: e.latency }, (k, v) => typeof v === "number" ? +v.toFixed(3) : v));
  for (const c of e.byCategory) console.log("  ", c.name.padEnd(10), JSON.stringify(c, (k, v) => typeof v === "number" ? +v.toFixed(2) : v)); };
pr("test default", all.filter(r => r.split === "test"));
pr("dev default", all.filter(r => r.split === "dev"));
for (const cap of [0.05, 0.1, 0.15]) { const t = tuneOnDev(all, DEFAULTS, cap); console.log("tune cap", cap, JSON.stringify(t)); if (t) pr(`test @dev-tuned tau=${t.tau}`, all.filter(r => r.split === "test"), { tauAction: t.tau, tauArg: t.tau }); }
console.log("\nsweep test", JSON.stringify(sweep(all.filter(r => r.split === "test"), DEFAULTS).map(p => [p.tau, p.s1Share && +p.s1Share.toFixed(2), p.autoAcc && +p.autoAcc.toFixed(2), p.success && +p.success.toFixed(2)])));
