// wiki_lookup: Wikipedia title search + page summary (both send CORS headers, no key). Returns the lead paragraph,
// which is where most multi-hop facts come from ("Kyoto ... in the Kansai region of Japan").

const API = "https://en.wikipedia.org";

export function firstSentences(text, n = 3) {
  // split after . ! ? followed by whitespace and a capital, so "1.6 km" and "U.S." stay whole
  return String(text || "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+(?=[A-Z("“])/).slice(0, n).join(" ").trim();
}

export default {
  id: "wiki_lookup",
  whenToUse: "Read the encyclopedia article about a person, place, thing or event",
  slots: [{ name: "topic", kinds: ["proper", "place", "person", "org", "topic", "noun"], instruction: "Which topic should be looked up in the encyclopedia?", none: "None of these is the right topic to look up" }],
  async run({ topic }, ctx = {}) {
    const f = ctx.fetch || fetch;
    const s = await f(`${API}/w/rest.php/v1/search/title?q=${encodeURIComponent(topic)}&limit=1`).then((r) => r.json());
    const hit = s.pages?.[0];
    if (!hit) return { observation: `No encyclopedia article found for "${topic}".`, answer: `No article found for "${topic}".`, data: null, ok: false };
    const r = await f(`${API}/api/rest_v1/page/summary/${encodeURIComponent(hit.key)}?redirect=true`);
    if (!r.ok) throw new Error(`Wikipedia: HTTP ${r.status}`);
    const j = await r.json();
    const lead = firstSentences(j.extract, 3);
    return {
      observation: `${j.title}${j.description ? ` (${j.description})` : ""}: ${lead}`,
      answer: `${j.title}: ${firstSentences(j.extract, 2)}`,
      data: { title: j.title, description: j.description || "", url: j.content_urls?.desktop?.page || `${API}/wiki/${hit.key}` },
      source: j.content_urls?.desktop?.page || `${API}/wiki/${hit.key}`,
    };
  },
};
