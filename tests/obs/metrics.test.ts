import { beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import {
  runWithRpcTrace,
  registerInboundBytes,
  registerOutboundBytes,
  collectMethodMetrics,
  renderMetricsSnapshot,
  __tracingInternals,
} from "../../src/infra/tracing.js";

/**
 * Unit coverage ensuring the tracing helpers accumulate per-method metrics and
 * expose them via the `/metrics` endpoint. The tests rely on the public API so
 * production code stays untouched.
 */
describe("observability metrics", () => {
  beforeEach(() => {
    __tracingInternals.reset();
  });

  it("tracks counts, errors and percentile estimates", async () => {
    await runWithRpcTrace({ method: "graph_patch", requestId: "1", bytesIn: 0 }, async () => {
      registerInboundBytes(128);
      registerOutboundBytes(256);
    });

    await runWithRpcTrace({ method: "graph_patch", requestId: "2", bytesIn: 0 }, async () => {
      registerInboundBytes(64);
      registerOutboundBytes(32);
      throw new Error("simulated failure");
    }).catch(() => {
      // The error is expected for the test, therefore we swallow it.
    });

    const metrics = collectMethodMetrics();
    expect(metrics).to.have.lengthOf(1);
    const [snapshot] = metrics;
    expect(snapshot.method).to.equal("graph_patch");
    expect(snapshot.count).to.equal(2);
    expect(snapshot.errorCount).to.equal(1);
    expect(snapshot.p50).to.be.at.least(0);
    expect(snapshot.p95).to.be.at.least(snapshot.p50);

    const rendered = renderMetricsSnapshot();
    expect(rendered).to.contain("rpc_count{method=\"graph_patch\"} 2");
    expect(rendered).to.contain("rpc_error_count{method=\"graph_patch\"} 1");
  });
});

