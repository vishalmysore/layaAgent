// System 2: a small instruction-tuned LLM running in the tab through WebLLM (WebGPU), in a web worker so the page
// stays responsive. It only runs when System 1 is unsure (HOLD), for shadow checks, and for the optional answer
// rewrite. It answers in the SAME action space as System 1 (a JSON step checked against the registry), so the two
// can be compared step by step. From the second step on it first answers a yes/no "is the goal answered?".
import { TOOLS, TOOL } from "./tools/index.js";

// Check the WebLLM prebuilt list when upgrading web-llm (pinned in package.json); IDs change between releases.
// q4f32 builds, not q4f16: on the Intel iGPU we tested, the f16 builds generated garbage ("setColor setColor ...")
// once decoding was unconstrained, and a JSON grammar only disguised it (every reply became ask_user).
export const S2_MODELS = {
  "Qwen2.5-1.5B-Instruct-q4f32_1-MLC": { label: "Qwen2.5 1.5B Instruct (default, ~1.6 GB)", license: "Apache-2.0" },
  "Qwen2.5-0.5B-Instruct-q4f32_1-MLC": { label: "Qwen2.5 0.5B Instruct (light, ~0.6 GB)", license: "Apache-2.0" },
  "Llama-3.2-1B-Instruct-q4f32_1-MLC": { label: "Llama 3.2 1B Instruct (~1.1 GB)", license: "Llama 3.2 Community License" },
};
export const DEFAULT_S2 = "Qwen2.5-1.5B-Instruct-q4f32_1-MLC";

// The shape System 2 must return (checked after parsing; decoding is not grammar-constrained, see above).
export const STEP_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: TOOLS.map((t) => t.id) },
    args: { type: "object" },
    reason: { type: "string" },
  },
  required: ["action", "args"],
};

export const SYSTEM_PROMPT = "You are the planner of a tool-using assistant. You choose the next tool call. Answer with one JSON object only.";

const toolLine = (t) => {
  const args = t.id === "ask_user" ? ["question"] : t.slots.map((sl) => (sl.fixed ? `${sl.name} (one of: ${Object.keys(sl.fixed).join(", ")})` : sl.name));
  return `- ${t.id}: ${t.whenToUse}.${args.length ? " Args: " + args.join(", ") : ""}`;
};

/** A plain-text prompt: small models follow this far better than a JSON blob (measured on the dev split). */
export function buildPrompt({ goal, state, s1View, reasons }) {
  const lines = [
    `Goal: ${goal}`,
    state.steps_done.length ? "Steps done:\n" + state.steps_done.map((l) => "- " + l).join("\n") : "Steps done: none yet",
  ];
  if (state.last_observation) lines.push(`Result of the last step: ${state.last_observation}`);
  lines.push("", "Tools:", ...TOOLS.map(toolLine), "");
  const top = s1View?.top_actions?.length ? s1View.top_actions.map((a) => `${a.action} (${Math.round(a.p * 100)}%)`).join(", ") : "";
  if (top) lines.push(`A smaller model suggested: ${top}. It was unsure${reasons?.length ? ` (${reasons.join("; ")})` : ""}.`);
  const cands = Object.entries(s1View?.slot_candidates || {}).filter(([, v]) => v.length);
  if (cands.length) lines.push("Spans found in the text: " + cands.map(([k, v]) => `${k}: ${v.slice(0, 8).join(" | ")}`).join("; "));
  lines.push(
    state.steps_done.length ? "The goal is not answered yet, so do not repeat a call that was already done." : "Nothing has been looked up yet.",
    "Copy argument values from the goal or the last result when they are there; write a new value only when they are not (for example the real name behind a nickname).",
    "Use ask_user only when the goal does not say what or where. Use calculator for any arithmetic.",
    'Reply with JSON: {"action": "<tool id>", "args": {...}, "reason": "<a few words>"}',
  );
  return lines.join("\n");
}

/** The yes/no stop check System 2 answers before planning (from the second step on). */
export function doneCheckPrompt({ goal, state }) {
  // wording chosen on the dev split: "does it answer the question completely?" made the model say no to everything
  return ["Question: " + goal, "Found: " + state.last_observation, "", "Is the answer to the question contained in what was found? Reply with only yes or no."].join("\n");
}

/** Parse and tidy a JSON reply: map labels of fixed slots back to keys, drop args the tool does not take. */
export function parseReply(text) {
  // the first balanced {...} in the reply (models sometimes add text or a code fence around it)
  const src = String(text);
  const start = src.indexOf("{");
  let depth = 0, end = -1, inStr = false;
  for (let i = start; start >= 0 && i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) { end = i; break; }
  }
  if (start < 0 || end < 0) throw new Error("System 2 did not return JSON");
  const j = JSON.parse(src.slice(start, end + 1));
  if (!TOOL[j.action]) throw new Error(`System 2 chose an unknown action "${j.action}"`);
  const tool = TOOL[j.action];
  const args = {};
  if (tool) {
    for (const s of tool.slots) {
      let v = j.args?.[s.name];
      if (v == null) continue;
      v = String(v).trim();
      if (s.fixed && !(v in s.fixed)) { const hit = Object.entries(s.fixed).find(([k, l]) => l.toLowerCase() === v.toLowerCase() || k.toLowerCase() === v.toLowerCase()); if (hit) v = hit[0]; }
      args[s.name] = v;
    }
    if (j.action === "ask_user" && j.args?.question) args.question = String(j.args.question);
  }
  return { action: j.action, args, reason: j.reason || "" };
}

export function hasWebGPU() { return typeof navigator !== "undefined" && !!navigator.gpu; }

/**
 * Load a WebLLM model in a worker. Returns { decide, rewrite, ready, model, info, unload }.
 * @param opts { model, onProgress(fraction|null, text) }
 */
export async function loadSystem2({ model = DEFAULT_S2, onProgress = () => {} } = {}) {
  if (!hasWebGPU()) throw new Error("WebGPU is not available in this browser, so System 2 cannot run here. The agent will ask you instead.");
  const webllm = await import("./vendor/web-llm.mjs");
  const t0 = performance.now();
  const worker = new Worker(new URL("./s2-worker.js", import.meta.url), { type: "module" });
  const engine = await webllm.CreateWebWorkerMLCEngine(worker, model, {
    initProgressCallback: (r) => onProgress(r.progress ?? null, r.text || ""),
  });
  const loadMs = performance.now() - t0;
  let busy = Promise.resolve();
  const serial = (fn) => { const p = busy.then(fn); busy = p.catch(() => {}); return p; };

  async function decide(payload) {
    return serial(async () => {
      const t = performance.now();
      // 1) after the first step, a one-word check: is the goal already answered? (a planning prompt alone keeps
      //    repeating the last tool; a separate yes/no question stops far more reliably)
      if (payload.state.last_observation) {
        const check = doneCheckPrompt(payload);
        const r = await engine.chat.completions.create({ temperature: 0, max_tokens: 3, messages: [{ role: "user", content: check }] });
        const yes = /^\W*yes/i.test(r.choices?.[0]?.message?.content || "");
        if (yes) return { action: "FINISH", args: {}, reason: "the last result answers the goal", raw: r.choices[0].message.content, prompt: check, ms: performance.now() - t };
      }
      // 2) otherwise plan the next tool call
      const prompt = buildPrompt(payload);
      const reply = await engine.chat.completions.create({
        temperature: 0, max_tokens: 120,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }],
      });
      const raw = reply.choices?.[0]?.message?.content || "";
      const ms = performance.now() - t;
      let parsed;
      try { parsed = parseReply(raw); } catch (e) { return { action: null, args: {}, reason: "", raw, prompt, ms, parseError: String(e.message) }; }
      return { ...parsed, raw, prompt, ms, usage: reply.usage };
    });
  }

  async function rewrite(goal, templated, steps) {
    return serial(async () => {
      const t = performance.now();
      const facts = steps.filter((s) => s.result?.answer).map((s) => s.result.answer);
      const reply = await engine.chat.completions.create({
        temperature: 0, max_tokens: 160,
        messages: [
          { role: "system", content: "Answer the user's question in one short paragraph using ONLY the facts given. Do not add facts. Keep numbers exactly as written." },
          { role: "user", content: JSON.stringify({ question: goal, facts, draft_answer: templated }) },
        ],
      });
      return { text: (reply.choices?.[0]?.message?.content || templated).trim(), ms: performance.now() - t };
    });
  }

  return {
    decide, rewrite, model, engine, ready: () => true,
    info: { model, label: S2_MODELS[model]?.label || model, loadMs },
    async unload() { try { await engine.unload(); } catch { /* fine */ } worker.terminate(); },
  };
}
