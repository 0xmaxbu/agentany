# agentany prod 镜像（PRD M3：Docker + Linux/bwrap 对等）。
#
# 形态：单容器跑 server（Hono + bridge 3199）+ pi 子进程（bwrap 沙箱）。
# ⚠ web 前端目前 dev 分离部署（vite 5173），server 不托管静态——prod 需 nginx 反代托管 web/dist
#   或开「server 托管静态」票（见 M3 收尾注）。dist 已构建在 web-stage，可被 compose/nginx 挂用。
# bwrap 需 user namespace → 运行时需 --security-opt seccomp=unconfined（允许 clone(CLONE_NEWUSER)）+ /data 卷。
#
# 构建：docker build -t agentany .
# 运行（最小）：docker run -p 3000:3000 -v agentany-data:/data --security-opt seccomp=unconfined agentany
# （compose 已封装，见 docker-compose.yml）

# ---- 前端构建（独立 stage，产物供反代/挂载）----
FROM oven/bun:1.3-debian AS web
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile || bun install
COPY apps/web apps/web
RUN cd apps/web && bun run build

# ---- 运行镜像 ----
FROM oven/bun:1.3-debian AS run
WORKDIR /app

# bwrap（pi 沙箱）+ git（运行时数据版本管理，PRD M5）+ ca 证书。
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    bubblewrap git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# workspace 根 install（lockfile 覆盖 apps/*，--production 会让 workspace 解析失败）
RUN bun install --frozen-lockfile
COPY apps/server apps/server
COPY skills /app/skills
COPY chat /app/chat

# 数据卷：DB + workspaces + pi sessions + 运行时 git 仓（skills 可写副本按 M5 落地，先占位）。
ENV DATA_DIR=/data \
    NODE_ENV=production \
    HOST=0.0.0.0
VOLUME /data

EXPOSE 3000 3199
WORKDIR /app/apps/server
CMD ["bun", "run", "src/index.ts"]
