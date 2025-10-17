import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sinon from "sinon";

import { runPlanPhase } from "../../scripts/runPlanPhase.ts";
import { createCliStructuredLogger } from "../../src/validation/cliLogger.js";
import { StructuredLogger, type LogEntry } from "../../src/logger.js";

/** Integration coverage for the plan validation CLI wrapper. */
describe("scripts/runPlanPhase", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;
  let stdoutStub: sinon.SinonStub;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-run-plan-phase-"));
    stdoutStub = sinon.stub(process.stdout, "write");
  });

  afterEach(async () => {
    stdoutStub.restore();
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("emits structured summary logs after executing the validation workflow", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { tree: { id: "bt", root: {} }, graph_id: "validation_plan_bt" } },
      {
        jsonrpc: "2.0",
        result: {
          status: "success",
          ticks: 1,
          run_id: "bt-run",
          op_id: "bt-op",
          events: [{ type: "bt.tick" }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          status: "success",
          loop_ticks: 2,
          run_id: "reactive-run",
          op_id: "reactive-op",
          events: [{ type: "scheduler_tick_result" }],
        },
      },
      { jsonrpc: "2.0", result: { state: "running", progress: 50 } },
      { jsonrpc: "2.0", result: { state: "paused", supports_resume: true } },
      { jsonrpc: "2.0", result: { state: "running" } },
      { jsonrpc: "2.0", result: { cancelled: true, events: [{ type: "plan.cancelled" }] } },
      { jsonrpc: "2.0", result: { ok: true, op_id: "reactive-op", run_id: "reactive-run" } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const captured: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => captured.push(entry) });
    const stageLogger = createCliStructuredLogger("plan_validation_test", { logger });

    await runPlanPhase(
      ["--base-dir", workingDir, "--run-id", "scenario"],
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9000",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      stageLogger,
    );

    await logger.flush();

    const consoleEntries = captured.filter((entry) => entry.message === "validation_cli_console");
    expect(consoleEntries).to.not.be.empty;
    expect(consoleEntries[0]?.payload?.stage).to.equal("plan_validation_test");

    const summaryEntry = captured.find((entry) => entry.message === "plan_validation.summary");
    expect(summaryEntry).to.not.equal(undefined);
    expect(summaryEntry?.payload?.artefacts?.summary).to.include("scenario");
  });
});
