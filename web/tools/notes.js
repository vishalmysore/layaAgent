// Agent memory: note_save / note_search / note_delete over ctx.notes (IndexedDB in the page, a Map in tests and in
// the evaluation, where each task seeds its own notes). Search is lexical (content-word overlap), so no second model.

const STOP = new Set("a an the my our your his her their is are was were be on in at of to for and or with about what when where who which how do does did i me we you it that this these those any all some please note notes remember".split(" "));
export const words = (s) => String(s || "").toLowerCase().replace(/'s\b/g, "").match(/[a-z0-9]+/g)?.filter((w) => !STOP.has(w)).map((w) => w.replace(/(?<=\w{3})s$/, "")) || [];

export function scoreNote(query, text) {
  const q = new Set(words(query)), t = new Set(words(text));
  if (!q.size) return 0;
  let hit = 0; for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

export function searchNotes(notes, query, k = 3) {
  return notes.map((n) => ({ ...n, score: scoreNote(query, n.text) })).filter((n) => n.score > 0).sort((a, b) => b.score - a.score || b.at - a.at).slice(0, k);
}

/** In-memory note store; the page swaps in an IndexedDB-backed one with the same interface. */
export function memoryNotes(seed = []) {
  let id = 0;
  const m = new Map(seed.map((t) => { const n = typeof t === "string" ? { text: t } : t; const note = { id: ++id, at: id, ...n }; return [note.id, note]; }));
  return {
    async all() { return [...m.values()]; },
    async add(text) { const n = { id: ++id, text, at: Date.now() }; m.set(n.id, n); return n; },
    async remove(ids) { ids.forEach((i) => m.delete(i)); },
  };
}

export const noteSave = {
  id: "note_save",
  whenToUse: "Save something the user asks to remember for later",
  sideEffect: "saves a note in this browser",
  slots: [{ name: "text", kinds: ["clause"], instruction: "What exactly should be saved as a note?", none: "None of these is what should be saved" }],
  async run({ text }, ctx) {
    await ctx.notes.add(text);
    return { observation: `Saved the note: "${text}"`, answer: `Saved: "${text}"`, data: { text } };
  },
};

export const noteSearch = {
  id: "note_search",
  whenToUse: "Search the user's saved notes for something they told you before",
  slots: [{ name: "query", kinds: ["noun", "topic", "proper"], instruction: "What should the saved notes be searched for?", none: "None of these is what to search for" }],
  async run({ query }, ctx) {
    const hits = searchNotes(await ctx.notes.all(), query);
    if (!hits.length) return { observation: `No saved note mentions "${query}".`, answer: `No saved note mentions "${query}".`, data: { hits: [] }, ok: false };
    const out = `Notes about "${query}": ${hits.map((h) => `"${h.text}"`).join("; ")}`;
    return { observation: out, answer: `From your notes: ${hits.map((h) => `"${h.text}"`).join("; ")}`, data: { hits: hits.map((h) => h.text) } };
  },
};

export const noteDelete = {
  id: "note_delete",
  whenToUse: "Delete saved notes the user no longer wants",
  sideEffect: "permanently deletes saved notes",
  slots: [{ name: "query", kinds: ["noun", "topic", "proper"], extra: ["all notes"], instruction: "Which saved notes should be deleted?", none: "None of these says which notes to delete" }],
  async run({ query }, ctx) {
    const all = await ctx.notes.all();
    const gone = /^all( notes)?$/i.test(query.trim()) ? all : searchNotes(all, query, 50);
    await ctx.notes.remove(gone.map((n) => n.id));
    const out = gone.length ? `Deleted ${gone.length} note${gone.length > 1 ? "s" : ""}: ${gone.map((n) => `"${n.text}"`).join("; ")}` : `No saved note matched "${query}", nothing deleted.`;
    return { observation: out, answer: out, data: { deleted: gone.length } };
  },
};
