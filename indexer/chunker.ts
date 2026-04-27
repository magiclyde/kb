/**
 * indexer/chunker.ts
 * Markdown 按 ## 二级标题切分 + overlap 保留上下文
 */

export interface Chunk {
  heading: string;       // 所属 ## 标题（含父级 # 标题）
  content: string;       // 原始 Markdown
  plainText: string;     // 去标记的纯文本
  tokenCount: number;    // 估算 token 数
}

/**
 * 按 ## 标题切分 Markdown，并为每个块附加上下文 overlap
 *
 * overlap 策略：
 *   - 每个 chunk 头部附加上一个 chunk 末尾的 overlapLines 行
 *   - 每个 chunk 尾部附加下一个 chunk 开头的 overlapLines 行
 */
export function chunkMarkdown(
  content: string,
  options: {
    overlapLines?: number;   // 上下各保留多少行作为重叠（默认 3）
    minChunkLength?: number; // 最小块长度，过短的块合并到前一个（默认 100）
  } = {}
): Chunk[] {
  const { overlapLines = 3, minChunkLength = 100 } = options;

  // ── 1. 提取文档级 # 一级标题 ──────────────────────────────────────
  const h1Match = content.match(/^#\s+(.+)/m);
  const docTitle = h1Match ? h1Match[1].trim() : "";

  // ── 2. 按 ## 切分原始块 ───────────────────────────────────────────
  const rawChunks = splitByH2(content);

  // ── 3. 过滤过短的块，合并到前一个 ────────────────────────────────
  const merged = mergeShortChunks(rawChunks, minChunkLength);

  // ── 4. 为每个块添加 overlap ───────────────────────────────────────
  const withOverlap = addOverlap(merged, overlapLines);

  // ── 5. 构建最终 Chunk 对象 ────────────────────────────────────────
  return withOverlap.map(({ heading, lines }) => {
    const raw = lines.join("\n").trim();
    const fullHeading = docTitle ? `${docTitle} > ${heading}` : heading;
    const plain = stripMarkdown(raw);
    return {
      heading: fullHeading,
      content: raw,
      plainText: plain,
      tokenCount: estimateTokens(plain),
    };
  });
}

// ── 内部工具函数 ──────────────────────────────────────────────────────

interface RawChunk {
  heading: string;
  lines: string[];
}

/** 按 ## 边界切分 */
function splitByH2(content: string): RawChunk[] {
  const lines = content.split("\n");
  const chunks: RawChunk[] = [];
  let currentHeading = "__preamble__";
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      if (currentLines.length > 0) {
        chunks.push({ heading: currentHeading, lines: [...currentLines] });
      }
      currentHeading = h2Match[1].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    chunks.push({ heading: currentHeading, lines: currentLines });
  }

  return chunks;
}

/** 合并过短的块 */
function mergeShortChunks(chunks: RawChunk[], minLen: number): RawChunk[] {
  const result: RawChunk[] = [];
  for (const chunk of chunks) {
    const text = chunk.lines.join("\n").trim();
    if (text.length < minLen && result.length > 0) {
      // 合并到前一个块
      const prev = result[result.length - 1];
      prev.lines.push("", ...chunk.lines);
      prev.heading = `${prev.heading} / ${chunk.heading}`;
    } else {
      result.push({ ...chunk, lines: [...chunk.lines] });
    }
  }
  return result;
}

/** 为每个块的首尾加入相邻块的重叠行 */
function addOverlap(chunks: RawChunk[], n: number): RawChunk[] {
  if (n <= 0 || chunks.length <= 1) return chunks;

  return chunks.map((chunk, i) => {
    const prevTail =
      i > 0
        ? chunks[i - 1].lines.slice(-n).map((l) => `<!-- overlap:prev --> ${l}`)
        : [];
    const nextHead =
      i < chunks.length - 1
        ? chunks[i + 1].lines.slice(0, n).map((l) => `<!-- overlap:next --> ${l}`)
        : [];

    return {
      heading: chunk.heading,
      lines: [...prevTail, ...chunk.lines, ...nextHead],
    };
  });
}

/** 去除 Markdown 标记，保留纯文本 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/<!--.*?-->/gs, "")        // HTML 注释（overlap 标记）
    .replace(/^#{1,6}\s+/gm, "")        // 标题 #
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")  // 图片 → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // 链接 → text
    .replace(/`{3}[\s\S]*?`{3}/g, "")   // 代码块
    .replace(/`([^`]+)`/g, "$1")         // 行内代码
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // 粗体
    .replace(/(\*|_)(.*?)\1/g, "$2")    // 斜体
    .replace(/~~(.*?)~~/g, "$1")         // 删除线
    .replace(/^[-*+]\s+/gm, "")          // 无序列表
    .replace(/^\d+\.\s+/gm, "")          // 有序列表
    .replace(/^>\s+/gm, "")              // 引用
    .replace(/[-]{3,}/g, "")             // 分隔线
    .replace(/\|[^\n]+\|/g, "")          // 表格行
    .replace(/\n{3,}/g, "\n\n")          // 多余空行
    .trim();
}

/** 估算 token 数（粗略：中文 1字=1token，英文 4字符=1token）*/
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const ascii = text.length - cjk;
  return cjk + Math.ceil(ascii / 4);
}
