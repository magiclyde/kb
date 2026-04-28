/**
 * search/index.ts
 * 前端检索服务 — Hono HTTP + SSE 流式回答
 * 端口: SEARCH_PORT (默认 3000)
 */

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { stream } from "hono/streaming";
import { retrieve } from "./retriever";
import { LRUCache } from "./cache";
import { join } from "path";

const app = new Hono();
const PORT = parseInt(process.env.SEARCH_PORT || "3000");

// ── Debug helpers ─────────────────────────────────────────────────────
function isDebugEnabled() {
  const v = (process.env.DEBUG || "").toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ── LLM 配置策略 ──────────────────────────────────────────────────────
const LLM_CONFIG = {
  provider: process.env.LLM_PROVIDER || "ollama", // 可选: 'anthropic' | 'ollama' | 'openai'
  baseUrl: process.env.LLM_API_URL || "http://localhost:11434/v1",
  apiKey: process.env.LLM_API_KEY || "ollama",
  model: process.env.LLM_MODEL || "qwen2.5:7b",
};

// ── /api/ask 缓存（回答级别）───────────────────────────────────────────
type AskCacheValue = {
  sources: Array<{
    id: string;
    docTitle: string;
    heading: string;
    rrfScore: number;
    bm25Score: number | null;
    vectorScore: number | null;
  }>;
  answer: string;
};

const askCache = new LRUCache<string, AskCacheValue>({
  maxSize: parseInt(process.env.ASK_CACHE_MAX_SIZE || process.env.CACHE_MAX_SIZE || "500"),
  ttlMs: parseInt(process.env.ASK_CACHE_TTL_MS || process.env.CACHE_TTL_MS || "600000"), // 默认复用通用缓存配置
});

function makeAskCacheKey(params: {
  q: string;
  category?: string;
  provider: string;
  model: string;
}) {
  const normQ = params.q.trim().toLowerCase();
  return [
    normQ,
    params.category ?? "*",
    params.provider,
    params.model,
  ].join("|");
}

/**
 * 获取特定 Provider 的请求参数
 */
function getProviderSpec(provider: string, systemPrompt: string, userPrompt: string) {
  const specs: Record<string, any> = {
    anthropic: {
      url: `${LLM_CONFIG.baseUrl}/messages`,
      headers: {
        "x-api-key": LLM_CONFIG.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: {
        model: LLM_CONFIG.model,
        max_tokens: 2048,
        stream: true,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      },
      // 解析器：处理 Anthropic 的 SSE 数据块
      parse: (rawJson: any) => {
        if (rawJson.type === "content_block_delta" && rawJson.delta?.type === "text_delta") {
          return rawJson.delta.text;
        }
        return null;
      }
    },
    ollama: { // 以及 OpenAI 兼容接口
      url: `${LLM_CONFIG.baseUrl}/chat/completions`,
      headers: {
        "Authorization": `Bearer ${LLM_CONFIG.apiKey}`,
        "Content-Type": "application/json",
      },
      body: {
        model: LLM_CONFIG.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        stream: true,
      },
      // 解析器：处理 OpenAI/Ollama 的 SSE 数据块
      parse: (rawJson: any) => {
        return rawJson.choices?.[0]?.delta?.content || null;
      }
    }
  };

  return specs[provider] || specs["ollama"];
}


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
  const providerParam = c.req.query("provider") || LLM_CONFIG.provider; // 允许 query 参数动态切换

  if (!query.trim()) {
    return c.json({ ok: false, error: "query is empty" }, 400);
  }

  // 显式声明 SSE，避免浏览器/代理缓冲导致前端读流异常
  c.header("Content-Type", "text/event-stream; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("Connection", "keep-alive");

  return stream(c, async (s) => {
    const send = (type: string, data: unknown) =>
      s.write(`data: ${JSON.stringify({ type, data })}\n\n`);

    const debug = isDebugEnabled();
    const t0 = Date.now();
    const model = LLM_CONFIG.model;
    const askKey = makeAskCacheKey({ q: query, category, provider: providerParam, model });

    try {
      // ── 0. 回答缓存命中：直接回放 SSE ──────────────────────────
      const cachedAsk = askCache.get(askKey);
      if (cachedAsk) {
        send("status", "正在检索知识库…");
        send("sources", cachedAsk.sources);
        send("answer_chunk", cachedAsk.answer);
        send("done", null);
        if (debug) {
          console.log(
            `[ask][cache_hit] q="${query}" total_ms=${Date.now() - t0} sources=${cachedAsk.sources.length}`
          );
        }
        return;
      }

      // ── 1. 检索相关块 ──────────────────────────────────────────
      send("status", "正在检索知识库…");
      const tRetrieveStart = Date.now();
      const chunks = await retrieve(query, { topK: 5, category });
      const tRetrieveEnd = Date.now();

      if (chunks.length === 0) {
        send("answer_chunk", "抱歉，知识库中没有找到与您问题相关的内容。");
        send("done", null);
        if (debug) {
          console.log(
            `[ask][no_sources] q="${query}" retrieve_ms=${tRetrieveEnd - tRetrieveStart} total_ms=${Date.now() - t0}`
          );
        }
        return;
      }

      const sources = chunks.map(c => ({
        id: String(c.id),
        docTitle: c.docTitle,
        heading: c.heading,
        rrfScore: c.rrfScore,
        bm25Score: c.bm25Score,
        vectorScore: c.vectorScore,
      }));
      send("sources", sources);

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

      // ── 3. 获取 Provider 具体的请求规格, 调用 LLM 流式输出 ────────────────────────────────────
      const spec = getProviderSpec(providerParam, systemPrompt, userPrompt);
      send("status", `正在调用 ${providerParam} 生成回答…`);

      const llmTimeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || "120000");
      const aborter = new AbortController();
      const timeout = setTimeout(() => aborter.abort(), llmTimeoutMs);
      const tLlmStart = Date.now();
      const llmRes = await fetch(spec.url, {
        method: "POST",
        headers: spec.headers,
        body: JSON.stringify(spec.body),
        signal: aborter.signal,
      }).finally(() => clearTimeout(timeout));

      if (!llmRes.ok) {
        const err = await llmRes.text();
        send("error", `LLM error: ${err}`);
        send("done", null);
        if (debug) {
          console.log(
            `[ask][llm_error] q="${query}" retrieve_ms=${tRetrieveEnd - tRetrieveStart} llm_ms=${Date.now() - tLlmStart} total_ms=${Date.now() - t0}`
          );
        }
        return;
      }

      // ── 4. 通用流式解析逻辑 (SSE: data: <json>) ─────────────────────
      const reader = llmRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let answerText = "";
      let tFirstToken: number | null = null;

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
            const delta = spec.parse(evt);
            if (delta) {
              if (tFirstToken === null) tFirstToken = Date.now();
              answerText += delta;
              send("answer_chunk", delta);
            }
          } catch {}
        }
      }

      send("done", null);
      // 仅在成功完成后写入回答缓存
      if (answerText.trim().length > 0) {
        askCache.set(askKey, { sources, answer: answerText });
      }

      if (debug) {
        const tEnd = Date.now();
        const firstTokenMs = tFirstToken ? tFirstToken - tLlmStart : null;
        console.log(
          `[ask][ok] q="${query}" retrieve_ms=${tRetrieveEnd - tRetrieveStart} llm_first_token_ms=${firstTokenMs ?? "null"} llm_ms=${tEnd - tLlmStart} total_ms=${tEnd - t0}`
        );
      }
    } catch (e: any) {
      send("error", e.message);
      send("done", null);
      if (debug) {
        console.log(`[ask][exception] q="${query}" total_ms=${Date.now() - t0} err="${e?.message || e}"`);
      }
    }
  });
});

console.log(`🔍 检索服务启动: http://localhost:${PORT}`);

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 60,
};
