// wikidata_fact: one property of one entity from Wikidata (entity search + a one-line SPARQL query; both CORS-enabled).
// The property is a FIXED list, so Laya chooses it; numbers come back as data and are never reasoned about by Laya.
import { fmtNumber } from "./calculator.js";

export const PROPERTIES = {
  population: { pid: "P1082", label: "population", number: true },
  capital: { pid: "P36", label: "capital city" },
  country: { pid: "P17", label: "country it is in", name: "country" },
  head_of_government: { pid: "P6", label: "head of government, e.g. prime minister or mayor" },
  ceo: { pid: "P169", label: "chief executive officer" },
  founded: { pid: "P571", label: "date founded or created", date: true },
  founder: { pid: "P112", label: "founder" },
  official_language: { pid: "P37", label: "official language" },
  currency: { pid: "P38", label: "currency" },
  area: { pid: "P2046", label: "area", number: true, unit: "km²" },
  height: { pid: "P2048", label: "height", number: true, unit: "m" },
};

const SEARCH = "https://www.wikidata.org/w/api.php";
const REST = "https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items/";

export function formatValue(prop, raw) {
  if (prop.date) return String(raw).replace(/^\+/, "").slice(0, 4);
  if (prop.number) return `${fmtNumber(Math.round(+raw * 100) / 100)}${prop.unit ? " " + prop.unit : ""}`;
  return raw;
}

const qual = (st, pid) => st.qualifiers?.find((q) => q.property.id === pid)?.value?.content;
/**
 * The current value(s) of a property, like Wikidata's "truthy" statements: no deprecated ones; preferred rank wins;
 * statements with an end time are dropped when others remain; with a point in time (population), the latest wins.
 */
export function currentStatements(list = []) {
  let s = list.filter((x) => x.rank !== "deprecated" && x.value?.type === "value");
  if (s.some((x) => x.rank === "preferred")) s = s.filter((x) => x.rank === "preferred");
  const open = s.filter((x) => !qual(x, "P582"));
  if (open.length) s = open;
  const dated = s.filter((x) => qual(x, "P585")?.time);
  if (dated.length) { const t = dated.map((x) => qual(x, "P585").time).sort().at(-1); s = dated.filter((x) => qual(x, "P585").time === t); }
  return s;
}

export default {
  id: "wikidata_fact",
  whenToUse: "Look up one fact about a named thing, such as its population, capital, CEO, founder or height",
  slots: [
    { name: "entity", kinds: ["proper", "place", "person", "org", "topic"], instruction: "Which named thing is the fact about?", none: "None of these is the thing the fact is about" },
    { name: "property", fixed: Object.fromEntries(Object.entries(PROPERTIES).map(([k, v]) => [k, v.label])), instruction: "Which fact about it is needed?" },
  ],
  async run({ entity, property }, ctx = {}) {
    const f0 = ctx.fetch || fetch;
    // Wikidata rate-limits bursts (HTTP 429): wait and retry a couple of times
    const f = async (url, init) => { for (let i = 0; ; i++) { const r = await f0(url, init); if (r.status !== 429 || i >= 2) return r; await new Promise((res) => setTimeout(res, 1500 * (i + 1))); } };
    const prop = PROPERTIES[property];
    if (!prop) throw new Error(`unknown property "${property}"`);
    const s = await f(`${SEARCH}?action=wbsearchentities&search=${encodeURIComponent(entity)}&language=en&format=json&limit=1&origin=*`).then((r) => r.json());
    const hit = s.search?.[0];
    if (!hit) return { observation: `Wikidata has no entity called "${entity}".`, answer: `No Wikidata entity for "${entity}".`, data: null, ok: false };
    const r = await f(`${REST}${hit.id}/statements?property=${prop.pid}`);
    if (!r.ok) throw new Error(`Wikidata: HTTP ${r.status}`);
    const sts = currentStatements((await r.json())[prop.pid]);
    const label = hit.label || entity;
    const name = prop.name || prop.label.split(",")[0];
    if (!sts.length) return { observation: `Wikidata lists no ${name} for ${label}.`, answer: `No ${name} recorded for ${label}.`, data: null, ok: false };
    const vals = [];
    for (const st of sts.slice(0, 3)) {
      const c = st.value.content;
      let v;
      if (st.property.data_type === "wikibase-item") v = await f(`${REST}${c}/labels/en`).then((x) => (x.ok ? x.json() : c)).catch(() => c);
      else if (st.property.data_type === "quantity") v = formatValue(prop, c.amount);
      else if (st.property.data_type === "time") v = formatValue(prop, c.time);
      else v = typeof c === "object" ? c.text ?? JSON.stringify(c) : c;
      if (!vals.includes(v)) vals.push(v);
    }
    const out = `${name[0].toUpperCase()}${name.slice(1)} of ${label} (${hit.description || hit.id}): ${vals.join(", ")} (Wikidata)`;
    return { observation: out, answer: out, data: { id: hit.id, values: vals }, source: `https://www.wikidata.org/wiki/${hit.id}` };
  },
};
