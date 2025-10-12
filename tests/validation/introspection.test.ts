import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  type HttpEnvironmentSummary,
} from "../../src/validation/runSetup.js";
import {
  DEFAULT_INTROSPECTION_CALLS,
  INTROSPECTION_JSONL_FILES,
  runIntrospectionPhase,
  type JsonRpcCallSpec,
} from "../../src/validation/introspection.js";

describe("introspection phase runner", () => {
  let workingDir: string;
  let runRoot: string;
  let environment: HttpEnvironmentSummary;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-introspect-"));
    runRoot = await ensureRunStructure(workingDir, "validation_test");
    environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "9999",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "secret-token",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("executes the default sequence and records artefacts", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { info: { version: "1.0.0" } } },
      { jsonrpc: "2.0", result: { transports: ["http"] } },
      { jsonrpc: "2.0", result: { tools: [] } },
      { jsonrpc: "2.0", result: { resources: [] } },
      { jsonrpc: "2.0", result: { events: [{ seq: 1, type: "ready" }] } },
    ];

    const capturedRequests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({ url, init });
      const payload = responses.shift() ?? { jsonrpc: "2.0", error: { code: -1, message: "exhausted" } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const outcomes = await runIntrospectionPhase(runRoot, environment);

    expect(outcomes).to.have.lengthOf(DEFAULT_INTROSPECTION_CALLS.length);
    expect(capturedRequests).to.have.lengthOf(DEFAULT_INTROSPECTION_CALLS.length);

    const rawHeaders = capturedRequests[0]?.init?.headers;
    const authorisationHeader =
      rawHeaders instanceof Headers ? rawHeaders.get("authorization") : (rawHeaders as Record<string, string>)?.authorization;
    expect(authorisationHeader).to.equal("Bearer secret-token");

    const inputsContent = await readFile(join(runRoot, INTROSPECTION_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, INTROSPECTION_JSONL_FILES.outputs), "utf8");
    const logContent = await readFile(join(runRoot, INTROSPECTION_JSONL_FILES.log), "utf8");
    const eventsContent = await readFile(join(runRoot, INTROSPECTION_JSONL_FILES.events), "utf8");

    const inputLines = inputsContent.trim().split("\n");
    const outputLines = outputsContent.trim().split("\n");

    expect(inputLines).to.have.lengthOf(DEFAULT_INTROSPECTION_CALLS.length);
    expect(outputLines).to.have.lengthOf(DEFAULT_INTROSPECTION_CALLS.length);
    expect(logContent.trim()).to.contain("mcp_info");
    expect(eventsContent.trim()).to.contain("events_subscribe");

    const firstInputEntry = JSON.parse(inputLines[0]);
    expect(firstInputEntry.request.body.method).to.equal("mcp_info");
  });

  it("forwards custom params when provided", async () => {
    const calls: JsonRpcCallSpec[] = [
      { name: "custom_call", method: "custom/do", params: { answer: 42 } },
    ];

    let receivedBody: unknown;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      receivedBody = init?.body;
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await runIntrospectionPhase(runRoot, environment, calls);

    expect(typeof receivedBody).to.equal("string");
    const parsed = JSON.parse(receivedBody as string);
    expect(parsed.params).to.deep.equal({ answer: 42 });

    const inputsContent = await readFile(join(runRoot, INTROSPECTION_JSONL_FILES.inputs), "utf8");
    expect(inputsContent).to.contain("custom/do");
  });
});
