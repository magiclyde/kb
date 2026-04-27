/**
 * search/index.ts
 * 前端检索服务 — Hono HTTP + SSE 流式回答
 * 端口: SEARCH_PORT (默认 3000)
 */

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { stream } from "hono/streaming";
import { retrieve } from "./retriever";
import { join } from "path";

const app = new Hono();
const PORT = parseInt(process.env.SEARCH_PORT || "3000");

const LLM_API_URL = process.env.LLM_API_URL || "https://api.anthropic.com/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || "";

// ── 静态文件 ──────────────────────────────────────────────────────────
app.use("/static/*", serveStatic({ root: "./search" }));

// ── 主页 ──────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const html = await Bun.file(
    join(import.meta.dir, "public/index.html")
  ).text();
  return c.html(html);
});

// ── API: 纯检索（不生成回答）─────────────────────────────────────────
app.get("/api/search", async (c) => {
  const query = c.req.query("q") || "";
  const category = c.req.query("category") || undefined;
  const topK = parseInt(c.req.query("k") || "5");

  if (!query.trim()) return c.json({ ok: false, error: "query is empty" }, 400);

  try {
    const results = await retrieve(query, { topK, category });
    return c.json({ ok: true, data: results });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

// ── API: RAG 流式回答 (SSE) ───────────────────────────────────────────
app.get("/api/ask", async (c) => {
  const query = c.req.query("q") || "";
  const category = c.req.query("category") || undefined;

  if (!query.trim()) {
    return c.json({ ok: false, error: "query is empty" }, 400);
  }

  return stream(c, async (s) => {
    const send = (type: string, data: unknown) =>
      s.write(`data: ${JSON.stringify({ type, data })}\n\n`);

    try {
      // ── 1. 检索相关块 ──────────────────────────────────────────
      send("status", "正在检索知识库…");
      const chunks = await retrieve(query, { topK: 5, category });

      if (chunks.length === 0) {
        send("answer_chunk", "抱歉，知识库中没有找到与您问题相关的内容。");
        send("done", null);
        return;
      }

      send("sources", chunks.map(c => ({
        id: String(c.id),
        docTitle: c.docTitle,
        heading: c.heading,
        rrfScore: c.rrfScore,
        bm25Score: c.bm25Score,
        vectorScore: c.vectorScore,
      })));

      // ── 2. 构建 Prompt ─────────────────────────────────────────
      const context = chunks
        .map((c, i) =>
          `[${i + 1}] 来源: ${c.docTitle} > ${c.heading}\n${c.plainText}`
        )
        .join("\n\n---\n\n");

      const systemPrompt = `你是一个技术文档问答助手。根据提供的文档片段，准确、简洁地回答用户问题。
- 回答基于文档内容，如文档未涉及请明确说明
- 使用 Markdown 格式，代码用代码块
- 引用来源时用 [1]、[2] 等编号
- 中文回答`;

      const userPrompt = `文档片段:\n${context}\n\n问题: ${query}`;

      // ── 3. 调用 LLM 流式输出 ────────────────────────────────────
      send("status", "正在生成回答…");

      if (!LLM_API_KEY) {
        // 没有 LLM 配置时，直接返回最相关的块内容
        send("answer_chunk", `根据知识库检索到以下相关内容：\n\n`);
        for (const chunk of chunks.slice(0, 3)) {
          send("answer_chunk", `**${chunk.docTitle} > ${chunk.heading}**\n\n${chunk.plainText}\n\n---\n\n`);
        }
        send("done", null);
        return;
      }

      const llmRes = await fetch(`${LLM_API_URL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": LLM_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          max_tokens: 2048,
          stream: true,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!llmRes.ok) {
        const err = await llmRes.text();
        send("error", `LLM error: ${err}`);
        send("done", null);
        return;
      }

      const reader = llmRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              send("answer_chunk", evt.delta.text);
            }
          } catch {}
        }
      }

      send("done", null);
    } catch (e: any) {
      send("error", e.message);
      send("done", null);
    }
  });
});

console.log(`🔍 检索服务启动: http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
};
