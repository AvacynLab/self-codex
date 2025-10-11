import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executePlanCli, parsePlanCliOptions } from "../../src/validation/plansCli.js";
import { PLAN_JSONL_FILES } from "../../src/validation/plans.js";

/** CLI-level tests ensuring the Stage 6 workflow remains ergonomic. */
describe("planning validation CLI", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-plans-cli-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parsePlanCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--tick-ms",
      "250",
      "--timeout-ms",
      "7500",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      tickMs: 250,
      timeoutMs: 7500,
    });
  });

  it("executes the CLI workflow and surfaces artefact locations", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { tree: { id: "bt", root: {} }, graph_id: "validation_plan_bt" } },
      { jsonrpc: "2.0", result: { status: "success", ticks: 2, run_id: "bt-run", op_id: "bt-op" } },
      {
        jsonrpc: "2.0",
        result: {
          status: "success",
          loop_ticks: 3,
          run_id: "reactive-run",
          op_id: "reactive-op",
          events: [{ type: "scheduler_tick_result" }],
        },
      },
      { jsonrpc: "2.0", result: { state: "running", progress: 50 } },
      { jsonrpc: "2.0", result: { state: "paused", supports_resume: true } },
      { jsonrpc: "2.0", result: { state: "running" } },
      { jsonrpc: "2.0", result: { cancelled: true, events: [{ type: "plan.cancelled" }] } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    const { runRoot, result } = await executePlanCli(
      { baseDir: workingDir, runId: "validation_cli", tickMs: 200, timeoutMs: 5000 },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9000",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      logger,
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.summary.runBt.status).to.equal("success");
    expect(result.summary.runReactive.loopTicks).to.equal(3);

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.artefacts.requestsJsonl).to.equal(join(runRoot, PLAN_JSONL_FILES.inputs));

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(PLAN_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain("Summary");
  });
});
