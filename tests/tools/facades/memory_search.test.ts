import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";
import { z } from "zod";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { VectorMemoryIndex } from "../../../src/memory/vector.js";
import { BudgetTracker } from "../../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger } from "../../../src/logger.js";
import {
  createMemorySearchHandler,
  MEMORY_SEARCH_TOOL_NAME,
} from "../../../src/tools/memory_search.js";

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("memory_search tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("memory_search tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("memory_search facade", () => {
  let indexDir: string;
  let vectorIndex: VectorMemoryIndex;

  beforeEach(async () => {
    indexDir = await mkdtemp(join(tmpdir(), "memory-search-"));
    vectorIndex = await VectorMemoryIndex.create({ directory: indexDir, maxDocuments: 64 });
    await vectorIndex.upsert({
      id: "doc-1",
      text: "Les opérateurs peuvent consulter ce souvenir pour comprendre la stratégie d'escalade.",
      tags: ["ops", "strategy"],
      metadata: { owner: "ops" },
    });
    await vectorIndex.upsert({
      id: "doc-2",
      text: "Ce souvenir résume la procédure de validation automatisée.",
      tags: ["automation", "qa"],
      metadata: { owner: "qa" },
    });
  });

  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("returns matching documents and applies tag filters", async () => {
    const logger = new StructuredLogger();
    const handler = createMemorySearchHandler({ vectorIndex, logger });
    const extras = createRequestExtras("req-memory-search-success");
    const budget = new BudgetTracker({ toolCalls: 3, tokens: 5_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${MEMORY_SEARCH_TOOL_NAME}`, traceId: "trace-memory-search", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              query: "procédure automatisée",
              tags_filter: ["automation"],
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.returned).to.equal(1);
    expect(structured.details.hits[0]?.document_id).to.equal("doc-2");
    expect(structured.details.hits[0]?.metadata.owner).to.equal("qa");
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const logger = new StructuredLogger();
    const handler = createMemorySearchHandler({ vectorIndex, logger });
    const extras = createRequestExtras("req-memory-search-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${MEMORY_SEARCH_TOOL_NAME}`, traceId: "trace-memory-search-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              query: "budget",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(true);
    expect(structured.ok).to.equal(false);
    expect(structured.details.reason).to.equal("budget_exhausted");
  });

  it("validates the input payload", async () => {
    const logger = new StructuredLogger();
    const handler = createMemorySearchHandler({ vectorIndex, logger });

    let captured: unknown;
    try {
      await handler({ query: "" } as unknown as Record<string, unknown>, createRequestExtras("req-memory-search-invalid"));
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});

