import { describe, it } from "mocha";
import { expect } from "chai";

import { StructuredLogger, type LogEntry } from "../../src/logger.js";
import {
  runWithRpcTrace,
  registerInboundBytes,
  registerOutboundBytes,
  annotateTraceContext,
} from "../../src/infra/tracing.js";

/**
 * Regression coverage for the structured logger enrichment logic. The tests
 * ensure correlation identifiers and byte counters are attached to payloads
 * emitted while a trace context is active.
 */
describe("observability logs", () => {
  it("attaches trace, request and IO metadata to payloads", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      onEntry(entry) {
        entries.push(entry);
      },
    });

    await runWithRpcTrace({ method: "graph_patch", requestId: "req-123", childId: "child-9", bytesIn: 0 }, async () => {
      registerInboundBytes(28);
      registerOutboundBytes(64);
      annotateTraceContext({ childId: "child-9" });

      logger.info("observability_check", { custom: true });
    });

    expect(entries).to.have.lengthOf(1);
    const payload = entries[0]?.payload as Record<string, unknown>;
    expect(payload).to.not.be.undefined;
    expect(payload.custom).to.equal(true);
    expect(payload.trace_id).to.be.a("string");
    expect(payload.span_id).to.be.a("string");
    expect(payload.request_id).to.equal("req-123");
    expect(payload.child_id).to.equal("child-9");
    expect(payload.method).to.equal("graph_patch");
    expect(payload.duration_ms).to.be.a("number");
    expect(payload.bytes_in).to.be.a("number");
    expect(payload.bytes_out).to.be.a("number");
  });
});

