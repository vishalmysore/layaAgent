// System 2: a small instruction-tuned LLM running in the tab through WebLLM (WebGPU), in a web worker so the page
// stays responsive. It only runs when System 1 is unsure (HOLD), for shadow checks, and for the optional answer
// rewrite. Its reply is constrained to a JSON schema over the SAME action space as System 1, so the two can be
// compared step by step.
import { TOOLS, TOOL } from "./tools/index.js";

// Check the WebLLM prebuilt list when upgrading web-llm (pinned in package.json); IDs change between releases.
export const S2_MODELS = {
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC": { label: "Qwen2.5 1.5B Instruct (default, ~1.1 GB)", size: "1.1 GB", license: "Apache-2.0" },
  "Qwen2.5-0.5B-Instruct-q4f16_1-MLC": { label: "Qwen2.5 0.5B Instruct (light, ~0.4 GB)", size: "0.4 GB", license: "Apache-2.0" },
  "Llama-3.2-1B-Instruct-q4f16_1-MLC": { label: "Llama 3.2 1B Instruct (~0.9 GB)", size: "0.9 GB", license: "Llama 3.2 Community License" },
};
export const DEFAULT_S2 = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

const SLOT_NAMES = [...new Set(TOOLS.flatMap((t) => t.slots.map((s) => s.name))), "question"];

export const STEP_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: TOOLS.map((t) => t.id) },
    args: { type: "object", properties: Object.fromEntries(SLOT_NAMES.map((n) => [n, { type: "string" }])) },
    reason: { type: "string" },
  },
  required: ["action", "args", "reason"],
};

export const SYSTEM_PROMPT = [
  "You plan the next step of a tool-using assistant. Choose exactly one tool from the list, fill its arguments, and reply with JSON only.",
  "Rules:",
  "- Use FINISH when the steps done so far already answer the goal.",
  "- Prefer copying an argument exactly from the goal, the last observation or the candidate spans. Write a new value only when none of them fits (for example the real name behind a nickname).",
  "- For arguments with a fixed list of options, use one of the listed keys exactly.",
  "- Use ask_user only when the goal is genuinely unclear; put your question in args.question.",
  "- Do arithmetic with the calculator, never in your head.",
  "- Keep reason under 20 words.",
].join("\n");

export function toolSpec() {
  return TOOLS.map((t) => ({
    id: t.id, use: t.whenToUse,
    args: Object.fromEntries(t.slots.map((s) => [s.name, s.fixed ? { one_of: Object.keys(s.fixed) } : s.instruction])),
    ...(t.id === "ask_user" ? { args: { question: "the question to ask the user" } } : {}),
  }));
}

export function buildPrompt({ goal, state, s1View, reasons }) {
  return JSON.stringify({
    goal,
    steps_done: state.steps_done,
    last_observation: state.last_observation,
    tools: toolSpec(),
    system1_view: { ...s1View, why_unsure: reasons || [] },
  });
}

/** Parse and tidy a JSON reply: map labels of fixed slots back to keys, drop args the tool does not take. */
export function parseReply(text) {
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) throw new Error("System 2 did not return JSON");
  const j = JSON.parse(m[0]);
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
      const prompt = buildPrompt(payload);
      const t = performance.now();
      const reply = await engine.chat.completions.create({
        temperature: 0, max_tokens: 200,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }],
        response_format: { type: "json_object", schema: JSON.stringify(STEP_SCHEMA) },
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
    decide, rewrite, model, ready: () => true,
    info: { model, label: S2_MODELS[model]?.label || model, loadMs },
    async unload() { try { await engine.unload(); } catch { /* fine */ } worker.terminate(); },
  };
}
