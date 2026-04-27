/**
 * shared/db.ts
 * 数据库连接 + Schema 初始化
 *
 * 表结构:
 *   documents   — 原始文档元信息
 *   chunks      — 切分后的文档块（含全文索引 + 向量）
 */

import postgres from "postgres";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://postgres:password@localhost:5432/knowledge_base";

const EMBEDDING_DIM = parseInt(process.env.EMBEDDING_DIM || "768");

export const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 30,
});

export async function initSchema() {
  console.log("🔧 初始化数据库 Schema...");

  // 启用扩展（通常已由 initdb SQL 处理，这里保留作兜底）
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`CREATE EXTENSION IF NOT EXISTS pg_search`;

  // ── 文档主表 ──────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS documents (
      id          BIGSERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      file_path   TEXT UNIQUE NOT NULL,
      file_hash   TEXT NOT NULL,          -- MD5, 用于 upsert 去重
      category    TEXT DEFAULT 'general',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // 兼容旧表：如果 file_hash 列不存在则补上
  // await sql`
  //   ALTER TABLE documents
  //     ADD COLUMN IF NOT EXISTS file_hash TEXT NOT NULL DEFAULT ''
  // `;

  // ── 文档块表 ──────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS chunks (
      id          BIGSERIAL PRIMARY KEY,
      doc_id      BIGINT REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      heading     TEXT,
      content     TEXT NOT NULL,
      plain_text  TEXT NOT NULL,
      embedding   VECTOR(${sql.unsafe(String(EMBEDDING_DIM))}),
      token_count INT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (doc_id, chunk_index)
    )
  `;

  // ── BM25 全文索引（ParadeDB v0.20+ 新语法）────────────────────────
  // 使用标准 CREATE INDEX ... USING bm25，不再用旧的 CALL paradedb.create_bm25()
  try {
    await sql`
      CREATE INDEX IF NOT EXISTS chunks_bm25
      ON chunks
      USING bm25 (id, plain_text, heading)
      WITH (key_field = 'id')
    `;
    console.log("✅ BM25 全文索引创建完成");
  } catch (e: any) {
    if (e.message?.includes("already exists")) {
      console.log("ℹ️  BM25 索引已存在，跳过");
    } else {
      console.warn("⚠️  BM25 索引创建失败:", e.message);
    }
  }

  // ── pgvector HNSW 向量索引 ────────────────────────────────────────
  await sql`
    CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `;

  // ── 普通索引 ──────────────────────────────────────────────────────
  await sql`CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks(doc_id)`;
  await sql`CREATE INDEX IF NOT EXISTS documents_hash_idx ON documents(file_hash)`;

  console.log("✅ Schema 初始化完成");
}

// 直接运行时初始化
if (import.meta.main) {
  await initSchema();
  await sql.end();
}