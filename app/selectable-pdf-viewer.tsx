"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Copy, FileCheck2, LoaderCircle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { callKiwi } from "@/lib/kiwi-client";
import { fitOcrLines, type SelectableTextLine } from "@/lib/ocr-text-layer";
import { getPaddleOrtWasmPaths } from "@/lib/paddle-ort";

type PaddleOcr = Awaited<ReturnType<(typeof import("@paddleocr/paddleocr-js"))["PaddleOCR"]["create"]>>;
type TesseractWorker = Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>;
type OcrEngine = "paddle" | "tesseract";
type PageView = {
  page: number;
  width: number;
  height: number;
  imageUrl: string;
  text: string;
  lines: SelectableTextLine[];
};

const DPI = 200;
const engineLabels: Record<OcrEngine, string> = {
  paddle: "PaddleOCR",
  tesseract: "Tesseract",
};

export default function SelectablePdfViewer() {
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const paddleRef = useRef<PaddleOcr | null>(null);
  const tesseractRef = useRef<TesseractWorker | null>(null);
  const fileRef = useRef<File | null>(null);
  const imageUrlRef = useRef("");
  const [fileName, setFileName] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [view, setView] = useState<PageView | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("PDF를 선택하세요");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [engine, setEngine] = useState<OcrEngine>("paddle");

  async function dispose() {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = "";
    await paddleRef.current?.dispose();
    await tesseractRef.current?.terminate();
    await loadingTaskRef.current?.destroy();
    paddleRef.current = null;
    tesseractRef.current = null;
    loadingTaskRef.current = null;
    pdfRef.current = null;
  }

  useEffect(() => () => void dispose(), []);

  async function renderPage(pageNumber: number, pdf = pdfRef.current, selectedEngine = engine) {
    const paddle = paddleRef.current;
    const tesseract = tesseractRef.current;
    if (!pdf || (selectedEngine === "paddle" ? !paddle : !tesseract)) return;
    setBusy(true);
    setCopied(false);
    setError("");
    setProgress(20);
    setStatus(`${pageNumber}/${pdf.numPages}쪽 렌더링 중`);

    const canvas = document.createElement("canvas");
    let page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | null = null;

    try {
      page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: DPI / 72 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("PDF 페이지 Canvas를 만들 수 없습니다.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" }).promise;

      setProgress(35);
      setStatus(`${pageNumber}/${pdf.numPages}쪽 ${engineLabels[selectedEngine]} 인식 중`);
      let ocrLines: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }>;
      if (selectedEngine === "paddle") {
        const [recognized] = await paddle!.predict(canvas, {
          textDetLimitSideLen: 1600,
          textDetLimitType: "max",
          textDetMaxSideLimit: 3000,
          textDetBoxThresh: 0.45,
          textRecScoreThresh: 0.25,
        });
        ocrLines = recognized.items.filter((item) => item.text.trim()).map((item) => ({
          text: item.text.trim(),
          bbox: {
            x0: Math.min(...item.poly.map((point) => point[0])),
            y0: Math.min(...item.poly.map((point) => point[1])),
            x1: Math.max(...item.poly.map((point) => point[0])),
            y1: Math.max(...item.poly.map((point) => point[1])),
          },
        }));
      } else {
        const recognized = await tesseract!.recognize(canvas, {}, { text: true, blocks: true });
        ocrLines = (recognized.data.blocks ?? []).flatMap((block) =>
          block.paragraphs.flatMap((paragraph) =>
            paragraph.lines
              .filter((line) => line.text.trim())
              .map((line) => ({ text: line.text.trim(), bbox: line.bbox })),
          ),
        );
      }
      setProgress(78);
      setStatus(`${pageNumber}/${pdf.numPages}쪽 Kiwi 후처리 중`);
      const processedText = await callKiwi("postprocess", ocrLines.map((line) => line.text).join("\n"));
      const processedLines = processedText.split("\n");
      const lines = fitOcrLines(ocrLines.map((line, index) => ({
        ...line,
        text: processedLines[index] ?? line.text,
      })), (text, fontSize) => {
        context.font = `${fontSize}px sans-serif`;
        return context.measureText(text).width;
      });
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("페이지 이미지를 만들 수 없습니다.")), "image/png"),
      );
      const imageUrl = URL.createObjectURL(blob);
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = imageUrl;
      setView({
        page: pageNumber,
        width: canvas.width,
        height: canvas.height,
        imageUrl,
        text: processedText,
        lines,
      });
      setProgress(100);
      setStatus(`${pageNumber}/${pdf.numPages}쪽 · ${engineLabels[selectedEngine]} · ${lines.length.toLocaleString()}개 행 선택 영역`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus(`${pageNumber}/${pdf.numPages}쪽 처리 실패`);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      page?.cleanup();
      setBusy(false);
    }
  }

  async function openPdf(file: File, selectedEngine = engine) {
    fileRef.current = file;
    setBusy(true);
    setError("");
    setView(null);
    setFileName(file.name);
    setPageCount(0);
    setProgress(2);
    setStatus(`PDF, ${engineLabels[selectedEngine]}, Kiwi 준비 중`);

    try {
      await dispose();
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
      const loadingTask = pdfjs.getDocument({
        data: await file.arrayBuffer(),
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/",
      });
      loadingTaskRef.current = loadingTask;
      const pdf = await loadingTask.promise;
      pdfRef.current = pdf;
      setPageCount(pdf.numPages);
      setProgress(8);

      if (selectedEngine === "paddle") {
        const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
        const wasmPaths = await getPaddleOrtWasmPaths();
        paddleRef.current = await PaddleOCR.create({
          worker: false,
          textDetectionModelName: "PP-OCRv5_mobile_det",
          textDetectionModelAsset: { url: "/vendor/paddleocr/PP-OCRv5_mobile_det_onnx_infer.tar" },
          textRecognitionModelName: "korean_PP-OCRv5_mobile_rec",
          textRecognitionModelAsset: { url: "/vendor/paddleocr/korean_PP-OCRv5_mobile_rec_onnx_infer.tar" },
          textRecognitionBatchSize: 8,
          ortOptions: {
            backend: "wasm",
            wasmPaths,
            numThreads: 1,
            simd: true,
          },
        });
      } else {
        const tesseract = await import("tesseract.js");
        tesseractRef.current = await tesseract.createWorker(
          ["kor", "eng"],
          tesseract.OEM.LSTM_ONLY,
          {
            workerPath: "/vendor/tesseract/worker.min.js",
            corePath: "/vendor/tesseract",
            langPath: "/vendor/tessdata",
            gzip: true,
          },
        );
        await tesseractRef.current.setParameters({
          tessedit_pageseg_mode: tesseract.PSM.AUTO,
          preserve_interword_spaces: "1",
          user_defined_dpi: String(DPI),
        });
      }
      await callKiwi("init");
      await renderPage(1, pdf, selectedEngine);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("처리 실패");
      setBusy(false);
    }
  }

  async function copyPage() {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.text);
      setCopied(true);
    } catch {
      setError("브라우저가 클립보드 복사를 허용하지 않았습니다. 텍스트를 드래그한 뒤 복사해 주세요.");
    }
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 lg:px-8 lg:py-8">
      <section className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="h-fit rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
          <p className="eyebrow">SELECTABLE PDF</p>
          <h2 className="mt-2 text-xl font-bold tracking-tight">{engineLabels[engine]} + Kiwi 텍스트 레이어</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">
            PDF는 200 DPI로 로컬 처리됩니다. 선택한 OCR 결과를 Kiwi로 후처리한 뒤 옅은 파란 영역을 드래그해 복사할 수 있습니다.
          </p>

          <label className="mt-5 block text-xs font-bold text-[var(--muted-text)]">
            OCR 모델
            <select
              className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--foreground)]"
              value={engine}
              disabled={busy}
              onChange={(event) => {
                const selectedEngine = event.target.value as OcrEngine;
                setEngine(selectedEngine);
                if (fileRef.current) void openPdf(fileRef.current, selectedEngine);
              }}
            >
              <option value="paddle">PaddleOCR · PP-OCRv5 한국어</option>
              <option value="tesseract">Tesseract · kor + eng LSTM</option>
            </select>
            <span className="mt-1.5 block font-normal leading-5">모델을 바꾸면 현재 PDF를 같은 조건으로 다시 처리합니다.</span>
          </label>

          <label className="mt-3 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-5 text-center">
            {busy ? <LoaderCircle className="size-7 animate-spin text-[var(--accent-strong)]" /> : <Upload className="size-7 text-[var(--accent-strong)]" />}
            <span className="mt-3 text-sm font-bold">PDF 선택</span>
            <span className="mt-1 max-w-64 truncate text-xs text-[var(--muted-text)]">{fileName || "파일은 외부로 전송되지 않습니다"}</span>
            <input
              className="sr-only"
              type="file"
              accept="application/pdf,.pdf"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void openPdf(file);
                event.currentTarget.value = "";
              }}
            />
          </label>

          <Progress value={progress} className="mt-4 h-1.5" />
          <p className={`mt-3 text-xs leading-5 ${error ? "text-red-600" : "text-[var(--muted-text)]"}`}>{error || status}</p>

          {view && (
            <div className="mt-4 grid grid-cols-[auto_1fr_auto] items-center gap-2">
              <Button variant="outline" size="icon" disabled={busy || view.page === 1} onClick={() => void renderPage(view.page - 1)} aria-label="이전 페이지">
                <ChevronLeft />
              </Button>
              <span className="text-center text-sm font-bold tabular-nums">{view.page} / {pageCount}</span>
              <Button variant="outline" size="icon" disabled={busy || view.page === pageCount} onClick={() => void renderPage(view.page + 1)} aria-label="다음 페이지">
                <ChevronRight />
              </Button>
            </div>
          )}

          <Button className="mt-3 w-full" variant="outline" disabled={!view || busy} onClick={() => void copyPage()}>
            {copied ? <FileCheck2 /> : <Copy />}
            {copied ? "복사됨" : "현재 페이지 전체 복사"}
          </Button>
        </aside>

        <section className="min-w-0 rounded-2xl border border-[var(--line)] bg-slate-200 p-3 shadow-[var(--shadow)] sm:p-6">
          {!view ? (
            <div className="grid min-h-[560px] place-items-center rounded-xl border border-dashed border-slate-400 bg-white/60 text-sm text-[var(--muted-text)]">
              PDF를 선택하면 첫 페이지를 표시합니다.
            </div>
          ) : (
            <div
              className="relative mx-auto overflow-hidden bg-white shadow-lg"
              style={{ aspectRatio: `${view.width} / ${view.height}`, containerType: "inline-size" }}
            >
              <img src={view.imageUrl} alt={`${view.page}쪽 PDF`} draggable={false} className="block h-full w-full select-none" />
              <div className="absolute inset-0 overflow-hidden" aria-label={`${view.page}쪽 OCR 텍스트 레이어`}>
                {view.lines.map((line, index) => (
                  <div
                    key={`${line.x0}-${line.y0}-${index}`}
                    className="absolute origin-top-left cursor-text whitespace-pre bg-blue-400/5 text-transparent outline outline-1 outline-blue-500/10 selection:bg-blue-400/45"
                    style={{
                      left: `${(line.x0 / view.width) * 100}%`,
                      top: `${(line.y0 / view.height) * 100}%`,
                      fontSize: `${(line.fontSize / view.width) * 100}cqw`,
                      lineHeight: 1,
                      transform: `scaleX(${line.scaleX})`,
                      userSelect: "text",
                    }}
                  >
                    {line.text}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
