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
 * Computes a percentile using the same interpolation strategy as the
 * performance runner so the assertions remain aligned with production logic.
 */
function computePercentile(samples: readonly number[], percentile: number): number {
  if (!samples.length) {
    throw new Error("empty samples");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const clamped = Math.min(Math.max(percentile, 0), 1);
  const position = (sorted.length - 1) * clamped;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  return lower + (upper - lower) * weight;
}

/** Helper capturing rejection expectations without chai-as-promised. */
async function expectRunToFail(action: () => Promise<unknown>, messageFragment: string): Promise<void> {
  try {
    await action();
    expect.fail("Stage 10 validation devait échouer");
  } catch (error) {
    expect((error as Error).message).to.contain(messageFragment);
  }
}

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

    const sampleSize = 50;
    const concurrencyBurst = 5;
    const durations = Array.from({ length: sampleSize + concurrencyBurst + 5 }, (_, index) => 5 + index);
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
      { performance: { sampleSize, concurrencyBurst, logPath } },
      { httpCheck },
    );

    expect(result.summary.latency.samples).to.equal(sampleSize);
    const latencySamples = durations.slice(0, sampleSize);
    const expectedAverage = latencySamples.reduce((sum, value) => sum + value, 0) / sampleSize;
    expect(result.summary.latency.averageMs).to.be.closeTo(expectedAverage, 1e-9);
    expect(result.summary.latency.p50Ms).to.be.closeTo(computePercentile(latencySamples, 0.5), 1e-9);
    expect(result.summary.latency.p95Ms).to.be.closeTo(computePercentile(latencySamples, 0.95), 1e-9);
    expect(result.summary.latency.p99Ms).to.be.closeTo(computePercentile(latencySamples, 0.99), 1e-9);

    expect(result.summary.concurrency.groups).to.have.lengthOf(1);
    expect(result.summary.concurrency.groups[0]?.totalCalls).to.equal(concurrencyBurst);
    expect(result.summary.concurrency.groups[0]?.success).to.equal(concurrencyBurst);
    expect(result.summary.concurrency.groups[0]?.failure).to.equal(0);

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.latency.samples).to.equal(sampleSize);

    const inputsContent = await readFile(join(runRoot, PERFORMANCE_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, PERFORMANCE_JSONL_FILES.outputs), "utf8");

    const inputLines = inputsContent.trim().split("\n");
    const outputLines = outputsContent.trim().split("\n");
    expect(inputLines).to.have.lengthOf(sampleSize + concurrencyBurst);
    expect(outputLines).to.have.lengthOf(sampleSize + concurrencyBurst);
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
        repeat: 50,
      },
      {
        scenario: "custom",
        name: "with_concurrency",
        method: "custom/echo",
        params: { message: "hello burst" },
        concurrencyGroup: "custom_group",
        batch: 5,
      },
    ];

    const durations = Array.from({ length: 60 }, (_, index) => 20 + index);
    let callIndex = 0;

    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      const durationMs = durations[callIndex] ?? 20;
      callIndex += 1;
      return {
        name,
        startedAt: new Date(2024, 0, 1, 1, 0, callIndex).toISOString(),
        durationMs,
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
      };
    };

    const result = await runPerformancePhase(
      runRoot,
      baseEnvironment,
      { calls },
      { httpCheck },
    );

    expect(result.summary.latency.samples).to.equal(50);
    expect(result.summary.latency.label).to.equal("custom series");
    expect(result.summary.latency.toolName).to.equal("custom-tool");
    expect(result.summary.concurrency.groups).to.deep.include({
      group: "custom_group",
      totalCalls: 5,
      success: 5,
      failure: 0,
    });

    const eventsContent = await readFile(join(runRoot, PERFORMANCE_JSONL_FILES.events), "utf8");
    expect(eventsContent).to.contain("custom");

    const defaultPlan = buildDefaultPerformanceCalls({ sampleSize: 2, concurrencyBurst: 1 });
    expect(defaultPlan[0]?.repeat).to.equal(2);
  });

  it("fails when the latency plan collects fewer than 50 samples", async () => {
    const logPath = join(workingDir, "mcp_http_small.log");
    await writeFile(logPath, "seed\n", "utf8");

    const sampleSize = 10;
    const concurrencyBurst = 5;
    const durations = Array.from({ length: sampleSize + concurrencyBurst }, (_, index) => 7 + index);
    let callIndex = 0;

    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      const durationMs = durations[callIndex] ?? 7;
      callIndex += 1;
      await appendFile(logPath, `${name} call\n`, "utf8");
      return {
        name,
        startedAt: new Date(2024, 0, 1, 1, 0, callIndex).toISOString(),
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

    await expectRunToFail(
      () =>
        runPerformancePhase(
          runRoot,
          baseEnvironment,
          { performance: { sampleSize, concurrencyBurst, logPath } },
          { httpCheck },
        ),
      "50 échantillons",
    );
  });

  it("fails when the concurrency burst is below the Stage 10 threshold", async () => {
    const logPath = join(workingDir, "mcp_http_concurrency.log");
    await writeFile(logPath, "seed\n", "utf8");

    const sampleSize = 50;
    const concurrencyBurst = 3;
    const durations = Array.from({ length: sampleSize + concurrencyBurst }, (_, index) => 9 + index);
    let callIndex = 0;

    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      const durationMs = durations[callIndex] ?? 9;
      callIndex += 1;
      await appendFile(logPath, `${name} call\n`, "utf8");
      return {
        name,
        startedAt: new Date(2024, 0, 1, 2, 0, callIndex).toISOString(),
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

    await expectRunToFail(
      () =>
        runPerformancePhase(
          runRoot,
          baseEnvironment,
          { performance: { sampleSize, concurrencyBurst, logPath } },
          { httpCheck },
        ),
      "5 appels simultanés",
    );
  });

  it("fails when no concurrency burst is configured", async () => {
    const logPath = join(workingDir, "mcp_http_missing.log");
    await writeFile(logPath, "seed\n", "utf8");

    const sampleSize = 50;
    const durations = Array.from({ length: sampleSize }, (_, index) => 11 + index);
    let callIndex = 0;

    const httpCheck = async (
      name: string,
      request: HttpCheckRequestSnapshot,
    ): Promise<HttpCheckSnapshot> => {
      const durationMs = durations[callIndex] ?? 11;
      callIndex += 1;
      await appendFile(logPath, `${name} call\n`, "utf8");
      return {
        name,
        startedAt: new Date(2024, 0, 1, 3, 0, callIndex).toISOString(),
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

    const calls: PerformanceCallSpec[] = [
      {
        scenario: "latency",
        name: "tools_call_echo",
        method: "tools/call",
        params: { name: "echo", arguments: { text: "latency" } },
        collectLatency: true,
        repeat: sampleSize,
      },
    ];

    await expectRunToFail(
      () =>
        runPerformancePhase(
          runRoot,
          baseEnvironment,
          { calls, performance: { logPath } },
          { httpCheck },
        ),
      "burst de concurrence",
    );
  });
});
