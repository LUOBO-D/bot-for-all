# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Production image for the API + Socket.IO server.
#
# Build context is the repository root (pnpm workspace):
#   docker build -f backend/Dockerfile -t bot-for-all-backend .
# ---------------------------------------------------------------------------

# ---- base: Node 24 with the pnpm release that produced pnpm-lock.yaml ----
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
    && corepack prepare pnpm@11.22.0 --activate \
    && pnpm config set store-dir /pnpm/store
WORKDIR /app

# ---- deps: only the manifests, so editing source does not re-install ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter backend...

# ---- build: tsc -> backend/dist ----
FROM deps AS build
COPY backend/tsconfig.json backend/tsconfig.json
COPY backend/src backend/src
RUN pnpm --filter backend build

# ---- prod-deps: same workspace, dev dependencies pruned ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter backend...

# ---- runtime ----
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# pnpm keeps real packages in /app/node_modules/.pnpm and symlinks them from
# /app/backend/node_modules; both are copied so the relative links stay valid.
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/backend/node_modules /app/backend/node_modules
COPY --from=build /app/backend/dist /app/backend/dist
COPY backend/package.json /app/backend/package.json

# migrate-core resolves migrations at <cwd>/../db/migrations.
COPY db/migrations /app/db/migrations

# WORKDIR matches the layout the migration resolver expects, and matches the
# dev checkout (backend/ next to db/).
WORKDIR /app/backend
# Create the attachment directory with the runtime user's ownership; the named
# volume mounted here inherits it on first use, so uploads stay writable.
RUN mkdir -p /app/backend/uploads && chown node:node /app/backend/uploads
USER node
EXPOSE 3000

# `exec` replaces the shell so node becomes PID 1 and receives SIGTERM directly
# (graceful shutdown drains sockets and the MySQL pool).
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/index.js"]
