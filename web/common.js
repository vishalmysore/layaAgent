// Shared by both pages: DOM helpers, per-browser settings, the model card (System 1 = Laya, System 2 = WebLLM),
// the candidate extractor's NLP library and recorded results.
import { approxTokens } from "./state.js";
import { S2_MODELS, DEFAULT_S2, hasWebGPU } from "./system2.js";

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pct = (p, d = 0) => (p == null ? "–" : `${(p * 100).toFixed(d)}%`);
export const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
export const msText = (x) => (x == null || !Number.isFinite(x) ? "–" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
// MessageChannel, not setTimeout: background tabs clamp setTimeout to >= 1 s (see layaAsRagJudge).
export const yieldToBrowser = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

export const settings = {
  get(k, d) { try { const v = localStorage.getItem("lagent." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lagent." + k, JSON.stringify(v)); } catch { /* fine */ } },
};

export const M = { laya: null, info: null, s2: null, s2Loading: false, nlp: null, manifest: null, loading: false, listeners: [] };
export const onModelsChanged = (fn) => M.listeners.push(fn);
const changed = () => { for (const fn of M.listeners) fn(); updatePill(); };

/** Token counter for the state budget: Laya's own tokenizer once it is loaded. */
export const countTokens = () => (M.laya ? (t) => M.laya.tok.encode(String(t), { add_special_tokens: false }).ids.length : approxTokens);

let modelMod = null;
const modelApi = () => (modelMod ||= import("./model.js"));

export async function loadNlp() {
  if (M.nlp) return M.nlp;
  const [{ default: nlp }, { default: dates }] = await Promise.all([import("./vendor/compromise.mjs"), import("./vendor/compromise-dates.mjs")]);
  nlp.plugin(dates);
  return (M.nlp = nlp);
}

function setPill(kind, text) { const p = $("modelPill"); if (!p) return; p.className = "modelpill " + kind; $("modelPillText").textContent = text; }
export function setStatus(msg, warn = false) { const s = $("status"); s.textContent = msg; s.classList.toggle("warn", warn); }
function setProgress(f) { $("progress").hidden = f == null; if (f != null) $("progressBar").style.width = (f * 100).toFixed(1) + "%"; }
export function updatePill() {
  if (M.loading || M.s2Loading) return setPill("busy", "Loading…");
  if (M.laya) return setPill("ready", `System 1 ready${M.s2 ? " · System 2 ready" : ""}`);
  setPill("replay", "Playback · load System 1 to run your own goals");
}
function badge(t, ok) { const b = document.createElement("span"); b.className = "badge" + (ok ? " ok" : ""); b.textContent = t; $("badges").appendChild(b); }

export async function initModelCard() {
  $("loadBtn").addEventListener("click", loadS1);
  $("s2LoadBtn").addEventListener("click", loadS2);
  const sel2 = $("s2Model");
  for (const [k, v] of Object.entries(S2_MODELS)) sel2.add(new Option(v.label, k));
  sel2.value = settings.get("s2Model", DEFAULT_S2) in S2_MODELS ? settings.get("s2Model", DEFAULT_S2) : DEFAULT_S2;
  const gpu = hasWebGPU() && !!(await navigator.gpu.requestAdapter().catch(() => null));
  M.webgpu = gpu;
  $("s2LoadBtn").disabled = !gpu;
  $("s2Note").textContent = gpu ? "Loads only when you ask (or on the first escalation, if enabled below). Needs WebGPU; weights are cached by the browser." : "WebGPU is not available in this browser, so System 2 cannot run here: steps Laya is unsure about go to you instead.";
  updatePill();
  const m = await modelApi();
  const base = m.modelBase();
  const link = $("modelLink"); link.href = base === m.DEFAULT_MODEL_BASE ? m.MODEL_PAGE : base; link.textContent = base === m.DEFAULT_MODEL_BASE ? "VishalMysore/layaForWebTrained" : base;
  try {
    M.manifest = await m.fetchManifest(base);
    const sel = $("variant"); sel.innerHTML = "";
    // int4 on WebGPU was about 2x faster than int8 on WASM in our measurements, so it is the default where WebGPU works
    const saved = settings.get("variant", M.webgpu ? "q4e8" : "q8e8");
    for (const [k, v] of Object.entries(M.manifest.variants)) {
      const cached = await m.cachedParts(base, v.data);
      const tag = cached === v.data.parts.length ? ", cached" : cached ? `, ${cached}/${v.data.parts.length} parts cached` : "";
      sel.add(new Option(`${k === "q8e8" ? "int8 (WASM, any browser)" : k === "q4e8" ? "int4 (WebGPU, faster)" : v.label} · ${Math.round(v.data.size / 1048576)} MB${tag}`, k));
    }
    if (M.manifest.variants[saved]) sel.value = saved;
    $("loadBtn").disabled = false;
  } catch (e) {
    setStatus(`Could not read the model manifest from ${base} (${e.message}). Recorded runs still play back.`, true);
  }
}

export async function loadS1() {
  if (M.loading) return;
  M.loading = true; $("loadBtn").disabled = true; updatePill();
  settings.set("variant", $("variant").value);
  try {
    await loadNlp();
    const m = await modelApi();
    const { laya, backend, info } = await m.loadLaya({ base: m.modelBase(), manifest: M.manifest, variant: $("variant").value, backend: $("backend").value, onStatus: setStatus, onProgress: setProgress });
    M.laya = laya; M.info = { backend, ...info };
    setStatus(`System 1 ready: download ${(info.downloadMs / 1000).toFixed(1)} s${info.fromCache ? ` (${info.fromCache}/${info.parts} parts from cache)` : ""}, session ${(info.initMs / 1000).toFixed(1)} s, warm-up ${(info.warmMs / 1000).toFixed(1)} s.`);
    badge(`S1: Laya ${info.variant} · ${backend === "webgpu" ? "WebGPU" : `WASM · ${info.threads} thread${info.threads > 1 ? "s" : ""}`}`, true);
    badge(`context ${info.maxLen} tokens`);
    $("loadBtn").textContent = "Reload System 1";
  } catch (e) {
    console.error(e); setStatus("Could not load System 1: " + (e?.message || e), true);
  } finally { M.loading = false; $("loadBtn").disabled = false; setProgress(null); changed(); }
}

export async function loadS2() {
  if (M.s2Loading || !M.webgpu) return M.s2;
  M.s2Loading = true; $("s2LoadBtn").disabled = true; updatePill();
  const model = $("s2Model").value; settings.set("s2Model", model);
  try {
    if (M.s2) { await M.s2.unload(); M.s2 = null; }
    const { loadSystem2 } = await import("./system2.js");
    M.s2 = await loadSystem2({ model, onProgress: (f, text) => { setProgress(f); setStatus(`System 2: ${text}`); } });
    setStatus(`System 2 ready: ${M.s2.info.label}, loaded in ${(M.s2.info.loadMs / 1000).toFixed(1)} s.`);
    badge(`S2: ${model.replace(/-q4f.*$/, "")} · WebGPU`, true);
    $("s2LoadBtn").textContent = "Reload System 2";
  } catch (e) {
    console.error(e); setStatus("Could not load System 2: " + (e?.message || e), true); M.s2 = null;
  } finally { M.s2Loading = false; $("s2LoadBtn").disabled = !M.webgpu; setProgress(null); changed(); }
  return M.s2;
}

export async function loadRecorded() {
  try { const r = await fetch("./recorded.json", { cache: "no-cache" }); if (r.ok) return await r.json(); } catch { /* optional */ }
  return null;
}
export async function loadTasks() { const r = await fetch("./tasks.json", { cache: "no-cache" }); if (!r.ok) throw new Error(`tasks.json: HTTP ${r.status}`); return r.json(); }

export function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Probability bars. */
export function bars(probs, selected, { max = 12, gold = null } = {}) {
  const rows = Object.entries(probs || {}).sort((a, b) => b[1] - a[1]).slice(0, max);
  return `<div class="bars">${rows.map(([k, v]) => `<div class="bar${k === selected ? " sel" : ""}${gold != null && k === gold ? " gold" : ""}"><span class="n" title="${esc(k)}">${esc(k)}</span><span class="tr"><span class="f" style="width:${(v * 100).toFixed(1)}%"></span></span><span class="v">${v.toFixed(2)}</span></div>`).join("")}</div>`;
}
