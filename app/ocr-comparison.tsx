"use client";

import { useMemo, useState } from "react";
import { FileCheck2, Gauge, LoaderCircle, ScanSearch, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";

const ortJsepModuleUrl = "/vendor/onnxruntime/ort-wasm-simd-threaded.jsep.mjs";
const ortJsepWasmUrl = "/vendor/onnxruntime/ort-wasm-simd-threaded.jsep.wasm";

type EngineResult = {
  text: string;
  confidence: number;
  ms: number;
};

type PageComparison = {
  page: number;
  dpi: Dpi;
  imageWidth: number;
  imageHeight: number;
  tesseract: EngineResult;
  paddle: EngineResult;
};

type ComparisonTimings = {
  tesseractInitMs: number;
  paddleInitMs: number;
};

type Accuracy = {
  distance: number;
  referenceLength: number;
  cer: number;
  accuracy: number;
  insertions: number;
  deletions: number;
  substitutions: number;
};

type Dpi = 200 | 300 | 400;

const dpiOptions: Dpi[] = [200, 300, 400];

const paddleBenchmarkOptions = {
  textDetLimitSideLen: 1600,
  textDetBoxThresh: 0.45,
  textRecScoreThresh: 0.25,
} as const;

const emptyTimings: ComparisonTimings = {
  tesseractInitMs: 0,
  paddleInitMs: 0,
};

function elapsed(start: number) {
  return Math.round((performance.now() - start) * 10) / 10;
}

function formatMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}초` : `${Math.round(ms)}ms`;
}

function normalizeForCer(text: string) {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

function editDistanceBreakdown(leftText: string, rightText: string) {
  const left = Array.from(leftText);
  const right = Array.from(rightText);
  const width = right.length + 1;
  let previousDistance = Int32Array.from({ length: width }, (_, index) => index);
  let previousInsertions = Uint32Array.from({ length: width }, (_, index) => index);
  let previousDeletions = new Uint32Array(width);
  let previousSubstitutions = new Uint32Array(width);
  let currentDistance = new Int32Array(width);
  let currentInsertions = new Uint32Array(width);
  let currentDeletions = new Uint32Array(width);
  let currentSubstitutions = new Uint32Array(width);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    currentDistance[0] = leftIndex;
    currentInsertions[0] = 0;
    currentDeletions[0] = leftIndex;
    currentSubstitutions[0] = 0;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        currentDistance[rightIndex] = previousDistance[rightIndex - 1];
        currentInsertions[rightIndex] = previousInsertions[rightIndex - 1];
        currentDeletions[rightIndex] = previousDeletions[rightIndex - 1];
        currentSubstitutions[rightIndex] = previousSubstitutions[rightIndex - 1];
        continue;
      }

      const substitutionDistance = previousDistance[rightIndex - 1] + 1;
      const deletionDistance = previousDistance[rightIndex] + 1;
      const insertionDistance = currentDistance[rightIndex - 1] + 1;

      if (substitutionDistance <= deletionDistance && substitutionDistance <= insertionDistance) {
        currentDistance[rightIndex] = substitutionDistance;
        currentInsertions[rightIndex] = previousInsertions[rightIndex - 1];
        currentDeletions[rightIndex] = previousDeletions[rightIndex - 1];
        currentSubstitutions[rightIndex] = previousSubstitutions[rightIndex - 1] + 1;
      } else if (deletionDistance <= insertionDistance) {
        currentDistance[rightIndex] = deletionDistance;
        currentInsertions[rightIndex] = previousInsertions[rightIndex];
        currentDeletions[rightIndex] = previousDeletions[rightIndex] + 1;
        currentSubstitutions[rightIndex] = previousSubstitutions[rightIndex];
      } else {
        currentDistance[rightIndex] = insertionDistance;
        currentInsertions[rightIndex] = currentInsertions[rightIndex - 1] + 1;
        currentDeletions[rightIndex] = currentDeletions[rightIndex - 1];
        currentSubstitutions[rightIndex] = currentSubstitutions[rightIndex - 1];
      }
    }

    [previousDistance, currentDistance] = [currentDistance, previousDistance];
    [previousInsertions, currentInsertions] = [currentInsertions, previousInsertions];
    [previousDeletions, currentDeletions] = [currentDeletions, previousDeletions];
    [previousSubstitutions, currentSubstitutions] = [currentSubstitutions, previousSubstitutions];
  }

  return {
    distance: previousDistance[right.length],
    insertions: previousInsertions[right.length],
    deletions: previousDeletions[right.length],
    substitutions: previousSubstitutions[right.length],
  };
}

function measureAccuracy(reference: string, candidate: string): Accuracy | null {
  const normalizedReference = normalizeForCer(reference);
  if (!normalizedReference) return null;
  const errors = editDistanceBreakdown(normalizedReference, normalizeForCer(candidate));
  const referenceLength = Array.from(normalizedReference).length;
  const cer = errors.distance / referenceLength;
  return {
    ...errors,
    referenceLength,
    cer,
    accuracy: Math.max(0, 1 - cer),
  };
}

function aggregateAccuracy(
  pages: PageComparison[],
  references: string[],
  engine: "tesseract" | "paddle",
): (Accuracy & { evaluatedPages: number }) | null {
  let distance = 0;
  let referenceLength = 0;
  let evaluatedPages = 0;
  let insertions = 0;
  let deletions = 0;
  let substitutions = 0;

  for (const page of pages) {
    const result = measureAccuracy(references[page.page - 1] ?? "", page[engine].text);
    if (!result) continue;
    distance += result.distance;
    referenceLength += result.referenceLength;
    evaluatedPages += 1;
    insertions += result.insertions;
    deletions += result.deletions;
    substitutions += result.substitutions;
  }

  if (!referenceLength) return null;
  const cer = distance / referenceLength;
  return {
    distance,
    referenceLength,
    evaluatedPages,
    insertions,
    deletions,
    substitutions,
    cer,
    accuracy: Math.max(0, 1 - cer),
  };
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatErrors(accuracy: Accuracy | null) {
  if (!accuracy) return "정답 대기";
  return `삭제 ${accuracy.deletions} · 삽입 ${accuracy.insertions} · 치환 ${accuracy.substitutions}`;
}

export default function OcrComparison() {
  const [file, setFile] = useState<File | null>(null);
  const [results, setResults] = useState<PageComparison[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  const [timings, setTimings] = useState<ComparisonTimings>(emptyTimings);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("PDF를 선택하세요");
  const [error, setError] = useState("");
  const [dpi, setDpi] = useState<Dpi>(300);

  const tesseractAccuracy = useMemo(
    () => aggregateAccuracy(results, references, "tesseract"),
    [results, references],
  );
  const paddleAccuracy = useMemo(
    () => aggregateAccuracy(results, references, "paddle"),
    [results, references],
  );
  const tesseractInferenceMs = results.reduce((sum, page) => sum + page.tesseract.ms, 0);
  const paddleInferenceMs = results.reduce((sum, page) => sum + page.paddle.ms, 0);

  async function compare() {
    if (!file || running) return;
    const selectedDpi = dpi;
    setRunning(true);
    setResults([]);
    setTimings(emptyTimings);
    setProgress(1);
    setError("");

    let tesseractWorker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null = null;
    let paddleOcr: Awaited<ReturnType<(typeof import("@paddleocr/paddleocr-js"))["PaddleOCR"]["create"]>> | null = null;

    try {
      setStatus("PDF 페이지 준비 중");
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
      const loadingTask = pdfjs.getDocument({
        data: await file.arrayBuffer(),
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/",
      });
      const pdf = await loadingTask.promise;
      setReferences((current) =>
        Array.from({ length: pdf.numPages }, (_, index) => current[index] ?? ""),
      );
      setProgress(5);

      setStatus("Tesseract 한국어 모델 초기화");
      const tesseractModule = await import("tesseract.js");
      const tesseractInitStart = performance.now();
      tesseractWorker = await tesseractModule.createWorker(
        ["kor", "eng"],
        tesseractModule.OEM.LSTM_ONLY,
        {
          workerPath: "/vendor/tesseract/worker.min.js",
          corePath: "/vendor/tesseract",
          langPath: "/vendor/tessdata",
          gzip: true,
        },
      );
      await tesseractWorker.setParameters({
        tessedit_pageseg_mode: tesseractModule.PSM.AUTO,
        preserve_interword_spaces: "1",
        user_defined_dpi: String(selectedDpi),
      });
      const tesseractInitMs = elapsed(tesseractInitStart);
      setProgress(12);

      setStatus("PaddleOCR 한국어 모델 초기화");
      const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
      const paddleInitStart = performance.now();
      paddleOcr = await PaddleOCR.create({
        worker: false,
        textDetectionModelName: "PP-OCRv5_mobile_det",
        textDetectionModelAsset: { url: "/vendor/paddleocr/PP-OCRv5_mobile_det_onnx_infer.tar" },
        textRecognitionModelName: "korean_PP-OCRv5_mobile_rec",
        textRecognitionModelAsset: { url: "/vendor/paddleocr/korean_PP-OCRv5_mobile_rec_onnx_infer.tar" },
        textRecognitionBatchSize: 8,
        ortOptions: {
          backend: "wasm",
          wasmPaths: {
            mjs: ortJsepModuleUrl,
            wasm: ortJsepWasmUrl,
          } as unknown as string,
          numThreads: 1,
          simd: true,
        },
      });
      const paddleInitMs = elapsed(paddleInitStart);
      setTimings({ tesseractInitMs, paddleInitMs });
      setProgress(20);

      const comparisons: PageComparison[] = [];
      for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
        const pageNumber = pageIndex + 1;
        setStatus(`${pageNumber}/${pdf.numPages}쪽 · ${selectedDpi} DPI 동일 이미지 비교 중`);
        const page = await pdf.getPage(pageNumber);
        const renderScale = selectedDpi / 72;
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("PDF 페이지 Canvas를 만들 수 없습니다.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" }).promise;

        const recognizeTesseract = async (): Promise<EngineResult> => {
          const start = performance.now();
          const recognized = await tesseractWorker!.recognize(canvas);
          return {
            text: recognized.data.text.trim(),
            confidence: recognized.data.confidence,
            ms: elapsed(start),
          };
        };

        const recognizePaddle = async (): Promise<EngineResult> => {
          const start = performance.now();
          const [recognized] = await paddleOcr!.predict(canvas, {
            textDetLimitSideLen: paddleBenchmarkOptions.textDetLimitSideLen,
            textDetLimitType: "max",
            textDetMaxSideLimit: 3000,
            textDetBoxThresh: paddleBenchmarkOptions.textDetBoxThresh,
            textRecScoreThresh: paddleBenchmarkOptions.textRecScoreThresh,
          });
          const items = recognized.items
            .filter((item) => item.text.trim())
            .sort((left, right) => {
              const leftY = Math.min(...left.poly.map((point) => point[1]));
              const rightY = Math.min(...right.poly.map((point) => point[1]));
              const leftX = Math.min(...left.poly.map((point) => point[0]));
              const rightX = Math.min(...right.poly.map((point) => point[0]));
              return Math.abs(leftY - rightY) < 12 ? leftX - rightX : leftY - rightY;
            });
          return {
            text: items.map((item) => item.text.trim()).join("\n"),
            confidence: items.length
              ? (items.reduce((sum, item) => sum + item.score, 0) / items.length) * 100
              : 0,
            ms: elapsed(start),
          };
        };

        let tesseract: EngineResult;
        let paddle: EngineResult;
        if (pageIndex % 2 === 0) {
          tesseract = await recognizeTesseract();
          paddle = await recognizePaddle();
        } else {
          paddle = await recognizePaddle();
          tesseract = await recognizeTesseract();
        }

        comparisons.push({
          page: pageNumber,
          dpi: selectedDpi,
          imageWidth: canvas.width,
          imageHeight: canvas.height,
          tesseract,
          paddle,
        });
        setResults([...comparisons]);
        setProgress(20 + (pageNumber / pdf.numPages) * 80);
        canvas.width = 0;
        canvas.height = 0;
      }

      await loadingTask.destroy();
      setStatus(`${pdf.numPages}쪽 · ${selectedDpi} DPI 비교 완료 · 정답 텍스트를 입력하세요`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setStatus("비교 실패");
    } finally {
      await tesseractWorker?.terminate();
      await paddleOcr?.dispose();
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 lg:px-8 lg:py-8">
      <section className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
          <p className="eyebrow">OCR BENCHMARK</p>
          <h2 className="mt-2 text-xl font-bold tracking-tight">같은 페이지, 두 엔진</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">
            선택한 DPI로 한 번 렌더링한 동일 Canvas를 두 엔진에 전달합니다. 홀수·짝수 페이지의 실행 순서를 바꿔 순서 편향을 줄입니다.
          </p>

          <label className="mt-5 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-5 text-center transition hover:border-[var(--accent-strong)]">
            <Upload className="size-7 text-[var(--accent-strong)]" />
            <span className="mt-3 text-sm font-bold">비교할 PDF 선택</span>
            <span className="mt-1 max-w-64 truncate text-xs text-[var(--muted-text)]">
              {file?.name ?? "권장: 정답을 만들 수 있는 5쪽 샘플"}
            </span>
            <input
              className="sr-only"
              type="file"
              accept="application/pdf,.pdf"
              disabled={running}
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setFile(selected);
                setResults([]);
                setReferences([]);
                setTimings(emptyTimings);
                setProgress(0);
                setError("");
                setStatus(selected ? "두 엔진 비교를 시작하세요" : "PDF를 선택하세요");
                event.currentTarget.value = "";
              }}
            />
          </label>

          <label className="mt-3 block text-xs font-bold text-[var(--muted-text)]">
            공통 렌더링 DPI
            <select
              className="mt-1.5 w-full rounded-lg border border-[var(--line)] bg-[var(--panel)] px-3 py-2 text-sm font-medium text-[var(--foreground)]"
              value={dpi}
              disabled={running}
              onChange={(event) => {
                setDpi(Number(event.target.value) as Dpi);
                setResults([]);
                setTimings(emptyTimings);
                setProgress(0);
                setError("");
                setStatus(file ? "선택한 DPI로 두 엔진 비교를 시작하세요" : "PDF를 선택하세요");
              }}
            >
              {dpiOptions.map((value) => (
                <option key={value} value={value}>
                  {value} DPI
                </option>
              ))}
            </select>
            <span className="mt-1.5 block font-normal leading-5">두 모델 모두 같은 크기의 페이지 이미지를 입력받습니다.</span>
          </label>

          <Button className="mt-3 w-full" size="lg" disabled={!file || running} onClick={() => void compare()}>
            {running ? <LoaderCircle className="animate-spin" /> : <ScanSearch />}
            {running ? "비교 중" : "두 엔진 비교 시작"}
          </Button>
          <Progress value={progress} className="mt-4 h-1.5" />
          <p className={`mt-3 text-xs leading-5 ${error ? "text-red-600" : "text-[var(--muted-text)]"}`}>
            {error || status}
          </p>
        </aside>

        <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
          <div className="flex items-center gap-2">
            <Gauge className="size-5 text-[var(--accent-strong)]" />
            <h2 className="text-xl font-bold tracking-tight">측정 결과</h2>
          </div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">
            정확도는 공백을 하나로 통일한 음절 CER 기준입니다. 오류는 삭제(누락), 삽입(과검출·중복), 치환(오인식)으로 분리합니다.
          </p>

          {!results.length ? (
            <div className="empty-state !min-h-56">
              <FileCheck2 className="size-7" />
              <p>비교 실행 후 속도가 나타납니다. 페이지별 정답을 붙여 넣으면 정확도도 즉시 계산됩니다.</p>
            </div>
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <EngineSummary
                name="Tesseract"
                model="kor + eng · LSTM"
                accuracy={tesseractAccuracy}
                initMs={timings.tesseractInitMs}
                inferenceMs={tesseractInferenceMs}
                pageCount={results.length}
              />
              <EngineSummary
                name="PaddleOCR"
                model="PP-OCRv5 · 1600 / box 0.45 / rec 0.25 고정"
                accuracy={paddleAccuracy}
                initMs={timings.paddleInitMs}
                inferenceMs={paddleInferenceMs}
                pageCount={results.length}
              />
            </div>
          )}
        </section>
      </section>

      {results.length > 0 && (
        <section className="mt-5 space-y-4">
          {results.map((result) => {
            const reference = references[result.page - 1] ?? "";
            const tesseractPageAccuracy = measureAccuracy(reference, result.tesseract.text);
            const paddlePageAccuracy = measureAccuracy(reference, result.paddle.text);
            return (
              <article key={result.page} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-lg font-bold">{result.page}쪽</h3>
                  <span className="text-xs text-[var(--muted-text)]">
                    {result.dpi} DPI · {result.imageWidth}×{result.imageHeight}px · 두 모델 동일 입력
                  </span>
                </div>
                <div className="mt-4 grid gap-4 xl:grid-cols-3">
                  <ResultColumn title="정답 텍스트" meta="사람이 검수한 원문">
                    <Textarea
                      value={reference}
                      onChange={(event) => {
                        const next = [...references];
                        next[result.page - 1] = event.target.value;
                        setReferences(next);
                      }}
                      placeholder={`${result.page}쪽의 정확한 본문을 붙여 넣으세요`}
                      className="min-h-72 resize-y font-mono text-sm leading-6"
                      aria-label={`${result.page}쪽 정답 텍스트`}
                    />
                  </ResultColumn>
                  <ResultColumn
                    title="Tesseract"
                    meta={`${formatMs(result.tesseract.ms)} · confidence ${result.tesseract.confidence.toFixed(1)} · ${tesseractPageAccuracy ? `CER ${formatPercent(tesseractPageAccuracy.cer)} · ${formatErrors(tesseractPageAccuracy)}` : "정답 대기"}`}
                  >
                    <Textarea readOnly value={result.tesseract.text} className="min-h-72 resize-y font-mono text-sm leading-6" aria-label={`${result.page}쪽 Tesseract 결과`} />
                  </ResultColumn>
                  <ResultColumn
                    title="PaddleOCR"
                    meta={`${formatMs(result.paddle.ms)} · confidence ${result.paddle.confidence.toFixed(1)} · ${paddlePageAccuracy ? `CER ${formatPercent(paddlePageAccuracy.cer)} · ${formatErrors(paddlePageAccuracy)}` : "정답 대기"}`}
                  >
                    <Textarea readOnly value={result.paddle.text} className="min-h-72 resize-y font-mono text-sm leading-6" aria-label={`${result.page}쪽 PaddleOCR 결과`} />
                  </ResultColumn>
                </div>
              </article>
            );
          })}
        </section>
      )}

      <section className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
        <h2 className="text-lg font-bold">비교 조건</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <ComparisonNote title="Tesseract">
            선택한 DPI의 공통 Canvas를 PSM.AUTO와 kor+eng LSTM으로 한 번만 인식합니다. 저신뢰 대비 보정·재시도는 사용하지 않습니다.
          </ComparisonNote>
          <ComparisonNote title="PaddleOCR">
            같은 공통 Canvas를 사용하며 긴 변 1600px, box 0.45, rec 0.25를 모든 DPI에서 고정합니다. 엔진 내부 리사이즈는 각 모델 파이프라인의 일부입니다.
          </ComparisonNote>
        </div>
      </section>
    </div>
  );
}

function EngineSummary({
  name,
  model,
  accuracy,
  initMs,
  inferenceMs,
  pageCount,
}: {
  name: string;
  model: string;
  accuracy: (Accuracy & { evaluatedPages: number }) | null;
  initMs: number;
  inferenceMs: number;
  pageCount: number;
}) {
  return (
    <article className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-bold">{name}</h3>
          <p className="mt-1 text-xs text-[var(--muted-text)]">{model}</p>
        </div>
        <strong className="text-xl tabular-nums text-[var(--accent-strong)]">
          {accuracy ? formatPercent(accuracy.accuracy) : "—"}
        </strong>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-xs text-[var(--muted-text)]">내용 CER</dt><dd className="mt-1 font-bold tabular-nums">{accuracy ? formatPercent(accuracy.cer) : "정답 필요"}</dd></div>
        <div><dt className="text-xs text-[var(--muted-text)]">평가 페이지</dt><dd className="mt-1 font-bold tabular-nums">{accuracy ? `${accuracy.evaluatedPages}/${pageCount}` : `0/${pageCount}`}</dd></div>
        <div><dt className="text-xs text-[var(--muted-text)]">모델 초기화</dt><dd className="mt-1 font-bold tabular-nums">{formatMs(initMs)}</dd></div>
        <div><dt className="text-xs text-[var(--muted-text)]">OCR 합계</dt><dd className="mt-1 font-bold tabular-nums">{formatMs(inferenceMs)}</dd></div>
        <div><dt className="text-xs text-[var(--muted-text)]">페이지 평균</dt><dd className="mt-1 font-bold tabular-nums">{formatMs(inferenceMs / Math.max(1, pageCount))}</dd></div>
        <div><dt className="text-xs text-[var(--muted-text)]">편집 오류</dt><dd className="mt-1 font-bold tabular-nums">{accuracy ? `${accuracy.distance}/${accuracy.referenceLength}` : "—"}</dd></div>
        <div><dt className="text-xs text-[var(--muted-text)]">삭제 · 누락</dt><dd className="mt-1 font-bold tabular-nums">{accuracy?.deletions ?? "—"}</dd></div>
        <div><dt className="text-xs text-[var(--muted-text)]">삽입 · 과검출</dt><dd className="mt-1 font-bold tabular-nums">{accuracy?.insertions ?? "—"}</dd></div>
        <div><dt className="text-xs text-[var(--muted-text)]">치환 · 오인식</dt><dd className="mt-1 font-bold tabular-nums">{accuracy?.substitutions ?? "—"}</dd></div>
      </dl>
    </article>
  );
}

function ResultColumn({ title, meta, children }: { title: string; meta: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h4 className="font-bold">{title}</h4>
      <p className="mb-2 mt-1 min-h-5 text-xs leading-5 text-[var(--muted-text)]">{meta}</p>
      {children}
    </section>
  );
}

function ComparisonNote({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <strong className="text-sm">{title}</strong>
      <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">{children}</p>
    </div>
  );
}
