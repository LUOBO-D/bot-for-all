# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Production image for the SPA: Vite build served by Nginx, which also proxies
# /api and /socket.io to the `backend` service.
#
# Build context is the repository root (pnpm workspace):
#   docker build -f frontend/Dockerfile -t bot-for-all-web .
# ---------------------------------------------------------------------------

# ---- build: vue-tsc --noEmit && vite build -> frontend/dist ----
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
    && corepack prepare pnpm@11.22.0 --activate \
    && pnpm config set store-dir /pnpm/store
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter frontend...

COPY frontend/ frontend/
RUN pnpm --filter frontend build

# ---- runtime: static files + reverse proxy ----
FROM nginx:alpine AS runtime
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
