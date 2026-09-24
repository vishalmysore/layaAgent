// date_math: "3 weeks after March 4", "10 days before 2026-12-25", "90 days from today". Local, deterministic
// (the reference "today" comes from ctx.now, so recorded runs replay the same).

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const monthIdx = (w) => MONTHS.findIndex((m) => m.startsWith(String(w).toLowerCase().slice(0, 3)));
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
export const today = (now) => { const n = now ? new Date(now) : new Date(); return utc(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); };

/** "March 4", "4 March 2027", "2026-12-25", "today", "tomorrow", "Christmas" -> Date (UTC midnight). */
export function parseDate(span, now) {
  const s = String(span).trim().toLowerCase().replace(/[?.!,]+$/, "").replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  const t = today(now);
  if (!s || s === "today" || s === "now") return t;
  if (s === "tomorrow") return utc(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
  if (s === "yesterday") return utc(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - 1);
  if (/christmas/.test(s)) return utc(t.getUTCFullYear(), 11, 25);
  if (/new year/.test(s)) return utc(t.getUTCFullYear() + 1, 0, 1);
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return utc(+m[1], +m[2] - 1, +m[3]);
  if ((m = /^([a-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s)) && monthIdx(m[1]) >= 0) return utc(m[3] ? +m[3] : t.getUTCFullYear(), monthIdx(m[1]), +m[2]);
  if ((m = /^(\d{1,2})\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/.exec(s)) && monthIdx(m[2]) >= 0) return utc(m[3] ? +m[3] : t.getUTCFullYear(), monthIdx(m[2]), +m[1]);
  throw new Error(`cannot read the date "${span}"`);
}

/** "3 weeks after" / "10 days before" / "2 months" -> { n, unit, sign } */
export function parseOffset(span) {
  const s = String(span).toLowerCase();
  const m = /(\d+)\s*(day|week|month|year)s?/.exec(s);
  if (!m) throw new Error(`cannot read the offset "${span}"`);
  return { n: +m[1], unit: m[2], sign: /\b(before|earlier|ago|prior)\b/.test(s) ? -1 : 1 };
}

export function addOffset(date, { n, unit, sign }) {
  const d = new Date(date.getTime());
  const k = n * sign;
  if (unit === "day") d.setUTCDate(d.getUTCDate() + k);
  else if (unit === "week") d.setUTCDate(d.getUTCDate() + 7 * k);
  else if (unit === "month") d.setUTCMonth(d.getUTCMonth() + k);
  else d.setUTCFullYear(d.getUTCFullYear() + k);
  return d;
}

export const fmtDate = (d) => `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1)} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

export default {
  id: "date_math",
  whenToUse: "Work out a date by adding or subtracting days, weeks or months",
  slots: [
    { name: "date", kinds: ["date"], extra: ["today"], instruction: "Which date is the starting point?", none: "None of these is the starting date" },
    { name: "offset", kinds: ["duration"], instruction: "How much time should be added or subtracted?", none: "None of these is the amount of time" },
  ],
  async run({ date, offset }, ctx = {}) {
    const d0 = parseDate(date, ctx.now), off = parseOffset(offset);
    const d = addOffset(d0, off);
    const out = `${off.n} ${off.unit}${off.n === 1 ? "" : "s"} ${off.sign < 0 ? "before" : "after"} ${fmtDate(d0)} is ${fmtDate(d)}`;
    return { observation: out, answer: out, data: { date: d.toISOString().slice(0, 10) } };
  },
};
