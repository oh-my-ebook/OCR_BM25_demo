import type { Database } from "sql.js";

const LAB_DIRECTORY = "bm25-pdf-lab";
const PDF_DIRECTORY = "pdfs";
const DATABASE_FILE = "metadata.sqlite";

export const OPFS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    opfs_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`;

export type StoredPdf = {
  id: string;
  originalName: string;
  opfsName: string;
  opfsPath: string;
  mimeType: string;
  byteSize: number;
  createdAt: string;
};

export type OpfsLabSnapshot = {
  documents: StoredPdf[];
  databaseBytes: number;
};

let sqlPromise: ReturnType<(typeof import("sql.js"))["default"]> | null = null;

function requireOpfs() {
  if (!navigator.storage?.getDirectory) {
    throw new Error("이 브라우저는 OPFS를 지원하지 않습니다. 최신 Chromium 계열 브라우저에서 확인해 주세요.");
  }
}

async function getSql() {
  sqlPromise ??= import("sql.js").then(({ default: initSqlJs }) =>
    initSqlJs({ locateFile: () => "/vendor/sql-wasm.wasm" }),
  );
  return sqlPromise;
}

async function openLab() {
  requireOpfs();
  const root = await navigator.storage.getDirectory();
  const labDirectory = await root.getDirectoryHandle(LAB_DIRECTORY, { create: true });
  const pdfDirectory = await labDirectory.getDirectoryHandle(PDF_DIRECTORY, { create: true });
  const databaseHandle = await labDirectory.getFileHandle(DATABASE_FILE, { create: true });
  const databaseFile = await databaseHandle.getFile();
  const SQL = await getSql();
  const database = databaseFile.size
    ? new SQL.Database(new Uint8Array(await databaseFile.arrayBuffer()))
    : new SQL.Database();
  database.run(OPFS_SCHEMA);
  return { database, databaseFile, databaseHandle, pdfDirectory };
}

async function writeDatabase(database: Database, handle: FileSystemFileHandle) {
  const writable = await handle.createWritable();
  const bytes = database.export();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  await writable.write(buffer);
  await writable.close();
}

export function listStoredPdfs(database: Database): StoredPdf[] {
  const statement = database.prepare(`
    SELECT id, original_name, opfs_name, mime_type, byte_size, created_at
    FROM documents
    ORDER BY created_at DESC
  `);
  const documents: StoredPdf[] = [];
  while (statement.step()) {
    const row = statement.getAsObject();
    const opfsName = String(row.opfs_name);
    documents.push({
      id: String(row.id),
      originalName: String(row.original_name),
      opfsName,
      opfsPath: `/${LAB_DIRECTORY}/${PDF_DIRECTORY}/${opfsName}`,
      mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size),
      createdAt: String(row.created_at),
    });
  }
  statement.free();
  return documents;
}

export function deleteStoredPdfMetadata(database: Database, id: string) {
  const document = listStoredPdfs(database).find((item) => item.id === id);
  if (!document) return null;
  database.run("DELETE FROM documents WHERE id = ?", [id]);
  return document;
}

export async function inspectOpfsLab(): Promise<OpfsLabSnapshot> {
  const { database, databaseFile, databaseHandle } = await openLab();
  try {
    if (!databaseFile.size) await writeDatabase(database, databaseHandle);
    const currentDatabaseFile = await databaseHandle.getFile();
    return {
      documents: listStoredPdfs(database),
      databaseBytes: currentDatabaseFile.size,
    };
  } finally {
    database.close();
  }
}

export async function storePdfs(files: File[]) {
  const { database, databaseHandle, pdfDirectory } = await openLab();
  const createdNames: string[] = [];
  try {
    database.run("BEGIN");
    const insert = database.prepare(`
      INSERT INTO documents (id, original_name, opfs_name, mime_type, byte_size, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const file of files) {
      const id = crypto.randomUUID();
      const opfsName = `${id}.pdf`;
      const fileHandle = await pdfDirectory.getFileHandle(opfsName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(file);
      await writable.close();
      createdNames.push(opfsName);
      insert.run([id, file.name, opfsName, file.type || "application/pdf", file.size, new Date().toISOString()]);
    }
    insert.free();
    database.run("COMMIT");
    await writeDatabase(database, databaseHandle);
  } catch (error) {
    try { database.run("ROLLBACK"); } catch { /* transaction may already be closed */ }
    await Promise.all(createdNames.map((name) => pdfDirectory.removeEntry(name).catch(() => undefined)));
    throw error;
  } finally {
    database.close();
  }
}

export async function deleteStoredPdf(id: string) {
  const { database, databaseHandle, pdfDirectory } = await openLab();
  try {
    const document = deleteStoredPdfMetadata(database, id);
    if (!document) return false;
    await pdfDirectory.removeEntry(document.opfsName);
    await writeDatabase(database, databaseHandle);
    return true;
  } finally {
    database.close();
  }
}

export async function readStoredPdf(opfsName: string) {
  requireOpfs();
  const root = await navigator.storage.getDirectory();
  const labDirectory = await root.getDirectoryHandle(LAB_DIRECTORY);
  const pdfDirectory = await labDirectory.getDirectoryHandle(PDF_DIRECTORY);
  return (await pdfDirectory.getFileHandle(opfsName)).getFile();
}
