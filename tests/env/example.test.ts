import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect } from "chai";

/**
 * Loads the example environment file from the repository root.
 *
 * The helper keeps the lookup encapsulated so individual test cases can focus on
 * the assertions they perform rather than repeat path resolution boilerplate.
 */
function readEnvExample(): string {
  const filePath = resolve(process.cwd(), ".env.example");
  return readFileSync(filePath, "utf8");
}

describe(".env.example documentation", () => {
  it("lists the orchestrator keys required for bootstrap", () => {
    const file = readEnvExample();
    const keys = file
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=", 1)[0]);

    expect(keys).to.include.members([
      "START_HTTP",
      "MCP_HTTP_TOKEN",
      "MCP_HTTP_HOST",
      "MCP_HTTP_PORT",
      "MCP_HTTP_PATH",
      "MCP_SSE_MAX_CHUNK_BYTES",
      "MCP_SSE_MAX_BUFFER",
      "MCP_SSE_EMIT_TIMEOUT_MS",
      "MCP_GRAPH_WORKERS",
      "MCP_GRAPH_POOL_THRESHOLD",
      "MCP_TOOLS_MODE",
      "MCP_TOOL_PACK",
      "IDEMPOTENCY_TTL_MS",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "MCP_LOG_REDACT",
      "MCP_LOG_FILE",
      "MCP_LOG_ROTATE_SIZE",
      "MCP_LOG_ROTATE_KEEP",
    ]);
  });

  it("documents HTTP token usage and SSE default recommendations", () => {
    const file = readEnvExample();

    expect(file).to.match(/START_HTTP=0/);
    expect(file).to.match(/scripts\/setup-agent-env\.sh/);
    expect(file).to.match(/# Exemple : `tok_dev_[a-f0-9]{32}`/);
    expect(file).to.match(/MCP_SSE_MAX_CHUNK_BYTES=32768/);
    expect(file).to.match(/MCP_SSE_MAX_BUFFER=1048576/);
    expect(file).to.match(/MCP_SSE_EMIT_TIMEOUT_MS=5000/);
    expect(file).to.match(/MCP_GRAPH_WORKERS=0/);
    expect(file).to.match(/MCP_GRAPH_POOL_THRESHOLD=6/);
  });
});
