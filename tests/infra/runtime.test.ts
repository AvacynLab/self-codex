/**
 * Unit tests for the JSON-RPC runtime assembly helper. The scenarios exercise
 * tool budget discovery, timeout clamping, and context cloning to guarantee
 * transports receive deterministic trackers on every request.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import {
  assembleJsonRpcRuntime,
  type JsonRpcRouteContext,
  type RuntimeAssemblyDependencies,
} from "../../src/infra/runtime.js";
import { BudgetTracker, type BudgetLimits } from "../../src/infra/budget.js";
import type { RpcTimeoutBudget } from "../../src/rpc/timeouts.js";
import type { ToolBudgets } from "../../src/mcp/registry.js";

/**
 * Lightweight registry stub exposing just enough behaviour to satisfy the
 * runtime assembly helper. Tests can seed manifests with custom budgets while
 * keeping the implementation intentionally deterministic.
 */
class StubRegistry {
  constructor(private readonly manifests: Map<string, { budgets?: ToolBudgets }>) {}

  get(name: string): { budgets?: ToolBudgets } | undefined {
    return this.manifests.get(name);
  }
}

/** Helper returning a frozen timeout budget to make assertions explicit. */
function stubTimeoutBudget(timeoutMs: number, minMs: number, maxMs: number): RpcTimeoutBudget {
  return Object.freeze({ timeoutMs, minMs, maxMs });
}

describe("infra/runtime", () => {
  it("creates request and tool budgets while preserving context metadata", () => {
    const registry = new StubRegistry(
      new Map([
        [
          "artifact_write",
          {
            budgets: { time_ms: 1_500, tool_calls: 2, bytes_out: 4_096 },
          },
        ],
      ]),
    );

    const baseContext: JsonRpcRouteContext = {
      transport: "http",
      headers: { authorization: "Bearer test" },
      requestId: "abc-123",
      idempotencyKey: "idem-key",
      payloadSizeBytes: 512,
    };

    const deps: RuntimeAssemblyDependencies = {
      toolRegistry: registry,
      requestLimits: { timeMs: 10_000, tokens: 500, toolCalls: 3 },
      resolveTimeoutBudget: (method, tool) => {
        expect(method).to.equal("tools/call");
        expect(tool).to.equal("artifact_write");
        return stubTimeoutBudget(30_000, 5_000, 60_000);
      },
      defaultTimeoutOverride: 20_000,
    };

    const { context, requestBudget, toolBudget, timeoutBudget } = assembleJsonRpcRuntime(deps, {
      method: "tools/call",
      toolName: "artifact_write",
      context: baseContext,
    });

    expect(context, "runtime context is cloned").to.not.equal(baseContext);
    expect(baseContext.requestBudget, "original context must remain untouched").to.equal(undefined);
    expect(context.transport).to.equal("http");
    expect(context.headers).to.deep.equal(baseContext.headers);

    expect(context.requestBudget, "request tracker attached to context").to.equal(requestBudget);
    const requestSnapshot = requestBudget.snapshot();
    expect(requestSnapshot.limits.timeMs).to.equal(10_000);
    expect(requestSnapshot.limits.tokens).to.equal(500);
    expect(requestSnapshot.limits.toolCalls).to.equal(3);

    expect(toolBudget, "tool budget tracker instantiated").to.be.instanceOf(BudgetTracker);
    expect(context.budget, "tool tracker exposed through context").to.equal(toolBudget);
    const toolSnapshot = toolBudget?.snapshot();
    expect(toolSnapshot?.limits.timeMs).to.equal(1_500);
    expect(toolSnapshot?.limits.toolCalls).to.equal(2);
    expect(toolSnapshot?.limits.bytesOut).to.equal(4_096);

    expect(timeoutBudget.timeoutMs, "override respected within bounds").to.equal(20_000);
    expect(context.timeoutMs, "timeout stored on runtime context").to.equal(20_000);
  });

  it("falls back to request-only budgets and clamps tight timeout overrides", () => {
    const registry = new StubRegistry(new Map());
    const inheritedBudget = new BudgetTracker({ timeMs: 1_000 });
    const baseContext: JsonRpcRouteContext = { budget: inheritedBudget, transport: "stdio" };

    const deps: RuntimeAssemblyDependencies = {
      toolRegistry: registry,
      requestLimits: { bytesIn: 1_024 } as BudgetLimits,
      resolveTimeoutBudget: (method, tool) => {
        expect(method).to.equal("child_spawn");
        expect(tool).to.equal(null);
        return stubTimeoutBudget(10_000, 5_000, 20_000);
      },
      defaultTimeoutOverride: 1_000,
    };

    const { context, requestBudget, toolBudget, timeoutBudget } = assembleJsonRpcRuntime(deps, {
      method: "  child_spawn  ",
      toolName: null,
      context: baseContext,
    });

    expect(toolBudget, "no manifest -> no tool tracker").to.equal(null);
    expect(Object.prototype.hasOwnProperty.call(context, "budget"), "budget key removed when absent").to.equal(false);
    expect(baseContext.budget, "original budget preserved on parent context").to.equal(inheritedBudget);

    const requestSnapshot = requestBudget.snapshot();
    expect(requestSnapshot.limits.bytesIn).to.equal(1_024);

    expect(timeoutBudget.timeoutMs, "override clamped to minimum").to.equal(5_000);
    expect(context.timeoutMs).to.equal(5_000);
  });

  it("omits undefined entries when cloning inbound contexts", () => {
    const registry = new StubRegistry(new Map());
    const deps: RuntimeAssemblyDependencies = {
      toolRegistry: registry,
      requestLimits: { timeMs: 5_000 },
      resolveTimeoutBudget: () => stubTimeoutBudget(2_000, 1_000, 3_000),
      defaultTimeoutOverride: null,
    };

    const baseContext: JsonRpcRouteContext = {
      transport: undefined,
      childId: undefined,
      requestId: 42,
    };

    const { context } = assembleJsonRpcRuntime(deps, {
      method: "telemetry/emit",
      toolName: null,
      context: baseContext,
    });

    expect("transport" in context, "transport omitted when unspecified").to.equal(false);
    expect("childId" in context, "childId omitted when unspecified").to.equal(false);
    expect(context.requestId).to.equal(42);
  });
});

