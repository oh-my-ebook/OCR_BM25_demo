export type OcrLineInput = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  rowAttributes?: { rowHeight: number };
};

export type SelectableTextLine = OcrLineInput["bbox"] & {
  text: string;
  fontSize: number;
  scaleX: number;
};

export function fitOcrLines(
  lines: OcrLineInput[],
  measure: (text: string, fontSize: number) => number,
): SelectableTextLine[] {
  return lines.flatMap((line) => {
    const text = line.text.trim();
    const width = line.bbox.x1 - line.bbox.x0;
    const height = line.bbox.y1 - line.bbox.y0;
    if (!text || width <= 0 || height <= 0) return [];

    const fontSize = Math.max(1, Math.min(height, line.rowAttributes?.rowHeight || height));
    const measuredWidth = measure(text, fontSize);
    const scaleX = measuredWidth > 0 ? Math.min(4, Math.max(0.25, width / measuredWidth)) : 1;
    return [{ text, ...line.bbox, fontSize, scaleX }];
  });
}
