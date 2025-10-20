import { expect } from "chai";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/sdk/server/mcp.js";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { BudgetTracker } from "../../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger, type LogEntry } from "../../../src/logger.js";
import { IdempotencyRegistry } from "../../../src/infra/idempotency.js";
import { PlanLifecycleRegistry } from "../../../src/executor/planLifecycle.js";
import { StigmergyField } from "../../../src/coord/stigmergy.js";
import { GraphState } from "../../../src/graph/state.js";
import {
  PLAN_COMPILE_EXECUTE_TOOL_NAME,
  createPlanCompileExecuteHandler,
  registerPlanCompileExecuteTool,
} from "../../../src/tools/plan_compile_execute.js";
import type { PlanToolContext } from "../../../src/tools/planTools.js";
import {
  ToolRegistry,
  ToolRegistrationError,
  getRegisteredToolMap,
} from "../../../src/mcp/registry.js";

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected in plan_compile_execute tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in plan_compile_execute tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

interface PlanTestContext {
  readonly planContext: PlanToolContext;
  readonly logger: StructuredLogger;
  readonly entries: LogEntry[];
}

function buildPlanContext(): PlanTestContext {
  const entries: LogEntry[] = [];
  const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
  const planContext: PlanToolContext = {
    supervisor: {} as PlanToolContext["supervisor"],
    graphState: new GraphState(),
    logger,
    childrenRoot: "/tmp",
    defaultChildRuntime: "codex",
    emitEvent: () => {
      // Intentionally left blank for tests; events are not asserted here.
    },
    stigmergy: new StigmergyField(),
    planLifecycle: new PlanLifecycleRegistry(),
    planLifecycleFeatureEnabled: true,
  };
  return { planContext, logger, entries };
}

/**
 * Helper bridging the private MCP server registry so ToolRegistry invocations
 * can exercise the façade end-to-end during tests. The helper mirrors the
 * runtime adapter by applying the registered Zod schema before calling the
 * underlying handler.
 */
async function invokeRegisteredTool(
  server: McpServer,
  tool: string,
  args: unknown,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<CallToolResult> {
  const registry = getRegisteredToolMap(server);
  if (!registry) {
    throw new Error("no tools registered on MCP server");
  }
  const entry = registry[tool];
  if (!entry) {
    throw new Error(`tool ${tool} not registered`);
  }
  if (entry.inputSchema) {
    const parsed = await entry.inputSchema.parseAsync(args ?? {});
    return await entry.callback(parsed, extra);
  }
  return await entry.callback(extra);
}

/**
 * Creates an isolated ToolRegistry instance backed by a temporary runs
 * directory. Each test receives a fresh MCP server so duplicate registration
 * assertions remain deterministic.
 */
async function createRegistryHarness() {
  const runsRoot = await mkdtemp(join(tmpdir(), "plan-facade-registry-"));
  const server = new McpServer({ name: "plan-facade-test", version: "1.0.0" });
  const registry = await ToolRegistry.create({
    server,
    logger: new StructuredLogger(),
    runsRoot,
    invokeTool: (name, args, extra) => invokeRegisteredTool(server, name, args, extra),
  });
  return {
    server,
    registry,
    runsRoot,
    async cleanup() {
      registry.close();
      await rm(runsRoot, { recursive: true, force: true });
    },
  };
}

describe("plan_compile_execute facade", () => {
  it("compiles a plan and surfaces schedule and tree summaries", async () => {
    const { planContext, logger, entries } = buildPlanContext();
    const idempotency = new IdempotencyRegistry();
    const handler = createPlanCompileExecuteHandler({ plan: planContext, logger, idempotency });
    const extras = createRequestExtras("req-plan-success");
    const budget = new BudgetTracker({ toolCalls: 2, bytesIn: 64_000 });

    const plan = {
      id: "demo-plan",
      version: "1.0.0",
      title: "Demo plan",
      tasks: [
        { id: "prepare", tool: "bb_set", input: { key: "ready", value: true }, estimated_duration_ms: 50 },
        { id: "execute", tool: "wait", depends_on: ["prepare"], estimated_duration_ms: 75 },
        { id: "finalise", tool: "noop", depends_on: ["execute"], estimated_duration_ms: 20 },
      ],
    };

    const result = await runWithRpcTrace(
      { method: `tools/${PLAN_COMPILE_EXECUTE_TOOL_NAME}`, traceId: "trace-plan-success", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ plan, dry_run: true, idempotency_key: "plan-success-1" }, extras),
        ),
    );

    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.summary).to.contain("demo-plan");
    expect(structured.details.stats.total_tasks).to.equal(3);
    expect(structured.details.plan_preview.preview_tasks).to.have.lengthOf(3);
    expect(structured.details.behavior_tree.total_nodes).to.be.greaterThan(0);
    expect(structured.details.plan_hash).to.match(/^[a-f0-9]{64}$/);
    expect(structured.details.idempotent).to.equal(false);

    const dryRunReport = structured.details.dry_run_report;
    expect(dryRunReport).to.not.equal(undefined);
    expect(dryRunReport.estimated_tool_calls).to.deep.equal([
      { tool: "bb_set", estimated_calls: 1 },
      { tool: "noop", estimated_calls: 1 },
      { tool: "wait", estimated_calls: 1 },
    ]);
    expect(dryRunReport.cumulative_budget).to.deep.equal({ tool_calls: 3 });

    const completionLog = entries.find((entry) => entry.message === "plan_compile_execute_completed");
    expect(completionLog?.request_id).to.equal("req-plan-success");
    expect(completionLog?.payload?.plan_id).to.equal("demo-plan");
  });

  it("replays a cached result when the idempotency key matches", async () => {
    const { planContext, logger } = buildPlanContext();
    const idempotency = new IdempotencyRegistry();
    const handler = createPlanCompileExecuteHandler({ plan: planContext, logger, idempotency });
    const extras = createRequestExtras("req-plan-idempotent");
    const budget = new BudgetTracker({ toolCalls: 4, bytesIn: 64_000 });

    const plan = {
      id: "demo-plan-idempotent",
      tasks: [
        { id: "step-1", tool: "bb_set", estimated_duration_ms: 10 },
        { id: "step-2", tool: "wait", depends_on: ["step-1"], estimated_duration_ms: 10 },
      ],
    };

    const first = await runWithRpcTrace(
      { method: `tools/${PLAN_COMPILE_EXECUTE_TOOL_NAME}`, traceId: "trace-plan-idempotent-1", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ plan, dry_run: true, idempotency_key: "plan-idem" }, extras),
        ),
    );
    const firstStructured = first.structuredContent as Record<string, any>;
    expect(firstStructured.ok).to.equal(true);
    expect(firstStructured.details.idempotent).to.equal(false);

    const second = await runWithRpcTrace(
      { method: `tools/${PLAN_COMPILE_EXECUTE_TOOL_NAME}`, traceId: "trace-plan-idempotent-2", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ plan, dry_run: true, idempotency_key: "plan-idem" }, extras),
        ),
    );
    const secondStructured = second.structuredContent as Record<string, any>;
    expect(secondStructured.ok).to.equal(true);
    expect(secondStructured.details.idempotent).to.equal(true);
  });

  it("returns structured diagnostics when the plan specification is invalid", async () => {
    const { planContext, logger, entries } = buildPlanContext();
    const handler = createPlanCompileExecuteHandler({ plan: planContext, logger });
    const extras = createRequestExtras("req-plan-invalid");
    const budget = new BudgetTracker({ toolCalls: 2, bytesIn: 16_000 });

    const invalidPlan = {
      id: "invalid-plan",
      tasks: [
        { id: "duplicate", tool: "noop" },
        { id: "duplicate", tool: "noop" },
      ],
    };

    const result = await runWithRpcTrace(
      { method: `tools/${PLAN_COMPILE_EXECUTE_TOOL_NAME}`, traceId: "trace-plan-invalid", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ plan: invalidPlan }, extras),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.summary).to.contain("plan invalide");
    expect(structured.details.error?.code).to.equal("E-PLAN-DUPLICATE");

    const degradeLog = entries.find((entry) => entry.message === "plan_compile_execute_degraded");
    expect(degradeLog?.payload?.reason).to.equal("plan_invalid");
  });

  it("surfaces budget exhaustion when no tool call budget remains", async () => {
    const { planContext, logger } = buildPlanContext();
    const handler = createPlanCompileExecuteHandler({ plan: planContext, logger });
    const extras = createRequestExtras("req-plan-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const plan = {
      id: "budget-plan",
      tasks: [{ id: "only", tool: "noop" }],
    };

    const result = await runWithRpcTrace(
      { method: `tools/${PLAN_COMPILE_EXECUTE_TOOL_NAME}`, traceId: "trace-plan-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ plan }, extras),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.budget?.reason).to.equal("budget_exhausted");
    expect(structured.details.budget?.dimension).to.equal("toolCalls");
  });

  it("validates the input payload and rejects malformed requests", async () => {
    const { planContext, logger } = buildPlanContext();
    const handler = createPlanCompileExecuteHandler({ plan: planContext, logger });
    const extras = createRequestExtras("req-plan-invalid-input");

    let captured: unknown;
    try {
      await handler({} as Record<string, unknown>, extras);
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});

describe("plan_compile_execute registration", () => {
  it("registers the façade manifest once via the ToolRegistry", async () => {
    const harness = await createRegistryHarness();
    const { planContext, logger } = buildPlanContext();

    try {
      const manifest = await registerPlanCompileExecuteTool(harness.registry, {
        plan: planContext,
        logger,
      });

      expect(manifest.name).to.equal(PLAN_COMPILE_EXECUTE_TOOL_NAME);
      expect(manifest.tags).to.include("facade");
      expect(manifest.tags).to.include("authoring");
      expect(manifest.tags).to.include("ops");
      expect(manifest.hidden).to.equal(false);
      expect(manifest.category).to.equal("plan");
      expect(manifest.budgets).to.deep.include({ tool_calls: 1 });

      const manifests = harness.registry.list().filter((entry) => entry.name === PLAN_COMPILE_EXECUTE_TOOL_NAME);
      expect(manifests).to.have.lengthOf(1);

      const registeredTools = getRegisteredToolMap(harness.server) ?? {};
      const registeredNames = Object.keys(registeredTools).filter((name) => name === PLAN_COMPILE_EXECUTE_TOOL_NAME);
      expect(registeredNames, "only one MCP server registration").to.have.lengthOf(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects duplicate registration attempts", async () => {
    const harness = await createRegistryHarness();
    const { planContext, logger } = buildPlanContext();

    try {
      await registerPlanCompileExecuteTool(harness.registry, { plan: planContext, logger });
      let caught: unknown;
      try {
        await registerPlanCompileExecuteTool(harness.registry, { plan: planContext, logger });
      } catch (error) {
        caught = error;
      }

      expect(caught, "duplicate registration should throw").to.be.instanceOf(ToolRegistrationError);
    } finally {
      await harness.cleanup();
    }
  });
});
