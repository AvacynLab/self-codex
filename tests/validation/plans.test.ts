import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  type HttpEnvironmentSummary,
} from "../../src/validation/runSetup.js";
import {
  PLAN_JSONL_FILES,
  buildPlanSummary,
  runPlanPhase,
} from "../../src/validation/plans.js";

/** Unit tests covering the Stage 6 planning validation runner. */
describe("planning validation runner", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;
  let runRoot: string;
  let environment: HttpEnvironmentSummary;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-plans-runner-"));
    runRoot = await ensureRunStructure(workingDir, "validation_plans");
    environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "8080",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "plans-token",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("persists artefacts and summary statistics for the planning workflow", async () => {
    const responses = [
      {
        jsonrpc: "2.0",
        result: {
          tree: {
            id: "compiled_bt",
            root: { type: "sequence", id: "seq", children: [] },
          },
          graph_id: "validation_plan_bt",
          events: [{ type: "bt.compile", seq: 1 }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          status: "success",
          ticks: 3,
          run_id: "bt-run",
          op_id: "bt-op",
          events: [{ type: "bt.tick", seq: 2 }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          status: "success",
          loop_ticks: 4,
          run_id: "reactive-run",
          op_id: "reactive-op",
          events: [
            { type: "scheduler_event_enqueued", seq: 3 },
            { type: "scheduler_tick_result", seq: 4 },
          ],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          state: "running",
          progress: 50,
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          state: "paused",
          supports_resume: true,
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          state: "running",
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          cancelled: true,
          snapshot: { state: "cancelled" },
          events: [{ type: "plan.cancelled", seq: 5 }],
        },
      },
    ];

    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) {
        capturedBodies.push(JSON.parse(init.body.toString()));
      }
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await runPlanPhase(runRoot, environment);

    expect(result.outcomes).to.have.lengthOf(7);
    expect(result.summary.compile.success).to.equal(true);
    expect(result.summary.graphId).to.equal("validation_plan_bt");
    expect(result.summary.runBt.status).to.equal("success");
    expect(result.summary.runBt.ticks).to.equal(3);
    expect(result.summary.runReactive.status).to.equal("success");
    expect(result.summary.runReactive.loopTicks).to.equal(4);
    expect(result.summary.runReactive.cancelled).to.equal(true);
    expect(result.summary.events.total).to.equal(5);
    expect(result.summary.events.types).to.have.property("plan.cancelled", 1);

    const inputsLog = await readFile(join(runRoot, PLAN_JSONL_FILES.inputs), "utf8");
    const outputsLog = await readFile(join(runRoot, PLAN_JSONL_FILES.outputs), "utf8");
    const eventsLog = await readFile(join(runRoot, PLAN_JSONL_FILES.events), "utf8");
    const httpLog = await readFile(join(runRoot, PLAN_JSONL_FILES.log), "utf8");

    expect(inputsLog).to.contain("plan_compile_bt");
    expect(outputsLog).to.contain("plan_cancel");
    expect(eventsLog).to.contain("scheduler_tick_result");
    expect(httpLog).to.contain("reactive-run");

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.runBt.runId).to.equal("bt-run");
    expect(summaryDocument.lifecycle.pauseResult?.state).to.equal("paused");

    const compileRequest = capturedBodies[0] as { params?: { graph?: { id?: string } } };
    expect(compileRequest?.params?.graph?.id).to.equal("validation_plan_bt");
  });

  it("aggregates event statistics from pre-recorded outcomes", async () => {
    const outcomes = [
      {
        call: {
          scenario: "reactive",
          name: "plan_run_reactive",
          method: "plan_run_reactive",
        },
        check: {
          name: "reactive:plan_run_reactive",
          startedAt: new Date().toISOString(),
          durationMs: 12,
          request: { method: "POST", url: "http://127.0.0.1:8080/mcp", headers: {}, body: {} },
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: {
              result: {
                status: "success",
                loop_ticks: 2,
                run_id: "reactive",
                op_id: "reactive-op",
                events: [{ type: "phase:start" }, { phase: "complete" }],
              },
            },
          },
        },
        events: [{ type: "phase:start" }, { phase: "complete" }],
      },
    ] as const;

    const summary = buildPlanSummary(runRoot, outcomes);
    expect(summary.events.total).to.equal(2);
    expect(summary.events.types).to.have.property("phase:start", 1);
    expect(summary.events.types).to.have.property("phase:complete", 1);
  });
});
