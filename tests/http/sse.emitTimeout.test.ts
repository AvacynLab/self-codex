/**
 * Regression test verifying that the SSE buffer enforces the emit timeout by
 * dropping frames, logging a warning, and incrementing the global
 * `sse_drops_total` metric when the downstream writer stalls.
 */
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import type { ResourceRunEvent, ResourceWatchResult } from "../../src/resources/registry.js";
import {
  ResourceWatchSseBuffer,
  renderResourceWatchSseMessages,
  serialiseResourceWatchResultForSse,
} from "../../src/resources/sse.js";
import { __tracingInternals, renderMetricsSnapshot } from "../../src/infra/tracing.js";

describe("http sse emit timeout", () => {
  const originalEmitTimeoutEnv = process.env.MCP_SSE_EMIT_TIMEOUT_MS;

  beforeEach(() => {
    __tracingInternals.reset();
  });

  afterEach(() => {
    process.env.MCP_SSE_EMIT_TIMEOUT_MS = originalEmitTimeoutEnv;
    __tracingInternals.reset();
  });

  it("drops frames and logs a warning when the writer exceeds the configured timeout", async () => {
    const buildResult = (seq: number): ResourceWatchResult => ({
      uri: "sc://runs/http-sse/events",
      kind: "run_events",
      nextSeq: seq,
      events: [
        {
          seq,
          ts: Date.now(),
          kind: "INFO",
          level: "info",
          jobId: null,
          runId: "http-sse",
          opId: null,
          graphId: null,
          nodeId: null,
          childId: null,
          component: "graph",
          stage: "emit-timeout",
          elapsedMs: null,
          payload: { seq },
        } satisfies ResourceRunEvent,
      ],
    });

    const frameBytes = Buffer.byteLength(
      renderResourceWatchSseMessages(serialiseResourceWatchResultForSse(buildResult(1)), { maxChunkBytes: 64 }),
      "utf8",
    );

    const warnings: Array<{ message: string; payload: Record<string, unknown> | undefined }> = [];
    const pendingWrites: Promise<void>[] = [];
    const buffer = new ResourceWatchSseBuffer({
      clientId: "http-sse-timeout-test",
      logger: {
        warn: (message: string, payload?: unknown) => {
          warnings.push({ message, payload: payload as Record<string, unknown> | undefined });
        },
      },
      maxChunkBytes: 64,
      maxBufferedBytes: frameBytes * 2,
      emitTimeoutMs: 5,
    });

    buffer.enqueue(serialiseResourceWatchResultForSse(buildResult(1)));

    await buffer.drain(async () => {
      const write = delay(40).then(() => undefined);
      pendingWrites.push(write);
      return write;
    });

    await Promise.all(pendingWrites);

    expect(buffer.size).to.equal(0);
    expect(buffer.droppedFrameCount).to.equal(1);
    expect(
      warnings.some(
        (entry) =>
          entry.message === "resources_sse_emit_timeout" &&
          (entry.payload?.client_id as string | undefined) === "http-sse-timeout-test" &&
          (entry.payload?.timeout_ms as number | undefined) === 5,
      ),
    ).to.equal(true);

    const metrics = renderMetricsSnapshot();
    expect(metrics).to.contain("sse_drops_total 1");
  });

  it("honours the environment emit timeout when options omit overrides", async () => {
    process.env.MCP_SSE_EMIT_TIMEOUT_MS = "15";

    const buildResult = (seq: number): ResourceWatchResult => ({
      uri: "sc://runs/http-sse/events",
      kind: "run_events",
      nextSeq: seq,
      events: [
        {
          seq,
          ts: Date.now(),
          kind: "INFO",
          level: "info",
          jobId: null,
          runId: "http-sse",
          opId: null,
          graphId: null,
          nodeId: null,
          childId: null,
          component: "graph",
          stage: "emit-timeout-env",
          elapsedMs: null,
          payload: { seq },
        } satisfies ResourceRunEvent,
      ],
    });

    const warnings: Array<{ message: string; payload: Record<string, unknown> | undefined }> = [];
    const buffer = new ResourceWatchSseBuffer({
      clientId: "http-sse-timeout-env", // Document the client id so log assertions remain clear.
      logger: {
        warn: (message: string, payload?: unknown) => {
          warnings.push({ message, payload: payload as Record<string, unknown> | undefined });
        },
      },
      maxChunkBytes: 64,
      maxBufferedBytes: Buffer.byteLength(
        renderResourceWatchSseMessages(serialiseResourceWatchResultForSse(buildResult(1)), { maxChunkBytes: 64 }),
        "utf8",
      ) * 2,
    });

    buffer.enqueue(serialiseResourceWatchResultForSse(buildResult(1)));

    await buffer.drain(async () => {
      await delay(40);
    });

    expect(
      warnings.some(
        (entry) =>
          entry.message === "resources_sse_emit_timeout" &&
          (entry.payload?.client_id as string | undefined) === "http-sse-timeout-env" &&
          (entry.payload?.timeout_ms as number | undefined) === 15,
      ),
    ).to.equal(true);
    expect(buffer.droppedFrameCount).to.equal(1);
  });
});
