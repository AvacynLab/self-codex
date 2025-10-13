/**
 * Validates the SSE streaming helpers by exercising chunking, bounded buffers
 * and timeout handling. The scenarios emulate slow consumers to ensure back-
 * pressure does not lead to unbounded memory growth.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import type { ResourceWatchResult } from "../../src/resources/registry.js";
import {
  ResourceWatchSseBuffer,
  renderResourceWatchSseMessages,
  serialiseResourceWatchResultForSse,
} from "../../src/resources/sse.js";
import { parseSseStream } from "../helpers/sse.js";

describe("resource SSE streaming", () => {
  it("chunks large payloads across multiple data lines", () => {
    const payloadSize = 512;
    const runId = "stream-chunk";
    const result: ResourceWatchResult = {
      uri: `sc://runs/${runId}/events`,
      kind: "run_events",
      nextSeq: 4,
      events: [
        {
          seq: 4,
          ts: Date.now(),
          kind: "INFO",
          level: "info",
          jobId: null,
          runId,
          opId: null,
          graphId: null,
          nodeId: null,
          childId: null,
          component: "graph",
          stage: "chunk",
          elapsedMs: null,
          payload: { body: "x".repeat(payloadSize) },
        },
      ],
    };

    const messages = serialiseResourceWatchResultForSse(result);
    const stream = renderResourceWatchSseMessages(messages, { maxChunkBytes: 64 });
    const parsed = parseSseStream(stream);

    expect(parsed).to.have.length(1);
    const dataLines = parsed[0]?.data ?? [];
    expect(dataLines.length).to.be.greaterThan(1);
    for (const line of dataLines) {
      expect(Buffer.byteLength(line, "utf8")).to.be.at.most(64);
    }
  });

  it("drops the oldest frames when the buffer exceeds capacity", () => {
    const warnings: Array<{ message: string; payload: Record<string, unknown> | undefined }> = [];
    const buffer = new ResourceWatchSseBuffer({
      clientId: "buffer-test",
      logger: {
        warn: (message: string, payload?: unknown) => {
          warnings.push({ message, payload: payload as Record<string, unknown> | undefined });
        },
      },
      maxBufferedMessages: 2,
      maxChunkBytes: 128,
      emitTimeoutMs: 50,
    });

    const buildResult = (seq: number): ResourceWatchResult => ({
      uri: "sc://runs/backpressure/events",
      kind: "run_events",
      nextSeq: seq,
      events: [
        {
          seq,
          ts: Date.now(),
          kind: "INFO",
          level: "info",
          jobId: null,
          runId: "backpressure",
          opId: null,
          graphId: null,
          nodeId: null,
          childId: null,
          component: "graph",
          stage: "buffer",
          elapsedMs: null,
          payload: { seq },
        },
      ],
    });

    buffer.enqueue(serialiseResourceWatchResultForSse(buildResult(1)));
    buffer.enqueue(serialiseResourceWatchResultForSse(buildResult(2)));
    buffer.enqueue(serialiseResourceWatchResultForSse(buildResult(3)));

    expect(buffer.size).to.equal(2);
    expect(
      warnings.some((entry) => entry.message === "resources_sse_buffer_overflow" && (entry.payload?.dropped as number) === 1),
    ).to.equal(true);
  });

  it("times out slow consumers instead of blocking indefinitely", async () => {
    const warnings: Array<{ message: string; payload: Record<string, unknown> | undefined }> = [];
    const buffer = new ResourceWatchSseBuffer({
      clientId: "slow-client",
      logger: {
        warn: (message: string, payload?: unknown) => {
          warnings.push({ message, payload: payload as Record<string, unknown> | undefined });
        },
      },
      maxBufferedMessages: 4,
      maxChunkBytes: 128,
      emitTimeoutMs: 25,
    });

    const result: ResourceWatchResult = {
      uri: "sc://runs/slow/events",
      kind: "run_events",
      nextSeq: 1,
      events: [
        {
          seq: 1,
          ts: Date.now(),
          kind: "INFO",
          level: "info",
          jobId: null,
          runId: "slow",
          opId: null,
          graphId: null,
          nodeId: null,
          childId: null,
          component: "graph",
          stage: "timeout",
          elapsedMs: null,
          payload: { message: "slow" },
        },
      ],
    };

    buffer.enqueue(serialiseResourceWatchResultForSse(result));

    const start = Date.now();
    await buffer.drain(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    const elapsed = Date.now() - start;

    expect(elapsed).to.be.lessThan(200);
    expect(
      warnings.some((entry) => entry.message === "resources_sse_emit_timeout" && (entry.payload?.timeout_ms as number) === 25),
    ).to.equal(true);
    expect(buffer.size).to.equal(0);
  });
});

