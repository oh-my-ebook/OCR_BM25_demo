export function createKiwiWorker() {
  return new Worker(new URL("../app/kiwi.worker.ts", import.meta.url), { type: "module" });
}

export function createWebLLMWorker() {
  return new Worker(new URL("../app/webllm.worker.ts", import.meta.url), { type: "module" });
}
