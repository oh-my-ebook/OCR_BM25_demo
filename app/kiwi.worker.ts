/// <reference lib="webworker" />

import { KiwiBuilder, Match } from "kiwi-nlp";
import type { Kiwi } from "kiwi-nlp";
import { postprocessKiwiText } from "@/lib/kiwi-postprocess";

const modelNames = [
  "combiningRule.txt",
  "extract.mdl",
  "sj.morph",
  "cong.mdl",
  "nounchr.mdl",
];

let kiwiPromise: Promise<Kiwi> | null = null;

function getKiwi() {
  if (!kiwiPromise) {
    kiwiPromise = KiwiBuilder.create("/kiwi/kiwi-wasm.wasm").then((builder) =>
      builder.build({
        modelFiles: Object.fromEntries(modelNames.map((name) => [name, `/kiwi/model/${name}`])),
        modelType: "cong",
        loadDefaultDict: false,
        loadMultiDict: false,
        loadTypoDict: false,
      }),
    );
  }
  return kiwiPromise;
}

self.onmessage = async (event: MessageEvent<{ id: number; type: "init" | "tokenize" | "postprocess"; text?: string }>) => {
  const { id, type, text = "" } = event.data;
  try {
    const kiwi = await getKiwi();
    if (type === "postprocess") {
      self.postMessage({ id, ok: true, text: postprocessKiwiText(kiwi, text) });
    } else {
      const tokens = type === "tokenize" ? kiwi.tokenize(text, Match.allWithNormalizing) : [];
      self.postMessage({ id, ok: true, tokens });
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};
