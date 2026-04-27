/**
 * indexer/pipeline.ts
 * 索引 Pipeline: 读取 Markdown → Chunk → Embed → Upsert ParadeDB
 */

import { sql } from "../shared/db";
import { embedBatch, toVectorString } from "../shared/embeddings";
import { chunkMarkdown } from "./chunker";
import { createHash } from "crypto";
import { readdir, readFile, stat } from "fs/promises";
import { join, extname, basename } from "path";

export interface IndexProgress {
  stage: "scan" | "chunk" | "embed" | "upsert" | "done" | "error";
  file?: string;
  total?: number;
  current?: number;
  message?: string;
}

export type ProgressCallback = (p: IndexProgress) => void;

/**
 * 索引单个 Markdown 文件
 */
export async function indexFile(
  filePath: string,
  category: string = "general",
  onProgress?: ProgressCallback
): Promise<{ chunksInserted: number; skipped: boolean }> {
  const report = (p: IndexProgress) => onProgress?.(p);

  // ── 读取文件 ──────────────────────────────────────────────────────
  const rawContent = await readFile(filePath, "utf-8");
  const fileHash = createHash("md5").update(rawContent).digest("hex");
  const title = extractTitle(rawContent) || basename(filePath, ".md");
  const fileName = filePath;

  report({ stage: "scan", file: filePath, message: `读取文件: ${title}` });

  // ── 检查是否需要重新索引 ──────────────────────────────────────────
  const existing = await sql`
    SELECT id, file_hash FROM documents WHERE file_path = ${fileName}
  `;

  let docId: bigint;

  if (existing.length > 0) {
    if (existing[0].file_hash === fileHash) {
      report({ stage: "done", file: filePath, message: "文件未变更，跳过" });
      return { chunksInserted: 0, skipped: true };
    }
    // 内容有变更，删除旧 chunks，更新文档记录
    await sql`DELETE FROM chunks WHERE doc_id = ${existing[0].id}`;
    await sql`
      UPDATE documents SET
        title = ${title},
        file_hash = ${fileHash},
        category = ${category},
        updated_at = NOW()
      WHERE id = ${existing[0].id}
    `;
    docId = existing[0].id;
    report({ stage: "scan", file: filePath, message: "文件已变更，重新索引" });
  } else {
    // 新文档
    const [doc] = await sql`
      INSERT INTO documents (title, file_path, file_hash, category)
      VALUES (${title}, ${fileName}, ${fileHash}, ${category})
      RETURNING id
    `;
    docId = doc.id;
  }

  // ── Chunking ──────────────────────────────────────────────────────
  report({ stage: "chunk", file: filePath, message: "按 ## 标题切分..." });
  const chunks = chunkMarkdown(rawContent, { overlapLines: 3, minChunkLength: 80 });
  report({
    stage: "chunk",
    file: filePath,
    total: chunks.length,
    message: `切分完成: ${chunks.length} 个块`,
  });

  // ── Embedding ─────────────────────────────────────────────────────
  report({ stage: "embed", file: filePath, total: chunks.length, current: 0 });

  const texts = chunks.map((c) => `${c.heading}\n\n${c.plainText}`);
  const embeddings = await embedBatch(texts, 8);

  report({ stage: "embed", file: filePath, total: chunks.length, current: chunks.length });

  // ── Upsert ────────────────────────────────────────────────────────
  report({ stage: "upsert", file: filePath, message: "写入数据库..." });

  await sql.begin(async (tx) => {
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const vec = toVectorString(embeddings[i]);

      await tx`
        INSERT INTO chunks (doc_id, chunk_index, heading, content, plain_text, embedding, token_count)
        VALUES (
          ${docId}, ${i}, ${c.heading}, ${c.content},
          ${c.plainText}, ${vec}::vector, ${c.tokenCount}
        )
        ON CONFLICT (doc_id, chunk_index)
        DO UPDATE SET
          heading    = EXCLUDED.heading,
          content    = EXCLUDED.content,
          plain_text = EXCLUDED.plain_text,
          embedding  = EXCLUDED.embedding,
          token_count = EXCLUDED.token_count
      `;
    }
  });

  report({
    stage: "done",
    file: filePath,
    total: chunks.length,
    message: `✅ 完成，写入 ${chunks.length} 个块`,
  });

  return { chunksInserted: chunks.length, skipped: false };
}

/**
 * 批量索引目录下所有 .md 文件
 */
export async function indexDirectory(
  dirPath: string,
  category: string = "general",
  onProgress?: ProgressCallback
): Promise<{ total: number; indexed: number; skipped: number; errors: number }> {
  const files = await collectMarkdownFiles(dirPath);
  let indexed = 0,
    skipped = 0,
    errors = 0;

  for (const file of files) {
    try {
      const { skipped: s } = await indexFile(file, category, onProgress);
      s ? skipped++ : indexed++;
    } catch (e: any) {
      errors++;
      onProgress?.({ stage: "error", file, message: e.message });
    }
  }

  return { total: files.length, indexed, skipped, errors };
}

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(full)));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(full);
    }
  }
  return files;
}

function extractTitle(md: string): string | null {
  const m = md.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : null;
}

/**
 * 删除文档及其所有 chunks
 */
export async function deleteDocument(filePathOrId: string | number) {
  if (typeof filePathOrId === "number") {
    await sql`DELETE FROM documents WHERE id = ${filePathOrId}`;
  } else {
    await sql`DELETE FROM documents WHERE file_path = ${filePathOrId}`;
  }
}

/**
 * 获取所有文档列表
 */
export async function listDocuments() {
  return sql`
    SELECT
      d.id, d.title, d.file_path, d.category, d.created_at, d.updated_at,
      COUNT(c.id)::int AS chunk_count
    FROM documents d
    LEFT JOIN chunks c ON c.doc_id = d.id
    GROUP BY d.id
    ORDER BY d.updated_at DESC
  `;
}
