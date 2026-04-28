# 技术知识库 (ParadeDB + Bun)

## 项目结构

```
kb/
├── package.json           # 根 package（workspace）
├── .env.example
├── shared/
│   ├── db.ts              # 数据库连接 + schema
│   ├── embeddings.ts      # 向量化工具（Ollama / OpenAI 兼容接口）
│   └── ocr.ts             # 基于 tesseract 的图片 OCR
├── indexer/               # 后台管理服务 (port 3001)
│   ├── index.ts
│   ├── chunker.ts         # Markdown 按 ## 切分 + overlap
│   ├── pipeline.ts        # Markdown / 图片 OCR 索引 pipeline
│   └── public/
│       └── admin.html     # 后台 UI
└── search/                # 前端检索服务 (port 3000)
    ├── index.ts
    ├── retriever.ts       # 全文 + 向量混合检索 + RRF 精排
    └── public/
        └── index.html     # 检索 UI
```

## 快速启动

```bash
# 1. 安装依赖
bun install

# 2. 安装 OCR 依赖（Ubuntu）
sudo apt install tesseract-ocr tesseract-ocr-chi-sim

# 3. 初始化数据库表
bun run db:init

# 4. 启动后台管理（索引）
bun run dev:indexer

# 5. 启动前端检索
bun run dev:search
```

## 环境变量

```env
DATABASE_URL=postgres://user:pass@localhost:5432/knowledge_base
EMBEDDING_API_URL=http://localhost:11434/v1   # Ollama 或 OpenAI 兼容
EMBEDDING_API_KEY=ollama
EMBEDDING_MODEL=nomic-embed-text:v1.5
EMBEDDING_DIM=768
LLM_PROVIDER=ollama
LLM_API_URL=http://localhost:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:7b
OCR_LANG=chi_sim+eng

# 通用缓存配置（检索缓存与 /api/ask 回答缓存默认共用）
CACHE_MAX_SIZE=500
CACHE_TTL_MS=600000

# 如需单独覆盖 /api/ask 的回答缓存，再按需添加：
# ASK_CACHE_MAX_SIZE=200
# ASK_CACHE_TTL_MS=600000

# Debug（仅在 DEBUG 时打印检索 / LLM 分阶段耗时日志）
DEBUG=false
```

## 缓存说明

- `search/retriever.ts` 会缓存重复查询的检索结果，减少 Postgres 检索与 embedding 压力。
- `search/index.ts` 会缓存 `/api/ask` 的最终回答，命中后可直接回放相同的来源与回答内容。
- 默认情况下，两层缓存共用 `CACHE_MAX_SIZE` / `CACHE_TTL_MS`；只有在需要细分时，才配置 `ASK_CACHE_*` 覆盖回答缓存。
- 将 `DEBUG=true` 写入 `.env` 后，可在控制台看到 `retrieve_ms`、`llm_first_token_ms`、`llm_ms`、`total_ms` 等阶段耗时。

## OCR 索引

- `indexer` 现在支持索引 `.md`、`.png`、`.jpg`、`.jpeg`、`.webp` 文件。
- 图片会先通过本地 `tesseract` 提取文字，再转成 Markdown 文本进入现有 chunk / embedding / ParadeDB 流程。
- `documents.source_type` 会区分 `markdown` 和 `image_ocr` 两种来源。
