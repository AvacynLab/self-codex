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
import { StructuredLogger } from "../../../src/logger.js";
import { createArtifactSearchHandler, ARTIFACT_SEARCH_TOOL_NAME } from "../../../src/tools/artifact_search.js";

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected in artifact_search tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in artifact_search tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("artifact_search facade", () => {
  let childrenRoot: string;

  beforeEach(async () => {
    childrenRoot = await mkdtemp(join(tmpdir(), "artifact-search-"));
  });

  afterEach(async () => {
    await rm(childrenRoot, { recursive: true, force: true });
  });

  it("lists artifacts applying filters", async () => {
    await writeArtifact({
      childrenRoot,
      childId: "child-search",
      relativePath: "reports/summary.txt",
      data: "summary",
      mimeType: "text/plain",
    });
    await writeArtifact({
      childrenRoot,
      childId: "child-search",
      relativePath: "reports/data.json",
      data: "{}",
      mimeType: "application/json",
    });

    const logger = new StructuredLogger();
    const handler = createArtifactSearchHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-search");
    const budget = new BudgetTracker({ toolCalls: 5, bytesOut: 50_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_SEARCH_TOOL_NAME}`, traceId: "trace-artifact-search", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-search",
              query: "report",
              mime_types: ["text/plain"],
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.returned).to.equal(1);
    expect(structured.details.artifacts[0]?.path).to.equal("reports/summary.txt");
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const logger = new StructuredLogger();
    const handler = createArtifactSearchHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-search-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_SEARCH_TOOL_NAME}`, traceId: "trace-artifact-search-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-search",
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
    const handler = createArtifactSearchHandler({ logger, childrenRoot });

    let captured: unknown;
    try {
      const invalidPayload: Record<string, unknown> = {
        // The MIME types filter must be an array; passing a string ensures schema validation paths are exercised.
        child_id: "child",
        mime_types: "invalid",
      };
      await handler(invalidPayload, createRequestExtras("req-invalid"));
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });
});
