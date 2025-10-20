import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
import { IdempotencyRegistry } from "../../../src/infra/idempotency.js";
import { createArtifactWriteHandler, ARTIFACT_WRITE_TOOL_NAME } from "../../../src/tools/artifact_write.js";

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected in artifact_write tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in artifact_write tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("artifact_write facade", () => {
  let childrenRoot: string;

  beforeEach(async () => {
    childrenRoot = await mkdtemp(join(tmpdir(), "artifact-write-"));
  });

  afterEach(async () => {
    await rm(childrenRoot, { recursive: true, force: true });
  });

  it("writes an artifact and records idempotency metadata", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const idempotency = new IdempotencyRegistry();
    const handler = createArtifactWriteHandler({ logger, childrenRoot, idempotency });
    const extras = createRequestExtras("req-artifact-write-success");
    const budget = new BudgetTracker({ toolCalls: 5, bytesIn: 10_000 });

    const call = async (content: string, key: string) =>
      await runWithRpcTrace(
        { method: `tools/${ARTIFACT_WRITE_TOOL_NAME}`, traceId: "trace-artifact-write", requestId: extras.requestId },
        async () =>
          await runWithJsonRpcContext({ requestId: extras.requestId, budget, idempotencyKey: key }, () =>
            handler(
              {
                child_id: "child-a",
                path: "notes/output.txt",
                content,
                mime_type: "text/plain",
                idempotency_key: key,
              },
              extras,
            ),
          ),
      );

    const first = await call("Hello facade!", "write-key-1");
    expect(first.structuredContent).to.be.an("object");
    const firstStructured = first.structuredContent as Record<string, any>;
    expect(firstStructured.ok).to.equal(true);
    expect(firstStructured.details.idempotent).to.equal(false);

    const stored = await readFile(join(childrenRoot, "child-a", "outbox", "notes", "output.txt"), "utf8");
    expect(stored).to.equal("Hello facade!");

    const second = await call("Hello facade!", "write-key-1");
    const secondStructured = second.structuredContent as Record<string, any>;
    expect(secondStructured.ok).to.equal(true);
    expect(secondStructured.details.idempotent).to.equal(true);

    const logEntry = entries.find((entry) => entry.message === "artifact_write_completed");
    expect(logEntry?.request_id).to.equal("req-artifact-write-success");
    expect(logEntry?.trace_id).to.equal("trace-artifact-write");
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const logger = new StructuredLogger();
    const handler = createArtifactWriteHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-write-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_WRITE_TOOL_NAME}`, traceId: "trace-artifact-write-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-b",
              path: "notes/output.txt",
              content: "Budget exceeded",
              mime_type: "text/plain",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(true);
    expect(structured.ok).to.equal(false);
    expect(structured.details.budget?.reason).to.equal("budget_exhausted");
  });

  it("validates the input payload", async () => {
    const logger = new StructuredLogger();
    const handler = createArtifactWriteHandler({ logger, childrenRoot });

    let captured: unknown;
    try {
      const invalidPayload: Record<string, unknown> = {
        // The path must be a string; providing a number confirms the façade bubbles up validation issues without casts.
        child_id: "child-c",
        path: 123,
      };
      await handler(invalidPayload, createRequestExtras("req-invalid"));
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});
