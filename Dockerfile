# syntax=docker/dockerfile:1.7

# Multi-stage build producing a minimal runtime image. The builder stage installs
# dependencies (including dev tools for TypeScript) and compiles both the main
# orchestrator bundle and the graph-forge helpers.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . ./
RUN npm run build

# Distroless runtime containing only the production dependencies and compiled
# assets. The resulting image has a small attack surface while keeping startup
# times fast.
FROM gcr.io/distroless/nodejs20-debian12 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/graph-forge/dist ./graph-forge/dist
COPY --from=builder /app/package.json ./package.json
ENTRYPOINT ["node", "dist/server.js"]
