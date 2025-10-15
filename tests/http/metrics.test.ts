import { beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import {
  __tracingInternals,
  runWithRpcTrace,
  registerRpcSuccess,
  registerRpcError,
  recordSseDrop,
  registerChildRestart,
  registerIdempotencyConflict,
  reportOpenSseClients,
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
      registerRpcSuccess();
    });
    await runWithRpcTrace({ method: "tools/call", requestId: "rpc-2" }, async () => {
      registerRpcError(-32000);
    }).catch(() => {
      // The simulated error is intentional for the metric assertions below.
    });

    recordSseDrop(3);
    registerChildRestart();
    registerIdempotencyConflict();
    reportOpenSseClients(2);
    reportOpenChildRuntimes(5);

    const snapshot = renderMetricsSnapshot();

    expect(snapshot).to.contain("rpc_count{method=\"tools/call\"} 2");
    expect(snapshot).to.contain("rpc_error_count{method=\"tools/call\"} 1");
    expect(snapshot).to.contain("# mcp infra metrics");
    expect(snapshot).to.contain("sse_drops 3");
    expect(snapshot).to.contain("child_restarts 1");
    expect(snapshot).to.contain("idempotency_conflicts 1");
    expect(snapshot).to.contain("open_sse 2");
    expect(snapshot).to.contain("open_children 5");
  });
});
