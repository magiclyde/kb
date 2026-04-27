/**
 * search/retriever.ts
 * 混合检索: BM25 全文 + 向量语义搜索 → RRF 精排
 */

import { sql } from "../shared/db";
import { embed } from "../shared/embeddings";

export interface SearchResult {
  id: bigint;
  docId: bigint;
  docTitle: string;
  heading: string;
  content: string;
  plainText: string;
  bm25Score: number | null;
  vectorScore: number | null;
  rrfScore: number;
}

interface RetrieveOptions {
  topK?: number;          // 最终返回数量 (默认 5)
  bm25Weight?: number;    // BM25 在 RRF 中的权重 (默认 1)
  vectorWeight?: number;  // 向量在 RRF 中的权重 (默认 1)
  category?: string;      // 按分类过滤
  rrfK?: number;          // RRF 常数 k (默认 60)
}

/**
 * 混合检索 + RRF 精排
 */
export async function retrieve(
  query: string,
  options: RetrieveOptions = {}
): Promise<SearchResult[]> {
  const {
    topK = 5,
    bm25Weight = 1,
    vectorWeight = 1.2,   // 语义权重略高
    category,
    rrfK = 60,
  } = options;

  const fetchN = topK * 4; // 从每路召回更多候选

  // ── 并行执行两路检索 ──────────────────────────────────────────────
  const [bm25Results, vectorResults] = await Promise.all([
    bm25Search(query, fetchN, category),
    vectorSearch(query, fetchN, category),
  ]);

  // ── RRF 融合 ─────────────────────────────────────────────────────
  const scores = new Map<string, {
    id: bigint; docId: bigint; docTitle: string; heading: string;
    content: string; plainText: string;
    bm25Score: number | null; vectorScore: number | null; rrfScore: number;
  }>();

  // BM25 贡献
  bm25Results.forEach((r, rank) => {
    const key = String(r.id);
    const rrf = bm25Weight / (rrfK + rank + 1);
    if (scores.has(key)) {
      scores.get(key)!.rrfScore += rrf;
      scores.get(key)!.bm25Score = r.score;
    } else {
      scores.set(key, {
        id: r.id, docId: r.docId, docTitle: r.docTitle,
        heading: r.heading, content: r.content, plainText: r.plainText,
        bm25Score: r.score, vectorScore: null, rrfScore: rrf,
      });
    }
  });

  // 向量贡献
  vectorResults.forEach((r, rank) => {
    const key = String(r.id);
    const rrf = vectorWeight / (rrfK + rank + 1);
    if (scores.has(key)) {
      scores.get(key)!.rrfScore += rrf;
      scores.get(key)!.vectorScore = r.score;
    } else {
      scores.set(key, {
        id: r.id, docId: r.docId, docTitle: r.docTitle,
        heading: r.heading, content: r.content, plainText: r.plainText,
        bm25Score: null, vectorScore: r.score, rrfScore: rrf,
      });
    }
  });

  // 按 RRF 排序，取 topK
  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}

// ── BM25 全文检索 ─────────────────────────────────────────────────────
interface RawResult {
  id: bigint; docId: bigint; docTitle: string;
  heading: string; content: string; plainText: string; score: number;
}

async function bm25Search(
  query: string,
  limit: number,
  category?: string
): Promise<RawResult[]> {
  try {
    // ParadeDB v0.20+ 新语法：||| 操作符 + pdb.score()
    const rows = category
      ? await sql`
          SELECT
            c.id, c.doc_id AS "docId", d.title AS "docTitle",
            c.heading, c.content, c.plain_text AS "plainText",
            pdb.score(c.id) AS score
          FROM chunks c
          JOIN documents d ON d.id = c.doc_id
          WHERE d.category = ${category}
            AND (c.plain_text ||| ${query} OR c.heading ||| ${query})
          ORDER BY pdb.score(c.id) DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT
            c.id, c.doc_id AS "docId", d.title AS "docTitle",
            c.heading, c.content, c.plain_text AS "plainText",
            pdb.score(c.id) AS score
          FROM chunks c
          JOIN documents d ON d.id = c.doc_id
          WHERE c.plain_text ||| ${query} OR c.heading ||| ${query}
          ORDER BY pdb.score(c.id) DESC
          LIMIT ${limit}
        `;

    return rows as unknown as RawResult[];
  } catch (e) {
    console.error("BM25 search error:", e);
    return [];
  }
}

// ── 向量检索 ─────────────────────────────────────────────────────────
async function vectorSearch(
  query: string,
  limit: number,
  category?: string
): Promise<RawResult[]> {
  try {
    const queryEmbedding = await embed(query);
    const vecStr = `[${queryEmbedding.join(",")}]`;

    const rows = category
      ? await sql`
          SELECT
            c.id, c.doc_id AS "docId", d.title AS "docTitle",
            c.heading, c.content, c.plain_text AS "plainText",
            1 - (c.embedding <=> ${vecStr}::vector) AS score
          FROM chunks c
          JOIN documents d ON d.id = c.doc_id
          WHERE d.category = ${category}
            AND c.embedding IS NOT NULL
          ORDER BY c.embedding <=> ${vecStr}::vector
          LIMIT ${limit}
        `
      : await sql`
          SELECT
            c.id, c.doc_id AS "docId", d.title AS "docTitle",
            c.heading, c.content, c.plain_text AS "plainText",
            1 - (c.embedding <=> ${vecStr}::vector) AS score
          FROM chunks c
          JOIN documents d ON d.id = c.doc_id
          WHERE c.embedding IS NOT NULL
          ORDER BY c.embedding <=> ${vecStr}::vector
          LIMIT ${limit}
        `;

    return rows as unknown as RawResult[];
  } catch (e) {
    console.error("Vector search error:", e);
    return [];
  }
}