// Candidate extraction for "extraction by choice": Laya cannot write a tool argument, but it can pick one from a
// list. This builds the list from the goal and the last observation with compromise (+ compromise-dates) and a few
// regexes. No model is involved. `nlp` is injected so the same code runs in the page (vendored build) and in Node.
import { UNIT_WORDS } from "./tools/units.js";

export const MAX_OPTIONS = 20; // Laya's practical option limit; spans + NONE must fit
export const NONE = "NONE";

const LEAD = /^(?:the|a|an|my|our|your|his|her|their|its|this|that|these|those|some|all|any|me|about)\s+/i;
// Capitalized only because they start a sentence or a description ("City in the Kansai region of Japan").
const GENERIC = new Set("city town village country state region province island tower building river lake mountain company person people capital prefecture county district".split(" "));
const QWORDS = new Set("what what's whats who who's when where which why how is are was were do does did can could will would should tell show find give get remember note save send delete remove convert calculate please weather population i i'm i'll i've it it's in on at of for and or but if then also add".split(" "));

/** Tidy a span: trim punctuation, leading determiners/possessives, trailing "'s". */
export function clean(span) {
  let s = String(span || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s"'“‘(\[]+|[\s"'”’)\].,;:!?]+$/g, "");
  for (let i = 0; i < 3; i++) s = s.replace(LEAD, "");
  s = s.replace(/[’']s$/i, "");
  return s.trim();
}

/** Capitalized sequences ("Kansai region of Japan" -> "Kansai", "Japan"; "Eiffel Tower"), skipping question words. */
export function properNouns(text) {
  const out = [];
  const re = /\b[A-Z][\p{L}\p{M}'’-]*(?:\s+(?:de|da|del|du|la|le|van|von|of the|of)?\s*[A-Z][\p{L}\p{M}'’-]*)*/gu;
  for (const m of String(text).matchAll(re)) {
    let s = clean(m[0]);
    const first = s.split(" ")[0].toLowerCase();
    if (QWORDS.has(first)) s = s.split(" ").slice(1).join(" ");
    if (!s || QWORDS.has(s.toLowerCase()) || GENERIC.has(s.toLowerCase())) continue;
    out.push(s);
    if (/\s(?:of the|of)\s/.test(s)) out.push(...s.split(/\s(?:of the|of)\s/).map(clean));
  }
  return out;
}

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
/** Arithmetic spans: "18% of 2,450", "(3 + 4) * 12", "15 times 7", "2^10". */
export function arithmetic(text) {
  const s = String(text);
  const out = [];
  const pct = new RegExp(String.raw`${NUM}\s*%\s*of\s*${NUM}`, "gi");
  for (const m of s.matchAll(pct)) out.push(m[0]);
  const op = String.raw`(?:[-+*/^×÷x]|\btimes\b|\bplus\b|\bminus\b|\bdivided by\b|\bmultiplied by\b)`;
  const expr = new RegExp(String.raw`[(]*\s*${NUM}\s*[)]*(?:\s*${op}\s*[(]*\s*${NUM}\s*[)]*)+`, "gi");
  for (const m of s.matchAll(expr)) out.push(m[0].trim());
  return out.map((x) => x.replace(/[?.]+$/, "").trim());
}

const UNIT_RE = UNIT_WORDS.map((u) => u.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|");
/** Quantities with a unit: "5 miles", "72°F", "3.5 kg". */
export function quantities(text) {
  const re = new RegExp(String.raw`-?${NUM}\s*(?:${UNIT_RE})\b`, "gi");
  return [...String(text).matchAll(re)].map((m) => m[0].trim());
}

/** Durations with an optional direction: "3 weeks after", "10 days before", "90 days". */
export function durations(text) {
  const re = new RegExp(String.raw`\b\d+\s*(?:day|week|month|year)s?(?:\s+(?:after|before|from|ago|later|earlier))?`, "gi");
  return [...String(text).matchAll(re)].map((m) => m[0].trim());
}

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
/** Calendar dates: "March 4", "4 March 2027", "2026-12-25", "Christmas". */
export function calendarDates(text) {
  const re = new RegExp(String.raw`\b(?:(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTHS})(?:\s+\d{4})?|\d{4}-\d{2}-\d{2}|Christmas|New Year'?s? Day|today|tomorrow)\b`, "gi");
  return [...String(text).matchAll(re)].map((m) => m[0].trim());
}

/** Clauses to save or send: text after "remember (that)", "note (that)", "saying", "tell X (that)". */
export function clauses(text) {
  const s = String(text).trim();
  const out = [];
  const pats = [
    /\b(?:remember|note down|make a note|save a note|note)\s+(?:that\s+)?(.+?)[.!?]?$/i,
    /\b(?:saying|that says|to say|telling (?:him|her|them))\s+(?:that\s+)?(.+?)[.!?]?$/i,
    /\b(?:tell|message|text|email)\s+[A-Z][\w'-]*\s+(?:that\s+)?(.+?)[.!?]?$/,
  ];
  for (const p of pats) { const m = p.exec(s); if (m && m[1].split(" ").length >= 2) out.push(m[1].replace(/^(?:that|to)\s+/i, "").trim()); }
  return out;
}

/** People to message: names after "to / tell / message / text / email", plus compromise's people. */
export function recipients(text) {
  return [...String(text).matchAll(/\b(?:to|tell|message|text|email|remind)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/g)].map((m) => clean(m[1]));
}

/**
 * @param nlp   compromise (with the dates plugin)
 * @param goal  the user's goal
 * @param obs   the last observation ("" on the first step)
 * @returns [{ span, kind, from: "goal"|"obs" }], goal spans first, deduplicated case-insensitively per kind
 */
export function extractCandidates(nlp, goal, obs = "") {
  const out = [];
  const seen = new Set();
  const push = (span, kind, from) => {
    // compromise can run a span across brackets or a colon ("Japan): Kyoto"); keep the pieces instead
    if (kind !== "clause" && /[():;]/.test(span)) { for (const part of String(span).split(/[():;]/)) if (part.trim()) push(part, kind, from); return; }
    const s = kind === "expression" || kind === "quantity" || kind === "duration" || kind === "clause" ? String(span).trim() : clean(span);
    if (!s || s.length > 80 || GENERIC.has(s.toLowerCase())) return;
    const key = kind + "|" + s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); out.push({ span: s, kind, from });
  };
  for (const [text, from] of [[goal, "goal"], [obs, "obs"]]) {
    if (!text) continue;
    const doc = nlp(text);
    const arr = (m) => m.out("array");
    for (const s of arr(doc.places())) { push(s, "place", from); for (const p of clean(s).split(/\s(?:of the|of|in)\s/)) push(p, "place", from); }
    for (const s of arr(doc.people())) push(s, "person", from);
    for (const s of arr(doc.organizations())) push(s, "org", from);
    for (const s of properNouns(text)) push(s, "proper", from);
    for (const s of arr(doc.topics())) push(s, "topic", from);
    for (const s of arr(doc.nouns())) { const c = clean(s); if (c && !/^(it|i'll|i|me|you|they|he|she)$/i.test(c)) push(c, "noun", from); }
    for (const s of quantities(text)) push(s, "quantity", from);
    if (from === "goal") {
      for (const s of recipients(text)) push(s, "person", from);
      for (const s of arithmetic(text)) push(s, "expression", from);
      for (const s of durations(text)) push(s, "duration", from);
      for (const s of calendarDates(text)) push(s, "date", from);
      try { for (const s of arr(doc.dates())) if (!/\d+\s*(?:day|week|month|year)s?\s+(?:after|before)/i.test(s)) push(s, "date", from); } catch { /* dates plugin missing */ }
      for (const s of clauses(text)) push(s, "clause", from);
    }
  }
  return out;
}

/**
 * The options for one slot: spans of the accepted kinds (deduplicated across kinds), the slot's extra literals,
 * then NONE. Keys are the spans themselves, so Laya reads e.g. "Japan" rather than "c3".
 */
export function slotOptions(slot, cands) {
  if (slot.fixed) return { ...slot.fixed };
  const opts = {};
  const seen = new Set();
  const kinds = slot.kinds || [];
  const rank = (c) => (c.from === "goal" ? 0 : 100) + kinds.indexOf(c.kind);
  const ranked = cands.filter((c) => kinds.includes(c.kind)).sort((a, b) => rank(a) - rank(b));
  for (const c of ranked) {
    const k = c.span.toLowerCase();
    if (seen.has(k) || c.span === NONE) continue;
    seen.add(k); opts[c.span] = null;
    if (Object.keys(opts).length >= MAX_OPTIONS - 1 - (slot.extra?.length || 0)) break;
  }
  for (const e of slot.extra || []) if (!seen.has(e.toLowerCase())) opts[e] = null;
  opts[NONE] = slot.none || "None of these is right";
  return opts;
}

/** Does a gold argument value appear among a slot's options? (extractor recall, measured apart from Laya) */
export function optionFor(options, value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  return Object.keys(options).find((k) => k.toLowerCase() === v) ?? null;
}
