import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { deleteStoredPdfMetadata, listStoredPdfs, OPFS_SCHEMA } from "../lib/opfs-sqlite.ts";

const SQL = await initSqlJs({
  locateFile: () => fileURLToPath(new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url)),
});
const database = new SQL.Database();
database.run(OPFS_SCHEMA);
database.run(
  "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)",
  ["id-1", "한국어.pdf", "id-1.pdf", "application/pdf", 1234, "2026-09-16T00:00:00.000Z"],
);

assert.deepEqual(listStoredPdfs(database), [{
  id: "id-1",
  originalName: "한국어.pdf",
  opfsName: "id-1.pdf",
  opfsPath: "/bm25-pdf-lab/pdfs/id-1.pdf",
  mimeType: "application/pdf",
  byteSize: 1234,
  createdAt: "2026-09-16T00:00:00.000Z",
}]);
assert.equal(deleteStoredPdfMetadata(database, "missing"), null);
assert.equal(deleteStoredPdfMetadata(database, "id-1")?.opfsName, "id-1.pdf");
assert.deepEqual(listStoredPdfs(database), []);
database.close();
console.log("OPFS SQLite metadata check passed");
