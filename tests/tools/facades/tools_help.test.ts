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
  listVisible,
  type ToolManifest,
  type ToolPack,
  type ToolVisibilityMode,
} from "../../../src/mcp/registry.js";
import {
  TOOLS_HELP_TOOL_NAME,
  createToolsHelpHandler,
  type ToolsHelpRegistryView,
} from "../../../src/tools/tools_help.js";

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected in tools_help tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in tools_help tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function createManifest(partial: Partial<ToolManifest> & { name: string; title: string; category: ToolManifest["category"] }): ToolManifest {
  const now = new Date("2025-01-01T00:00:00.000Z").toISOString();
  return {
    name: partial.name,
    title: partial.title,
    kind: partial.kind ?? "dynamic",
    version: partial.version ?? 1,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    category: partial.category,
    description: partial.description,
    tags: partial.tags ? [...partial.tags] : undefined,
    hidden: partial.hidden,
    deprecated: partial.deprecated
      ? partial.deprecated.replace_with
        ? { since: partial.deprecated.since, replace_with: partial.deprecated.replace_with }
        : { since: partial.deprecated.since }
      : undefined,
    budgets: partial.budgets
      ? {
          ...(typeof partial.budgets.time_ms === "number" ? { time_ms: partial.budgets.time_ms } : {}),
          ...(typeof partial.budgets.tool_calls === "number" ? { tool_calls: partial.budgets.tool_calls } : {}),
          ...(typeof partial.budgets.bytes_out === "number" ? { bytes_out: partial.budgets.bytes_out } : {}),
        }
      : undefined,
    steps: partial.steps ? [...partial.steps] : undefined,
    inputs: partial.inputs ? [...partial.inputs] : undefined,
    source: partial.source ?? "runtime",
  };
}

function createRegistryView(manifests: ToolManifest[]): ToolsHelpRegistryView {
  const sorted = manifests
    .map((manifest) => createManifest(manifest))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    list: () => sorted.map((manifest) => createManifest(manifest)),
    listVisible: (mode?: ToolVisibilityMode, pack?: ToolPack) =>
      listVisible(
        sorted.map((manifest) => createManifest(manifest)),
        mode ?? "pro",
        pack ?? "all",
      ),
  };
}

describe("tools_help facade", () => {
  it("lists visible tools and applies filters", async () => {
    const manifests: ToolManifest[] = [
      createManifest({ name: "artifact_write", title: "Artifact write", category: "artifact", tags: ["facade"] }),
      createManifest({ name: "graph_mutate", title: "Graph mutate", category: "graph", hidden: true }),
      createManifest({
        name: "plan_compile_execute",
        title: "Plan compile & execute",
        category: "plan",
        tags: ["facade", "authoring"],
      }),
    ];
    const registry = createRegistryView(manifests);
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createToolsHelpHandler({ registry, logger });
    const extras = createRequestExtras("req-help-visible");
    const budget = new BudgetTracker({ toolCalls: 5 });

    const result = await runWithRpcTrace(
      { method: `tools/${TOOLS_HELP_TOOL_NAME}`, traceId: "trace-help-1", requestId: "req-help-visible" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-help-visible", budget }, () =>
          handler({ tags: ["facade"], search: "plan" }, extras),
        ),
    );

    expect(result.isError).to.not.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.mode).to.equal("pro");
    expect(structured.details.pack).to.equal("all");
    expect(structured.details.filters.search).to.equal("plan");
    expect(structured.details.tools).to.have.lengthOf(1);
    expect(structured.details.tools[0]?.name).to.equal("plan_compile_execute");

    const logEntry = entries.find((entry) => entry.message === "tools_help_listed");
    expect(logEntry?.request_id).to.equal("req-help-visible");
    expect(logEntry?.trace_id).to.equal("trace-help-1");
    const payload = (logEntry?.payload ?? {}) as Record<string, any>;
    expect(payload.returned).to.equal(1);
  });

  it("exposes hidden tools when include_hidden is set", async () => {
    const manifests: ToolManifest[] = [
      createManifest({ name: "artifact_write", title: "Artifact write", category: "artifact", tags: ["facade"] }),
      createManifest({ name: "graph_mutate", title: "Graph mutate", category: "graph", hidden: true }),
    ];
    const registry = createRegistryView(manifests);
    const logger = new StructuredLogger();
    const handler = createToolsHelpHandler({ registry, logger });
    const extras = createRequestExtras("req-help-hidden");
    const budget = new BudgetTracker({ toolCalls: 2 });

    const result = await runWithRpcTrace(
      { method: `tools/${TOOLS_HELP_TOOL_NAME}`, traceId: "trace-help-2", requestId: "req-help-hidden" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-help-hidden", budget }, () =>
          handler({ include_hidden: true, categories: ["graph"] }, extras),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.tools).to.have.lengthOf(1);
    expect(structured.details.tools[0]?.name).to.equal("graph_mutate");
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const manifests: ToolManifest[] = [
      createManifest({ name: "artifact_write", title: "Artifact write", category: "artifact", tags: ["facade"] }),
    ];
    const registry = createRegistryView(manifests);
    const logger = new StructuredLogger();
    const handler = createToolsHelpHandler({ registry, logger });
    const extras = createRequestExtras("req-help-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${TOOLS_HELP_TOOL_NAME}`, traceId: "trace-help-3", requestId: "req-help-budget" },
      async () =>
        await runWithJsonRpcContext({ requestId: "req-help-budget", budget }, () => handler({}, extras)),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(true);
    expect(structured.ok).to.equal(false);
    expect(structured.details.budget?.reason).to.equal("budget_exhausted");
    expect(structured.details.tools).to.have.lengthOf(0);
  });

  it("validates the input payload", async () => {
    const manifests: ToolManifest[] = [
      createManifest({ name: "artifact_write", title: "Artifact write", category: "artifact", tags: ["facade"] }),
    ];
    const registry = createRegistryView(manifests);
    const logger = new StructuredLogger();
    const handler = createToolsHelpHandler({ registry, logger });

    let captured: unknown;
    try {
      await handler({ limit: "invalid" } as unknown as Record<string, unknown>, createRequestExtras("req-invalid"));
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});
