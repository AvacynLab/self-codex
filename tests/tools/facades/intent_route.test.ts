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
import type { ToolBudgets } from "../../../src/mcp/registry.js";

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
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
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
  });

  it("suggests fallback candidates when no heuristic matches", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
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
        score: 0.55,
        rationale: "aucune règle précise trouvée : proposer la documentation interactive",
        estimated_budget: { time_ms: 1_000, tool_calls: 1, bytes_out: 16_384 },
      },
      {
        tool: "artifact_search",
        score: 0.5,
        rationale: "aucune règle précise trouvée : suggérer l'exploration des artefacts",
        estimated_budget: { time_ms: 4_000, tool_calls: 1, bytes_out: 24_576 },
      },
      {
        tool: "child_orchestrate",
        score: 0.45,
        rationale: "aucune règle précise trouvée : envisager un enfant opérateur",
        estimated_budget: { time_ms: 15_000, tool_calls: 1, bytes_out: 32_768 },
      },
    ]);
    expect(structured.details.diagnostics).to.be.an("array").that.is.not.empty;
  });

  it("returns a degraded response when the caller exhausted its budget", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
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

  it("orders multiple heuristic hits by confidence before adding fallbacks", async () => {
    const logger = new StructuredLogger();
    const handler = createIntentRouteHandler({
      logger,
      resolveBudget: (tool) => BUDGET_HINTS[tool],
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
