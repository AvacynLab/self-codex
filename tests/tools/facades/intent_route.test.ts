import { expect } from "chai";
import { z } from "zod";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { BudgetTracker } from "../../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger, type LogEntry } from "../../../src/logger.js";
import {
  INTENT_ROUTE_TOOL_NAME,
  createIntentRouteHandler,
} from "../../../src/tools/intent_route.js";
import type { ToolBudgets, ToolManifest } from "../../../src/mcp/registry.js";
import { ToolRouter } from "../../../src/tools/toolRouter.js";
import type { ToolRouterDecisionRecord } from "../../../src/tools/toolRouter.js";
import { IntentRouteOutputSchema } from "../../../src/rpc/schemas.js";

/** Budgets mirroring the manifests registered in production. */
const BUDGET_HINTS: Record<string, ToolBudgets> = {
  graph_apply_change_set: { time_ms: 7_000, tool_calls: 1, bytes_out: 24_576 },
  graph_snapshot_time_travel: { time_ms: 7_000, tool_calls: 1, bytes_out: 32_768 },
  plan_compile_execute: { time_ms: 10_000, tool_calls: 1, bytes_out: 32_768 },
  artifact_write: { time_ms: 5_000, tool_calls: 1, bytes_out: 8_192 },
  artifact_read: { time_ms: 3_000, tool_calls: 1, bytes_out: 16_384 },
  artifact_search: { time_ms: 4_000, tool_calls: 1, bytes_out: 24_576 },
  memory_search: { time_ms: 3_000, tool_calls: 1, bytes_out: 16_384 },
  memory_upsert: { time_ms: 5_000, tool_calls: 1, bytes_out: 12_288 },
  child_orchestrate: { time_ms: 15_000, tool_calls: 1, bytes_out: 32_768 },
  runtime_observe: { time_ms: 1_000, tool_calls: 1, bytes_out: 12_288 },
  tools_help: { time_ms: 1_000, tool_calls: 1, bytes_out: 16_384 },
};

/** Builds a router seeded with manifests mirroring the production catalogue. */
function createToolRouter(): ToolRouter {
  const router = new ToolRouter({
    fallbacks: [
      {
        tool: "tools_help",
        rationale: "aucune règle précise trouvée : proposer la documentation interactive",
        score: 0.55,
      },
      {
        tool: "artifact_search",
        rationale: "aucune règle précise trouvée : suggérer l'exploration des artefacts",
        score: 0.5,
      },
      {
        tool: "child_orchestrate",
        rationale: "aucune règle précise trouvée : envisager un enfant opérateur",
        score: 0.45,
      },
    ],
  });
  const timestamp = new Date(2025, 0, 1).toISOString();
  const register = (manifest: ToolManifest) => router.register(manifest);

  const manifests: ToolManifest[] = [
    {
      name: "graph_apply_change_set",
      title: "Graph apply change set",
      description: "Appliquer un patch sur le graphe",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "graph",
      tags: ["graph", "mutation"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "graph_snapshot_time_travel",
      title: "Graph snapshot time travel",
      description: "Explorer les snapshots du graphe",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "graph",
      tags: ["graph", "snapshot"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "plan_compile_execute",
      title: "Plan compile execute",
      description: "Compiler et exécuter un plan",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "plan",
      tags: ["plan", "execution"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "artifact_write",
      title: "Artifact write",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "artifact",
      tags: ["artifact", "write"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "artifact_read",
      title: "Artifact read",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "artifact",
      tags: ["artifact", "read"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "artifact_search",
      title: "Artifact search",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "artifact",
      tags: ["artifact", "search"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "memory_search",
      title: "Memory search",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "memory",
      tags: ["memory", "search"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "memory_upsert",
      title: "Memory upsert",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "memory",
      tags: ["memory", "write"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "child_orchestrate",
      title: "Child orchestrate",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "child",
      tags: ["child", "orchestration"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "runtime_observe",
      title: "Runtime observe",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "runtime",
      tags: ["metrics"],
      hidden: false,
      source: "runtime",
    },
    {
      name: "tools_help",
      title: "Tools help",
      kind: "dynamic",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      category: "admin",
      tags: ["facade"],
      hidden: false,
      source: "runtime",
    },
  ];

  manifests.forEach(register);
  return router;
}

/**
 * Builds a minimal `RequestHandlerExtra` object satisfying the MCP SDK typing
 * contract. Tests do not rely on notifications or nested requests so the
 * methods intentionally throw when invoked to surface unexpected usage.
 */
function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    sendNotification: async () => {
      throw new Error("notifications are not expected in intent_route tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in intent_route tests");
    },
    requestId,
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("intent_route facade", () => {
  it("routes graph related goals to the graph_apply_change_set façade", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const router = createToolRouter();
    const recordedDecisions: ToolRouterDecisionRecord[] = [];
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
      toolRouter: router,
      recordRouterDecision: (record) => recordedDecisions.push(record),
    });
    const extras = createRequestExtras("req-graph-1");
    const budget = new BudgetTracker({ toolCalls: 4 });

    const result = await runWithRpcTrace(
      { method: `tools/${INTENT_ROUTE_TOOL_NAME}`, traceId: "trace-graph-1", requestId: "req-graph-1" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-graph-1", budget }, () =>
          handler({ natural_language_goal: "Modifier le graphe de dépendances" }, extras),
        ),
    );

    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.summary).to.equal("top recommandation : graph_apply_change_set");
    expect(structured.details.idempotency_key).to.be.a("string").with.length.greaterThan(0);
    expect(structured.details.recommendations)
      .to.be.an("array")
      .with.length.greaterThan(0);
    const [primary, ...rest] = structured.details.recommendations as Array<Record<string, any>>;
    expect(primary.tool).to.equal("graph_apply_change_set");
    expect(primary.score).to.be.greaterThan(0.9);
    expect(primary.rationale).to.include("graphe");
    expect(primary.estimated_budget).to.deep.equal({
      time_ms: 7_000,
      tool_calls: 1,
      bytes_out: 24_576,
    });
    expect(structured.details.diagnostics).to.satisfy((diagnostics: Array<Record<string, unknown>>) =>
      diagnostics.some((entry) => entry.tool === "graph_apply_change_set" && entry.matched === true),
    );
    expect(rest).to.have.length.of.at.most(2);

    const evaluationLog = entries.find((entry) => entry.message === "intent_route_evaluated");
    expect(evaluationLog?.request_id).to.equal("req-graph-1");
    expect(evaluationLog?.trace_id).to.equal("trace-graph-1");
    expect((evaluationLog?.payload as Record<string, any> | undefined)?.top_tool).to.equal(
      "graph_apply_change_set",
    );
    expect(recordedDecisions).to.have.length(1);
    expect(recordedDecisions[0]?.decision.tool).to.be.a("string");
  });

  it("suggests fallback candidates when no heuristic matches", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const router = createToolRouter();
    const recordedDecisions: ToolRouterDecisionRecord[] = [];
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
      toolRouter: router,
      recordRouterDecision: (record) => recordedDecisions.push(record),
    });
    const extras = createRequestExtras("req-fallback-1");
    const budget = new BudgetTracker({ toolCalls: 3 });

    const result = await runWithRpcTrace(
      { method: `tools/${INTENT_ROUTE_TOOL_NAME}`, traceId: "trace-fallback-1", requestId: "req-fallback-1" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-fallback-1", budget }, () =>
          handler({ natural_language_goal: "J'aimerais explorer les capacités disponibles" }, extras),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.summary).to.equal("top recommandation : tools_help");
    expect(structured.details.recommendations).to.deep.equal([
      {
        tool: "tools_help",
        score: 0.6,
        rationale:
          "routeur contextuel : aucune règle précise trouvée : proposer la documentation interactive",
        estimated_budget: { time_ms: 1_000, tool_calls: 1, bytes_out: 16_384 },
      },
      {
        tool: "artifact_search",
        score: 0.54,
        rationale:
          "routeur contextuel : aucune règle précise trouvée : suggérer l'exploration des artefacts",
        estimated_budget: { time_ms: 4_000, tool_calls: 1, bytes_out: 24_576 },
      },
      {
        tool: "child_orchestrate",
        score: 0.48,
        rationale:
          "routeur contextuel : aucune règle précise trouvée : envisager un enfant opérateur",
        estimated_budget: { time_ms: 15_000, tool_calls: 1, bytes_out: 32_768 },
      },
    ]);
    expect(structured.details.diagnostics).to.be.an("array").that.is.not.empty;
    expect(recordedDecisions).to.have.length(1);
    expect(recordedDecisions[0]?.decision.tool).to.equal("tools_help");
  });

  it("returns a degraded response when the caller exhausted its budget", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const router = createToolRouter();
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
      toolRouter: router,
    });
    const extras = createRequestExtras("req-budget-1");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${INTENT_ROUTE_TOOL_NAME}`, traceId: "trace-budget-1", requestId: "req-budget-1" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-budget-1", budget }, () =>
          handler({ natural_language_goal: "Analyser un plan" }, extras),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.reason).to.equal("budget_exhausted");
    expect(structured.details.dimension).to.equal("toolCalls");
    expect(structured.details.diagnostics).to.deep.equal([]);
  });

  it("publishes a typed degraded payload when the router is disabled", async () => {
    const logger = new StructuredLogger();
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
      isRouterEnabled: () => false,
    });
    const extras = createRequestExtras("req-router-disabled-1");

    const result = await runWithJsonRpcContext(
      { requestId: "req-router-disabled-1" },
      () => handler({ natural_language_goal: "Inspecter un artefact" }, extras),
    );

    expect(result.isError).to.equal(true);
    const structured = IntentRouteOutputSchema.parse(result.structuredContent);
    expect(structured.ok).to.equal(false);
    expect(structured.summary).to.equal("routeur d'intentions désactivé");
    expect(structured.details).to.deep.include({ reason: "router_disabled" });
    expect(structured.details.idempotency_key).to.be.a("string").with.length.greaterThan(0);
  });

  it("orders multiple heuristic hits by confidence before adding fallbacks", async () => {
    const logger = new StructuredLogger();
    const router = createToolRouter();
    const recordedDecisions: ToolRouterDecisionRecord[] = [];
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
      toolRouter: router,
      recordRouterDecision: (record) => recordedDecisions.push(record),
    });
    const extras = createRequestExtras("req-memory-1");
    const budget = new BudgetTracker({ toolCalls: 5 });

    const result = await runWithRpcTrace(
      { method: `tools/${INTENT_ROUTE_TOOL_NAME}`, traceId: "trace-memory-1", requestId: "req-memory-1" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-memory-1", budget }, () =>
          handler({ natural_language_goal: "Je veux rechercher et ajouter un souvenir mémoire" }, extras),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    const recommendations = structured.details.recommendations as Array<Record<string, any>>;
    expect(recommendations).to.have.length(3);
    expect(recommendations[0].tool).to.equal("memory_search");
    expect(recommendations[1].tool).to.equal("memory_upsert");
    expect(recommendations[2].tool).to.equal("tools_help");
    expect(recommendations[0].score).to.be.greaterThan(recommendations[1].score);
    expect(recommendations[1].score).to.be.greaterThan(recommendations[2].score);
    expect(recordedDecisions).to.have.length(1);
  });

  it("propagates planner metadata hints into the router context", async () => {
    const logger = new StructuredLogger();
    const router = createToolRouter();
    const recordedDecisions: ToolRouterDecisionRecord[] = [];
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
      toolRouter: router,
      recordRouterDecision: (record) => recordedDecisions.push(record),
    });
    const extras = createRequestExtras("req-router-metadata-1");
    const budget = new BudgetTracker({ toolCalls: 4 });

    const metadata = {
      category: "Planner",
      tags: ["Ops", " Graph  "],
      domains: ["Reliability", "GraphOps"],
      preferred_tools: ["plan_compile_execute", "artifact_write", ""],
      router_context: {
        category: "graph_operations",
        tags: [" Planner ", "Fallback"],
        preferred_tools: ["graph_apply_change_set"],
        keywords: ["Graph maintenance", "patch"],
      },
      goal_keywords: ["GraphOps", "fix"],
      keywords: "graph,maintenance",
    } as Record<string, unknown>;

    const result = await runWithRpcTrace(
      {
        method: `tools/${INTENT_ROUTE_TOOL_NAME}`,
        traceId: "trace-router-metadata-1",
        requestId: "req-router-metadata-1",
      },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-router-metadata-1", budget }, () =>
          handler(
            {
              natural_language_goal: "Applique un patch précis sur le graphe",
              metadata,
            },
            extras,
          ),
        ),
    );

    expect(recordedDecisions).to.have.length(1);
    const context = recordedDecisions[0]!.context;
    expect(context.goal).to.equal("applique un patch précis sur le graphe");
    expect(context.metadata).to.deep.equal(metadata);
    expect(context.category).to.equal("graph_operations");
    expect(context.tags).to.include.members([
      "ops",
      "graph",
      "reliability",
      "graphops",
      "planner",
      "fallback",
      "graph maintenance",
      "patch",
      "graph_mutation",
      "fix",
      "maintenance",
    ]);
    expect(context.preferredTools).to.include.members([
      "plan_compile_execute",
      "graph_apply_change_set",
    ]);
    expect(context.preferredTools).to.not.include("");

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.details.metadata).to.deep.equal(metadata);
  });

  it("omits optional routing hints when metadata is absent", async () => {
    const logger = new StructuredLogger();
    const router = createToolRouter();
    const recordedDecisions: ToolRouterDecisionRecord[] = [];
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
      toolRouter: router,
      recordRouterDecision: (record) => recordedDecisions.push(record),
    });
    const extras = createRequestExtras("req-router-minimal");
    const budget = new BudgetTracker({ toolCalls: 2 });

    await runWithRpcTrace(
      { method: `tools/${INTENT_ROUTE_TOOL_NAME}`, traceId: "trace-router-minimal", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ natural_language_goal: "Inspecte les options" }, extras),
        ),
    );

    expect(recordedDecisions).to.have.length(1);
    const context = recordedDecisions[0]!.context;
    // Optional properties such as category, tags or preferred tools must be omitted entirely when no hint is provided.
    expect(context.goal).to.equal("inspecte les options");
    expect("category" in context).to.equal(false);
    expect("tags" in context).to.equal(false);
    expect("preferredTools" in context).to.equal(false);
    expect("metadata" in context).to.equal(false);
  });

  it("validates the natural language goal string", async () => {
    const logger = new StructuredLogger();
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
    });
    const extras = createRequestExtras("req-invalid-1");

    let captured: unknown;
    try {
      await handler({} as Record<string, unknown>, extras);
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});
