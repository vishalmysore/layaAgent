// calculator: safe arithmetic (no eval). Laya is weak with numbers, so every calculation goes through here.
// Accepts the spans the candidate extractor finds in text: "18% of 2,450", "(3 + 4) * 12", "15 times 7", "2^10".

const WORDS = [
  [/\bdivided by\b/gi, "/"], [/\bmultiplied by\b/gi, "*"], [/\btimes\b/gi, "*"], [/\bplus\b/gi, "+"], [/\bminus\b/gi, "-"],
  [/\bto the power of\b/gi, "^"], [/[×x](?=\s*[\d(])/g, "*"], [/÷/g, "/"],
];

/** Turn a natural span into a plain expression: "18% of 2,450" -> "(18/100)*2450". */
export function normalizeExpression(src) {
  let s = String(src ?? "").trim().replace(/[?=]+$/, "");
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1");
  for (const [re, to] of WORDS) s = s.replace(re, to);
  s = s.replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/gi, "($1/100)*");
  s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, "($1/100)");
  return s.replace(/\s+/g, " ").trim();
}

/** Recursive-descent evaluator for + - * / ^ and parentheses. Throws on anything else. */
export function evaluateExpression(src) {
  const s = normalizeExpression(src);
  let i = 0;
  const peek = () => { while (s[i] === " ") i++; return s[i]; };
  const num = () => {
    peek();
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) throw new Error(`expected a number at "${s.slice(i) || "end"}"`);
    i += m[0].length; return parseFloat(m[0]);
  };
  const atom = () => {
    const c = peek();
    if (c === "(") { i++; const v = expr(); if (peek() !== ")") throw new Error("missing )"); i++; return v; }
    if (c === "-") { i++; return -atom(); }
    if (c === "+") { i++; return atom(); }
    return num();
  };
  const power = () => { const b = atom(); if (peek() === "^") { i++; return Math.pow(b, power()); } return b; };
  const term = () => {
    let v = power();
    for (let c = peek(); c === "*" || c === "/"; c = peek()) { i++; const r = power(); v = c === "*" ? v * r : v / r; }
    return v;
  };
  const expr = () => {
    let v = term();
    for (let c = peek(); c === "+" || c === "-"; c = peek()) { i++; const r = term(); v = c === "+" ? v + r : v - r; }
    return v;
  };
  if (!s) throw new Error("empty expression");
  const v = expr();
  if (peek() !== undefined) throw new Error(`unexpected "${s.slice(i)}"`);
  if (!Number.isFinite(v)) throw new Error("result is not a finite number");
  return v;
}

export const fmtNumber = (v) => (Number.isInteger(v) ? v.toLocaleString("en-US") : (+v.toPrecision(10)).toLocaleString("en-US", { maximumFractionDigits: 6 }));

export default {
  id: "calculator",
  whenToUse: "Do arithmetic or percentages on numbers given in the goal",
  slots: [{ name: "expression", kinds: ["expression"], instruction: "Which arithmetic expression should be calculated?", none: "None of these is the calculation that is needed" }],
  async run({ expression }) {
    const v = evaluateExpression(expression);
    const out = fmtNumber(v);
    return { observation: `${expression} = ${out}`, answer: `${expression} = ${out}`, data: { value: v } };
  },
};
