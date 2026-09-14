import KiwiWorker from "../app/kiwi.worker?worker";
import WebLLMWorker from "../app/webllm.worker?worker";

export function createKiwiWorker() {
  return new KiwiWorker();
}

export function createWebLLMWorker() {
  return new WebLLMWorker();
}
