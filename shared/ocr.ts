/**
 * shared/ocr.ts
 * 基于 Ollama Vision LLM 的图片内容提取，降级到 tesseract
 */

const OCR_LANG = process.env.OCR_LANG || "chi_sim+eng";
const VISION_MODEL = process.env.VISION_MODEL || "qwen2.5vl:7b";
const VISION_TIMEOUT_MS = parseInt(process.env.VISION_TIMEOUT_MS || "120000", 10);

// EMBEDDING_API_URL 形如 http://localhost:11434/v1，去掉 /v1 后缀得到 Ollama base URL
const OLLAMA_BASE_URL = (process.env.EMBEDDING_API_URL || "http://localhost:11434/v1")
  .replace(/\/v1\/?$/, "");

const VISION_PROMPT = `你是一个专业的文档内容提取助手。请分析这张图片，提取并输出以下内容：

1. 图片中所有可见的文字（保持原始顺序，代码块保留缩进）
2. 如果有表格，转换为 Markdown 表格格式
3. 如果有流程图、架构图或图表，用文字描述其结构和含义
4. 最后一行输出一句整体语义摘要（格式：「摘要：...」）

只输出提取的内容，不要添加解释或前缀。如果图片中没有有意义的内容，输出"（图片内容无法提取）"。`;

async function extractWithVisionLLM(filePath: string): Promise<string> {
  const imageBuffer = await Bun.file(filePath).arrayBuffer();
  const base64Image = Buffer.from(imageBuffer).toString("base64");

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  // mimeType 备用，Ollama 目前靠 base64 自动识别，此处保留供将来扩展
  const _mimeType = mimeMap[ext] ?? "image/jpeg";

  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    body: JSON.stringify({
      model: VISION_MODEL,
      stream: false,
      messages: [
        {
          role: "user",
          content: VISION_PROMPT,
          images: [base64Image],
        },
      ],
      options: {
        temperature: 0.1,
        num_predict: 2048,
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Vision LLM 请求失败: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`
    );
  }

  const data = (await res.json()) as {
    message?: { content?: string };
    error?: string;
  };

  if (data.error) {
    throw new Error(`Ollama 返回错误: ${data.error}`);
  }

  const text = data.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error("Vision LLM 未返回内容");
  }

  return text;
}

async function extractWithTesseract(filePath: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["tesseract", filePath, "stdout", "-l", OCR_LANG],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    const detail = stderrText.trim();
    if (detail.includes("No such file or directory")) {
      throw new Error("未找到 tesseract 命令，请确认已安装并可在 PATH 中访问");
    }
    throw new Error(
      `OCR 失败: ${detail || `tesseract exited with code ${exitCode}`}`
    );
  }

  const text = stdoutText.trim();
  if (!text) {
    throw new Error("OCR 未识别到可用文字");
  }

  return text;
}

export async function extractTextFromImage(filePath: string): Promise<string> {
  try {
    const text = await extractWithVisionLLM(filePath);
    console.log(`[ocr] vision LLM 提取成功，${text.length} 字符`);
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ocr] vision LLM 失败 (${msg})，降级到 tesseract`);
  }

  return extractWithTesseract(filePath);
}

/** 启动时检查 vision model 是否已拉取，在 indexer/index.ts 启动处调用 */
export async function checkVisionModel(): Promise<void> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;

    const data = (await res.json()) as { models?: { name: string }[] };
    const modelBaseName = VISION_MODEL.replace(/:.*$/, "");
    const found = (data.models ?? []).some(
      (m) => m.name === VISION_MODEL || m.name.startsWith(modelBaseName)
    );

    if (!found) {
      console.warn(
        `[ocr] 未找到模型 "${VISION_MODEL}"，请先执行: ollama pull ${VISION_MODEL}`
      );
      console.warn("[ocr] 图片索引将降级使用 tesseract");
    } else {
      console.log(`[ocr] vision model 就绪: ${VISION_MODEL}`);
    }
  } catch {
    console.warn(
      `[ocr] 无法连接 Ollama (${OLLAMA_BASE_URL})，图片索引将降级使用 tesseract`
    );
  }
}
