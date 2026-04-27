-- ==============================================================
-- 首次初始化脚本：仅执行一次
-- ==============================================================

-- --------------------------------------------------------------
-- 启用 extensions
-- --------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;               -- pgvector 向量搜索
CREATE EXTENSION IF NOT EXISTS pg_search;            -- ParadeDB BM25 全文搜索
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;   -- SQL 性能统计

-- 可选：创建应用专用角色（权限最小化）
-- CREATE ROLE kb_app LOGIN PASSWORD 'changeme';
-- GRANT CONNECT ON DATABASE knowledge_base TO kb_app;
