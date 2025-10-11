import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  executeIntrospectionCli,
  parseIntrospectionCliOptions,
} from "../../src/validation/introspectionCli.js";
import { INTROSPECTION_JSONL_FILES } from "../../src/validation/introspection.js";

/**
 * Captures CLI-specific unit tests distinct from the core introspection runner.
 * The focus here is on argument parsing and orchestration glue (directory
 * initialisation, logging, call sequencing).
 */
describe("introspection CLI helpers", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-introspect-cli-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parseIntrospectionCliOptions([
      "--run-id",
      "validation_custom",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--ignored",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_custom",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
    });
  });

  it("executes the introspection phase and persists artefacts", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { info: { version: "1.2.3" } } },
      { jsonrpc: "2.0", result: { transports: ["http"] } },
      { jsonrpc: "2.0", result: { tools: [{ name: "echo" }] } },
      { jsonrpc: "2.0", result: { resources: [] } },
      { jsonrpc: "2.0", result: { events: [{ seq: 42, type: "ready" }] } },
    ];

    globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    const { runRoot, outcomes, summary } = await executeIntrospectionCli(
      { baseDir: workingDir, runId: "validation_test" },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9999",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "token",
      } as NodeJS.ProcessEnv,
      logger,
    );

    expect(outcomes).to.have.lengthOf(5);
    expect(runRoot).to.equal(join(workingDir, "validation_test"));
    expect(summary.calls).to.have.lengthOf(5);
    expect(summary.info).to.deep.equal({ info: { version: "1.2.3" } });

    const inputsContent = await readFile(join(runRoot, INTROSPECTION_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, INTROSPECTION_JSONL_FILES.outputs), "utf8");
    const eventsContent = await readFile(join(runRoot, INTROSPECTION_JSONL_FILES.events), "utf8");
    const summaryPath = join(runRoot, "report", "introspection_summary.json");
    const summaryContent = await readFile(summaryPath, "utf8");

    expect(inputsContent).to.contain("mcp/info");
    expect(inputsContent).to.contain("tools/list");
    expect(eventsContent).to.contain("ready");
    expect(JSON.parse(summaryContent).info).to.deep.equal({ info: { version: "1.2.3" } });

    const outputLines = outputsContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(outputLines).to.have.lengthOf(5);
    expect(outputLines[1].response.body.result.transports).to.deep.equal(["http"]);
    expect(outputLines[2].response.body.result.tools[0].name).to.equal("echo");

    // Ensure the logger exposed paths for operator visibility.
    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(INTROSPECTION_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain(INTROSPECTION_JSONL_FILES.events);
    expect(flattenedLogs).to.contain("introspection_summary.json");
  });
});
