/**
 * indexer/pipeline.ts
 * 索引 Pipeline: 读取 Markdown / 图片 OCR → Chunk → Embed → Upsert ParadeDB
 */

import { sql } from "../shared/db";
import { embedBatch, toVectorString } from "../shared/embeddings";
import { extractTextFromImage } from "../shared/ocr";
import { chunkMarkdown } from "./chunker";
import { createHash } from "crypto";
import { readdir, readFile } from "fs/promises";
import type { TransactionSql } from "postgres";
import { join, extname, basename } from "path";

type SourceType = "markdown" | "image_ocr";

const MARKDOWN_EXTENSIONS = new Set([".md"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface IndexProgress {
  stage: "scan" | "ocr" | "chunk" | "embed" | "upsert" | "done" | "error";
  file?: string;
  total?: number;
  current?: number;
  message?: string;
}

export type ProgressCallback = (p: IndexProgress) => void;

/**
 * 索引单个 Markdown / 图片文件
 */
export async function indexFile(
  filePath: string,
  category: string = "general",
  onProgress?: ProgressCallback
): Promise<{ chunksInserted: number; skipped: boolean }> {
  const report = (p: IndexProgress) => onProgress?.(p);

  const document = await loadIndexableDocument(filePath, report);
  const rawContent = document.content;
  const fileHash = document.fileHash;
  const title = document.title;
  const fileName = filePath;

  report({
    stage: "scan",
    file: filePath,
    message: `读取${document.sourceType === "image_ocr" ? "图片" : "文件"}: ${title}`,
  });

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
        source_type = ${document.sourceType},
        category = ${category},
        updated_at = NOW()
      WHERE id = ${existing[0].id}
    `;
    docId = existing[0].id;
    report({ stage: "scan", file: filePath, message: "文件已变更，重新索引" });
  } else {
    // 新文档
    const [doc] = await sql`
      INSERT INTO documents (title, file_path, file_hash, source_type, category)
      VALUES (${title}, ${fileName}, ${fileHash}, ${document.sourceType}, ${category})
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

  await sql.begin(async (tx: TransactionSql<Record<string, unknown>>) => {
    for (const [i, chunk] of chunks.entries()) {
      const vec = toVectorString(embeddings[i]!);

      await tx`
        INSERT INTO chunks (doc_id, chunk_index, heading, content, plain_text, embedding, token_count)
        VALUES (
          ${docId}, ${i}, ${chunk.heading}, ${chunk.content},
          ${chunk.plainText}, ${vec}::vector, ${chunk.tokenCount}
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
  const files = await collectIndexableFiles(dirPath);
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

async function collectIndexableFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectIndexableFiles(full)));
    } else if (entry.isFile() && isIndexableFile(full)) {
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
      d.id, d.title, d.file_path, d.source_type, d.category, d.created_at, d.updated_at,
      COUNT(c.id)::int AS chunk_count
    FROM documents d
    LEFT JOIN chunks c ON c.doc_id = d.id
    GROUP BY d.id
    ORDER BY d.updated_at DESC
  `;
}

function isIndexableFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

async function loadIndexableDocument(
  filePath: string,
  report: ProgressCallback
): Promise<{
  sourceType: SourceType;
  title: string;
  content: string;
  fileHash: string;
}> {
  const ext = extname(filePath).toLowerCase();
  const fileName = basename(filePath, ext);

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    const rawContent = await readFile(filePath, "utf-8");
    return {
      sourceType: "markdown",
      title: extractTitle(rawContent) || fileName,
      content: rawContent,
      fileHash: createHash("md5").update(rawContent).digest("hex"),
    };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    report({ stage: "ocr", file: filePath, message: "正在识别图片文字..." });
    const imageBuffer = await readFile(filePath);
    const ocrText = await extractTextFromImage(filePath);
    const markdown = buildOcrMarkdown(filePath, fileName, ocrText);
    return {
      sourceType: "image_ocr",
      title: fileName,
      content: markdown,
      fileHash: createHash("md5").update(imageBuffer).digest("hex"),
    };
  }

  throw new Error(`不支持的文件类型: ${ext || filePath}`);
}

function buildOcrMarkdown(filePath: string, title: string, ocrText: string): string {
  return [
    `# ${title}`,
    "",
    "## OCR 提取内容",
    "",
    ocrText.trim(),
    "",
    "## 来源信息",
    "",
    `- source_type: image_ocr`,
    `- original_file: ${filePath}`,
  ].join("\n");
}
