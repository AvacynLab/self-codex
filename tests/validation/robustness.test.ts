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
  ROBUSTNESS_JSONL_FILES,
  buildDefaultRobustnessCalls,
  runRobustnessPhase,
  type RobustnessCallContext,
  type RobustnessCallOutcome,
} from "../../src/validation/robustness.js";

/** Unit tests covering the Stage 9 robustness validation runner. */
describe("robustness validation runner", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;
  let runRoot: string;
  let environment: HttpEnvironmentSummary;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-robustness-runner-"));
    runRoot = await ensureRunStructure(workingDir, "validation_robustness");
    environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "8081",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "robust-token",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("persists artefacts and summary statistics for robustness scenarios", async () => {
    const responses = [
      {
        status: 400,
        payload: {
          jsonrpc: "2.0",
          error: {
            code: -32602,
            message: "Invalid params",
            data: { reason: "missing graph_id" },
          },
        },
      },
      {
        status: 404,
        payload: {
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: "Unknown method",
          },
        },
      },
      {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          result: {
            transaction_id: "tx-001",
            idempotent: true,
            idempotency_key: "robustness-tx",
            events: [],
          },
        },
      },
      {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          result: {
            transaction_id: "tx-001",
            idempotent: true,
            idempotency_key: "robustness-tx",
            events: [],
          },
        },
      },
      {
        status: 500,
        payload: {
          jsonrpc: "2.0",
          error: {
            code: 5001,
            message: "Child crashed",
            data: {
              events: [
                { type: "child.error", seq: 1 },
                { type: "child.cleanup", seq: 2 },
              ],
            },
          },
        },
      },
      {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          result: {
            status: "timeout",
            message: "Operation timed out",
            events: [{ type: "plan.timeout", seq: 3 }],
          },
        },
      },
    ];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body) {
        throw new Error("Expected fetch body");
      }
      const next = responses.shift() ?? { status: 200, payload: { jsonrpc: "2.0", result: {} } };
      return new Response(JSON.stringify(next.payload), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await runRobustnessPhase(runRoot, environment);

    expect(result.outcomes).to.have.lengthOf(6);
    expect(result.summary.checks[0]?.status).to.equal(400);
    expect(result.summary.checks[1]?.status).to.equal(404);
    expect(result.summary.idempotency?.consistent).to.equal(true);
    expect(result.summary.idempotency?.idempotencyKey).to.equal("robustness-tx");
    expect(result.summary.crashSimulation?.eventCount).to.equal(2);
    expect(result.summary.timeout?.timedOut).to.equal(true);
    expect(result.summary.timeout?.statusToken).to.equal("timeout");
    expect(result.summary.timeout?.message).to.equal("Operation timed out");

    const inputsLog = await readFile(join(runRoot, ROBUSTNESS_JSONL_FILES.inputs), "utf8");
    const outputsLog = await readFile(join(runRoot, ROBUSTNESS_JSONL_FILES.outputs), "utf8");
    const eventsLog = await readFile(join(runRoot, ROBUSTNESS_JSONL_FILES.events), "utf8");
    const httpLog = await readFile(join(runRoot, ROBUSTNESS_JSONL_FILES.log), "utf8");
    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));

    expect(inputsLog).to.contain("graph_diff_invalid");
    expect(outputsLog).to.contain("plan_reactive_timeout");
    expect(eventsLog).to.contain("child_spawn_failure");
    expect(eventsLog).to.contain("plan.timeout");
    expect(httpLog).to.contain("invalid-schema:graph_diff_invalid");
    expect(summaryDocument.checks).to.have.lengthOf(6);
  });

  it("fails when required error responses do not expose the expected status codes", async () => {
    const responses = [
      { status: 200, payload: { jsonrpc: "2.0", error: { message: "oops" } } },
      { status: 200, payload: { jsonrpc: "2.0", error: { message: "also bad" } } },
      { status: 200, payload: { jsonrpc: "2.0", result: {} } },
      { status: 200, payload: { jsonrpc: "2.0", result: {} } },
      { status: 500, payload: { jsonrpc: "2.0", error: { message: "crash", data: { events: [{}] } } } },
      { status: 200, payload: { jsonrpc: "2.0", result: { status: "timeout", events: [] } } },
    ];

    globalThis.fetch = (async () => {
      const next = responses.shift() ?? { status: 200, payload: { jsonrpc: "2.0", result: {} } };
      return new Response(JSON.stringify(next.payload), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await runRobustnessPhase(runRoot, environment)
      .then(() => {
        throw new Error("Expected the robustness phase to fail when HTTP 400 is not returned");
      })
      .catch((error: unknown) => {
        expect((error as Error).message).to.contain("Expected invalid schema request to return HTTP 400");
      });
  });

  it("fails when idempotent calls diverge", async () => {
    const responses = [
      { status: 400, payload: { jsonrpc: "2.0", error: { message: "Invalid" } } },
      { status: 404, payload: { jsonrpc: "2.0", error: { message: "Unknown" } } },
      { status: 200, payload: { jsonrpc: "2.0", result: { idempotency_key: "key" } } },
      { status: 200, payload: { jsonrpc: "2.0", result: { idempotency_key: "different" } } },
      { status: 500, payload: { jsonrpc: "2.0", error: { message: "Crash", data: { events: [{}] } } } },
      { status: 200, payload: { jsonrpc: "2.0", result: { status: "timeout", events: [] } } },
    ];

    globalThis.fetch = (async () => {
      const next = responses.shift() ?? { status: 200, payload: { jsonrpc: "2.0", result: {} } };
      return new Response(JSON.stringify(next.payload), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await runRobustnessPhase(runRoot, environment)
      .then(() => {
        throw new Error("Expected the robustness phase to fail when idempotency diverges");
      })
      .catch((error: unknown) => {
        expect((error as Error).message).to.contain("Idempotency check failed");
      });
  });

  it("fails when the timeout scenario does not report a timeout or cancellation", async () => {
    const responses = [
      { status: 400, payload: { jsonrpc: "2.0", error: { message: "Invalid" } } },
      { status: 404, payload: { jsonrpc: "2.0", error: { message: "Unknown" } } },
      { status: 200, payload: { jsonrpc: "2.0", result: { idempotency_key: "key" } } },
      { status: 200, payload: { jsonrpc: "2.0", result: { idempotency_key: "key" } } },
      { status: 500, payload: { jsonrpc: "2.0", error: { message: "Crash", data: { events: [{}] } } } },
      { status: 200, payload: { jsonrpc: "2.0", result: { status: "running", events: [] } } },
    ];

    globalThis.fetch = (async () => {
      const next = responses.shift() ?? { status: 200, payload: { jsonrpc: "2.0", result: {} } };
      return new Response(JSON.stringify(next.payload), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await runRobustnessPhase(runRoot, environment)
      .then(() => {
        throw new Error("Expected the robustness phase to fail when timeout evidence is missing");
      })
      .catch((error: unknown) => {
        expect((error as Error).message).to.contain(
          "Reactive plan did not report a timeout or cancellation status",
        );
      });
  });

  it("supports overriding defaults when building the call plan", () => {
    const invalidParams = { custom: true } as Record<string, unknown>;
    const calls = buildDefaultRobustnessCalls({
      idempotencyKey: "custom-key",
      invalidSchemaParams: invalidParams,
      unknownMethod: "custom.method",
      crashCommand: "force-crash",
      reactiveTimeoutMs: 250,
    });

    expect(calls[0]?.params).to.equal(invalidParams);
    expect(calls[1]?.method).to.equal("custom.method");
    expect((calls[2]?.meta as { idempotency_key?: string })?.idempotency_key).to.equal("custom-key");
    expect((calls[3]?.meta as { idempotency_key?: string })?.idempotency_key).to.equal("custom-key");
    expect((calls[4]?.params as { prompt?: { user?: string[] } }).prompt?.user?.join(" "))
      .to.contain("force-crash");
    expect((calls[5]?.params as { timeout_ms?: number }).timeout_ms).to.equal(250);

    const previousCalls: RobustnessCallOutcome[] = [
      {
        call: {
          scenario: "idempotency",
          name: "tx_begin_first",
          method: "tx_begin",
          group: "idempotency_tx_begin",
        },
        check: {
          name: "idempotency:tx_begin_first",
          startedAt: new Date().toISOString(),
          durationMs: 10,
          request: { method: "POST", url: "http://localhost", headers: {}, body: {} },
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: { jsonrpc: "2.0", result: { idempotency_key: "custom-key" } },
          },
        },
        events: [],
      },
    ];

    const timeoutMetaFactory = calls[5]?.meta as
      | ((context: RobustnessCallContext) => Record<string, unknown>)
      | undefined;
    const derivedMeta = timeoutMetaFactory?.({
      environment,
      previousCalls,
      state: { artefacts: new Map<string, string>() },
    });

    expect(derivedMeta).to.deep.equal({ idempotency_key: "custom-key" });
  });
});
