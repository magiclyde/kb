# ==============================================================
# 基于 ParadeDB 官方镜像（已内置 pg_search + pgvector）
# 锁定版本：paradedb 0.22.5 + PostgreSQL 17
# 升级时同步修改此处和 docker-compose.yml 中的 PARADEDB_VERSION
# 完整 tag 列表：https://hub.docker.com/r/paradedb/paradedb/tags
# ==============================================================
ARG PARADEDB_VERSION=0.22.5-pg17
FROM paradedb/paradedb:${PARADEDB_VERSION}

# PG 主版本号，与上方 tag 中的 pg 版本保持一致
ARG PG_MAJOR=17

LABEL org.opencontainers.image.title="kb-paradedb"
LABEL org.opencontainers.image.description="ParadeDB ${PARADEDB_VERSION} for knowledge base search"
LABEL paradedb.version="${PARADEDB_VERSION}"

# --------------------------------------------------------------
# 安装额外 extension
# PGDG apt 源在 paradedb 基础镜像中已配置好，可直接使用
# 按需取消注释，添加后重新 docker compose build
# --------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
    # -- 定时任务（paradedb 已内置 pg_cron，仅作示例）
    # postgresql-${PG_MAJOR}-cron \
    #
    # -- 时序数据扩展
    # timescaledb-2-postgresql-${PG_MAJOR} \
    #
    # -- 图数据扩展（文档关系图谱）
    # postgresql-${PG_MAJOR}-age \
    #
    # 占位：保证 apt-get 不因空参数报错
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# --------------------------------------------------------------
# 自定义 postgresql.conf
# paradedb 基础镜像已设置：
#   shared_preload_libraries = 'pg_search,pg_cron,pg_stat_statements'
# 如新增需要 preload 的 extension，在 custom.conf 中追加
# --------------------------------------------------------------
COPY conf/custom.conf /etc/postgresql/custom.conf
RUN echo "" >> /usr/share/postgresql/postgresql.conf.sample \
    && echo "# custom overrides" >> /usr/share/postgresql/postgresql.conf.sample \
    && echo "include = '/etc/postgresql/custom.conf'" \
       >> /usr/share/postgresql/postgresql.conf.sample

# --------------------------------------------------------------
# 初始化 SQL：仅在数据目录首次创建时执行，重启不重复执行
# 多个文件按文件名字母序执行
# --------------------------------------------------------------
COPY initdb/ /docker-entrypoint-initdb.d/
