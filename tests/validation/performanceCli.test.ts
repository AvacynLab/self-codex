import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executePerformanceCli,
  parsePerformanceCliOptions,
} from "../../src/validation/performanceCli.js";
import { PERFORMANCE_JSONL_FILES } from "../../src/validation/performance.js";

/** CLI-level tests ensuring the Stage 10 workflow remains ergonomic. */
describe("performance validation CLI", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-perf-cli-"));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parsePerformanceCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--sample-size",
      "25",
      "--concurrency",
      "7",
      "--tool-name",
      "ping",
      "--tool-text",
      "benchmark",
      "--log-path",
      "logs/http.log",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      sampleSize: 25,
      concurrencyBurst: 7,
      toolName: "ping",
      toolText: "benchmark",
      logPath: "logs/http.log",
    });
  });

  it("executes the CLI workflow and surfaces artefact locations", async () => {
    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    let capturedOptions: unknown;

    const summary = {
      artefacts: {
        inputsJsonl: "inputs.jsonl",
        outputsJsonl: "outputs.jsonl",
        eventsJsonl: "events.jsonl",
        httpSnapshotLog: "log.json",
      },
      latency: {
        label: "stub",
        toolName: "stub-tool",
        samples: 0,
        averageMs: null,
        minMs: null,
        maxMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
      },
      concurrency: { groups: [] },
      logs: {
        path: null,
        existedBefore: false,
        existedAfter: false,
        sizeBeforeBytes: null,
        sizeAfterBytes: null,
        growthBytes: null,
        rotated: false,
      },
    } as const;

    const overrides = {
      runner: async (
        runRoot: string,
        _environment: unknown,
        options: unknown,
      ) => {
        capturedOptions = options;
        const summaryPath = join(runRoot, "report", "perf_summary.json");
        await writeFile(summaryPath, JSON.stringify(summary, null, 2));
        return {
          outcomes: [],
          summary,
          summaryPath,
          logBefore: { exists: false, size: 0, mtimeMs: 0 },
          logAfter: { exists: false, size: 0, mtimeMs: 0 },
        };
      },
    };

    const { runRoot, result } = await executePerformanceCli(
      {
        baseDir: workingDir,
        runId: "validation_cli",
        sampleSize: 12,
        concurrencyBurst: 4,
        toolName: "echo",
        toolText: "load",
        logPath: "logs/custom.log",
      },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9000",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      logger,
      overrides,
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.summaryPath).to.equal(join(runRoot, "report", "perf_summary.json"));

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.artefacts.inputsJsonl).to.equal("inputs.jsonl");

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(PERFORMANCE_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain("Summary");

    const mergedOptions = capturedOptions as { performance?: { [key: string]: unknown } };
    expect(mergedOptions.performance?.sampleSize).to.equal(12);
    expect(mergedOptions.performance?.concurrencyBurst).to.equal(4);
    expect(mergedOptions.performance?.toolName).to.equal("echo");
    expect(mergedOptions.performance?.logPath).to.equal("logs/custom.log");
  });
});
