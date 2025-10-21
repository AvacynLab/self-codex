import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  runWithRpcTrace,
  registerInboundBytes,
  registerOutboundBytes,
  registerRpcError,
  registerRpcSuccess,
  collectMethodMetrics,
  renderMetricsSnapshot,
  __tracingInternals,
} from "../../src/infra/tracing.js";
import { BudgetExceededError, BudgetTracker } from "../../src/infra/budget.js";

/**
 * Unit coverage ensuring the tracing helpers accumulate per-method metrics and
 * expose them via the `/metrics` endpoint. The tests rely on the public API so
 * production code stays untouched.
 */
describe("observability metrics", () => {
  afterEach(async () => {
    sinon.restore();
    __tracingInternals.configureOtlp(null);
    await __tracingInternals.flushOtlpQueue();
  });

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
    expect(snapshot.errorCodes).to.deep.equal({ unknown: 1 });
    expect(snapshot.p50).to.be.at.least(0);
    expect(snapshot.p95).to.be.at.least(snapshot.p50);

    const rendered = renderMetricsSnapshot();
    expect(rendered).to.contain("rpc_count{method=\"graph_patch\"} 2");
    expect(rendered).to.contain("rpc_error_count{method=\"graph_patch\"} 1");
    expect(rendered).to.contain("rpc_latency_ms_p99{method=\"graph_patch\"}");
    expect(rendered).to.contain("rpc_error_code_count{method=\"graph_patch\",code=\"unknown\"} 1");
  });

  it("records explicit RPC error codes when provided", async () => {
    await runWithRpcTrace({ method: "tool_call", requestId: "req-7" }, async () => {
      registerRpcError(-32099);
    });

    await runWithRpcTrace({ method: "tool_call", requestId: "req-8" }, async () => {
      registerRpcSuccess();
    });

    const [snapshot] = collectMethodMetrics();
    expect(snapshot.errorCount).to.equal(1);
    expect(snapshot.errorCodes).to.deep.equal({ "-32099": 1 });

    const rendered = renderMetricsSnapshot();
    expect(rendered).to.contain("rpc_error_code_count{method=\"tool_call\",code=\"-32099\"} 1");
  });

  it("exports spans to an OTLP endpoint when configured", async () => {
    const fetchStub = sinon.stub(globalThis, "fetch");
    fetchStub.resolves(new Response(null, { status: 200 }));
    __tracingInternals.configureOtlp({ endpoint: "https://example.test/v1/traces", headers: { "content-type": "application/json" } });

    await runWithRpcTrace({ method: "graph_patch", requestId: "req-otlp", bytesIn: 12 }, async () => {
      registerOutboundBytes(34);
      registerRpcSuccess();
    });

    await __tracingInternals.flushOtlpQueue();
    expect(fetchStub.calledOnce).to.equal(true);

    const [, init] = fetchStub.firstCall.args;
    expect(init?.method).to.equal("POST");
    expect(init?.headers).to.deep.equal({ "content-type": "application/json" });
    const body = init?.body as string;
    expect(body).to.be.a("string");
    const parsed = JSON.parse(body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> };
    const span = parsed.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(span?.traceId).to.be.a("string");
    expect(span?.attributes).to.satisfy((value: unknown) => Array.isArray(value) && value.length >= 2);
  });

  it("summarises budget consumption and exhaustion", async () => {
    await runWithRpcTrace({ method: "child_spawn_codex", requestId: "budget-1" }, async () => {
      const tracker = new BudgetTracker({ tokens: 5, bytesOut: 64 });
      tracker.consume(
        { tokens: 3, bytesOut: 16 },
        { actor: "transport", stage: "ingress", operation: "child_spawn_codex" },
      );
      tracker.consume({ tokens: 2 }, { actor: "transport", stage: "egress", operation: "child_spawn_codex" });
      try {
        tracker.consume({ tokens: 1 }, { actor: "transport", stage: "ingress", operation: "child_spawn_codex" });
      } catch (error) {
        expect(error).to.be.instanceOf(BudgetExceededError);
      }
    });

    const rendered = renderMetricsSnapshot();
    expect(rendered).to.contain(
      "budget_consumed_total{method=\"child_spawn_codex\",stage=\"ingress\",actor=\"transport\",dimension=\"tokens\"} 3",
    );
    expect(rendered).to.contain(
      "budget_consumed_total{method=\"child_spawn_codex\",stage=\"ingress\",actor=\"transport\",dimension=\"bytesOut\"} 16",
    );
    expect(rendered).to.contain(
      "budget_consumed_total{method=\"child_spawn_codex\",stage=\"egress\",actor=\"transport\",dimension=\"tokens\"} 2",
    );
    expect(rendered).to.contain(
      "budget_exhausted_total{method=\"child_spawn_codex\",stage=\"ingress\",actor=\"transport\",dimension=\"tokens\"} 1",
    );
  });
});

