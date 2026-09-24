// Assemble the static site into dist/: the pages from web/ plus vendored libraries and the license files.
// No model is bundled: System 1 (Laya) streams from Hugging Face (VishalMysore/layaForWebTrained) and System 2's
// WebLLM weights stream from the MLC model repositories, so dist/ stays small.
//   npm ci && node scripts/prepare_site.mjs [--out dist]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const dist = path.resolve(root, arg("--out") || "dist");
const nm = path.join(root, "node_modules");
const need = (p, hint) => { if (!fs.existsSync(p)) { console.error(`Missing ${path.relative(root, p)}. ${hint}`); process.exit(1); } };

need(nm, "Install dependencies first: npm ci");
// Empty dist/ rather than deleting it, so a running local server (which holds the folder open on Windows) keeps working.
fs.mkdirSync(dist, { recursive: true });
for (const e of fs.readdirSync(dist)) fs.rmSync(path.join(dist, e), { recursive: true, force: true });
fs.cpSync(path.join(root, "web"), dist, { recursive: true });
fs.mkdirSync(path.join(dist, "vendor"), { recursive: true });

const vendor = [
  ["onnxruntime-web/dist/ort.min.mjs", "ort.min.mjs"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.mjs"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", "ort-wasm-simd-threaded.jsep.wasm"],
  ["@huggingface/tokenizers/dist/tokenizers.min.mjs", "tokenizers.min.mjs"],
  ["cytoscape/dist/cytoscape.min.js", "cytoscape.min.js"],
  ["cytoscape-dagre/dist/cytoscape-dagre.min.js", "cytoscape-dagre.min.js"],
  ["compromise/builds/three/compromise-three.mjs", "compromise.mjs"],
  ["compromise-dates/builds/compromise-dates.mjs", "compromise-dates.mjs"],
  ["@mlc-ai/web-llm/lib/index.js", "web-llm.mjs"],
];
for (const [src, dst] of vendor) {
  const p = path.join(nm, src);
  need(p, "Unexpected package layout; check the pinned versions in package.json.");
  fs.copyFileSync(p, path.join(dist, "vendor", dst));
}

// License texts and notices travel with every copy of the site (Apache-2.0 and MIT both require it).
for (const f of ["NOTICE.md", "LICENSE"]) { need(path.join(root, f), "It must be in the repository root."); fs.copyFileSync(path.join(root, f), path.join(dist, f)); }
fs.copyFileSync(path.join(root, "NOTICE.md"), path.join(dist, "NOTICE.txt"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(dist, "LICENSE.txt"));
fs.cpSync(path.join(root, "licenses"), path.join(dist, "licenses"), { recursive: true });
fs.writeFileSync(path.join(dist, ".nojekyll"), "");

let total = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; });
walk(dist);
console.log(`dist/ ready: ${(total / 1e6).toFixed(1)} MB`);
