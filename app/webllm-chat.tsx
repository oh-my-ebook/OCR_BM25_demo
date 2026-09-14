"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MLCEngineInterface } from "@mlc-ai/web-llm";
import type { Database } from "sql.js";
import {
  Bot,
  CircleStop,
  Cpu,
  FileText,
  Gauge,
  LoaderCircle,
  MessageSquareText,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { chunkText, indexChunks, searchBm25, searchTerms, type IndexedChunk } from "@/lib/bm25";
import { callKiwi } from "@/lib/kiwi-client";
import { createWebLLMWorker } from "@/lib/worker-factory";

type RagSource = {
  id: number;
  page: number;
  score: number;
  preview: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources?: RagSource[];
};

type ModelOption = {
  id: string;
  vramMB: number;
  lowResource: boolean;
};

const RECOMMENDED_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

function formatMemory(megabytes: number) {
  if (!megabytes) return "용량 정보 없음";
  return megabytes >= 1024
    ? `약 ${(megabytes / 1024).toFixed(1)}GB VRAM`
    : `약 ${Math.round(megabytes)}MB VRAM`;
}

function displayName(modelId: string) {
  return modelId.replace(/-q4f16_1-MLC(?:-1k)?$/, "").replace(/-MLC$/, "");
}

export default function WebLLMChat() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [selectedModel, setSelectedModel] = useState(RECOMMENDED_MODEL);
  const [loadedModel, setLoadedModel] = useState("");
  const [modelStatus, setModelStatus] = useState("WebLLM 모델 목록 확인 중");
  const [loadProgress, setLoadProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runtimeStats, setRuntimeStats] = useState("");
  const [error, setError] = useState("");
  const [webGpuSupported, setWebGpuSupported] = useState<boolean | null>(null);
  const [documentName, setDocumentName] = useState("");
  const [documentStatus, setDocumentStatus] = useState(
    "PDF를 올리면 문서 기반 답변을 사용할 수 있습니다",
  );
  const [documentProgress, setDocumentProgress] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [documentPages, setDocumentPages] = useState(0);
  const [indexedChunks, setIndexedChunks] = useState<IndexedChunk[]>([]);
  const [termCount, setTermCount] = useState(0);
  const [databaseBytes, setDatabaseBytes] = useState(0);
  const [documentError, setDocumentError] = useState("");
  const engineRef = useRef<MLCEngineInterface | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const dbRef = useRef<Database | null>(null);

  useEffect(() => {
    let cancelled = false;

    void import("@mlc-ai/web-llm")
      .then(({ ModelType, prebuiltAppConfig }) => {
        if (cancelled) return;
        setWebGpuSupported("gpu" in navigator);
        const chatModels = prebuiltAppConfig.model_list
          .filter((model) => (model.model_type ?? ModelType.LLM) === ModelType.LLM)
          .filter((model) => model.model_id.includes("q4f16_1"))
          .filter((model) => !/(Coder|Math|Base)/i.test(model.model_id))
          .filter((model) => (model.vram_required_MB ?? 0) <= 12_000)
          .map((model) => ({
            id: model.model_id,
            vramMB: model.vram_required_MB ?? 0,
            lowResource: model.low_resource_required ?? false,
          }))
          .sort((left, right) => left.vramMB - right.vramMB || left.id.localeCompare(right.id));
        setModels(chatModels);
        if (!chatModels.some((model) => model.id === RECOMMENDED_MODEL) && chatModels[0]) {
          setSelectedModel(chatModels[0].id);
        }
        setModelStatus(`${chatModels.length}개 대화용 4비트 모델 사용 가능`);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setModelStatus("모델 목록을 불러오지 못했습니다");
        }
      });

    return () => {
      cancelled = true;
      const engine = engineRef.current;
      engineRef.current = null;
      if (engine) void engine.unload().catch(() => undefined);
      workerRef.current?.terminate();
      workerRef.current = null;
      dbRef.current?.close();
      dbRef.current = null;
    };
  }, []);

  const visibleModels = useMemo(() => {
    const normalized = modelFilter.trim().toLocaleLowerCase("ko-KR");
    if (!normalized) return models;
    return models.filter((model) => model.id.toLocaleLowerCase("ko-KR").includes(normalized));
  }, [modelFilter, models]);

  const selectedModelInfo = models.find((model) => model.id === selectedModel);

  async function processPdf(file: File) {
    if (indexing || generating || loading) return;

    setIndexing(true);
    setDocumentError("");
    setDocumentName(file.name);
    setDocumentPages(0);
    setIndexedChunks([]);
    setTermCount(0);
    setDatabaseBytes(0);
    setDocumentProgress(1);
    setDocumentStatus("PDF와 Tesseract 준비 중");
    setMessages([]);
    dbRef.current?.close();
    dbRef.current = null;

    let ocrWorker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null =
      null;
    let destroyPdf: (() => Promise<void>) | null = null;

    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
      const loadingTask = pdfjs.getDocument({
        data: await file.arrayBuffer(),
        cMapUrl: "/vendor/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
        wasmUrl: "/vendor/pdfjs/wasm/",
      });
      destroyPdf = () => loadingTask.destroy();
      const pdf = await loadingTask.promise;
      setDocumentPages(pdf.numPages);

      let currentPage = 0;
      const tesseract = await import("tesseract.js");
      ocrWorker = await tesseract.createWorker(["kor", "eng"], tesseract.OEM.LSTM_ONLY, {
        workerPath: "/vendor/tesseract/worker.min.js",
        corePath: "/vendor/tesseract",
        langPath: "/vendor/tessdata",
        gzip: true,
        logger: (message) => {
          if (message.status === "recognizing text") {
            setDocumentProgress(5 + ((currentPage + message.progress) / pdf.numPages) * 58);
          }
        },
      });
      await ocrWorker.setParameters({
        tessedit_pageseg_mode: tesseract.PSM.AUTO,
        preserve_interword_spaces: "1",
      });

      const pages: Array<{ page: number; text: string }> = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        currentPage = pageNumber - 1;
        setDocumentStatus(`Tesseract OCR · ${pageNumber}/${pdf.numPages}쪽`);
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
        await page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" })
          .promise;
        const recognized = await ocrWorker.recognize(canvas);
        pages.push({ page: pageNumber, text: recognized.data.text.trim() });
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }

      setDocumentStatus("문서를 청크로 나누고 Kiwi로 분석 중");
      setDocumentProgress(65);
      await callKiwi("init");
      const drafts = pages.flatMap((page) =>
        chunkText(page.text).map((chunk) => ({
          page: page.page,
          source: "ocr" as const,
          text: chunk.text,
        })),
      );
      if (!drafts.length) throw new Error("OCR로 인식된 텍스트가 없습니다.");

      const indexed: IndexedChunk[] = [];
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        const tokens = await callKiwi("tokenize", draft.text);
        indexed.push({ id: index + 1, ...draft, tokens: searchTerms(tokens) });
        setDocumentProgress(68 + ((index + 1) / drafts.length) * 25);
        setDocumentStatus(`BM25 색인 생성 · ${index + 1}/${drafts.length} 청크`);
      }

      const initSqlJs = (await import("sql.js")).default;
      const SQL = await initSqlJs({ locateFile: () => "/vendor/sql-wasm.wasm" });
      const db = new SQL.Database();
      indexChunks(db, indexed);
      const count = db.exec("SELECT COUNT(*) FROM terms");
      const uniqueTerms = Number(count[0]?.values[0]?.[0] ?? 0);
      dbRef.current = db;
      setIndexedChunks(indexed);
      setTermCount(uniqueTerms);
      setDatabaseBytes(db.export().byteLength);
      setDocumentProgress(100);
      setDocumentStatus(`${pdf.numPages}쪽 OCR 완료 · BM25 검색 준비 완료`);
    } catch (caught) {
      setDocumentError(caught instanceof Error ? caught.message : String(caught));
      setDocumentStatus("문서 처리 실패");
      setDocumentProgress(0);
    } finally {
      if (ocrWorker) await ocrWorker.terminate().catch(() => undefined);
      if (destroyPdf) await destroyPdf().catch(() => undefined);
      setIndexing(false);
    }
  }

  function clearDocument() {
    dbRef.current?.close();
    dbRef.current = null;
    setDocumentName("");
    setDocumentStatus("PDF를 올리면 문서 기반 답변을 사용할 수 있습니다");
    setDocumentProgress(0);
    setDocumentPages(0);
    setIndexedChunks([]);
    setTermCount(0);
    setDatabaseBytes(0);
    setDocumentError("");
    setMessages([]);
  }

  async function loadModel() {
    if (!selectedModel || loading || generating || indexing || webGpuSupported === false) return;
    setLoading(true);
    setError("");
    setRuntimeStats("");
    setLoadProgress(0);
    setModelStatus("모델 파일 준비 중");

    try {
      if (engineRef.current) {
        await engineRef.current.reload(selectedModel);
      } else {
        const webllm = await import("@mlc-ai/web-llm");
        const worker = createWebLLMWorker();
        workerRef.current = worker;
        engineRef.current = await webllm.CreateWebWorkerMLCEngine(worker, selectedModel, {
          initProgressCallback: (report) => {
            setLoadProgress(Math.round(report.progress * 100));
            setModelStatus(report.text);
          },
          logLevel: "WARN",
        });
      }
      setLoadedModel(selectedModel);
      setMessages([]);
      setLoadProgress(100);
      setModelStatus("모델 준비 완료 · 모든 추론은 이 브라우저에서 실행됩니다");
    } catch (caught) {
      setLoadedModel("");
      setError(caught instanceof Error ? caught.message : String(caught));
      setModelStatus("모델 로딩 실패");
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const question = input.trim();
    const engine = engineRef.current;
    if (!question || !engine || !loadedModel || generating || indexing) return;

    const history: ChatMessage[] = [...messages, { role: "user", content: question }];
    setInput("");
    setError("");
    setRuntimeStats("");
    setGenerating(true);

    try {
      let sources: RagSource[] = [];
      let documentContext = "";
      if (dbRef.current && indexedChunks.length) {
        const queryTokens = await callKiwi("tokenize", question);
        const results = searchBm25(dbRef.current, searchTerms(queryTokens), indexedChunks).slice(
          0,
          3,
        );
        sources = results.map((result) => ({
          id: result.chunk.id,
          page: result.chunk.page,
          score: result.score,
          preview: result.chunk.text.slice(0, 180),
        }));
        documentContext = results
          .map(
            (result) =>
              `[p.${result.chunk.page}, 청크 #${result.chunk.id}, BM25 ${result.score.toFixed(3)}]\n${result.chunk.text.slice(0, 600)}`,
          )
          .join("\n\n---\n\n");
      }

      setMessages([...history, { role: "assistant", content: "", sources }]);
      const recentHistory = history.slice(-3).map(({ role, content }) => ({
        role,
        content: content.slice(-600),
      }));
      const chunks = await engine.chat.completions.create({
        model: loadedModel,
        messages: [
          {
            role: "system",
            content: indexedChunks.length
              ? `당신은 사용자가 올린 PDF에 답하는 한국어 RAG 도우미입니다. 반드시 아래 '검색된 문서 발췌'만 사실 근거로 사용하세요. 발췌에 답이 없거나 관련 발췌가 비어 있으면 추측하지 말고 "문서에서 관련 근거를 찾지 못했습니다"라고 분명히 말하세요. 답변에 근거를 표시할 때 [p.페이지, 청크 #번호] 형식을 사용하세요. OCR 오류 가능성이 있으므로 불명확한 글자는 단정하지 마세요.\n\n검색된 문서 발췌:\n${documentContext || "(관련 발췌 없음)"}`
              : "당신은 친절하고 정확한 한국어 AI 도우미입니다. 사용자가 다른 언어를 요청하지 않는 한 한국어로 답하세요.",
          },
          ...recentHistory,
        ],
        stream: true,
        stream_options: { include_usage: true },
        temperature: indexedChunks.length ? 0.2 : 0.7,
        max_tokens: 2000,
      });

      let answer = "";
      for await (const chunk of chunks) {
        answer += chunk.choices[0]?.delta.content ?? "";
        setMessages([...history, { role: "assistant", content: answer, sources }]);
      }
      setRuntimeStats(await engine.runtimeStatsText(loadedModel));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setMessages((current) =>
        current.map((message, index) =>
          index === current.length - 1 && message.role === "assistant" && !message.content
            ? { ...message, content: "응답 생성이 중단되었거나 실패했습니다." }
            : message,
        ),
      );
    } finally {
      setGenerating(false);
    }
  }

  async function resetChat() {
    if (generating) engineRef.current?.interruptGenerate();
    await engineRef.current?.resetChat();
    setMessages([]);
    setRuntimeStats("");
    setError("");
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 lg:px-8 lg:py-8">
      <section className="grid gap-5 xl:grid-cols-[390px_minmax(0,1fr)]">
        <aside className="space-y-5">
          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <p className="eyebrow">01 · MODEL</p>
            <div className="mt-2 flex items-center gap-2">
              <Sparkles className="size-5 text-[var(--accent-strong)]" />
              <h2 className="text-xl font-bold tracking-tight">WebLLM 모델 선택</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">
              한국어 전용 사전 빌드 모델은 없어 다국어 성능과 메모리 균형이 좋은 Qwen2.5 1.5B를 기본
              추천합니다.
            </p>

            <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 p-3">
              <strong className="block text-sm text-blue-900">추천 · Qwen2.5 1.5B Instruct</strong>
              <span className="mt-1 block text-xs leading-5 text-blue-800">
                4비트 양자화 · 약 1.6GB VRAM · 한국어 채팅 입문용
              </span>
            </div>

            <label
              className="mt-5 block text-xs font-bold text-[var(--muted-text)]"
              htmlFor="model-filter"
            >
              모델 검색
            </label>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted-text)]" />
              <Input
                id="model-filter"
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                placeholder="Qwen, Llama, Gemma..."
                className="pl-9"
                disabled={loading || generating || indexing}
              />
            </div>

            <label
              className="mt-4 block text-xs font-bold text-[var(--muted-text)]"
              htmlFor="webllm-model"
            >
              대화용 4비트 모델 · {visibleModels.length}개
            </label>
            <NativeSelect
              id="webllm-model"
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              className="mt-2 w-full"
              disabled={!visibleModels.length || loading || generating || indexing}
            >
              {visibleModels.map((model) => (
                <NativeSelectOption key={model.id} value={model.id}>
                  {displayName(model.id)} · {formatMemory(model.vramMB)}
                </NativeSelectOption>
              ))}
            </NativeSelect>

            {selectedModelInfo && (
              <div className="mt-3 flex items-center justify-between text-xs text-[var(--muted-text)]">
                <span>{formatMemory(selectedModelInfo.vramMB)}</span>
                <span>{selectedModelInfo.lowResource ? "저사양 기기 고려" : "데스크톱 권장"}</span>
              </div>
            )}

            <Button
              className="mt-4 w-full"
              onClick={() => void loadModel()}
              disabled={
                loading || generating || indexing || !selectedModel || webGpuSupported === false
              }
            >
              {loading ? <LoaderCircle className="animate-spin" /> : <Cpu />}
              {loading
                ? "모델 불러오는 중"
                : loadedModel === selectedModel
                  ? "모델 다시 불러오기"
                  : "이 모델 불러오기"}
            </Button>

            {(loading || loadProgress > 0) && <Progress value={loadProgress} className="mt-4" />}
            <p className="mt-2 break-words text-xs leading-5 text-[var(--muted-text)]">
              {modelStatus}
            </p>
            {error && (
              <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs leading-5 text-red-700">
                {error}
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <p className="eyebrow">02 · DOCUMENT RAG</p>
            <div className="mt-2 flex items-center gap-2">
              <FileText className="size-5 text-[var(--accent-strong)]" />
              <h2 className="text-xl font-bold tracking-tight">PDF 문서 연결</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">
              모든 페이지를 Tesseract로 OCR한 뒤 Kiwi 형태소와 BM25 색인을 브라우저 SQLite에
              저장합니다.
            </p>

            <label
              className="mt-4 block text-xs font-bold text-[var(--muted-text)]"
              htmlFor="rag-pdf"
            >
              PDF 파일
            </label>
            <Input
              id="rag-pdf"
              type="file"
              accept="application/pdf,.pdf"
              className="mt-2 cursor-pointer bg-white file:mr-3 file:font-semibold"
              disabled={indexing || generating || loading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void processPdf(file);
                event.currentTarget.value = "";
              }}
            />

            {documentName && (
              <div className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <strong className="block truncate text-sm">{documentName}</strong>
                    <span className="mt-1 block text-xs leading-5 text-[var(--muted-text)]">
                      {documentStatus}
                    </span>
                  </div>
                  {!indexing && (
                    <Button variant="ghost" size="sm" onClick={clearDocument}>
                      지우기
                    </Button>
                  )}
                </div>
                <Progress value={documentProgress} className="mt-3" />
                {indexedChunks.length > 0 && (
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                    <DocumentMetric label="페이지" value={documentPages.toLocaleString()} />
                    <DocumentMetric label="청크" value={indexedChunks.length.toLocaleString()} />
                    <DocumentMetric label="검색어" value={termCount.toLocaleString()} />
                  </div>
                )}
              </div>
            )}

            {!documentName && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-dashed border-[var(--line)] p-3 text-xs text-[var(--muted-text)]">
                <Upload className="size-4 shrink-0" />
                PDF는 서버로 전송되지 않고 현재 브라우저 안에서 처리됩니다.
              </div>
            )}
            {documentError && (
              <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs leading-5 text-red-700">
                {documentError}
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-[var(--accent-strong)]" />
              <h3 className="font-bold">실행 상태</h3>
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              <StatusRow
                label="WebGPU"
                value={
                  webGpuSupported === null
                    ? "확인 중"
                    : webGpuSupported
                      ? "사용 가능"
                      : "지원 안 됨"
                }
              />
              <StatusRow label="실행 위치" value="브라우저 로컬" />
              <StatusRow label="Worker" value="별도 스레드" />
              <StatusRow
                label="문서 RAG"
                value={indexedChunks.length ? `활성 · ${indexedChunks.length}청크` : "비활성"}
              />
              <StatusRow
                label="SQLite"
                value={databaseBytes ? `${(databaseBytes / 1024).toFixed(1)}KB · 메모리` : "미생성"}
              />
              <StatusRow
                label="현재 모델"
                value={loadedModel ? displayName(loadedModel) : "미로딩"}
              />
            </dl>
            {runtimeStats && (
              <pre className="mt-4 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-[11px] leading-5 text-slate-300">
                {runtimeStats}
              </pre>
            )}
          </section>
        </aside>

        <section className="flex min-h-[680px] min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface)] shadow-[var(--shadow)]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="grid size-9 place-items-center rounded-lg bg-[var(--ink)] text-white">
                <Bot className="size-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-bold">브라우저 로컬 채팅</h2>
                  {indexedChunks.length > 0 && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                      BM25 RAG 활성
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--muted-text)]">
                  {loadedModel
                    ? `${displayName(loadedModel)}${documentName ? ` · ${documentName}` : ""}`
                    : "왼쪽에서 모델을 먼저 불러오세요"}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {generating && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => engineRef.current?.interruptGenerate()}
                >
                  <CircleStop /> 중지
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void resetChat()}
                disabled={!messages.length && !generating}
              >
                <RotateCcw /> 대화 초기화
              </Button>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto p-5 lg:p-6">
            {!messages.length ? (
              <div className="grid h-full min-h-96 place-items-center text-center">
                <div>
                  <MessageSquareText className="mx-auto size-9 text-[var(--accent-strong)]" />
                  <h3 className="mt-4 text-lg font-bold">
                    {indexedChunks.length
                      ? "PDF에 관해 질문해 보세요"
                      : "모델과 직접 대화해 보세요"}
                  </h3>
                  <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--muted-text)]">
                    {indexedChunks.length
                      ? "질문마다 BM25가 관련 청크를 찾고, 로컬 LLM은 그 발췌문을 근거로 답합니다."
                      : "첫 실행에는 모델 파일 다운로드가 필요합니다. 이후 파일은 브라우저 캐시에 저장되며 질문과 답변은 외부 API로 전송되지 않습니다."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {messages.map((message, index) => (
                  <article
                    key={`${message.role}-${index}`}
                    className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-7 ${message.role === "user" ? "bg-[var(--ink)] text-white" : "border border-[var(--line)] bg-[var(--panel)] text-slate-700"}`}
                    >
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider opacity-60">
                        {message.role === "user" ? "You" : "Local model"}
                      </span>
                      <p className="whitespace-pre-wrap">
                        {message.content || <LoaderCircle className="size-4 animate-spin" />}
                      </p>
                      {message.role === "assistant" &&
                        message.sources &&
                        message.sources.length > 0 && (
                          <details className="mt-3 border-t border-slate-200 pt-2 text-xs">
                            <summary className="cursor-pointer font-semibold text-[var(--accent-strong)]">
                              BM25 근거 {message.sources.length}개
                            </summary>
                            <div className="mt-2 space-y-2">
                              {message.sources.map((source) => (
                                <div
                                  key={source.id}
                                  className="rounded-lg bg-white/70 p-2 leading-5"
                                >
                                  <strong>
                                    p.{source.page} · 청크 #{source.id}
                                  </strong>
                                  <span className="ml-2 text-[var(--muted-text)]">
                                    BM25 {source.score.toFixed(3)}
                                  </span>
                                  <p className="mt-1 text-[var(--muted-text)]">
                                    {source.preview}
                                    {source.preview.length >= 180 ? "…" : ""}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>

          <form
            onSubmit={sendMessage}
            className="border-t border-[var(--line)] bg-[var(--panel)] p-4 lg:p-5"
          >
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                disabled={!loadedModel || loading || generating || indexing}
                placeholder={
                  loadedModel
                    ? indexedChunks.length
                      ? "PDF 내용에 관해 질문하세요 · Shift+Enter 줄바꿈"
                      : "메시지를 입력하세요 · Shift+Enter 줄바꿈"
                    : "모델을 불러오면 채팅할 수 있습니다"
                }
                className="min-h-12 max-h-40 resize-none bg-white"
              />
              <Button
                type="submit"
                size="lg"
                className="h-12 shrink-0"
                disabled={!loadedModel || !input.trim() || loading || generating || indexing}
              >
                {generating ? <LoaderCircle className="animate-spin" /> : <Send />}
                보내기
              </Button>
            </div>
          </form>
        </section>
      </section>
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] pb-3 last:border-0 last:pb-0">
      <dt className="font-semibold">{label}</dt>
      <dd className="max-w-[220px] text-right text-xs leading-5 text-[var(--muted-text)]">
        {value}
      </dd>
    </div>
  );
}

function DocumentMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white px-2 py-2">
      <strong className="block text-sm text-[var(--ink)]">{value}</strong>
      <span className="text-[10px] text-[var(--muted-text)]">{label}</span>
    </div>
  );
}
