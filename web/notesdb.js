// The agent's memory in this browser: IndexedDB, falling back to memory (private windows, blocked storage).
// Same interface as memoryNotes() in tools/notes.js.
const DB = "laya-agent", STORE = "notes";
let dbp = null;
const mem = new Map();

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}
const done = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const browserNotes = {
  async all() { const db = await open(); if (!db) return [...mem.values()]; return done(db.transaction(STORE).objectStore(STORE).getAll()); },
  async add(text) {
    const n = { text: String(text), at: Date.now() };
    const db = await open();
    if (!db) { n.id = mem.size + 1 + Math.random(); mem.set(n.id, n); return n; }
    n.id = await done(db.transaction(STORE, "readwrite").objectStore(STORE).add(n));
    return n;
  },
  async remove(ids) {
    const db = await open();
    if (!db) { ids.forEach((i) => mem.delete(i)); return; }
    const tx = db.transaction(STORE, "readwrite");
    for (const i of ids) tx.objectStore(STORE).delete(i);
    await new Promise((r) => { tx.oncomplete = r; tx.onerror = r; });
  },
  async clear() { await this.remove((await this.all()).map((n) => n.id)); },
};
