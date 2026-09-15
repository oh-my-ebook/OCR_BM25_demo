import assert from "node:assert/strict";
import { fitOcrLines } from "../lib/ocr-text-layer.ts";

const lines = fitOcrLines(
  [
    { text: "  한국어 OCR  ", bbox: { x0: 10, y0: 20, x1: 210, y1: 40 }, rowAttributes: { rowHeight: 18 } },
    { text: "", bbox: { x0: 0, y0: 0, x1: 100, y1: 20 } },
  ],
  (_text, fontSize) => fontSize * 5,
);

assert.equal(lines.length, 1);
assert.equal(lines[0].text, "한국어 OCR");
assert.equal(lines[0].fontSize, 18);
assert.equal(lines[0].scaleX, 200 / 90);
console.log("OCR text layer check passed");
