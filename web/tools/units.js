// unit_convert: local conversion tables. The target unit is a fixed list, so Laya chooses it rather than writes it.
import { fmtNumber } from "./calculator.js";

// factor to the base unit of each dimension (m, kg, l, m/s); temperature is handled separately
const UNITS = {
  km: ["length", 1000, ["km", "kilometer", "kilometers", "kilometre", "kilometres"]],
  m: ["length", 1, ["m", "meter", "meters", "metre", "metres"]],
  cm: ["length", 0.01, ["cm", "centimeter", "centimeters", "centimetre", "centimetres"]],
  mi: ["length", 1609.344, ["mi", "mile", "miles"]],
  ft: ["length", 0.3048, ["ft", "foot", "feet"]],
  in: ["length", 0.0254, ["in", "inch", "inches"]],
  kg: ["mass", 1, ["kg", "kilogram", "kilograms", "kilo", "kilos"]],
  g: ["mass", 0.001, ["g", "gram", "grams"]],
  lb: ["mass", 0.45359237, ["lb", "lbs", "pound", "pounds"]],
  oz: ["mass", 0.028349523125, ["oz", "ounce", "ounces"]],
  l: ["volume", 1, ["l", "liter", "liters", "litre", "litres"]],
  ml: ["volume", 0.001, ["ml", "milliliter", "milliliters", "millilitre", "millilitres"]],
  gal: ["volume", 3.785411784, ["gal", "gallon", "gallons"]],
  C: ["temperature", null, ["c", "°c", "celsius", "degrees celsius", "degrees c", "deg c"]],
  F: ["temperature", null, ["f", "°f", "fahrenheit", "degrees fahrenheit", "degrees f", "deg f"]],
  "km/h": ["speed", 1 / 3.6, ["km/h", "kph", "kmh", "kilometers per hour", "kilometres per hour"]],
  mph: ["speed", 0.44704, ["mph", "miles per hour"]],
};
const ALIAS = new Map(Object.entries(UNITS).flatMap(([id, [, , names]]) => names.map((n) => [n, id])));
export const UNIT_WORDS = [...ALIAS.keys()].sort((a, b) => b.length - a.length);

// The options Laya picks the target from (key -> label). Keep it short: every option costs head tokens.
export const TARGET_UNITS = { km: "kilometers", mi: "miles", m: "meters", ft: "feet", kg: "kilograms", lb: "pounds", l: "liters", gal: "gallons", C: "degrees Celsius", F: "degrees Fahrenheit", "km/h": "km per hour", mph: "miles per hour" };

export function unitId(word) { return ALIAS.get(String(word).trim().toLowerCase().replace(/\.$/, "")) || null; }

/** "5 miles" / "72°F" / "3.5 kg" -> { value, unit } */
export function parseQuantity(span) {
  const src = String(span).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const m = /(-?\d+(?:\.\d+)?)\s*/.exec(src);
  if (!m) throw new Error(`no quantity in "${span}"`);
  // the longest unit name right after the number ("degrees fahrenheit" before "f")
  const rest = src.slice(m.index + m[0].length).toLowerCase().replace(/^°\s+/, "°");
  const word = UNIT_WORDS.find((w) => rest.startsWith(w) && !/[a-z]/.test(rest[w.length] || ""));
  if (!word) throw new Error(`unknown unit in "${span}"`);
  return { value: parseFloat(m[1]), unit: ALIAS.get(word) };
}

export function convert(value, from, to) {
  const [df, ff] = UNITS[from], [dt, ft] = UNITS[to];
  if (df !== dt) throw new Error(`cannot convert ${df} to ${dt}`);
  if (df === "temperature") {
    const c = from === "C" ? value : (value - 32) * 5 / 9;
    return to === "C" ? c : c * 9 / 5 + 32;
  }
  return (value * ff) / ft;
}

export default {
  id: "unit_convert",
  whenToUse: "Convert a quantity from one unit of measurement to another",
  slots: [
    { name: "quantity", kinds: ["quantity"], instruction: "Which quantity should be converted?", none: "None of these is the quantity to convert" },
    { name: "to_unit", fixed: TARGET_UNITS, instruction: "Which unit should the quantity be converted to?" },
  ],
  async run({ quantity, to_unit }) {
    const q = parseQuantity(quantity);
    const to = UNITS[to_unit] ? to_unit : unitId(to_unit);
    if (!to) throw new Error(`unknown unit "${to_unit}"`);
    const v = convert(q.value, q.unit, to);
    const out = `${quantity} = ${fmtNumber(+v.toFixed(v < 10 ? 3 : 2))} ${TARGET_UNITS[to] || to}`;
    return { observation: out, answer: out, data: { value: v, unit: to } };
  },
};
