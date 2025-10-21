import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeRobustnessCli,
  parseRobustnessCliOptions,
} from "../../src/validation/robustnessCli.js";
import {
  ROBUSTNESS_JSONL_FILES,
  type RobustnessPhaseOptions,
  type RobustnessPhaseResult,
} from "../../src/validation/robustness.js";

/** CLI-level tests ensuring the Stage 9 workflow remains ergonomic. */
describe("robustness validation CLI", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-robustness-cli-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parseRobustnessCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--idempotency-key",
      "cli-key",
      "--timeout-ms",
      "250",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      idempotencyKey: "cli-key",
      reactiveTimeoutMs: 250,
    });
  });

  it("executes the CLI workflow and surfaces artefact locations", async () => {
    const responses = [
      {
        status: 400,
        payload: { jsonrpc: "2.0", error: { code: -32602, message: "Invalid" } },
      },
      {
        status: 404,
        payload: { jsonrpc: "2.0", error: { code: -32601, message: "Unknown" } },
      },
      {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          result: { transaction_id: "tx", idempotent: true, idempotency_key: "cli-key" },
        },
      },
      {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          result: { transaction_id: "tx", idempotent: true, idempotency_key: "cli-key" },
        },
      },
      {
        status: 500,
        payload: {
          jsonrpc: "2.0",
          error: {
            code: 5001,
            message: "Crash",
            data: { events: [{ type: "child.error", seq: 1 }] },
          },
        },
      },
      {
        status: 200,
        payload: {
          jsonrpc: "2.0",
          result: { status: "timeout", message: "Timeout", events: [] },
        },
      },
    ];

    globalThis.fetch = (async () => {
      const next =
        responses.shift() ?? { status: 200, payload: { jsonrpc: "2.0", result: {} } };
      return new Response(JSON.stringify(next.payload), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    const { runRoot, result } = await executeRobustnessCli(
      { baseDir: workingDir, runId: "validation_cli", idempotencyKey: "cli-key", reactiveTimeoutMs: 150 },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9001",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      logger,
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.summary.idempotency?.consistent).to.equal(true);
    expect(result.summary.timeout?.timedOut).to.equal(true);

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.artefacts.inputsJsonl).to.equal(join(runRoot, ROBUSTNESS_JSONL_FILES.inputs));

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(ROBUSTNESS_JSONL_FILES.log);
    expect(flattenedLogs).to.contain("Robustness validation run");
    expect(flattenedLogs).to.contain("Timeout status token: timeout");
  });

  it("only forwards robustness defaults when they contain data", async () => {
    const logger = { log: () => undefined };
    const env = {
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "9002",
      MCP_HTTP_PATH: "/mcp",
    } as NodeJS.ProcessEnv;

    const stubSummary: RobustnessPhaseResult["summary"] = {
      artefacts: {
        inputsJsonl: ROBUSTNESS_JSONL_FILES.inputs,
        outputsJsonl: ROBUSTNESS_JSONL_FILES.outputs,
        eventsJsonl: ROBUSTNESS_JSONL_FILES.events,
        httpSnapshotLog: ROBUSTNESS_JSONL_FILES.log,
      },
      checks: [],
    };

    let emptyOptions: RobustnessPhaseOptions | undefined;
    const emptyRunner = async (
      runRoot: string,
      environment: unknown,
      options: RobustnessPhaseOptions,
    ): Promise<RobustnessPhaseResult> => {
      emptyOptions = options;
      const summaryPath = join(runRoot, "report", "robustness_summary.json");
      await writeFile(summaryPath, JSON.stringify(stubSummary, null, 2));
      return { outcomes: [], summary: stubSummary, summaryPath };
    };

    await executeRobustnessCli(
      { baseDir: workingDir, runId: "no-defaults" },
      env,
      logger,
      { runner: emptyRunner },
    );

    expect(Object.prototype.hasOwnProperty.call(emptyOptions ?? {}, "defaults")).to.equal(false);

    let mergedOptions: RobustnessPhaseOptions | undefined;
    const withDefaultsRunner = async (
      runRoot: string,
      environment: unknown,
      options: RobustnessPhaseOptions,
    ): Promise<RobustnessPhaseResult> => {
      mergedOptions = options;
      const summaryPath = join(runRoot, "report", "robustness_summary.json");
      await writeFile(summaryPath, JSON.stringify(stubSummary, null, 2));
      return { outcomes: [], summary: stubSummary, summaryPath };
    };

    await executeRobustnessCli(
      { baseDir: workingDir, runId: "with-defaults" },
      env,
      logger,
      {
        phaseOptions: { defaults: { idempotencyKey: "base" } },
        runner: withDefaultsRunner,
      },
    );

    expect(mergedOptions?.defaults?.idempotencyKey).to.equal("base");
  });
});
