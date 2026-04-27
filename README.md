# 技术知识库 (ParadeDB + Bun)

## 项目结构

```
kb/
├── package.json           # 根 package（workspace）
├── .env.example
├── shared/
│   ├── db.ts              # 数据库连接 + schema
│   └── embeddings.ts      # 向量化工具（Ollama / OpenAI 兼容接口）
├── indexer/               # 后台管理服务 (port 3001)
│   ├── index.ts
│   ├── chunker.ts         # Markdown 按 ## 切分 + overlap
│   ├── pipeline.ts        # 索引 pipeline
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

# 2. 初始化数据库表
bun run db:init

# 3. 启动后台管理（索引）
bun run dev:indexer

# 4. 启动前端检索
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
```
