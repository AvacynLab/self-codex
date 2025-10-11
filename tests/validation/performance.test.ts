import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  type HttpCheckRequestSnapshot,
  type HttpCheckSnapshot,
} from "../../src/validation/runSetup.js";
import {
  PERFORMANCE_JSONL_FILES,
  buildDefaultPerformanceCalls,
  runPerformancePhase,
  type PerformanceCallSpec,
} from "../../src/validation/performance.js";

/**
 * Unit tests covering the Stage 10 performance validation workflow. The suite
 * focuses on deterministic artefact generation so operators can trust the
 * derived latency and concurrency metrics.
 */
describe("performance validation", () => {
  let workingDir: string;
  let runRoot: string;
  const baseEnvironment = collectHttpEnvironment({
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_HTTP_PORT: "7777",
    MCP_HTTP_PATH: "/mcp",
    MCP_HTTP_TOKEN: "token",
  } as NodeJS.ProcessEnv);

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-performance-"));
    runRoot = await ensureRunStructure(workingDir, "validation_test");
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("collects latency percentiles, concurrency stats, and log growth", async () => {
    const logPath = join(workingDir, "mcp_http.log");
    await writeFile(logPath, "seed\n", "utf8");

    const durations = [5, 10, 15, 20, 25, 8, 9, 11];
    let callIndex = 0;

    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      const durationMs = durations[callIndex] ?? 5;
      callIndex += 1;
      await appendFile(logPath, `${name} call\n`, "utf8");
      return {
        name,
        startedAt: new Date(2024, 0, 1, 0, 0, callIndex).toISOString(),
        durationMs,
        request,
        response: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: { jsonrpc: "2.0", result: { ok: true } },
        },
      };
    };

    const result = await runPerformancePhase(
      runRoot,
      baseEnvironment,
      { performance: { sampleSize: 5, concurrencyBurst: 3, logPath } },
      { httpCheck },
    );

    expect(result.summary.latency.samples).to.equal(5);
    expect(result.summary.latency.p50Ms).to.equal(15);
    expect(result.summary.latency.p95Ms).to.be.closeTo(24, 1e-9);
    expect(result.summary.latency.p99Ms).to.be.closeTo(24.8, 1e-9);

    expect(result.summary.concurrency.groups).to.have.lengthOf(1);
    expect(result.summary.concurrency.groups[0]?.totalCalls).to.equal(3);
    expect(result.summary.concurrency.groups[0]?.success).to.equal(3);

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.latency.samples).to.equal(5);

    const inputsContent = await readFile(join(runRoot, PERFORMANCE_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, PERFORMANCE_JSONL_FILES.outputs), "utf8");

    const inputLines = inputsContent.trim().split("\n");
    const outputLines = outputsContent.trim().split("\n");
    expect(inputLines).to.have.lengthOf(8);
    expect(outputLines).to.have.lengthOf(8);
    expect(inputsContent).to.contain("latency");
    expect(inputsContent).to.contain("concurrency");

    const afterStats = await stat(logPath);
    expect(afterStats.size).to.be.greaterThan(0);
    expect(result.summary.logs.growthBytes).to.be.greaterThan(0);
  });

  it("supports custom call plans and event capture", async () => {
    const calls: PerformanceCallSpec[] = [
      {
        scenario: "custom",
        name: "with_events",
        method: "custom/echo",
        params: () => ({ message: "hello" }),
        collectLatency: true,
        latencyLabel: "custom series",
        latencyToolName: "custom-tool",
      },
    ];

    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => ({
      name,
      startedAt: new Date(2024, 0, 1, 1, 0, 0).toISOString(),
      durationMs: 42,
      request,
      response: {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          result: { ok: true, events: [{ type: "custom", detail: "sample" }] },
        },
      },
    });

    const result = await runPerformancePhase(
      runRoot,
      baseEnvironment,
      { calls },
      { httpCheck },
    );

    expect(result.summary.latency.samples).to.equal(1);
    expect(result.summary.latency.label).to.equal("custom series");
    expect(result.summary.latency.toolName).to.equal("custom-tool");

    const eventsContent = await readFile(join(runRoot, PERFORMANCE_JSONL_FILES.events), "utf8");
    expect(eventsContent).to.contain("custom");

    const defaultPlan = buildDefaultPerformanceCalls({ sampleSize: 2, concurrencyBurst: 1 });
    expect(defaultPlan[0]?.repeat).to.equal(2);
  });
});
