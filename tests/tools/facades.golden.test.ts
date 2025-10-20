import { expect } from "chai";
import { readFile } from "node:fs/promises";

import { BudgetTracker } from "../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../src/infra/tracing.js";
import { StructuredLogger } from "../../src/logger.js";
import { createRpcHandler, normaliseJsonRpcRequest } from "../../src/rpc/middleware.js";
import type { JsonRpcResponse } from "../../src/server.js";
import { INTENT_ROUTE_TOOL_NAME, createIntentRouteHandler } from "../../src/tools/intent_route.js";
import { createToolsHelpHandler } from "../../src/tools/tools_help.js";
import { PLAN_COMPILE_EXECUTE_TOOL_NAME, createPlanCompileExecuteHandler } from "../../src/tools/plan_compile_execute.js";
import { StigmergyField } from "../../src/coord/stigmergy.js";
import { GraphState } from "../../src/graph/state.js";
import { PlanLifecycleRegistry } from "../../src/executor/planLifecycle.js";
import { IdempotencyRegistry } from "../../src/infra/idempotency.js";
import type { ToolBudgets, ToolManifest } from "../../src/mcp/registry.js";
import { z } from "zod";

import type { RequestHandlerExtra, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ToolsHelpRegistryView } from "../../src/tools/tools_help.js";
import type { PlanToolContext } from "../../src/tools/planTools.js";
import { IntentRouteInputSchema } from "../../src/rpc/schemas.js";

/** Absolute path helper resolving fixture files alongside this test module. */
function resolveFixture(path: string): URL {
  return new URL(`../fixtures/golden/${path}`, import.meta.url);
}

/** Recursively removes properties with `undefined` values from JSON snapshots. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefined(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripUndefined(inner);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * Builds a minimal {@link RequestHandlerExtra} satisfying the MCP SDK contract.
 * Tests never send notifications or nested requests; each method throws when
 * invoked to surface unexpected usage.
 */
function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected during facade golden tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected during facade golden tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

/** Utility returning a structured logger that records entries without printing. */
function createSilentLogger(): StructuredLogger {
  return new StructuredLogger({ onEntry: () => {} });
}

/**
 * Loads and parses a golden snapshot into a JSON object. The helper throws when
 * the file is missing so regressions immediately highlight missing fixtures.
 */
async function loadGoldenSnapshot(name: string): Promise<Record<string, unknown>> {
  const payload = await readFile(resolveFixture(name), "utf-8");
  return JSON.parse(payload) as Record<string, unknown>;
}

/**
 * Builds a deterministic `ToolRegistry` view exposing the provided manifests.
 * Tests rely on this helper to emulate the runtime registry without mutating
 * shared state.
 */
function createRegistryView(
  manifests: ToolManifest[],
  schemas: Record<string, z.ZodTypeAny | undefined>,
): ToolsHelpRegistryView {
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest] as const));
  return {
    list: () => manifests,
    listVisible: () => manifests,
    describe: (name: string) => {
      const manifest = byName.get(name);
      if (!manifest) {
        return undefined;
      }
      return { manifest, inputSchema: schemas[name] };
    },
  };
}

/**
 * Normalises plan compile responses by replacing unstable identifiers with
 * placeholders. Golden snapshots should remain readable while ignoring
 * run-specific UUIDs.
 */
function sanitisePlanResult(structured: Record<string, any>): Record<string, any> {
  const base = stripUndefined(structured);
  const clone = JSON.parse(JSON.stringify(base));
  if (clone?.details) {
    if (typeof clone.details.run_id === "string") {
      clone.details.run_id = "<<dynamic>>";
    }
    if (typeof clone.details.op_id === "string") {
      clone.details.op_id = "<<dynamic>>";
    }
  }
  return clone;
}

/**
 * Constructs the deterministic budget hints consumed by the intent router
 * tests. The values match the manifests registered in production.
 */
function buildBudgetHints(): Record<string, ToolBudgets> {
  return {
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
}

/**
 * Builds a minimal plan façade context mirroring the runtime dependencies while
 * keeping side effects disabled for deterministic tests.
 */
function buildPlanContext(logger: StructuredLogger): PlanToolContext {
  return {
    supervisor: {} as PlanToolContext["supervisor"],
    graphState: new GraphState(),
    logger,
    childrenRoot: "/tmp",
    defaultChildRuntime: "codex",
    emitEvent: () => {
      // Intentionally left blank; golden tests assert outputs, not telemetry.
    },
    stigmergy: new StigmergyField(),
    planLifecycle: new PlanLifecycleRegistry(),
    planLifecycleFeatureEnabled: true,
  };
}

/** Constructs the structured payload returned by the intent_route façade. */
async function invokeIntentRoute(): Promise<Record<string, unknown>> {
  const logger = createSilentLogger();
  const handler = createIntentRouteHandler({ logger, resolveBudget: (tool) => buildBudgetHints()[tool] });
  const extras = createRequestExtras("req-golden-intent");
  const budget = new BudgetTracker({ toolCalls: 4 });
  const result = await runWithRpcTrace(
    { method: `tools/${INTENT_ROUTE_TOOL_NAME}`, traceId: "trace-golden-intent", requestId: extras.requestId },
    async () =>
      runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
        handler(
          { natural_language_goal: "Je veux modifier le graphe de dépendances", idempotency_key: "golden-intent" },
          extras,
        ),
      ),
  );
  return stripUndefined(result.structuredContent) as Record<string, unknown>;
}

/** Constructs the structured payload returned by the tools_help façade. */
async function invokeToolsHelp(): Promise<Record<string, unknown>> {
  const logger = createSilentLogger();
  const nowIso = new Date("2025-01-01T00:00:00Z").toISOString();
  const manifest: ToolManifest = {
    name: "artifact_search",
    title: "Recherche d'artefacts",
    description: "Permet de retrouver des artefacts enregistrés",
    kind: "dynamic",
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    category: "artifact",
    tags: ["facade", "discovery"],
    hidden: false,
    budgets: { time_ms: 4_000, tool_calls: 1, bytes_out: 24_576 },
  };
  const schema = z
    .object({
      query: z.string().min(3),
      tags: z.array(z.enum(["plan", "artifact"])).min(1),
      limit: z.number().int().min(1).max(5).optional(),
    })
    .strict();
  const registry = createRegistryView([manifest], { [manifest.name]: schema });
  const handler = createToolsHelpHandler({ registry, logger });
  const extras = createRequestExtras("req-tools-help-golden");
  const result = await handler({ idempotency_key: "golden-tools-help" }, extras);
  return stripUndefined(result.structuredContent) as Record<string, unknown>;
}

/** Constructs the structured payload returned by the plan_compile_execute façade. */
async function invokePlanCompileExecute(): Promise<Record<string, unknown>> {
  const logger = createSilentLogger();
  const planContext = buildPlanContext(logger);
  const idempotency = new IdempotencyRegistry();
  const handler = createPlanCompileExecuteHandler({ plan: planContext, logger, idempotency });
  const extras = createRequestExtras("req-plan-golden");
  const budget = new BudgetTracker({ toolCalls: 3, bytesIn: 64_000 });
  const plan = {
    id: "golden-plan",
    version: "1.0.0",
    title: "Golden plan",
    tasks: [
      { id: "prepare", tool: "bb_set", input: { key: "ready", value: true }, estimated_duration_ms: 50 },
      { id: "execute", tool: "wait", depends_on: ["prepare"], estimated_duration_ms: 75 },
      { id: "finalise", tool: "noop", depends_on: ["execute"], estimated_duration_ms: 20 },
    ],
  };
  const result = await runWithRpcTrace(
    { method: `tools/${PLAN_COMPILE_EXECUTE_TOOL_NAME}`, traceId: "trace-plan-golden", requestId: extras.requestId },
    async () =>
      runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
        handler({ plan, dry_run: true, idempotency_key: "golden-plan" }, extras),
      ),
  );
  return stripUndefined(result.structuredContent) as Record<string, unknown>;
}

/** Invokes the JSON-RPC middleware with an invalid payload to assert typing. */
async function invokeInvalidIntentRoute(): Promise<JsonRpcResponse> {
  let routed = false;
  const handler = createRpcHandler({
    normalise: (raw, options) => normaliseJsonRpcRequest(raw, options, { intent_route: IntentRouteInputSchema }),
    route: async () => {
      routed = true;
      throw new Error("route should not be called when validation fails");
    },
  });
  const response = await handler({
    jsonrpc: "2.0",
    id: "invalid-intent",
    method: "tools/call",
    params: { name: INTENT_ROUTE_TOOL_NAME, arguments: {} },
  });
  expect(routed).to.equal(false);
  return response;
}

describe("tool facade golden snapshots", () => {
  it("matches the golden snapshot for intent_route", async () => {
    const structured = await invokeIntentRoute();
    const expected = await loadGoldenSnapshot("intent_route.facade.json");
    expect(structured).to.deep.equal(expected);
  });

  it("matches the golden snapshot for tools_help", async () => {
    const structured = await invokeToolsHelp();
    const expected = await loadGoldenSnapshot("tools_help.facade.json");
    expect(structured).to.deep.equal(expected);
  });

  it("matches the golden snapshot for plan_compile_execute", async () => {
    const structured = sanitisePlanResult(await invokePlanCompileExecute());
    const expected = await loadGoldenSnapshot("plan_compile_execute.facade.json");
    expect(structured).to.deep.equal(expected);
  });

  it("maps invalid intent_route payloads to VALIDATION_ERROR without routing", async () => {
    const response = await invokeInvalidIntentRoute();
    expect(response.error).to.not.equal(undefined);
    expect(response.error?.code).to.equal(-32602);
    expect(response.error?.data?.category).to.equal("VALIDATION_ERROR");
  });
});
