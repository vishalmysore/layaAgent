// WebLLM runs System 2 in this worker so token generation never blocks the page.
import { WebWorkerMLCEngineHandler } from "./vendor/web-llm.mjs";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
