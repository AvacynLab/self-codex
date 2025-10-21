import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sinon from "sinon";

import { executePlanCli, parsePlanCliOptions } from "../../src/validation/plansCli.js";
import { createCliStructuredLogger } from "../../src/validation/cliLogger.js";
import {
  PLAN_JSONL_FILES,
  type PlanPhaseOptions,
  type PlanPhaseResult,
  type PlanPhaseSummaryDocument,
} from "../../src/validation/plans.js";

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
      {
        jsonrpc: "2.0",
        result: {
          status: "success",
          ticks: 2,
          run_id: "bt-run",
          op_id: "bt-op",
          events: [{ type: "bt.tick" }],
        },
      },
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
      { jsonrpc: "2.0", result: { ok: true, op_id: "reactive-op", run_id: "reactive-run" } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const cliLogger = createCliStructuredLogger("plan_cli");
    const stdoutStub = sinon.stub(process.stdout, "write");

    try {
      const { runRoot, result } = await executePlanCli(
        { baseDir: workingDir, runId: "validation_cli", tickMs: 200, timeoutMs: 5000 },
        {
          MCP_HTTP_HOST: "127.0.0.1",
          MCP_HTTP_PORT: "9000",
          MCP_HTTP_PATH: "/mcp",
          MCP_HTTP_TOKEN: "cli-token",
        } as NodeJS.ProcessEnv,
        cliLogger.console,
      );

      expect(runRoot).to.equal(join(workingDir, "validation_cli"));
      expect(result.summary.runBt.status).to.equal("success");
      expect(result.summary.runReactive.loopTicks).to.equal(3);
      expect(result.summary.opCancel.ok).to.equal(true);

      const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
      expect(summaryDocument.artefacts.requestsJsonl).to.equal(join(runRoot, PLAN_JSONL_FILES.inputs));

      await cliLogger.logger.flush();

      const combined = cliLogger.entries.map((entry) => entry.text).join(" ");
      expect(combined).to.contain(PLAN_JSONL_FILES.inputs);
      expect(combined).to.contain("Summary");
    } finally {
      stdoutStub.restore();
    }
  });

  it("sanitises plan overrides by omitting undefined reactive fields", async () => {
    const logger = { log: () => undefined };
    const captured: PlanPhaseOptions[] = [];

    const runner = async (
      runRoot: string,
      _environment: unknown,
      options: PlanPhaseOptions,
    ): Promise<PlanPhaseResult> => {
      captured.push(structuredClone(options));
      const summary: PlanPhaseSummaryDocument = {
        capturedAt: new Date().toISOString(),
        graphId: null,
        compile: { success: true },
        runBt: { status: null, ticks: null, runId: null, opId: null },
        runReactive: {
          status: null,
          loopTicks: null,
          runId: null,
          opId: null,
          cancelled: false,
        },
        lifecycle: {
          statusSnapshot: null,
          pauseResult: null,
          resumeResult: null,
          cancelResult: null,
        },
        opCancel: {
          ok: true,
          outcome: null,
          reason: null,
          runId: null,
          opId: null,
          progress: null,
        },
        events: { total: 0, types: {} },
        artefacts: {
          requestsJsonl: "inputs.jsonl",
          responsesJsonl: "outputs.jsonl",
          eventsJsonl: "events.jsonl",
          httpLog: "log.json",
        },
      };
      const summaryPath = join(runRoot, "report", "plans_summary.json");
      await writeFile(summaryPath, JSON.stringify(summary, null, 2));
      return { outcomes: [], summary, summaryPath };
    };

    // Capture both the run root and the nested phase result emitted by the CLI
    // so the expectations track the actual phase metadata rather than the wrapper.
    const { runRoot, result: planResult } = await executePlanCli(
      { baseDir: workingDir, runId: "cli-options", tickMs: 150 },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9000",
        MCP_HTTP_PATH: "/mcp",
      } as NodeJS.ProcessEnv,
      logger,
      {
        phaseOptions: { plan: { variables: { payload: { objective: "test" } } } },
        runner,
      },
    );

    expect(planResult.summaryPath).to.equal(join(runRoot, "report", "plans_summary.json"));

    const [options] = captured;
    expect(options.plan?.variables).to.deep.equal({ payload: { objective: "test" } });
    expect(options.plan?.reactive).to.deep.equal({ tickMs: 150 });
    expect(Object.prototype.hasOwnProperty.call(options.plan?.reactive ?? {}, "timeoutMs")).to.equal(false);
  });
});
