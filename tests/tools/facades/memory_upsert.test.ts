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
import { IdempotencyRegistry } from "../../../src/infra/idempotency.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger } from "../../../src/logger.js";
import {
  createMemoryUpsertHandler,
  MEMORY_UPSERT_TOOL_NAME,
} from "../../../src/tools/memory_upsert.js";

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("memory_upsert tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("memory_upsert tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("memory_upsert facade", () => {
  let indexDir: string;
  let vectorIndex: VectorMemoryIndex;

  beforeEach(async () => {
    indexDir = await mkdtemp(join(tmpdir(), "memory-upsert-"));
    vectorIndex = await VectorMemoryIndex.create({ directory: indexDir, maxDocuments: 32 });
  });

  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("indexes a new memory entry", async () => {
    const logger = new StructuredLogger();
    const idempotency = new IdempotencyRegistry();
    const handler = createMemoryUpsertHandler({ vectorIndex, logger, idempotency });
    const extras = createRequestExtras("req-memory-upsert-success");
    const budget = new BudgetTracker({ toolCalls: 3, tokens: 10_000, bytesIn: 16_384 });

    const result = await runWithRpcTrace(
      { method: `tools/${MEMORY_UPSERT_TOOL_NAME}`, traceId: "trace-memory-upsert", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              text: "Un souvenir persistant pour la mémoire vectorielle.",
              tags: ["test", "memory"],
              metadata: { origin: "unit-test" },
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.document_id).to.be.a("string");
    expect(structured.details.tags).to.deep.equal(["test", "memory"]);
    expect(structured.details.idempotent).to.equal(false);
    expect(vectorIndex.size()).to.equal(1);
  });

  it("replays cached results when the idempotency key matches", async () => {
    const logger = new StructuredLogger();
    const idempotency = new IdempotencyRegistry();
    const handler = createMemoryUpsertHandler({ vectorIndex, logger, idempotency });
    const extras = createRequestExtras("req-memory-upsert-idem");
    const budget = new BudgetTracker({ toolCalls: 5, tokens: 10_000, bytesIn: 32_768 });

    const payload = {
      text: "Mémoire idempotente.",
      tags: ["memo"],
      idempotency_key: "idem-123",
    };

    const first = await runWithRpcTrace(
      { method: `tools/${MEMORY_UPSERT_TOOL_NAME}`, traceId: "trace-memory-upsert-1", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(payload, extras)),
    );
    const firstDetails = first.structuredContent as Record<string, any>;
    expect(firstDetails.details.idempotent).to.equal(false);

    const second = await runWithRpcTrace(
      { method: `tools/${MEMORY_UPSERT_TOOL_NAME}`, traceId: "trace-memory-upsert-2", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(payload, extras)),
    );
    const secondDetails = second.structuredContent as Record<string, any>;
    expect(secondDetails.details.idempotent).to.equal(true);
    expect(secondDetails.details.document_id).to.equal(firstDetails.details.document_id);
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const logger = new StructuredLogger();
    const handler = createMemoryUpsertHandler({ vectorIndex, logger });
    const extras = createRequestExtras("req-memory-upsert-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${MEMORY_UPSERT_TOOL_NAME}`, traceId: "trace-memory-upsert-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              text: "épuisement du budget",
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
    const handler = createMemoryUpsertHandler({ vectorIndex, logger });

    let captured: unknown;
    try {
      const invalidPayload: Record<string, unknown> = {
        // Leading whitespace-only text violates the schema; ensure zod surfaces the failure without casts.
        text: "   ",
      };
      await handler(invalidPayload, createRequestExtras("req-memory-upsert-invalid"));
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});

