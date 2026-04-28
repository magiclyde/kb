/**
 * shared/ocr.ts
 * 基于本地 tesseract 命令行的 OCR 文本提取
 */

const OCR_LANG = process.env.OCR_LANG || "chi_sim+eng";

export async function extractTextFromImage(filePath: string): Promise<string> {
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
    throw new Error(`OCR 失败: ${detail || `tesseract exited with code ${exitCode}`}`);
  }

  const text = stdoutText.trim();
  if (!text) {
    throw new Error("OCR 未识别到可用文字");
  }

  return text;
}
