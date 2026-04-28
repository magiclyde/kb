/**
 * indexer/index.ts
 * 后台管理服务 — Hono HTTP API
 * 端口: INDEXER_PORT (默认 3001)
 */

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { stream } from "hono/streaming";
import {
  indexFile,
  indexDirectory,
  deleteDocument,
  listDocuments,
} from "./pipeline";
import { initSchema } from "../shared/db";
import { sql } from "../shared/db";
import { join } from "path";

const app = new Hono();
const PORT = parseInt(process.env.INDEXER_PORT || "3001");
const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ".md",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
]);

// ── 静态文件 ──────────────────────────────────────────────────────────
app.use("/static/*", serveStatic({ root: "./indexer" }));

// ── HTML 管理界面 ─────────────────────────────────────────────────────
app.get("/", async (c) => {
  const html = await Bun.file(
    join(import.meta.dir, "public/admin.html")
  ).text();
  return c.html(html);
});

// ── API: 初始化 Schema ────────────────────────────────────────────────
app.post("/api/init", async (c) => {
  try {
    await initSchema();
    return c.json({ ok: true, message: "Schema 初始化成功" });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ── API: 列出文档 ─────────────────────────────────────────────────────
app.get("/api/documents", async (c) => {
  try {
    const docs = await listDocuments();
    return c.json({ ok: true, data: docs });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ── API: 删除文档 ─────────────────────────────────────────────────────
app.delete("/api/documents/:id", async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    await deleteDocument(id);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ── API: 索引单文件（SSE 实时进度）────────────────────────────────────
app.post("/api/index/file", async (c) => {
  const body = await c.req.json<{ path: string; category?: string }>();

  return stream(c, async (s) => {
    const send = (data: object) =>
      s.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await indexFile(
        body.path,
        body.category || "general",
        (p) => send(p)
      );
      send({ stage: "done", result });
    } catch (e: any) {
      send({ stage: "error", message: e.message });
    }
  });
});

// ── API: 索引目录（SSE 实时进度）──────────────────────────────────────
app.post("/api/index/directory", async (c) => {
  const body = await c.req.json<{ path: string; category?: string }>();

  return stream(c, async (s) => {
    const send = (data: object) =>
      s.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await indexDirectory(
        body.path,
        body.category || "general",
        (p) => send(p)
      );
      send({ stage: "done", result });
    } catch (e: any) {
      send({ stage: "error", message: e.message });
    }
  });
});

// ── API: 上传并索引 Markdown / 图片文件 ───────────────────────────────
app.post("/api/upload", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const category = (formData.get("category") as string) || "general";

  if (!file) return c.json({ ok: false, error: "No file" }, 400);
  const ext = getFileExtension(file.name);
  if (!SUPPORTED_UPLOAD_EXTENSIONS.has(ext)) {
    return c.json(
      { ok: false, error: "仅支持 .md、.png、.jpg、.jpeg、.webp 文件" },
      400
    );
  }

  // 保存到临时目录
  const tmpPath = join("/tmp", `kb_upload_${Date.now()}_${file.name}`);
  await Bun.write(tmpPath, await file.arrayBuffer());

  return stream(c, async (s) => {
    const send = (data: object) =>
      s.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      const result = await indexFile(tmpPath, category, (p) => send(p));
      send({ stage: "done", result, fileName: file.name });
    } catch (e: any) {
      send({ stage: "error", message: e.message });
    }
  });
});

// ── API: 统计 ──────────────────────────────────────────────────────────
app.get("/api/stats", async (c) => {
  try {
    const [stats] = await sql`
      SELECT
        (SELECT COUNT(*) FROM documents)::int AS doc_count,
        (SELECT COUNT(*) FROM chunks)::int    AS chunk_count,
        (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL)::int AS embedded_count
    `;
    return c.json({ ok: true, data: stats });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

console.log(`🚀 后台管理服务启动: http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};

function getFileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}
