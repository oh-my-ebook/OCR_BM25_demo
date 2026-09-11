import assert from "node:assert/strict";
import initSqlJs from "sql.js";
import { indexChunks, searchBm25, type IndexedChunk } from "../lib/bm25.ts";

const SQL = await initSqlJs();
const db = new SQL.Database();
const chunks: IndexedChunk[] = [
  { id: 1, page: 1, source: "text", text: "계약 해지는 서면 통지로 한다.", tokens: ["계약", "해지", "서면", "통지"] },
  { id: 2, page: 2, source: "text", text: "배송은 영업일 기준이다.", tokens: ["배송", "영업일", "기준"] },
];

indexChunks(db, chunks);
const results = searchBm25(db, ["계약", "해지"], chunks);
assert.equal(results[0]?.chunk.id, 1);
assert.equal(results[0]?.relative, 100);
assert.equal(results[0]?.contributions.length, 2);
console.log("BM25 check passed");
