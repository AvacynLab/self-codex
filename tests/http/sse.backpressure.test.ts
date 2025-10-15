/**
 * Validates that the SSE buffer honours the MCP_SSE_MAX_BUFFER limit by
 * dropping frames, logging a warning and emitting the corresponding metric
 * increment. The regression ensures the HTTP layer benefits from deterministic
 * backpressure behaviour even under slow consumers.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import type { ResourceWatchResult } from "../../src/resources/registry.js";
import {
  ResourceWatchSseBuffer,
  serialiseResourceWatchResultForSse,
} from "../../src/resources/sse.js";
import { __tracingInternals, renderMetricsSnapshot } from "../../src/infra/tracing.js";

describe("http sse backpressure", () => {
  const originalBufferEnv = process.env.MCP_SSE_MAX_BUFFER;

  beforeEach(() => {
    __tracingInternals.reset();
  });

  afterEach(() => {
    process.env.MCP_SSE_MAX_BUFFER = originalBufferEnv;
    __tracingInternals.reset();
  });

  it("records drops when the environment-configured buffer is exceeded", async () => {
    process.env.MCP_SSE_MAX_BUFFER = "2";

    const warnings: Array<{ message: string; payload: Record<string, unknown> | undefined }> = [];
    const buffer = new ResourceWatchSseBuffer({
      clientId: "http-sse-test",
      logger: {
        warn: (message: string, payload?: unknown) => {
          warnings.push({ message, payload: payload as Record<string, unknown> | undefined });
        },
      },
      maxChunkBytes: 128,
      emitTimeoutMs: 25,
    });

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
          stage: "backpressure",
          elapsedMs: null,
          payload: { seq },
        },
      ],
    });

    buffer.enqueue(serialiseResourceWatchResultForSse(buildResult(1)));
    buffer.enqueue(serialiseResourceWatchResultForSse(buildResult(2)));
    buffer.enqueue(serialiseResourceWatchResultForSse(buildResult(3)));

    expect(buffer.size).to.equal(2);
    expect(buffer.droppedFrameCount).to.equal(1);
    expect(
      warnings.some(
        (entry) => entry.message === "resources_sse_buffer_overflow" && (entry.payload?.dropped as number) === 1,
      ),
    ).to.equal(true);

    await buffer.drain(async () => {
      // Draining with a resolved promise mimics a healthy HTTP writer.
    });

    const metrics = renderMetricsSnapshot();
    expect(metrics).to.contain("sse_drops 1");
  });
});
