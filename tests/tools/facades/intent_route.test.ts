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
    const handler = createIntentRouteHandler({ logger });
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
    expect(structured.details.chosen).to.equal("graph_apply_change_set");
    expect(structured.details.candidates).to.be.undefined;
    expect(structured.details.idempotency_key).to.be.a("string").with.length.greaterThan(0);
    expect(structured.details.diagnostics).to.satisfy((diagnostics: Array<Record<string, unknown>>) =>
      diagnostics.some((entry) => entry.tool === "graph_apply_change_set" && entry.matched === true),
    );

    const evaluationLog = entries.find((entry) => entry.message === "intent_route_evaluated");
    expect(evaluationLog?.request_id).to.equal("req-graph-1");
    expect(evaluationLog?.trace_id).to.equal("trace-graph-1");
  });

  it("suggests fallback candidates when no heuristic matches", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createIntentRouteHandler({ logger });
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
    expect(structured.details.chosen).to.be.undefined;
    expect(structured.details.candidates).to.deep.equal([
      "tools_help",
      "artifact_search",
      "child_orchestrate",
    ]);
    expect(structured.details.diagnostics).to.be.an("array").that.is.not.empty;
  });

  it("returns a degraded response when the caller exhausted its budget", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createIntentRouteHandler({ logger });
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

  it("validates the natural language goal string", async () => {
    const logger = new StructuredLogger();
    const handler = createIntentRouteHandler({ logger });
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
