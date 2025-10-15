import { expect } from "chai";
import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { StructuredLogger } from "../../src/logger.js";
import { createPlanCompileExecuteHandler } from "../../src/tools/plan_compile_execute.js";
import type { PlanToolContext } from "../../src/tools/planTools.js";
import { GraphState } from "../../src/graphState.js";
import { StigmergyField } from "../../src/coord/stigmergy.js";
import { PlanLifecycleRegistry } from "../../src/executor/planLifecycle.js";

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    requestId,
    signal: controller.signal,
    sendNotification: async () => {
      throw new Error("notifications are not expected in dry-run tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in dry-run tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function buildPlanContext(): { planContext: PlanToolContext; logger: StructuredLogger } {
  const logger = new StructuredLogger();
  const planContext: PlanToolContext = {
    supervisor: {} as PlanToolContext["supervisor"],
    graphState: new GraphState(),
    logger,
    childrenRoot: "/tmp",
    defaultChildRuntime: "codex",
    emitEvent: () => {
      // The dry-run preview never emits orchestration events.
    },
    stigmergy: new StigmergyField(),
    planLifecycle: new PlanLifecycleRegistry(),
    planLifecycleFeatureEnabled: true,
  };
  return { planContext, logger };
}

describe("plan_compile_execute dry-run preview", () => {
  it("aggregates manifest budgets to expose a cumulative envelope", async () => {
    const { planContext, logger } = buildPlanContext();
    const budgets: Record<string, { time_ms?: number; bytes_out?: number; tool_calls?: number }> = {
      artifact_write: { time_ms: 500, bytes_out: 1024, tool_calls: 1 },
      graph_apply_change_set: { time_ms: 1500, bytes_out: 4096, tool_calls: 1 },
    };
    const handler = createPlanCompileExecuteHandler({
      plan: planContext,
      logger,
      resolveBudget: (tool) => budgets[tool],
    });
    const extras = createRequestExtras("req-plan-dry-run");

    const plan = {
      id: "dry-run-plan",
      tasks: [
        { id: "prepare", tool: "artifact_write", estimated_duration_ms: 25 },
        { id: "apply", tool: "graph_apply_change_set", estimated_duration_ms: 40 },
        { id: "verify", tool: "artifact_write", estimated_duration_ms: 30 },
        { id: "cleanup", tool: "noop", estimated_duration_ms: 10 },
      ],
    };

    const result = await handler({ plan, dry_run: true, idempotency_key: "dry-run-test" }, extras);
    const structured = result.structuredContent as Record<string, any>;

    expect(structured.ok).to.equal(true);
    const dryRunReport = structured.details.dry_run_report;
    expect(dryRunReport).to.not.equal(undefined);
    expect(dryRunReport.estimated_tool_calls).to.deep.equal([
      { tool: "artifact_write", estimated_calls: 2, budget: { time_ms: 1000, bytes_out: 2048, tool_calls: 2 } },
      { tool: "graph_apply_change_set", estimated_calls: 1, budget: { time_ms: 1500, bytes_out: 4096, tool_calls: 1 } },
      { tool: "noop", estimated_calls: 1 },
    ]);
    expect(dryRunReport.cumulative_budget).to.deep.equal({
      tool_calls: 4,
      time_ms: 2500,
      bytes_out: 6144,
    });
  });
});
