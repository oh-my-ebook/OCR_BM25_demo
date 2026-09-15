import assert from "node:assert/strict";
import type { Kiwi } from "kiwi-nlp";
import { postprocessKiwiText } from "../lib/kiwi-postprocess.ts";

const kiwi = {
  tokenize: (line: string) => line.split(" ").filter(Boolean).map((str) => ({ str, tag: "NNG" })),
  joinSent: (morphs: Array<{ form: string }>) => ({
    str: morphs.map((morph) => morph.form).join("·"),
    ranges: null,
  }),
} as unknown as Pick<Kiwi, "tokenize" | "joinSent">;

assert.equal(postprocessKiwiText(kiwi, "한국어 OCR\n\n소스 코드"), "한국어·OCR\n\n소스·코드");
console.log("Kiwi postprocess check passed");
