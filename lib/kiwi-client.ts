import type { Token } from "./bm25";
import { createKiwiWorker } from "@/lib/worker-factory";

let kiwiWorker: Worker | null = null;
let kiwiSequence = 0;
const kiwiPending = new Map<
  number,
  { resolve: (result: Token[] | string) => void; reject: (error: Error) => void }
>();

export function callKiwi(type: "init" | "tokenize", text?: string): Promise<Token[]>;
export function callKiwi(type: "postprocess", text: string): Promise<string>;
export function callKiwi(type: "init" | "tokenize" | "postprocess", text = "") {
  if (!kiwiWorker) {
    kiwiWorker = createKiwiWorker();
    kiwiWorker.onmessage = (
      event: MessageEvent<{ id: number; ok: boolean; tokens?: Token[]; text?: string; error?: string }>,
    ) => {
      const pending = kiwiPending.get(event.data.id);
      if (!pending) return;
      kiwiPending.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.text ?? event.data.tokens ?? []);
      else pending.reject(new Error(event.data.error ?? "Kiwi 분석 실패"));
    };
    kiwiWorker.onerror = () => {
      const error = new Error("Kiwi Worker 실행에 실패했습니다.");
      for (const pending of kiwiPending.values()) pending.reject(error);
      kiwiPending.clear();
      kiwiWorker?.terminate();
      kiwiWorker = null;
    };
  }

  const id = ++kiwiSequence;
  return new Promise<Token[] | string>((resolve, reject) => {
    kiwiPending.set(id, { resolve, reject });
    kiwiWorker!.postMessage({ id, type, text });
  });
}
