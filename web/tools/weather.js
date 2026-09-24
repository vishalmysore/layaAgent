// weather: Open-Meteo geocoding + daily forecast (CORS, no key). The time window is a fixed list Laya picks from.
import { WEEKDAYS, today } from "./datemath.js";

export const WHEN = { today: "today", tomorrow: "tomorrow", weekend: "this weekend (Saturday and Sunday)", week: "the next few days" };

// WMO weather interpretation codes (Open-Meteo docs), shortened
const WMO = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  56: "freezing drizzle", 57: "freezing drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain", 71: "light snow",
  73: "snow", 75: "heavy snow", 77: "snow grains", 80: "rain showers", 81: "rain showers", 82: "violent rain showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail" };

/** Indices into a 7-day daily forecast that starts today, for a time window. */
export function dayIndices(when, now) {
  const dow = today(now).getUTCDay();
  if (when === "tomorrow") return [1];
  if (when === "weekend") { const sat = dow === 6 ? 0 : dow === 0 ? -1 : 6 - dow; return sat < 0 ? [0] : [sat, sat + 1].filter((i) => i < 7); }
  if (when === "week") return [0, 1, 2];
  return [0];
}

export default {
  id: "weather",
  whenToUse: "Get the weather forecast for a place and time",
  slots: [
    { name: "place", kinds: ["place", "proper"], instruction: "Which place should the weather forecast be for?", none: "None of these is the right place" },
    { name: "when", fixed: WHEN, instruction: "Which days should the forecast cover?" },
  ],
  async run({ place, when = "today" }, ctx = {}) {
    const f = ctx.fetch || fetch;
    // "Springfield, Massachusetts": search the name, then prefer a result whose region or country matches the qualifier
    const [name, ...qual] = String(place).split(",").map((x) => x.trim());
    const g = await f(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${qual.length ? 20 : 1}&language=en&format=json`).then((r) => r.json());
    const q = qual.join(" ").toLowerCase();
    const loc = (q && g.results?.find((r) => [r.admin1, r.admin2, r.country, r.country_code].some((v) => v && (q.includes(v.toLowerCase()) || v.toLowerCase().includes(q))))) || g.results?.[0];
    if (!loc) return { observation: `No place called "${place}" was found.`, answer: `Could not find "${place}".`, data: null, ok: false };
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`;
    const w = await f(url).then((r) => r.json());
    const d = w.daily;
    if (!d?.time) throw new Error("Open-Meteo: no daily forecast");
    const days = dayIndices(when, ctx.now).map((i) => {
      const dt = new Date(d.time[i] + "T00:00:00Z");
      return `${WEEKDAYS[dt.getUTCDay()].slice(0, 3)} ${d.time[i].slice(5)}: ${WMO[d.weather_code[i]] ?? "code " + d.weather_code[i]}, ${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])}°C, rain chance ${d.precipitation_probability_max[i] ?? "?"}%`;
    });
    const where = [loc.name, loc.admin1, loc.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
    const out = `Forecast for ${where} (${WHEN[when] || when}): ${days.join("; ")}`;
    return { observation: out, answer: out, data: { place: where }, source: "https://open-meteo.com/" };
  },
};
