import type { Database } from "sql.js";

export type Token = { str: string; tag: string; position: number; length: number };

export type IndexedChunk = {
  id: number;
  page: number;
  source: "text" | "ocr";
  text: string;
  tokens: string[];
};

export type Contribution = {
  term: string;
  tf: number;
  df: number;
  idf: number;
  lengthNorm: number;
  score: number;
};

export type SearchResult = {
  chunk: IndexedChunk;
  score: number;
  relative: number;
  contributions: Contribution[];
};

const SEARCHABLE_TAGS = /^(NN|NR|NP|VV|VA|VX|XR|MAG|MAJ|SL|SH|SN)/;
const STOP_TERMS = new Set([
  "하",
  "되",
  "있",
  "없",
  "이렇",
  "그렇",
  "어떻",
  "것",
  "수",
  "때",
  "같",
]);

export function searchTerms(tokens: Token[]) {
  return tokens
    .filter((token) => SEARCHABLE_TAGS.test(token.tag))
    .map((token) => token.str.normalize("NFKC").toLocaleLowerCase("ko-KR"))
    .filter((token) => token.length > 0 && !STOP_TERMS.has(token));
}

export function createSchema(db: Database) {
  db.run(`
    DROP TABLE IF EXISTS postings;
    DROP TABLE IF EXISTS terms;
    DROP TABLE IF EXISTS chunks;
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      page INTEGER NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL
    );
    CREATE TABLE terms (term TEXT PRIMARY KEY, df INTEGER NOT NULL);
    CREATE TABLE postings (
      term TEXT NOT NULL,
      chunk_id INTEGER NOT NULL,
      tf INTEGER NOT NULL,
      PRIMARY KEY (term, chunk_id)
    );
    CREATE INDEX idx_postings_term ON postings(term);
  `);
}

export function indexChunks(db: Database, chunks: IndexedChunk[]) {
  createSchema(db);
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, page, source, content, token_count) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPosting = db.prepare(
    "INSERT INTO postings (term, chunk_id, tf) VALUES (?, ?, ?)",
  );
  const dfs = new Map<string, number>();

  db.run("BEGIN");
  for (const chunk of chunks) {
    insertChunk.run([chunk.id, chunk.page, chunk.source, chunk.text, chunk.tokens.length]);
    const counts = new Map<string, number>();
    for (const term of chunk.tokens) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, tf] of counts) {
      insertPosting.run([term, chunk.id, tf]);
      dfs.set(term, (dfs.get(term) ?? 0) + 1);
    }
  }
  insertChunk.free();
  insertPosting.free();

  const insertTerm = db.prepare("INSERT INTO terms (term, df) VALUES (?, ?)");
  for (const [term, df] of dfs) insertTerm.run([term, df]);
  insertTerm.free();
  db.run("COMMIT");
  db.run("PRAGMA optimize");
}

export function searchBm25(
  db: Database,
  queryTokens: string[],
  chunks: IndexedChunk[],
  k1 = 1.2,
  b = 0.75,
): SearchResult[] {
  if (!chunks.length || !queryTokens.length) return [];
  const avgdl = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / chunks.length;
  const uniqueTerms = [...new Set(queryTokens)];
  const rowsByChunk = new Map<number, Contribution[]>();
  const stmt = db.prepare(`
    SELECT p.chunk_id, p.tf, t.df, c.token_count
    FROM postings p
    JOIN terms t ON t.term = p.term
    JOIN chunks c ON c.id = p.chunk_id
    WHERE p.term = ?
  `);

  for (const term of uniqueTerms) {
    stmt.bind([term]);
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, number>;
      const idf = Math.log(1 + (chunks.length - row.df + 0.5) / (row.df + 0.5));
      const lengthNorm = row.tf + k1 * (1 - b + b * (row.token_count / avgdl));
      const score = idf * ((row.tf * (k1 + 1)) / lengthNorm);
      const list = rowsByChunk.get(row.chunk_id) ?? [];
      list.push({ term, tf: row.tf, df: row.df, idf, lengthNorm, score });
      rowsByChunk.set(row.chunk_id, list);
    }
    stmt.reset();
  }
  stmt.free();

  const ranked = [...rowsByChunk.entries()]
    .map(([id, contributions]) => ({
      chunk: chunks.find((chunk) => chunk.id === id)!,
      score: contributions.reduce((sum, item) => sum + item.score, 0),
      relative: 0,
      contributions,
    }))
    .sort((a, bResult) => bResult.score - a.score);
  const top = ranked[0]?.score ?? 1;
  return ranked.map((result) => ({ ...result, relative: (result.score / top) * 100 }));
}

export function chunkText(text: string, maxChars = 700, overlap = 100) {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(clean.length, start + maxChars);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("다. "));
      if (boundary > maxChars * 0.55) end = start + boundary + 1;
    }
    chunks.push({ text: clean.slice(start, end).trim(), start, end });
    if (end === clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function highlight(text: string, terms: string[]) {
  if (!terms.length) return [{ text, match: false }];
  const escaped = terms
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return [{ text, match: false }];
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return text.split(re).filter(Boolean).map((part) => ({
    text: part,
    match: terms.some((term) => term.toLocaleLowerCase("ko-KR") === part.toLocaleLowerCase("ko-KR")),
  }));
}
