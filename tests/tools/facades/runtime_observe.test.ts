import { expect } from "chai";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { BudgetTracker } from "../../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import {
  __tracingInternals,
  registerRpcError,
  registerRpcSuccess,
  runWithRpcTrace,
} from "../../../src/infra/tracing.js";
import { StructuredLogger, type LogEntry } from "../../../src/logger.js";
import { getMcpRuntimeSnapshot, setMcpRuntimeSnapshot } from "../../../src/mcp/info.js";
import {
  RUNTIME_OBSERVE_TOOL_NAME,
  createRuntimeObserveHandler,
} from "../../../src/tools/runtime_observe.js";

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("runtime_observe tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("runtime_observe tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

const ORIGINAL_SNAPSHOT = getMcpRuntimeSnapshot();

describe("runtime_observe facade", () => {
  beforeEach(() => {
    __tracingInternals.reset();
    setMcpRuntimeSnapshot(ORIGINAL_SNAPSHOT);
  });

  afterEach(() => {
    __tracingInternals.reset();
    setMcpRuntimeSnapshot(ORIGINAL_SNAPSHOT);
  });

  it("collects the runtime snapshot and metrics by default", async () => {
    const snapshot = {
      server: { name: "self-codex", version: "2.0.0", protocol: "1.0" },
      transports: {
        stdio: { enabled: true },
        http: { enabled: true, host: "127.0.0.1", port: 9999, path: "/mcp", enableJson: true, stateless: false },
      },
      features: { enableAssist: true, enableLoopGuard: false },
      timings: {
        btTickMs: 50,
        stigHalfLifeMs: 30_000,
        supervisorStallTicks: 6,
        defaultTimeoutMs: 60_000,
        autoscaleCooldownMs: 5_000,
        heartbeatIntervalMs: 2_000,
      },
      safety: { maxChildren: 16, memoryLimitMb: 512, cpuPercent: 100 },
      limits: { maxInputBytes: 128_000, defaultTimeoutMs: 60_000, maxEventHistory: 1_000 },
    } as const;
    setMcpRuntimeSnapshot(snapshot);

    await runWithRpcTrace({ method: "tools/artifact_write", traceId: "trace-metric-1" }, async () => {
      registerRpcSuccess();
    });
    await runWithRpcTrace({ method: "tools/artifact_read", traceId: "trace-metric-2" }, async () => {
      registerRpcError("TIMEOUT");
    });

    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createRuntimeObserveHandler({ logger });
    const extras = createRequestExtras("req-runtime-default");
    const budget = new BudgetTracker({ toolCalls: 5 });

    const result = await runWithRpcTrace(
      { method: `tools/${RUNTIME_OBSERVE_TOOL_NAME}`, traceId: "trace-runtime-1", requestId: "req-runtime-default" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-runtime-default", budget }, () => handler({}, extras)),
    );

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.sections).to.include.members(["snapshot", "metrics"]);
    expect(structured.details.snapshot.server.name).to.equal("self-codex");
    expect(structured.details.snapshot.transports.http.port).to.equal(9999);
    expect(structured.details.metrics.total_methods).to.be.at.least(2);

    const logEntry = entries.find((entry) => entry.message === "runtime_observe_collected");
    expect(logEntry?.request_id).to.equal("req-runtime-default");
    expect(logEntry?.trace_id).to.equal("trace-runtime-1");
    const payload = (logEntry?.payload ?? {}) as Record<string, any>;
    expect(payload.sections).to.deep.equal(["snapshot", "metrics"]);
  });

  it("filters metrics when methods and limit are provided", async () => {
    const snapshot = {
      server: { name: "self-codex", version: "2.0.0", protocol: "1.0" },
      transports: {
        stdio: { enabled: true },
        http: { enabled: false, host: null, port: null, path: null, enableJson: true, stateless: false },
      },
      features: { enableAssist: false },
      timings: {
        btTickMs: 50,
        stigHalfLifeMs: 30_000,
        supervisorStallTicks: 6,
        defaultTimeoutMs: 60_000,
        autoscaleCooldownMs: 5_000,
        heartbeatIntervalMs: 2_000,
      },
      safety: { maxChildren: 8, memoryLimitMb: 256, cpuPercent: 80 },
      limits: { maxInputBytes: 64_000, defaultTimeoutMs: 60_000, maxEventHistory: 500 },
    } as const;
    setMcpRuntimeSnapshot(snapshot);

    const methods = ["tools/graph_apply_change_set", "tools/graph_snapshot_time_travel", "tools/plan_compile_execute"] as const;
    for (const [index, method] of methods.entries()) {
      await runWithRpcTrace({ method, traceId: `trace-metric-${index}` }, async () => {
        if (index === 0) {
          registerRpcError("VALIDATION_ERROR");
        } else {
          registerRpcSuccess();
        }
      });
    }

    const logger = new StructuredLogger();
    const handler = createRuntimeObserveHandler({ logger });
    const extras = createRequestExtras("req-runtime-filter");
    const budget = new BudgetTracker({ toolCalls: 3 });

    const result = await runWithRpcTrace(
      { method: `tools/${RUNTIME_OBSERVE_TOOL_NAME}`, traceId: "trace-runtime-2", requestId: "req-runtime-filter" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-runtime-filter", budget }, () =>
          handler({ methods: [methods[0], methods[1]], limit: 1, include_error_codes: true }, extras),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.metrics.returned_methods).to.equal(1);
    expect(structured.details.metrics.methods[0]?.method).to.equal(methods[0]);
    expect(structured.details.metrics.methods[0]?.error_codes).to.have.property("VALIDATION_ERROR");
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const snapshot = ORIGINAL_SNAPSHOT;
    setMcpRuntimeSnapshot(snapshot);

    const logger = new StructuredLogger();
    const handler = createRuntimeObserveHandler({ logger });
    const extras = createRequestExtras("req-runtime-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${RUNTIME_OBSERVE_TOOL_NAME}`, traceId: "trace-runtime-3", requestId: "req-runtime-budget" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-runtime-budget", budget }, () => handler({}, extras)),
    );

    expect(result.isError).to.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.budget.reason).to.equal("budget_exhausted");
  });
});
