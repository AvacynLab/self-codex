import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  appendHttpCheckArtefacts,
  buildContextDocument,
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  headersToObject,
  persistContextDocument,
  toJsonlLine,
  type HttpCheckSnapshot,
} from "../../src/validation/runSetup.js";

const FAKE_CHECK: HttpCheckSnapshot = {
  name: "http_test",
  startedAt: "2025-10-10T16:03:31.000Z",
  durationMs: 42,
  request: {
    method: "POST",
    url: "http://127.0.0.1:8765/mcp",
    headers: { accept: "application/json" },
    body: { jsonrpc: "2.0", method: "ping" },
  },
  response: {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: { jsonrpc: "2.0", result: "pong" },
  },
};

describe("validation run setup helpers", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-run-"));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("generates a filesystem-friendly run identifier", () => {
    const runId = generateValidationRunId(new Date("2025-10-10T16:03:31.123Z"));
    expect(runId).to.equal("validation_2025-10-10T16-03-31Z");
  });

  it("normalises the HTTP environment for client consumption", () => {
    const summary = collectHttpEnvironment({
      MCP_HTTP_HOST: "0.0.0.0",
      MCP_HTTP_PORT: "9999",
      MCP_HTTP_PATH: "/custom",
      MCP_HTTP_TOKEN: "secret",
    } as NodeJS.ProcessEnv);

    expect(summary.host).to.equal("127.0.0.1");
    expect(summary.port).to.equal(9999);
    expect(summary.path).to.equal("/custom");
    expect(summary.token).to.equal("secret");
    expect(summary.baseUrl).to.equal("http://127.0.0.1:9999/custom");
  });

  it("serialises JSONL payloads with a trailing newline", () => {
    const line = toJsonlLine({ answer: 42 });
    expect(line).to.equal('{"answer":42}\n');
  });

  it("materialises the directory layout and logs HTTP checks", async () => {
    const runRoot = await ensureRunStructure(workingDir, "validation_test");
    await appendHttpCheckArtefacts(runRoot, FAKE_CHECK);

    const inputContent = await readFile(join(runRoot, "inputs", "00_preflight.jsonl"), "utf8");
    const outputContent = await readFile(join(runRoot, "outputs", "00_preflight.jsonl"), "utf8");
    const logContent = await readFile(join(runRoot, "logs", "http_checks.json"), "utf8");

    expect(inputContent.trim()).to.contain("http_test");
    expect(outputContent.trim()).to.contain("\"status\":200");
    expect(logContent.trim()).to.contain("\"durationMs\": 42");
  });

  it("persists the context document alongside captured headers", async () => {
    const runRoot = await ensureRunStructure(workingDir, "validation_test");
    await persistContextDocument(
      runRoot,
      buildContextDocument("validation_test", collectHttpEnvironment(process.env), [FAKE_CHECK]),
    );

    const contextContent = await readFile(join(runRoot, "report", "context.json"), "utf8");
    expect(contextContent).to.contain("validation_test");
  });

  it("converts Headers into plain objects", () => {
    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.append("x-custom", "abc");
    const snapshot = headersToObject(headers);
    expect(snapshot).to.deep.equal({ "content-type": "application/json", "x-custom": "abc" });
  });
});
