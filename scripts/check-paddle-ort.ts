import assert from "node:assert/strict";
import { getPaddleOrtWasmPaths } from "../lib/paddle-ort.ts";

let fetchCount = 0;
const fetchModule = async (input: string | URL | Request) => {
  fetchCount += 1;
  assert.equal(input, "/vendor/onnxruntime/ort-wasm-simd-threaded.jsep.mjs");
  return new Response("export default async function () {}", { status: 200 });
};

const first = (await getPaddleOrtWasmPaths(fetchModule as typeof fetch)) as unknown as {
  mjs: string;
  wasm: string;
};
const second = (await getPaddleOrtWasmPaths(fetchModule as typeof fetch)) as unknown as {
  mjs: string;
  wasm: string;
};

assert.match(first.mjs, /^blob:nodedata:/);
assert.equal(first.wasm, "/vendor/onnxruntime/ort-wasm-simd-threaded.jsep.wasm");
assert.equal(second.mjs, first.mjs);
assert.equal(fetchCount, 1);

URL.revokeObjectURL(first.mjs);
console.log("paddle ORT asset checks passed");
