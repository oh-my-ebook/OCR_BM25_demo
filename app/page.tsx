"use client";

import { useMemo, useRef, useState } from "react";
import type { Database } from "sql.js";
import {
  Check,
  Clock3,
  Cpu,
  Database as DatabaseIcon,
  FileSearch,
  FileText,
  Gauge,
  Languages,
  LoaderCircle,
  LockKeyhole,
  MousePointer2,
  RotateCcw,
  ScanText,
  Scissors,
  Search,
  SearchX,
  Sparkles,
  TableProperties,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import OcrComparison from "./ocr-comparison";
import SelectablePdfViewer from "./selectable-pdf-viewer";
import WebLLMChat from "./webllm-chat";
import {
  chunkText,
  highlight,
  indexChunks,
  searchBm25,
  searchTerms,
  type IndexedChunk,
  type SearchResult,
  type Token,
} from "@/lib/bm25";
import { callKiwi } from "@/lib/kiwi-client";
import { getPaddleOrtWasmPaths } from "@/lib/paddle-ort";

type PhaseId = "detect" | "ocr" | "kiwi" | "chunk" | "sqlite";
type OcrEngine = "paddle" | "tesseract";
type Phase = {
  id: PhaseId;
  label: string;
  status: "idle" | "running" | "done" | "skipped" | "error";
  ms: number | null;
  detail: string;
};
type PageInfo = {
  page: number;
  source: "text" | "ocr";
  text: string;
  confidence?: number;
  ocrEngine?: OcrEngine;
  ocrMs?: number;
  tokens: Token[];
};
type DatabaseSnapshot = {
  byteLength: number;
  postingCount: number;
  terms: Array<{ term: string; df: number }>;
  postings: Array<{ term: string; chunkId: number; tf: number }>;
};

const emptyDatabaseSnapshot: DatabaseSnapshot = {
  byteLength: 0,
  postingCount: 0,
  terms: [],
  postings: [],
};

const phaseMeta = {
  detect: { label: "PDF 판별", icon: FileSearch },
  ocr: { label: "OCR", icon: ScanText },
  kiwi: { label: "Kiwi 분석", icon: Languages },
  chunk: { label: "청킹", icon: Scissors },
  sqlite: { label: "SQLite 색인", icon: DatabaseIcon },
} satisfies Record<PhaseId, { label: string; icon: typeof FileSearch }>;

const initialPhases = (): Phase[] =>
  (Object.keys(phaseMeta) as PhaseId[]).map((id) => ({
    id,
    label: phaseMeta[id].label,
    status: "idle",
    ms: null,
    detail: "대기",
  }));

function elapsed(start: number) {
  return Math.round((performance.now() - start) * 10) / 10;
}

function formatMs(ms: number | null) {
  if (ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}초` : `${Math.round(ms)}ms`;
}

type OcrAttempt = { text: string; confidence: number };

const DATABASE_PAGE_SIZE = {
  chunks: 20,
  terms: 50,
  postings: 50,
} as const;

function paddleResultToAttempt(
  result: Awaited<ReturnType<Awaited<ReturnType<(typeof import("@paddleocr/paddleocr-js"))["PaddleOCR"]["create"]>>["predict"]>>[number],
) {
  const items = result.items
    .filter((item) => item.text.trim())
    .sort((a, b) => {
      const ay = Math.min(...a.poly.map((point) => point[1]));
      const by = Math.min(...b.poly.map((point) => point[1]));
      const ax = Math.min(...a.poly.map((point) => point[0]));
      const bx = Math.min(...b.poly.map((point) => point[0]));
      return Math.abs(ay - by) < 12 ? ax - bx : ay - by;
    });
  return {
    text: items.map((item) => item.text.trim()).join("\n"),
    confidence: items.length
      ? (items.reduce((sum, item) => sum + item.score, 0) / items.length) * 100
      : 0,
  };
}

function readDatabaseSnapshot(db: Database): DatabaseSnapshot {
  const count = db.exec("SELECT COUNT(*) FROM postings");
  const termRows = db.exec("SELECT term, df FROM terms ORDER BY df DESC, term");
  const postingRows = db.exec("SELECT term, chunk_id, tf FROM postings ORDER BY term, chunk_id");
  return {
    byteLength: db.export().byteLength,
    postingCount: Number(count[0]?.values[0]?.[0] ?? 0),
    terms: (termRows[0]?.values ?? []).map(([term, df]) => ({ term: String(term), df: Number(df) })),
    postings: (postingRows[0]?.values ?? []).map(([term, chunkId, tf]) => ({
      term: String(term),
      chunkId: Number(chunkId),
      tf: Number(tf),
    })),
  };
}

export default function Home() {
  const [phases, setPhases] = useState(initialPhases);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [chunks, setChunks] = useState<IndexedChunk[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [queryTokens, setQueryTokens] = useState<Token[]>([]);
  const [matchedTerms, setMatchedTerms] = useState<string[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [query, setQuery] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [termCount, setTermCount] = useState(0);
  const [forceOcr, setForceOcr] = useState(false);
  const [ocrEngine, setOcrEngine] = useState<OcrEngine>("paddle");
  const [databaseSnapshot, setDatabaseSnapshot] = useState<DatabaseSnapshot>(emptyDatabaseSnapshot);
  const [databaseFilter, setDatabaseFilter] = useState("");
  const [chunkPage, setChunkPage] = useState(1);
  const [termPage, setTermPage] = useState(1);
  const [postingPage, setPostingPage] = useState(1);
  const dbRef = useRef<Database | null>(null);

  const totalMs = useMemo(
    () => phases.reduce((sum, phase) => sum + (phase.ms ?? 0), 0),
    [phases],
  );

  function updatePhase(id: PhaseId, patch: Partial<Phase>) {
    setPhases((current) => current.map((phase) => (phase.id === id ? { ...phase, ...patch } : phase)));
  }

  async function processPdf(file: File) {
    setBusy(true);
    setError("");
    setFileName(file.name);
    setPages([]);
    setChunks([]);
    setResults([]);
    setQueryTokens([]);
    setMatchedTerms([]);
    setHasSearched(false);
    setDatabaseSnapshot(emptyDatabaseSnapshot);
    setDatabaseFilter("");
    setChunkPage(1);
    setTermPage(1);
    setPostingPage(1);
    setPhases(initialPhases());
    setProgress(2);

    let ocrWorker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null = null;
    let paddleOcr: Awaited<ReturnType<(typeof import("@paddleocr/paddleocr-js"))["PaddleOCR"]["create"]>> | null = null;
    try {
      updatePhase("detect", { status: "running", detail: "페이지와 텍스트 레이어 확인 중" });
      const detectStart = performance.now();
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
      const data = await file.arrayBuffer();
      const pdf = await pdfjs.getDocument({
        data,
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/",
      }).promise;
      const extracted: Array<{
        page: number;
        source: "text" | "ocr";
        text: string;
        confidence?: number;
        ocrEngine?: OcrEngine;
        ocrMs?: number;
      }> = [];
      const needsOcr: number[] = [];

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
          .join("")
          .trim();
        if (!forceOcr && text.replace(/\s/g, "").length >= 40) {
          extracted.push({ page: pageNumber, source: "text", text });
        } else {
          needsOcr.push(pageNumber);
        }
        page.cleanup();
        setProgress(4 + (pageNumber / pdf.numPages) * 12);
      }
      updatePhase("detect", {
        status: "done",
        ms: elapsed(detectStart),
        detail: `${pdf.numPages}쪽 · 텍스트 ${extracted.length} · 이미지 ${needsOcr.length}`,
      });

      if (needsOcr.length) {
        const engineLabel = ocrEngine === "paddle" ? "PaddleOCR 한국어" : "Tesseract 한국어";
        updatePhase("ocr", { status: "running", detail: `${engineLabel} 초기화` });
        const ocrStart = performance.now();
        let modelInitMs = 0;
        const modelStart = performance.now();
        if (ocrEngine === "paddle") {
          const { PaddleOCR } = await import("@paddleocr/paddleocr-js");
          const wasmPaths = await getPaddleOrtWasmPaths();
          paddleOcr = await PaddleOCR.create({
            // Vinext currently rebundles the SDK worker in a way that can make
            // OpenCV reference `window` inside WorkerGlobalScope. Main-thread
            // mode still runs fully in the browser and avoids that incompatibility.
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
          ocrWorker = await tesseract.createWorker(["kor", "eng"], tesseract.OEM.LSTM_ONLY, {
            workerPath: "/vendor/tesseract/worker.min.js",
            corePath: "/vendor/tesseract",
            langPath: "/vendor/tessdata",
            gzip: true,
            logger: (message) => {
              if (message.status === "recognizing text") {
                setProgress(16 + message.progress * (34 / Math.max(1, needsOcr.length)));
              }
            },
          });
          await ocrWorker.setParameters({
            tessedit_pageseg_mode: tesseract.PSM.AUTO,
          });
        }
        modelInitMs = elapsed(modelStart);
        let inferenceMs = 0;

        for (let index = 0; index < needsOcr.length; index += 1) {
          const pageNumber = needsOcr[index];
          const page = await pdf.getPage(pageNumber);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(3.7, 3000 / Math.max(baseViewport.width, baseViewport.height));
          const viewport = page.getViewport({ scale: Math.max(2.1, scale) });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("PDF 페이지를 그릴 수 없습니다.");
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" }).promise;
          const pageOcrStart = performance.now();
          let recognizedPage: OcrAttempt;
          if (ocrEngine === "paddle") {
            const [recognized] = await paddleOcr!.predict(canvas, {
              textDetLimitSideLen: 960,
              textDetLimitType: "max",
              textDetMaxSideLimit: 3000,
              textDetBoxThresh: 0.45,
              textRecScoreThresh: 0.25,
            });
            recognizedPage = paddleResultToAttempt(recognized);
          } else {
            const recognized = await ocrWorker!.recognize(canvas);
            recognizedPage = {
              text: recognized.data.text,
              confidence: recognized.data.confidence,
            };
          }
          const pageOcrMs = elapsed(pageOcrStart);
          inferenceMs += pageOcrMs;
          extracted.push({
            page: pageNumber,
            source: "ocr",
            text: recognizedPage.text,
            confidence: recognizedPage.confidence,
            ocrEngine,
            ocrMs: pageOcrMs,
          });
          canvas.width = 0;
          canvas.height = 0;
          page.cleanup();
          updatePhase("ocr", {
            status: "running",
            detail: `${index + 1}/${needsOcr.length}쪽 인식`,
          });
          setProgress(16 + ((index + 1) / needsOcr.length) * 34);
        }
        updatePhase("ocr", {
          status: "done",
          ms: elapsed(ocrStart),
          detail: `${engineLabel} · 초기화 ${formatMs(modelInitMs)} · 인식 ${formatMs(inferenceMs)} · 단일 인식`,
        });
      } else {
        updatePhase("ocr", { status: "skipped", ms: 0, detail: "OCR 필요한 페이지 없음" });
      }

      const orderedPages = extracted.sort((a, b) => a.page - b.page);
      updatePhase("kiwi", { status: "running", detail: "WASM 모델 로딩 중 · 약 90MB" });
      const kiwiStart = performance.now();
      await callKiwi("init");
      const analyzedPages: PageInfo[] = [];
      for (let index = 0; index < orderedPages.length; index += 1) {
        const page = orderedPages[index];
        const tokens = page.text ? await callKiwi("tokenize", page.text) : [];
        analyzedPages.push({ ...page, tokens });
        updatePhase("kiwi", { status: "running", detail: `${index + 1}/${orderedPages.length}쪽 분석` });
        setProgress(50 + ((index + 1) / orderedPages.length) * 18);
      }
      setPages(analyzedPages);
      updatePhase("kiwi", {
        status: "done",
        ms: elapsed(kiwiStart),
        detail: `${analyzedPages.reduce((sum, page) => sum + page.tokens.length, 0).toLocaleString()}개 형태소`,
      });

      updatePhase("chunk", { status: "running", detail: "문장 경계 기준 분할" });
      const chunkStart = performance.now();
      const chunkDrafts = analyzedPages.flatMap((page) =>
        chunkText(page.text).map((chunk) => ({
          page: page.page,
          source: page.source,
          text: chunk.text,
        })),
      );
      updatePhase("chunk", {
        status: "done",
        ms: elapsed(chunkStart),
        detail: `${chunkDrafts.length}개 · 최대 700자 · 100자 겹침`,
      });
      setProgress(72);

      updatePhase("sqlite", { status: "running", detail: "청크 토큰화와 역색인 생성" });
      const sqliteStart = performance.now();
      const indexed: IndexedChunk[] = [];
      for (let index = 0; index < chunkDrafts.length; index += 1) {
        const draft = chunkDrafts[index];
        const tokens = await callKiwi("tokenize", draft.text);
        indexed.push({ id: index + 1, ...draft, tokens: searchTerms(tokens) });
        setProgress(72 + ((index + 1) / Math.max(1, chunkDrafts.length)) * 22);
      }
      const initSqlJs = (await import("sql.js")).default;
      const SQL = await initSqlJs({ locateFile: () => "/vendor/sql-wasm.wasm" });
      dbRef.current?.close();
      const db = new SQL.Database();
      indexChunks(db, indexed);
      dbRef.current = db;
      const countResult = db.exec("SELECT COUNT(*) AS count FROM terms");
      const terms = Number(countResult[0]?.values[0]?.[0] ?? 0);
      setTermCount(terms);
      setChunks(indexed);
      setDatabaseSnapshot(readDatabaseSnapshot(db));
      updatePhase("sqlite", {
        status: "done",
        ms: elapsed(sqliteStart),
        detail: `${indexed.length}개 청크 · ${terms.toLocaleString()}개 고유어`,
      });
      setProgress(100);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setPhases((current) =>
        current.map((phase) =>
          phase.status === "running" ? { ...phase, status: "error", detail: "처리 실패" } : phase,
        ),
      );
    } finally {
      await ocrWorker?.terminate();
      await paddleOcr?.dispose();
      setBusy(false);
    }
  }

  async function runSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim() || !dbRef.current || !chunks.length) return;
    setSearching(true);
    setError("");
    try {
      const tokens = await callKiwi("tokenize", query);
      const terms = searchTerms(tokens);
      const indexedTerms = new Set(chunks.flatMap((chunk) => chunk.tokens));
      setQueryTokens(tokens);
      setMatchedTerms([...new Set(terms)].filter((term) => indexedTerms.has(term)));
      setResults(searchBm25(dbRef.current, terms, chunks).slice(0, 12));
      setHasSearched(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSearching(false);
    }
  }

  function reset() {
    dbRef.current?.close();
    dbRef.current = null;
    setPages([]);
    setChunks([]);
    setResults([]);
    setQueryTokens([]);
    setMatchedTerms([]);
    setHasSearched(false);
    setQuery("");
    setFileName("");
    setTermCount(0);
    setDatabaseSnapshot(emptyDatabaseSnapshot);
    setDatabaseFilter("");
    setChunkPage(1);
    setTermPage(1);
    setPostingPage(1);
    setProgress(0);
    setError("");
    setPhases(initialPhases());
  }

  const searchableQueryTokens = searchTerms(queryTokens);
  const normalizedDatabaseFilter = databaseFilter.trim().toLocaleLowerCase("ko-KR");
  const filteredChunks = chunks.filter((chunk) =>
      !normalizedDatabaseFilter
      || String(chunk.id) === normalizedDatabaseFilter
      || String(chunk.page) === normalizedDatabaseFilter
      || chunk.text.toLocaleLowerCase("ko-KR").includes(normalizedDatabaseFilter),
    );
  const filteredTerms = databaseSnapshot.terms.filter(
    (row) => !normalizedDatabaseFilter || row.term.includes(normalizedDatabaseFilter),
  );
  const filteredPostings = databaseSnapshot.postings.filter((row) =>
      !normalizedDatabaseFilter
      || row.term.includes(normalizedDatabaseFilter)
      || String(row.chunkId) === normalizedDatabaseFilter,
    );
  const chunkPageCount = Math.max(1, Math.ceil(filteredChunks.length / DATABASE_PAGE_SIZE.chunks));
  const termPageCount = Math.max(1, Math.ceil(filteredTerms.length / DATABASE_PAGE_SIZE.terms));
  const postingPageCount = Math.max(1, Math.ceil(filteredPostings.length / DATABASE_PAGE_SIZE.postings));
  const currentChunkPage = Math.min(chunkPage, chunkPageCount);
  const currentTermPage = Math.min(termPage, termPageCount);
  const currentPostingPage = Math.min(postingPage, postingPageCount);
  const visibleChunks = filteredChunks.slice(
    (currentChunkPage - 1) * DATABASE_PAGE_SIZE.chunks,
    currentChunkPage * DATABASE_PAGE_SIZE.chunks,
  );
  const visibleTerms = filteredTerms.slice(
    (currentTermPage - 1) * DATABASE_PAGE_SIZE.terms,
    currentTermPage * DATABASE_PAGE_SIZE.terms,
  );
  const visiblePostings = filteredPostings.slice(
    (currentPostingPage - 1) * DATABASE_PAGE_SIZE.postings,
    currentPostingPage * DATABASE_PAGE_SIZE.postings,
  );

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="border-b border-[var(--line)] bg-[var(--surface)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1480px] items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-[var(--ink)] text-white">
              <Gauge className="size-5" />
            </div>
            <div>
              <h1 className="text-[17px] font-bold tracking-[-0.02em]">BM25 Browser Lab</h1>
              <p className="text-xs text-[var(--muted-text)]">문서 검색 점수 해부실</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">
            <LockKeyhole className="size-3.5" />
            외부 전송 없음
          </div>
        </div>
      </header>

      <Tabs defaultValue="search-lab">
        <div className="border-b border-[var(--line)] bg-[var(--surface)]">
          <div className="mx-auto max-w-[1480px] px-5 py-3 lg:px-8">
            <TabsList aria-label="실험 화면 선택">
              <TabsTrigger value="search-lab">BM25 검색 실험</TabsTrigger>
              <TabsTrigger value="ocr-comparison">OCR 엔진 비교</TabsTrigger>
              <TabsTrigger value="selectable-pdf"><MousePointer2 /> 텍스트 선택 PDF</TabsTrigger>
              <TabsTrigger value="webllm-chat"><Sparkles /> WebLLM 채팅</TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="search-lab" className="mt-0">
          <div className="mx-auto max-w-[1480px] px-5 py-6 lg:px-8 lg:py-8">
        <section className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <p className="eyebrow">01 · SOURCE</p>
            <h2 className="mt-2 text-xl font-bold tracking-tight">PDF 넣기</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">
              텍스트 레이어를 먼저 검사하고, 이미지 페이지만 한국어·영어 OCR을 실행합니다.
            </p>

            <fieldset className="mt-5">
              <legend className="text-xs font-bold text-[var(--muted-text)]">OCR 엔진</legend>
              <RadioGroup
                value={ocrEngine}
                onValueChange={(value) => setOcrEngine(value as OcrEngine)}
                disabled={busy}
                className="mt-2 grid grid-cols-2 gap-2"
              >
                <label className={`ocr-engine-card ${ocrEngine === "paddle" ? "ocr-engine-active" : ""}`}>
                  <RadioGroupItem value="paddle" />
                  <span><strong>PaddleOCR</strong><small>한국어 v5 · ONNX</small></span>
                </label>
                <label className={`ocr-engine-card ${ocrEngine === "tesseract" ? "ocr-engine-active" : ""}`}>
                  <RadioGroupItem value="tesseract" />
                  <span><strong>Tesseract</strong><small>기존 기준선</small></span>
                </label>
              </RadioGroup>
              <p className="mt-2 text-[11px] leading-4 text-[var(--muted-text)]">
                Paddle 모델과 ONNX 런타임도 이 앱에서 불러옵니다. 문서 이미지는 전송하지 않습니다.
              </p>
            </fieldset>

            <label className="mt-4 flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-5 text-center transition hover:border-[var(--accent-strong)] hover:bg-[#eef3ff]">
              {busy ? <LoaderCircle className="size-8 animate-spin text-[var(--accent-strong)]" /> : <Upload className="size-8 text-[var(--accent-strong)]" />}
              <span className="mt-3 text-sm font-bold">{busy ? "브라우저에서 처리 중" : "PDF 선택 또는 끌어놓기"}</span>
              <span className="mt-1 max-w-64 truncate text-xs text-[var(--muted-text)]">
                {fileName || "파일은 이 기기를 벗어나지 않습니다"}
              </span>
              <input
                className="sr-only"
                type="file"
                accept="application/pdf,.pdf"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void processPdf(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>

            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--line)] p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--accent-strong)]"
                checked={forceOcr}
                disabled={busy}
                onChange={(event) => setForceOcr(event.target.checked)}
              />
              <span>
                <strong className="block font-semibold">모든 페이지 OCR</strong>
                <span className="text-xs text-[var(--muted-text)]">
                  {ocrEngine === "paddle" ? "PaddleOCR로 텍스트 페이지도 다시 인식" : "원본 Canvas·PSM.AUTO·페이지당 1회 인식"}
                </span>
              </span>
            </label>

            {(fileName || error) && (
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className={`text-xs ${error ? "text-red-600" : "text-[var(--muted-text)]"}`}>
                  {error || `${pages.length}쪽 처리됨`}
                </span>
                <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
                  <RotateCcw /> 초기화
                </Button>
              </div>
            )}
          </aside>

          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="eyebrow">02 · PIPELINE</p>
                <h2 className="mt-2 text-xl font-bold tracking-tight">브라우저 처리 흐름</h2>
              </div>
              <div className="flex items-center gap-2 text-sm text-[var(--muted-text)]">
                <Clock3 className="size-4" />
                총 {formatMs(totalMs)}
              </div>
            </div>

            <div className="mt-5 grid gap-2 md:grid-cols-5">
              {phases.map((phase, index) => {
                const Icon = phaseMeta[phase.id].icon;
                return (
                  <div key={phase.id} className={`phase-card phase-${phase.status}`}>
                    <div className="flex items-center justify-between">
                      <span className="phase-icon">
                        {phase.status === "running" ? <LoaderCircle className="animate-spin" /> : phase.status === "done" ? <Check /> : <Icon />}
                      </span>
                      <span className="text-[11px] font-bold text-[var(--muted-text)]">0{index + 1}</span>
                    </div>
                    <strong className="mt-4 block text-sm">{phase.label}</strong>
                    <span className="mt-1 block text-xs font-semibold text-[var(--accent-strong)]">{formatMs(phase.ms)}</span>
                    <span className="mt-2 block min-h-8 text-[11px] leading-4 text-[var(--muted-text)]">{phase.detail}</span>
                  </div>
                );
              })}
            </div>
            <Progress value={progress} className="mt-5 h-1.5 bg-slate-100 [&_[data-slot=progress-indicator]]:bg-[var(--accent-strong)]" />

            <div className="mt-5 grid gap-3 sm:grid-cols-4">
              <Metric label="페이지" value={pages.length || "—"} />
              <Metric label="OCR 페이지" value={pages.filter((page) => page.source === "ocr").length || "—"} />
              <Metric label="청크" value={chunks.length || "—"} />
              <Metric label="고유 검색어" value={termCount ? termCount.toLocaleString() : "—"} />
            </div>
          </section>
        </section>

        <section className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--ink)] p-5 text-white shadow-[var(--shadow)] lg:p-6">
          <div className="grid items-end gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(420px,1.5fr)]">
            <div>
              <p className="eyebrow !text-blue-300">03 · QUERY</p>
              <h2 className="mt-2 text-xl font-bold tracking-tight">어떤 청크가 답이 될 가능성이 높은가?</h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                확률이나 의미 임베딩이 아닙니다. 질문과 청크의 형태소가 얼마나 중요하게 겹치는지 계산합니다.
              </p>
            </div>
            <form onSubmit={runSearch} className="flex gap-2">
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHasSearched(false);
                  setResults([]);
                  setQueryTokens([]);
                  setMatchedTerms([]);
                }}
                disabled={!chunks.length || busy}
                placeholder={chunks.length ? "문서에 나온 핵심어를 포함해 질문하세요" : "먼저 PDF를 처리하세요"}
                className="h-12 border-slate-700 bg-slate-900 px-4 text-base text-white placeholder:text-slate-500"
              />
              <Button type="submit" size="lg" disabled={!chunks.length || !query.trim() || searching} className="h-12 bg-blue-500 px-5 hover:bg-blue-400">
                {searching ? <LoaderCircle className="animate-spin" /> : <Search />}
                분석
              </Button>
            </form>
          </div>
          {queryTokens.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-700 pt-4">
              <span className="mr-1 text-xs font-semibold text-slate-400">질문 형태소</span>
              {queryTokens.map((token, index) => {
                const normalized = token.str.toLocaleLowerCase("ko-KR");
                const searchable = searchableQueryTokens.includes(normalized);
                const matched = matchedTerms.includes(normalized);
                return (
                  <span key={`${token.position}-${index}`} className={`token ${matched ? "token-active" : searchable ? "token-miss" : "token-muted"}`}>
                    {token.str}<small>{token.tag}</small>
                  </span>
                );
              })}
              <span className="ml-auto text-xs text-slate-400">
                색인 일치 {matchedTerms.length}/{new Set(searchableQueryTokens).size}
              </span>
            </div>
          )}
        </section>

        <section className="mt-5 grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="eyebrow">04 · RANKING</p>
                <h2 className="mt-2 text-xl font-bold tracking-tight">답변 후보 청크</h2>
              </div>
              {results.length > 0 && <span className="text-xs text-[var(--muted-text)]">최고점을 100으로 환산 · 확률 아님</span>}
            </div>

            {!results.length ? (
              <div className="empty-state">
                {hasSearched ? <SearchX className="size-7 text-amber-600" /> : <Search className="size-7" />}
                <p>
                  {hasSearched
                    ? "질문 형태소와 문서 색인이 일치하지 않습니다."
                    : chunks.length
                      ? "질문을 입력하면 계산 근거가 여기에 나옵니다."
                      : "PDF 처리 후 질문을 입력하세요."}
                </p>
                {hasSearched && (
                  <span className="max-w-xl text-xs leading-5">
                    BM25는 의미를 추측하지 않고 같은 형태소를 찾습니다. 문서에 실제 등장하는 표현으로 질문하거나 페이지 판별 결과의 추출 텍스트를 확인하세요.
                  </span>
                )}
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {results.map((result, index) => (
                  <article key={result.chunk.id} className="result-card">
                    <div className="flex items-start gap-4">
                      <div className="rank">{index + 1}</div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--muted-text)]">
                            <FileText className="size-3.5" />
                            {fileName} · {result.chunk.page}쪽 · 청크 #{result.chunk.id}
                          </div>
                          <div className="flex items-baseline gap-2">
                            <strong className="text-lg tabular-nums text-[var(--accent-strong)]">{result.relative.toFixed(1)}</strong>
                            <span className="text-xs text-[var(--muted-text)]">BM25 {result.score.toFixed(4)}</span>
                          </div>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-[var(--accent-strong)]" style={{ width: `${result.relative}%` }} />
                        </div>
                        <p className="mt-4 line-clamp-4 text-[15px] leading-7 text-slate-700">
                          {highlight(result.chunk.text, searchableQueryTokens).map((part, partIndex) =>
                            part.match ? <mark key={partIndex}>{part.text}</mark> : <span key={partIndex}>{part.text}</span>,
                          )}
                        </p>
                        <details className="score-details">
                          <summary>점수 계산 펼치기</summary>
                          <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[560px] text-left text-xs">
                              <thead><tr><th>형태소</th><th>청크 빈도 TF</th><th>포함 청크 DF</th><th>IDF</th><th>길이 보정 분모</th><th>기여 점수</th></tr></thead>
                              <tbody>
                                {result.contributions.map((item) => (
                                  <tr key={item.term}>
                                    <td className="font-bold text-[var(--accent-strong)]">{item.term}</td>
                                    <td>{item.tf}</td><td>{item.df}</td><td>{item.idf.toFixed(4)}</td><td>{item.lengthNorm.toFixed(4)}</td><td>{item.score.toFixed(4)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="mt-3 font-mono text-[11px] text-[var(--muted-text)]">
                            IDF × (TF × (k1 + 1)) ÷ (TF + k1 × (1 − b + b × 문서길이 ÷ 평균길이)), k1=1.2, b=0.75
                          </p>
                        </details>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <aside className="space-y-5">
            <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
              <div className="flex items-center gap-2">
                <Cpu className="size-4 text-[var(--accent-strong)]" />
                <h3 className="font-bold">무엇을 측정하나</h3>
              </div>
              <dl className="mt-4 space-y-3 text-sm">
                <InfoRow term="PDF 판별" description="텍스트 레이어 읽기" />
                <InfoRow term="OCR" description="이미지→문자, 보통 최대 병목" />
                <InfoRow term="Kiwi" description="WASM 초기화+형태소 분석" />
                <InfoRow term="SQLite" description="역색인 작성+조회 준비" />
              </dl>
            </section>

            <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
              <h3 className="font-bold">페이지 판별 결과</h3>
              {!pages.length ? (
                <p className="mt-3 text-sm text-[var(--muted-text)]">아직 문서가 없습니다.</p>
              ) : (
                <div className="mt-3 max-h-80 space-y-2 overflow-auto pr-1">
                  {pages.map((page) => (
                    <details key={page.page} className="page-row">
                      <summary>
                        <span>{page.page}쪽</span>
                        <span className={`source-badge source-${page.source}`}>
                          {page.source === "ocr"
                            ? `${page.ocrEngine === "paddle" ? "PADDLE" : "TESS"} ${Math.round(page.confidence ?? 0)}%`
                            : "TEXT"}
                        </span>
                      </summary>
                      <p>
                        {page.ocrMs != null && <small className="mb-2 block font-semibold text-[var(--accent-strong)]">인식 {formatMs(page.ocrMs)}</small>}
                        {page.text || "추출된 텍스트 없음"}
                      </p>
                    </details>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </section>

        <section className="mt-5 rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="eyebrow">05 · SQLITE INSPECTOR</p>
              <div className="mt-2 flex items-center gap-2">
                <TableProperties className="size-5 text-[var(--accent-strong)]" />
                <h2 className="text-xl font-bold tracking-tight">메모리 DB 안쪽 보기</h2>
              </div>
              <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">
                원문 청크는 한 번 저장하고, 검색어가 등장한 위치만 postings에 연결합니다.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="db-pill">WASM 메모리 · 새로고침 시 삭제</span>
              <span className="db-pill">SQLite {(databaseSnapshot.byteLength / 1024).toFixed(1)} KB</span>
            </div>
          </div>

          <div className="sparse-flow" aria-label="SQLite sparse 역색인 구조">
            <div><strong>chunks</strong><span>청크 #{chunks[0]?.id ?? "—"}의 원문</span></div>
            <span className="sparse-arrow">→ 형태소 추출 →</span>
            <div><strong>terms</strong><span>검색어와 DF</span></div>
            <span className="sparse-arrow">→ 필요한 연결만 →</span>
            <div><strong>postings</strong><span>term · chunk_id · TF</span></div>
          </div>

          {!chunks.length ? (
            <div className="empty-state !min-h-44">
              <DatabaseIcon className="size-7" />
              <p>PDF를 처리하면 SQLite 세 테이블의 실제 값이 나타납니다.</p>
            </div>
          ) : (
            <Tabs defaultValue="chunks" className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <TabsList aria-label="SQLite 테이블 선택">
                  <TabsTrigger value="chunks">chunks · {chunks.length}</TabsTrigger>
                  <TabsTrigger value="terms">terms · {termCount.toLocaleString()}</TabsTrigger>
                  <TabsTrigger value="postings">postings · {databaseSnapshot.postingCount.toLocaleString()}</TabsTrigger>
                </TabsList>
                <Input
                  value={databaseFilter}
                  onChange={(event) => {
                    setDatabaseFilter(event.target.value);
                    setChunkPage(1);
                    setTermPage(1);
                    setPostingPage(1);
                  }}
                  placeholder="형태소, 청크 번호, 원문 찾기"
                  aria-label="SQLite 데이터 필터"
                  className="h-9 w-full sm:w-72"
                />
              </div>

              <TabsContent value="chunks" className="mt-4">
                <p className="db-help">한 행이 한 청크입니다. 앞 청크의 끝 100자가 다음 청크에 겹칩니다.</p>
                <div className="db-table-frame">
                  <Table>
                    <TableHeader><TableRow><TableHead>ID</TableHead><TableHead>페이지</TableHead><TableHead>출처</TableHead><TableHead>토큰</TableHead><TableHead>content</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {visibleChunks.map((chunk) => (
                        <TableRow key={chunk.id}>
                          <TableCell className="font-mono font-bold">#{chunk.id}</TableCell>
                          <TableCell>{chunk.page}쪽</TableCell>
                          <TableCell>{chunk.source.toUpperCase()}</TableCell>
                          <TableCell>{chunk.tokens.length}</TableCell>
                          <TableCell className="min-w-[480px] whitespace-normal">
                            <details className="db-content"><summary>{chunk.text.slice(0, 150)}{chunk.text.length > 150 ? "…" : ""}</summary><p>{chunk.text}</p></details>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <TablePagination
                  page={currentChunkPage}
                  pageCount={chunkPageCount}
                  total={filteredChunks.length}
                  pageSize={DATABASE_PAGE_SIZE.chunks}
                  onPageChange={setChunkPage}
                />
              </TabsContent>

              <TabsContent value="terms" className="mt-4">
                <p className="db-help">DF는 이 형태소를 포함한 청크 수입니다. 많은 청크에 흔한 말일수록 IDF가 낮아집니다.</p>
                <div className="db-table-frame">
                  <Table>
                    <TableHeader><TableRow><TableHead>term</TableHead><TableHead>DF</TableHead><TableHead>희소도</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {visibleTerms.map((row) => (
                        <TableRow key={row.term}>
                          <TableCell className="font-bold text-[var(--accent-strong)]">{row.term}</TableCell>
                          <TableCell>{row.df}</TableCell>
                          <TableCell className="min-w-52"><div className="sparsity-track"><span style={{ width: `${Math.max(2, (row.df / chunks.length) * 100)}%` }} /></div><small>{row.df}/{chunks.length} 청크</small></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <TablePagination
                  page={currentTermPage}
                  pageCount={termPageCount}
                  total={filteredTerms.length}
                  pageSize={DATABASE_PAGE_SIZE.terms}
                  onPageChange={setTermPage}
                />
              </TabsContent>

              <TabsContent value="postings" className="mt-4">
                <p className="db-help">0을 전부 저장하지 않습니다. 형태소가 실제 등장한 청크 연결만 한 행으로 저장하는 sparse 구조입니다.</p>
                <div className="db-table-frame">
                  <Table>
                    <TableHeader><TableRow><TableHead>term</TableHead><TableHead>chunk_id</TableHead><TableHead>TF</TableHead><TableHead>뜻</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {visiblePostings.map((row) => (
                        <TableRow key={`${row.term}-${row.chunkId}`}>
                          <TableCell className="font-bold text-[var(--accent-strong)]">{row.term}</TableCell>
                          <TableCell className="font-mono">#{row.chunkId}</TableCell>
                          <TableCell>{row.tf}</TableCell>
                          <TableCell className="whitespace-normal text-[var(--muted-text)]">청크 #{row.chunkId}에 “{row.term}”이 {row.tf}번 등장</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <TablePagination
                  page={currentPostingPage}
                  pageCount={postingPageCount}
                  total={filteredPostings.length}
                  pageSize={DATABASE_PAGE_SIZE.postings}
                  onPageChange={setPostingPage}
                />
              </TabsContent>
            </Tabs>
          )}
        </section>
          </div>
        </TabsContent>
        <TabsContent value="ocr-comparison" className="mt-0">
          <OcrComparison />
        </TabsContent>
        <TabsContent value="selectable-pdf" className="mt-0">
          <SelectablePdfViewer />
        </TabsContent>
        <TabsContent value="webllm-chat" className="mt-0">
          <WebLLMChat />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function TablePagination({
  page,
  pageCount,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const firstItem = total ? (page - 1) * pageSize + 1 : 0;
  const lastItem = Math.min(page * pageSize, total);

  return (
    <nav className="mt-3 flex flex-wrap items-center justify-between gap-3" aria-label="테이블 페이지 탐색">
      <span className="text-xs tabular-nums text-[var(--muted-text)]">
        {firstItem.toLocaleString()}–{lastItem.toLocaleString()} / {total.toLocaleString()}행
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={page === 1} onClick={() => onPageChange(1)}>
          처음
        </Button>
        <Button variant="outline" size="sm" disabled={page === 1} onClick={() => onPageChange(page - 1)}>
          이전
        </Button>
        <span className="min-w-24 px-2 text-center text-xs font-semibold tabular-nums">
          {page.toLocaleString()} / {pageCount.toLocaleString()}
        </span>
        <Button variant="outline" size="sm" disabled={page === pageCount} onClick={() => onPageChange(page + 1)}>
          다음
        </Button>
        <Button variant="outline" size="sm" disabled={page === pageCount} onClick={() => onPageChange(pageCount)}>
          마지막
        </Button>
      </div>
    </nav>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] px-4 py-3">
      <span className="block text-xs text-[var(--muted-text)]">{label}</span>
      <strong className="mt-1 block text-lg tabular-nums">{value}</strong>
    </div>
  );
}

function InfoRow({ term, description }: { term: string; description: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] pb-3 last:border-0 last:pb-0">
      <dt className="font-semibold">{term}</dt>
      <dd className="text-right text-xs leading-5 text-[var(--muted-text)]">{description}</dd>
    </div>
  );
}
