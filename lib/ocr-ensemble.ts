export type OcrRegion = {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type OcrEnsemble = {
  text: string;
  confidence: number;
  agreements: number;
  conflicts: number;
  tesseractChosen: number;
  paddleChosen: number;
  unmatchedAccepted: number;
  dropped: number;
};

const unmatchedConfidenceThreshold = 50;

function normalized(text: string) {
  return text.normalize("NFC").replace(/\s+/g, "").trim();
}

function overlapScore(left: OcrRegion, right: OcrRegion) {
  const overlapWidth = Math.max(0, Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0));
  const overlapHeight = Math.max(0, Math.min(left.y1, right.y1) - Math.max(left.y0, right.y0));
  const leftWidth = Math.max(1, left.x1 - left.x0);
  const rightWidth = Math.max(1, right.x1 - right.x0);
  const leftHeight = Math.max(1, left.y1 - left.y0);
  const rightHeight = Math.max(1, right.y1 - right.y0);
  const horizontal = overlapWidth / Math.min(leftWidth, rightWidth);
  const vertical = overlapHeight / Math.min(leftHeight, rightHeight);
  return vertical >= 0.5 && horizontal >= 0.1 ? vertical * 2 + horizontal : 0;
}

export function combineOcrRegions(tesseract: OcrRegion[], paddle: OcrRegion[]): OcrEnsemble {
  const candidates = tesseract.flatMap((left, tesseractIndex) =>
    paddle.flatMap((right, paddleIndex) => {
      const score = overlapScore(left, right);
      return score ? [{ tesseractIndex, paddleIndex, score }] : [];
    }),
  ).sort((left, right) => right.score - left.score);

  const usedTesseract = new Set<number>();
  const usedPaddle = new Set<number>();
  const selected: Array<OcrRegion & { source: "tesseract" | "paddle" }> = [];
  let agreements = 0;
  let conflicts = 0;
  let tesseractChosen = 0;
  let paddleChosen = 0;

  for (const candidate of candidates) {
    if (usedTesseract.has(candidate.tesseractIndex) || usedPaddle.has(candidate.paddleIndex)) continue;
    usedTesseract.add(candidate.tesseractIndex);
    usedPaddle.add(candidate.paddleIndex);
    const left = tesseract[candidate.tesseractIndex];
    const right = paddle[candidate.paddleIndex];
    if (normalized(left.text) === normalized(right.text)) agreements += 1;
    else conflicts += 1;
    const [region, source] = left.confidence >= right.confidence
      ? [left, "tesseract" as const]
      : [right, "paddle" as const];
    if (source === "tesseract") tesseractChosen += 1;
    else paddleChosen += 1;
    selected.push({ ...region, source });
  }

  let unmatchedAccepted = 0;
  let dropped = 0;
  for (const [source, regions, used] of [
    ["tesseract", tesseract, usedTesseract],
    ["paddle", paddle, usedPaddle],
  ] as const) {
    regions.forEach((region, index) => {
      if (used.has(index)) return;
      if (region.confidence < unmatchedConfidenceThreshold) {
        dropped += 1;
        return;
      }
      unmatchedAccepted += 1;
      if (source === "tesseract") tesseractChosen += 1;
      else paddleChosen += 1;
      selected.push({ ...region, source });
    });
  }

  selected.sort((left, right) => {
    const lineHeight = Math.max(left.y1 - left.y0, right.y1 - right.y0);
    return Math.abs(left.y0 - right.y0) <= lineHeight * 0.5
      ? left.x0 - right.x0
      : left.y0 - right.y0;
  });
  const characterCount = selected.reduce((sum, region) => sum + Array.from(region.text.trim()).length, 0);
  const confidence = characterCount
    ? selected.reduce(
      (sum, region) => sum + region.confidence * Array.from(region.text.trim()).length,
      0,
    ) / characterCount
    : 0;

  return {
    text: selected.map((region) => region.text.trim()).filter(Boolean).join("\n"),
    confidence,
    agreements,
    conflicts,
    tesseractChosen,
    paddleChosen,
    unmatchedAccepted,
    dropped,
  };
}
