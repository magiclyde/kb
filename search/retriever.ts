/**
 * search/retriever.ts
 * 混合检索: BM25 全文 + 向量语义搜索 → RRF 精排
 * 支持: 查询结果缓存 (LRU + TTL)
 */

import { sql } from "../shared/db";
import { embed } from "../shared/embeddings";
import { LRUCache } from "./cache";

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

export interface RetrieveOptions {
  topK?: number;          // 最终返回数量 (默认 5)
  bm25Weight?: number;    // BM25 在 RRF 中的权重 (默认 1)
  vectorWeight?: number;  // 向量在 RRF 中的权重 (默认 1.2)
  category?: string;      // 按分类过滤
  rrfK?: number;          // RRF 常数 k (默认 60)
  useCache?: boolean;     // 是否启用缓存 (默认 true)
}

// ── 全局缓存实例 ─────────────────────────────────────────────────────
const retrieveCache = new LRUCache<string, SearchResult[]>({
  maxSize: parseInt(process.env.CACHE_MAX_SIZE || "500"),
  ttlMs: parseInt(process.env.CACHE_TTL_MS || "600000"), // 默认 10 分钟
});

/**
 * 生成缓存键：规范化查询 + 参数组合
 */
function makeCacheKey(query: string, options: RetrieveOptions): string {
  const normQuery = query.trim().toLowerCase();
  const parts = [
    normQuery,
    options.category ?? "*",
    options.topK ?? 5,
    options.rrfK ?? 60,
    // 权重参数影响排序结果，需纳入缓存键
    options.bm25Weight ?? 1,
    options.vectorWeight ?? 1.2,
  ];
  return parts.join("|");
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
    useCache = true,
  } = options;

  // ── 缓存命中检查 ──────────────────────────────────────────────────
  if (useCache) {
    const key = makeCacheKey(query, options);
    const cached = retrieveCache.get(key);
    if (cached) {
      console.log(`🎯 Cache HIT: "${query}"`);
      return cached;
    }
  }

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

  // ── 按 RRF 排序，取 topK ─────────────────────────────────────────
  const results = Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);

  // ── 写入缓存（仅当启用缓存且结果非空）────────────────────────────
  if (useCache && results.length > 0) {
    const key = makeCacheKey(query, options);
    retrieveCache.set(key, results);
    console.log(`💾 Cache SET: "${query}" (ttl=${parseInt(process.env.CACHE_TTL_MS || "600000")}ms)`);
  }

  return results;
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

// ── 缓存管理工具函数 ─────────────────────────────────────────────────
/**
 * 手动清除指定查询的缓存
 */
export function invalidateCache(query: string, options: Omit<RetrieveOptions, "useCache"> = {}): boolean {
  const key = makeCacheKey(query, { ...options, useCache: true });
  const cache = retrieveCache as any;
  if (cache.cache?.has?.(key)) {
    cache.cache.delete(key);
    console.log(`🗑️ Cache INVALIDATE: "${query}"`);
    return true;
  }
  return false;
}

/**
 * 清除所有检索缓存
 */
export function clearRetrieveCache(): void {
  retrieveCache.clear();
  console.log("🧹 Cache CLEAR: all retrieve results");
}

/**
 * 获取缓存统计信息
 */
export function getCacheStats() {
  return retrieveCache.stats;
}