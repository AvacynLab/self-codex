import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { expect } from "chai";

// Tests in this file ensure the Docker image keeps exposing the knobs that the
// orchestrator relies on (ports, feature flags, RAG controls). The assertions
// make sure future refactors do not accidentally drop the documented
// environment variables or the exposed ports used by MCP clients and the
// dashboard UI.

const here = dirname(fileURLToPath(import.meta.url));
const dockerfilePath = resolve(here, "../../Dockerfile");
const dockerfileContents = readFileSync(dockerfilePath, "utf8");

describe("Dockerfile runtime configuration", () => {
  it("installs build tooling for optional native dependencies", () => {
    expect(dockerfileContents).to.include("apk add --no-cache python3 make g++");
  });

  it("exposes the MCP transport and dashboard ports", () => {
    expect(dockerfileContents).to.match(/EXPOSE\s+8765\s+4100/);
  });

  it("declares build arguments for runtime feature toggles", () => {
    const requiredArgs = [
      "MCP_HTTP_HOST",
      "MCP_HTTP_PORT",
      "MCP_HTTP_PATH",
      "MCP_HTTP_STATELESS",
      "MCP_HTTP_ALLOW_NOAUTH",
      "MCP_HTTP_RATE_LIMIT_RPS",
      "MCP_HTTP_RATE_LIMIT_BURST",
      "MEM_BACKEND",
      "EMBED_PROVIDER",
      "RETRIEVER_K",
      "HYBRID_BM25",
      "TOOLROUTER_TOPK",
      "LESSONS_MAX",
      "THOUGHTGRAPH_MAX_BRANCHES",
      "THOUGHTGRAPH_MAX_DEPTH",
      "MCP_DASHBOARD_PORT",
    ];

    for (const arg of requiredArgs) {
      expect(dockerfileContents, `Missing ARG for ${arg}`).to.match(
        new RegExp(`ARG\\s+${arg}`),
      );
    }
  });

  it("mirrors the build arguments into environment variables", () => {
    const requiredEnv = [
      "NODE_ENV=production",
      "MCP_HTTP_HOST=${MCP_HTTP_HOST}",
      "MCP_HTTP_PORT=${MCP_HTTP_PORT}",
      "MCP_HTTP_ALLOW_NOAUTH=${MCP_HTTP_ALLOW_NOAUTH}",
      "MEM_BACKEND=${MEM_BACKEND}",
      "EMBED_PROVIDER=${EMBED_PROVIDER}",
      "RETRIEVER_K=${RETRIEVER_K}",
      "HYBRID_BM25=${HYBRID_BM25}",
      "TOOLROUTER_TOPK=${TOOLROUTER_TOPK}",
      "LESSONS_MAX=${LESSONS_MAX}",
      "THOUGHTGRAPH_MAX_BRANCHES=${THOUGHTGRAPH_MAX_BRANCHES}",
      "THOUGHTGRAPH_MAX_DEPTH=${THOUGHTGRAPH_MAX_DEPTH}",
      "MCP_DASHBOARD_PORT=${MCP_DASHBOARD_PORT}",
    ];

    for (const envLine of requiredEnv) {
      expect(dockerfileContents, `Missing ENV for ${envLine}`).to.include(envLine);
    }
  });

  it("prunes development dependencies before copying node_modules", () => {
    expect(dockerfileContents).to.match(/npm run build \\\s+&& npm prune --omit=dev/);
  });
});
