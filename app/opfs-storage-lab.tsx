"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Database,
  ExternalLink,
  FileText,
  FolderTree,
  HardDrive,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  deleteStoredPdf,
  inspectOpfsLab,
  readStoredPdf,
  storePdfs,
  type StoredPdf,
} from "@/lib/opfs-sqlite";

type StorageMetrics = {
  usage: number;
  quota: number;
  persisted: boolean;
};

async function loadStorageState() {
  const [snapshot, estimate, persisted] = await Promise.all([
    inspectOpfsLab(),
    navigator.storage.estimate(),
    navigator.storage.persisted(),
  ]);
  return { snapshot, estimate, persisted };
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 2 : 0)} ${units[index]}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function OpfsStorageLab() {
  const [documents, setDocuments] = useState<StoredPdf[]>([]);
  const [databaseBytes, setDatabaseBytes] = useState(0);
  const [metrics, setMetrics] = useState<StorageMetrics>({ usage: 0, quota: 0, persisted: false });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("브라우저 저장소 확인 중");
  const [error, setError] = useState("");

  const pdfBytes = useMemo(
    () => documents.reduce((sum, document) => sum + document.byteSize, 0),
    [documents],
  );
  const labBytes = pdfBytes + databaseBytes;
  const remaining = Math.max(0, metrics.quota - metrics.usage);
  const usedPercent = metrics.quota ? Math.min(100, (metrics.usage / metrics.quota) * 100) : 0;

  async function refresh(message = "저장소 정보를 새로고침했습니다") {
    try {
      const { snapshot, estimate, persisted } = await loadStorageState();
      setError(message);
      setDocuments(snapshot.documents);
      setDatabaseBytes(snapshot.databaseBytes);
      setMetrics({
        usage: estimate.usage ?? 0,
        quota: estimate.quota ?? 0,
        persisted,
      });
      setStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("저장소를 열지 못했습니다");
    }
  }

  useEffect(() => {
    let active = true;
    void loadStorageState()
      .then(({ snapshot, estimate, persisted }) => {
        if (!active) return;
        setError("");
        setDocuments(snapshot.documents);
        setDatabaseBytes(snapshot.databaseBytes);
        setMetrics({
          usage: estimate.usage ?? 0,
          quota: estimate.quota ?? 0,
          persisted,
        });
        setStatus("OPFS와 SQLite 준비 완료");
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : String(caught));
        setStatus("저장소를 열지 못했습니다");
      });
    return () => {
      active = false;
    };
  }, []);

  async function upload(files: File[]) {
    if (!files.length || busy) return;
    const pdfFiles = files.filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
    );
    if (pdfFiles.length !== files.length) {
      setError("PDF 파일만 저장할 수 있습니다.");
      return;
    }
    const uploadBytes = pdfFiles.reduce((sum, file) => sum + file.size, 0);
    if (metrics.quota && uploadBytes > remaining) {
      setError(
        `선택한 파일 ${formatBytes(uploadBytes)}이 현재 남은 추정 용량 ${formatBytes(remaining)}보다 큽니다.`,
      );
      return;
    }
    setBusy(true);
    setError("");
    setStatus(`${pdfFiles.length}개 PDF를 OPFS에 쓰는 중`);
    try {
      await storePdfs(pdfFiles);
      await refresh(`${pdfFiles.length}개 PDF 저장 완료`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("PDF 저장 실패");
    } finally {
      setBusy(false);
    }
  }

  async function requestPersistence() {
    setBusy(true);
    setError("");
    try {
      const granted = await navigator.storage.persist();
      await refresh(
        granted
          ? "영구 저장 보호가 승인됐습니다"
          : "브라우저가 영구 저장 보호를 승인하지 않았습니다",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function openPdf(document: StoredPdf) {
    try {
      const file = await readStoredPdf(document.opfsName);
      const url = URL.createObjectURL(file);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function removePdf(document: StoredPdf) {
    if (
      busy ||
      !window.confirm(
        `“${document.originalName}”을 OPFS와 SQLite에서 삭제할까요?\n삭제 후 복구할 수 없습니다.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setStatus(`${document.originalName} 삭제 중`);
    try {
      const deleted = await deleteStoredPdf(document.id);
      await refresh(deleted ? `${document.originalName} 삭제 완료` : "이미 삭제된 PDF입니다");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus("PDF 삭제 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 lg:px-8 lg:py-8">
      <section className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="h-fit rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
          <p className="eyebrow">BROWSER STORAGE LAB</p>
          <h2 className="mt-2 text-xl font-bold tracking-tight">SQLite WASM + OPFS</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-text)]">
            PDF 바이트는 OPFS에, 파일 메타데이터는 OPFS 안의 SQLite 파일에 저장됩니다. 서버 전송은
            없습니다.
          </p>

          <div
            className={`mt-5 rounded-xl border p-4 ${metrics.persisted ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}
          >
            <div className="flex items-center gap-2">
              {metrics.persisted ? (
                <ShieldCheck className="size-5 text-emerald-700" />
              ) : (
                <ShieldQuestion className="size-5 text-amber-700" />
              )}
              <strong className={metrics.persisted ? "text-emerald-900" : "text-amber-900"}>
                {metrics.persisted ? "Persistent 저장소" : "Best-effort 저장소"}
              </strong>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-700">
              {metrics.persisted
                ? "브라우저가 저장 공간 부족을 이유로 자동 축출하지 않도록 보호합니다. 사용자가 사이트 데이터를 지우면 삭제됩니다."
                : "공간이 부족하면 브라우저가 데이터를 축출할 수 있습니다. 일반적인 재방문·새로고침에는 유지됩니다."}
            </p>
            {!metrics.persisted && (
              <Button
                className="mt-3 w-full"
                variant="outline"
                disabled={busy}
                onClick={() => void requestPersistence()}
              >
                <ShieldCheck /> persist() 요청
              </Button>
            )}
          </div>

          <label className="mt-4 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-[var(--accent)] bg-[var(--accent-soft)] px-5 text-center">
            {busy ? (
              <LoaderCircle className="size-7 animate-spin text-[var(--accent-strong)]" />
            ) : (
              <Upload className="size-7 text-[var(--accent-strong)]" />
            )}
            <span className="mt-3 text-sm font-bold">PDF를 OPFS에 저장</span>
            <span className="mt-1 text-xs text-[var(--muted-text)]">
              여러 파일 선택 가능 · 최대 추정 {formatBytes(remaining)}
            </span>
            <input
              className="sr-only"
              type="file"
              accept="application/pdf,.pdf"
              multiple
              disabled={busy}
              onChange={(event) => {
                void upload(Array.from(event.target.files ?? []));
                event.currentTarget.value = "";
              }}
            />
          </label>

          <Button
            className="mt-3 w-full"
            variant="outline"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className={busy ? "animate-spin" : ""} /> 저장소 다시 측정
          </Button>
          <p
            className={`mt-3 text-xs leading-5 ${error ? "text-red-600" : "text-[var(--muted-text)]"}`}
          >
            {error || status}
          </p>
        </aside>

        <div className="space-y-5">
          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
            <div className="flex items-center gap-2">
              <HardDrive className="size-5 text-[var(--accent-strong)]" />
              <h2 className="text-xl font-bold">저장 용량</h2>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                label="브라우저 할당량"
                value={formatBytes(metrics.quota)}
                note="이 origin 전체의 추정 quota"
              />
              <Metric
                label="전체 사용량"
                value={formatBytes(metrics.usage)}
                note={`${usedPercent.toFixed(2)}% 사용`}
              />
              <Metric
                label="남은 추정 용량"
                value={formatBytes(remaining)}
                note="실제 쓰기 성공을 보장하지 않음"
              />
              <Metric
                label="이 실험실 파일"
                value={formatBytes(labBytes)}
                note={`PDF ${documents.length}개 + DB ${formatBytes(databaseBytes)}`}
              />
            </div>
            <Progress value={usedPercent} className="mt-5 h-2" />
            <div className="mt-2 flex justify-between text-xs text-[var(--muted-text)]">
              <span>{formatBytes(metrics.usage)} 사용</span>
              <span>{formatBytes(metrics.quota)} 할당</span>
            </div>
          </section>

          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
            <h2 className="text-lg font-bold">PDF 한 개가 저장되는 흐름</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <FlowStep number="1" title="File 입력" detail="브라우저가 PDF Blob을 받음" />
              <FlowStep number="2" title="OPFS 쓰기" detail="UUID.pdf 이름으로 실제 바이트 저장" />
              <FlowStep number="3" title="SQLite 기록" detail="이름·경로·크기·시각을 INSERT" />
              <FlowStep
                number="4"
                title="DB 내보내기"
                detail="metadata.sqlite를 OPFS에 다시 기록"
              />
            </div>
          </section>

          <section className="grid gap-5 lg:grid-cols-2">
            <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
              <div className="flex items-center gap-2">
                <FolderTree className="size-5 text-[var(--accent-strong)]" />
                <h2 className="text-lg font-bold">OPFS 구조</h2>
              </div>
              <pre className="mt-4 overflow-auto rounded-xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">{`origin private file system\n└─ /bm25-pdf-lab\n   ├─ metadata.sqlite  (${formatBytes(databaseBytes)})\n   └─ /pdfs\n      └─ <UUID>.pdf     (${formatBytes(pdfBytes)})`}</pre>
              <p className="mt-3 text-xs leading-5 text-[var(--muted-text)]">
                OPFS 경로는 사용자의 일반 파일 탐색기 경로가 아니라 현재 origin에 격리된 브라우저
                전용 경로입니다.
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
              <h2 className="text-lg font-bold">일반 저장과 persist 차이</h2>
              <div className="mt-4 overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-[var(--muted-text)]">
                    <tr>
                      <th className="pb-2 pr-3">항목</th>
                      <th className="pb-2 pr-3">Best-effort</th>
                      <th className="pb-2">Persistent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    <tr>
                      <td className="py-3 pr-3 font-bold">새로고침·재방문</td>
                      <td className="py-3 pr-3">유지</td>
                      <td className="py-3">유지</td>
                    </tr>
                    <tr>
                      <td className="py-3 pr-3 font-bold">공간 부족 시</td>
                      <td className="py-3 pr-3">자동 축출 가능</td>
                      <td className="py-3">자동 축출 방지</td>
                    </tr>
                    <tr>
                      <td className="py-3 pr-3 font-bold">사용자 직접 삭제</td>
                      <td className="py-3 pr-3">삭제됨</td>
                      <td className="py-3">삭제됨</td>
                    </tr>
                    <tr>
                      <td className="py-3 pr-3 font-bold">획득 방법</td>
                      <td className="py-3 pr-3">기본값</td>
                      <td className="py-3">persist() 승인 필요</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] lg:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Database className="size-5 text-[var(--accent-strong)]" />
                  <h2 className="text-lg font-bold">SQLite documents 테이블</h2>
                </div>
                <p className="mt-1 text-xs text-[var(--muted-text)]">
                  PDF 본문이 아니라 OPFS 파일을 찾기 위한 메타데이터만 저장합니다.
                </p>
              </div>
              <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs font-bold text-[var(--accent-strong)]">
                {documents.length} rows
              </span>
            </div>
            {!documents.length ? (
              <div className="mt-5 grid min-h-40 place-items-center rounded-xl border border-dashed border-[var(--line)] text-sm text-[var(--muted-text)]">
                PDF를 올리면 SQLite 행과 OPFS 경로가 나타납니다.
              </div>
            ) : (
              <div className="mt-5 overflow-auto rounded-xl border border-[var(--line)]">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-[var(--panel)] text-xs text-[var(--muted-text)]">
                    <tr>
                      <th className="px-4 py-3">원본 파일명</th>
                      <th className="px-4 py-3">OPFS 경로</th>
                      <th className="px-4 py-3">크기</th>
                      <th className="px-4 py-3">저장 시각</th>
                      <th className="px-4 py-3">작업</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {documents.map((document) => (
                      <tr key={document.id}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <FileText className="size-4 shrink-0" />
                            <span className="max-w-56 truncate font-bold">
                              {document.originalName}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-[var(--muted-text)]">
                          {document.opfsPath}
                        </td>
                        <td className="px-4 py-3 tabular-nums">{formatBytes(document.byteSize)}</td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {formatDate(document.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void openPdf(document)}
                            >
                              <ExternalLink />
                              열기
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => void removePdf(document)}
                            >
                              <Trash2 />
                              삭제
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <p className="text-xs font-bold text-[var(--muted-text)]">{label}</p>
      <strong className="mt-2 block text-xl tabular-nums">{value}</strong>
      <p className="mt-1 text-xs text-[var(--muted-text)]">{note}</p>
    </div>
  );
}

function FlowStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
      <span className="grid size-7 place-items-center rounded-full bg-[var(--ink)] text-xs font-bold text-white">
        {number}
      </span>
      <strong className="mt-3 block text-sm">{title}</strong>
      <p className="mt-1 text-xs leading-5 text-[var(--muted-text)]">{detail}</p>
    </div>
  );
}
