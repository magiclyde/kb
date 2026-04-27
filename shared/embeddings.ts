/**
 * shared/embeddings.ts
 * 向量化工具 — 兼容 Ollama / OpenAI 接口
 */

const EMBEDDING_API_URL =
  process.env.EMBEDDING_API_URL || "http://localhost:11434/v1";
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "ollama";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text";

/**
 * 单条文本向量化
 */
export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${EMBEDDING_API_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API error ${res.status}: ${body}`);
  }

  const data = (await res.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return data.data[0].embedding;
}

/**
 * 批量向量化（自动分批，避免超出 API 限制）
 */
export async function embedBatch(
  texts: string[],
  batchSize = 16
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await fetch(`${EMBEDDING_API_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding batch API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      data: Array<{ index: number; embedding: number[] }>;
    };

    // 按 index 排序确保顺序正确
    const sorted = data.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);

    results.push(...sorted);
    console.log(
      `  向量化进度: ${Math.min(i + batchSize, texts.length)}/${texts.length}`
    );
  }

  return results;
}

/**
 * 格式化为 pgvector 字符串 '[0.1, 0.2, ...]'
 */
export function toVectorString(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
