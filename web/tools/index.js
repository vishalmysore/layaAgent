// The tool registry. Each tool: { id, whenToUse, slots[], sideEffect?, run(args, ctx) -> { observation, answer, data, ok?, source? } }.
//   whenToUse   the option text Laya reads for the action question (short: all 12 share a 256-token head)
//   slots       what the argument pass asks, one choice question each:
//                 kinds   candidate kinds from candidates.js the slot accepts (spans found in the goal / observation)
//                 fixed   a fixed option list { key: label } instead of spans (Laya picks the key)
//                 extra   literal options always offered next to the spans (e.g. "today")
//   sideEffect  set on tools that change something; the guard always asks the user before they run
// Order matters only for display. FINISH is always last.
import wiki from "./wiki.js";
import wikidata from "./wikidata.js";
import weather from "./weather.js";
import calculator from "./calculator.js";
import units from "./units.js";
import datemath from "./datemath.js";
import { noteSave, noteSearch, noteDelete } from "./notes.js";
import { sendMessage, askUser, finish } from "./misc.js";

export const TOOLS = [wiki, wikidata, weather, calculator, units, datemath, noteSave, noteSearch, noteDelete, sendMessage, askUser, finish];
export const TOOL = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
export const FINISH = "FINISH";
export const isSideEffect = (id) => !!TOOL[id]?.sideEffect;

/** One-line summary of a finished step for the agent's history ("wiki_lookup(Kyoto) -> Kyoto: capital of ..."). */
export function stepLine(action, args, observation, max = 160) {
  const a = Object.values(args || {}).filter((v) => v != null && v !== "").join(", ");
  const o = String(observation || "").replace(/\s+/g, " ");
  const line = `${action}(${a}) -> ${o}`;
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
