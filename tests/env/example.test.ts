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

/** Loads the canonical list of environment keys and prefixes expected by the repo. */
function readExpectedKeys(): { required: string[]; prefixes: string[] } {
  const manifestPath = resolve(process.cwd(), "config", "env", "expected-keys.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const required = Array.isArray(manifest.required) ? manifest.required : [];
  const prefixes = Array.isArray(manifest.prefixes) ? manifest.prefixes : [];
  return { required, prefixes };
}

describe(".env.example documentation", () => {
  it("lists the orchestrator keys required for bootstrap", () => {
    const file = readEnvExample();
    const { required, prefixes } = readExpectedKeys();
    const keys = file
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => line.split("=", 1)[0]);

    expect(keys).to.include.members(required);

    for (const prefix of prefixes) {
      expect(file, `${prefix} should be referenced for documentation`).to.include(prefix);
    }
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
