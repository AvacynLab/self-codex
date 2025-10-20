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

import { writeArtifact } from "../../../src/artifacts.js";
import { BudgetTracker } from "../../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger, type LogEntry } from "../../../src/logger.js";
import { createArtifactReadHandler, ARTIFACT_READ_TOOL_NAME } from "../../../src/tools/artifact_read.js";

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected in artifact_read tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in artifact_read tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("artifact_read facade", () => {
  let childrenRoot: string;

  beforeEach(async () => {
    childrenRoot = await mkdtemp(join(tmpdir(), "artifact-read-"));
  });

  afterEach(async () => {
    await rm(childrenRoot, { recursive: true, force: true });
  });

  it("reads an artifact and honours truncation", async () => {
    await writeArtifact({
      childrenRoot,
      childId: "child-read",
      relativePath: "reports/data.txt",
      data: "0123456789",
      mimeType: "text/plain",
    });

    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createArtifactReadHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-read");
    const budget = new BudgetTracker({ toolCalls: 5, bytesOut: 10_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_READ_TOOL_NAME}`, traceId: "trace-artifact-read", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-read",
              path: "reports/data.txt",
              max_bytes: 4,
              format: "text",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.content).to.equal("0123");
    expect(structured.details.truncated).to.equal(true);

    const logEntry = entries.find((entry) => entry.message === "artifact_read_completed");
    expect(logEntry?.request_id).to.equal("req-artifact-read");
    expect(logEntry?.trace_id).to.equal("trace-artifact-read");
  });

  it("returns a degraded response when the artifact is missing", async () => {
    const logger = new StructuredLogger();
    const handler = createArtifactReadHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-read-missing");
    const budget = new BudgetTracker({ toolCalls: 5, bytesOut: 1_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_READ_TOOL_NAME}`, traceId: "trace-artifact-read-missing", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "unknown-child",
              path: "reports/none.txt",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(true);
    expect(structured.ok).to.equal(false);
    expect(structured.details.error?.reason).to.equal("artifact_not_found");
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const logger = new StructuredLogger();
    const handler = createArtifactReadHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-read-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_READ_TOOL_NAME}`, traceId: "trace-artifact-read-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-read",
              path: "reports/data.txt",
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
    const handler = createArtifactReadHandler({ logger, childrenRoot });

    let captured: unknown;
    try {
      const invalidPayload: Record<string, unknown> = {
        // The format field must match the enumerated values; this string ensures the schema guard rejects the request.
        child_id: "child-x",
        format: "invalid",
      };
      await handler(invalidPayload, createRequestExtras("req-invalid"));
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});
