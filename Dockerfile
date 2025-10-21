# syntax=docker/dockerfile:1.7

# Multi-stage build producing a minimal runtime image. The builder stage installs
# dependencies (including dev tools for TypeScript) and compiles both the main
# orchestrator bundle and the graph-forge helpers.
FROM node:20-alpine AS builder
WORKDIR /app
# Install common build tooling so optional native dependencies (for example the
# local vector memory backend) can compile deterministically when the image is
# built in CI or on developer workstations.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . ./
# Compile the TypeScript sources before pruning development dependencies so the
# runtime stage only receives the production tree and keeps the final image
# lightweight.
RUN npm run build \
  && npm prune --omit=dev

# Distroless runtime containing only the production dependencies and compiled
# assets. The resulting image has a small attack surface while keeping startup
# times fast.
FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app

# Runtime knobs exposed via ARG so callers can override them at build time when
# producing hardened images. Each ARG is mirrored into ENV so operators can rely
# on the usual environment overrides at runtime without editing the Dockerfile.
ARG MCP_HTTP_HOST=0.0.0.0
ARG MCP_HTTP_PORT=8765
ARG MCP_HTTP_PATH=/mcp
ARG MCP_HTTP_STATELESS=yes
ARG MCP_HTTP_TOKEN
ARG MCP_HTTP_ALLOW_NOAUTH=0
ARG MCP_HTTP_RATE_LIMIT_DISABLE=0
ARG MCP_HTTP_RATE_LIMIT_RPS=10
ARG MCP_HTTP_RATE_LIMIT_BURST=20
ARG MEM_BACKEND=local
ARG MEM_URL
ARG EMBED_PROVIDER=openai
ARG RETRIEVER_K=5
ARG HYBRID_BM25=0
ARG TOOLROUTER_TOPK=5
ARG LESSONS_MAX=3
ARG THOUGHTGRAPH_MAX_BRANCHES=6
ARG THOUGHTGRAPH_MAX_DEPTH=4
ARG MCP_DASHBOARD_HOST=0.0.0.0
ARG MCP_DASHBOARD_PORT=4100
ARG MCP_DASHBOARD_INTERVAL_MS=2000

ENV NODE_ENV=production
ENV MCP_HTTP_HOST=${MCP_HTTP_HOST}
ENV MCP_HTTP_PORT=${MCP_HTTP_PORT}
ENV MCP_HTTP_PATH=${MCP_HTTP_PATH}
ENV MCP_HTTP_STATELESS=${MCP_HTTP_STATELESS}
ENV MCP_HTTP_TOKEN=${MCP_HTTP_TOKEN}
ENV MCP_HTTP_ALLOW_NOAUTH=${MCP_HTTP_ALLOW_NOAUTH}
ENV MCP_HTTP_RATE_LIMIT_DISABLE=${MCP_HTTP_RATE_LIMIT_DISABLE}
ENV MCP_HTTP_RATE_LIMIT_RPS=${MCP_HTTP_RATE_LIMIT_RPS}
ENV MCP_HTTP_RATE_LIMIT_BURST=${MCP_HTTP_RATE_LIMIT_BURST}
ENV MEM_BACKEND=${MEM_BACKEND}
ENV MEM_URL=${MEM_URL}
ENV EMBED_PROVIDER=${EMBED_PROVIDER}
ENV RETRIEVER_K=${RETRIEVER_K}
ENV HYBRID_BM25=${HYBRID_BM25}
ENV TOOLROUTER_TOPK=${TOOLROUTER_TOPK}
ENV LESSONS_MAX=${LESSONS_MAX}
ENV THOUGHTGRAPH_MAX_BRANCHES=${THOUGHTGRAPH_MAX_BRANCHES}
ENV THOUGHTGRAPH_MAX_DEPTH=${THOUGHTGRAPH_MAX_DEPTH}
ENV MCP_DASHBOARD_HOST=${MCP_DASHBOARD_HOST}
ENV MCP_DASHBOARD_PORT=${MCP_DASHBOARD_PORT}
ENV MCP_DASHBOARD_INTERVAL_MS=${MCP_DASHBOARD_INTERVAL_MS}

# Copy only the production dependency tree trimmed by `npm prune --omit=dev` so
# the runtime image does not embed the TypeScript toolchain or linting stack.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/graph-forge/dist ./graph-forge/dist
COPY --from=builder /app/package.json ./package.json

# The MCP transport listens on 8765 by default and the dashboard is exposed on
# 4100. Both ports are documented for convenience so `docker run -P` publishes
# the endpoints automatically.
EXPOSE 8765 4100
# Distroless Node images expose the runtime binary at /nodejs/bin/node instead of
# adding it to PATH. Use the absolute location so docker run works without
# overriding the entrypoint.
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/server.js"]
