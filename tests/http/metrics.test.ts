import { beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import {
  __tracingInternals,
  runWithRpcTrace,
  registerRpcSuccess,
  registerRpcError,
  annotateTraceContext,
  recordSseDrop,
  registerChildRestart,
  registerIdempotencyConflict,
  reportOpenSseStreams,
  reportOpenChildRuntimes,
  renderMetricsSnapshot,
} from "../../src/infra/tracing.js";

/**
 * Regression coverage for the `/metrics` handler output. The suite exercises the
 * tracing helpers directly so we can guarantee the rendered payload exposes the
 * counters required by the production HTTP endpoint without bootstrapping the
 * entire server.
 */
describe("http metrics", () => {
  beforeEach(() => {
    __tracingInternals.reset();
  });

  it("renders latency, counters and gauges for observability dashboards", async () => {
    await runWithRpcTrace({ method: "tools/call", requestId: "rpc-1" }, async () => {
      annotateTraceContext({ method: "tool:artifact_write" });
      registerRpcSuccess();
    });
    await runWithRpcTrace({ method: "tools/call", requestId: "rpc-2" }, async () => {
      annotateTraceContext({ method: "tool:artifact_write" });
      registerRpcError(-32000);
    }).catch(() => {
      // The simulated error is intentional for the metric assertions below.
    });

    recordSseDrop(3);
    registerChildRestart();
    registerIdempotencyConflict();
    reportOpenSseStreams(2);
    reportOpenChildRuntimes(5);

    const snapshot = renderMetricsSnapshot();

    expect(snapshot).to.contain("rpc_count{method=\"tool:artifact_write\"} 2");
    expect(snapshot).to.contain("rpc_error_count{method=\"tool:artifact_write\"} 1");
    // Percentile gauges expose the latency distribution per façade so dashboards can flag regressions.
    expect(snapshot).to.contain("rpc_latency_ms_p50{method=\"tool:artifact_write\"}");
    expect(snapshot).to.contain("rpc_latency_ms_p95{method=\"tool:artifact_write\"}");
    expect(snapshot).to.contain("rpc_latency_ms_p99{method=\"tool:artifact_write\"}");
    expect(snapshot).to.contain("# mcp infra metrics");
    expect(snapshot).to.contain("sse_drops_total 3");
    expect(snapshot).to.contain("child_restarts_total 1");
    expect(snapshot).to.contain("idempotency_conflicts_total 1");
    expect(snapshot).to.contain("open_sse_streams 2");
    expect(snapshot).to.contain("open_children 5");
  });
});
