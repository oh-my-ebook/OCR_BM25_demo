import assert from "node:assert/strict";
import { combineOcrRegions, type OcrRegion } from "../lib/ocr-ensemble.ts";

const region = (text: string, confidence: number, y0: number): OcrRegion => ({
  text,
  confidence,
  x0: 0,
  y0,
  x1: 200,
  y1: y0 + 20,
});

const result = combineOcrRegions(
  [region("같은 문장", 80, 0), region("테서렉트 선택", 92, 30), region("낮은 잡음", 20, 60)],
  [region("같은문장", 95, 0), region("패들 오인식", 70, 30), region("패들 전용", 88, 90)],
);

assert.equal(result.text, "같은문장\n테서렉트 선택\n패들 전용");
assert.equal(result.agreements, 1);
assert.equal(result.conflicts, 1);
assert.equal(result.unmatchedAccepted, 1);
assert.equal(result.dropped, 1);
assert.equal(result.tesseractChosen, 1);
assert.equal(result.paddleChosen, 2);
console.log("OCR ensemble check passed");
