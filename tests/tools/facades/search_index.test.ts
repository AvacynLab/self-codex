import { createHash } from "node:crypto";

import { expect } from "chai";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { BudgetTracker } from "../../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { StructuredLogger } from "../../../src/logger.js";
import type { StructuredDocument } from "../../../src/search/index.js";
import { createSearchIndexHandler, SEARCH_INDEX_TOOL_NAME } from "../../../src/tools/search_index.js";

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("search_index tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("search_index tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function createStructuredDocument(overrides: Partial<StructuredDocument> = {}): StructuredDocument {
  return {
    id: "doc-index-1",
    url: "https://example.net/doc",
    title: "Indexed document",
    language: "en",
    description: null,
    checksum: "deadbeef",
    mimeType: "text/html",
    size: 1_024,
    fetchedAt: 1_700_000_000_500,
    segments: [{ id: "doc-index-1#seg-0", kind: "paragraph", text: "Content" }],
    provenance: {
      searxQuery: "direct:index",
      engines: ["manual"],
      categories: ["general"],
      position: 0,
      sourceUrl: "https://example.net/doc",
    },
    ...overrides,
  };
}

function computeIndexDeterministicKey(payload: {
  items: ReadonlyArray<{
    url: string;
    title?: string | null;
    snippet?: string | null;
    categories?: readonly string[];
    engines?: readonly string[];
    position?: number | null;
  }>;
  label?: string | null;
  inject_graph?: boolean | null;
  inject_vector?: boolean | null;
}): string {
  const fingerprint = {
    label: payload.label ?? null,
    inject_graph: payload.inject_graph ?? null,
    inject_vector: payload.inject_vector ?? null,
    items: payload.items.map((item) => ({
      url: item.url,
      title: item.title ?? null,
      snippet: item.snippet ?? null,
      categories: item.categories ?? [],
      engines: item.engines ?? [],
      position: item.position ?? null,
    })),
  } as const;
  const digest = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
  return `search.index:${digest}`;
}

describe("search.index facade", () => {
  it("returns structured documents produced by the pipeline", async () => {
    const logger = new StructuredLogger();
    let capturedParameters: import("../../../src/search/index.js").DirectIngestParameters | undefined;
    const pipeline = {
      async ingestDirect(parameters: import("../../../src/search/index.js").DirectIngestParameters) {
        capturedParameters = parameters;
        return {
          documents: [createStructuredDocument()],
          errors: [
            {
              stage: "extract" as const,
              url: "https://example.net/broken",
              message: "timeout",
              code: "UnstructuredExtractorError",
            },
          ],
          stats: {
            requestedResults: 1,
            receivedResults: 1,
            fetchedDocuments: 1,
            structuredDocuments: 1,
            graphIngested: 1,
            vectorIngested: 1,
          },
          metrics: null,
        };
      },
    } as unknown as import("../../../src/search/index.js").SearchPipeline;

    const handler = createSearchIndexHandler({ pipeline, logger });
    const extras = createRequestExtras("req-search-index-success");
    const budget = new BudgetTracker({ toolCalls: 2, tokens: 5_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${SEARCH_INDEX_TOOL_NAME}`, traceId: "trace-search-index", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              items: [
                {
                  url: "https://example.net/doc",
                  title: "Indexed document",
                  snippet: "Snippet",
                  categories: ["general"],
                  engines: ["manual"],
                  position: 2,
                },
              ],
              label: "manual-import",
              job_id: "job-index-1",
              inject_graph: true,
              inject_vector: true,
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(false);
    expect(structured.ok).to.equal(true);
    expect(structured.count).to.equal(1);
    expect(structured.docs[0]?.url).to.equal("https://example.net/doc");
    expect(structured.errors).to.have.lengthOf(1);
    expect(structured.stats.requested).to.equal(1);
    const expectedIdempotencyKey = computeIndexDeterministicKey({
      items: [
        {
          url: "https://example.net/doc",
          title: "Indexed document",
          snippet: "Snippet",
          categories: ["general"],
          engines: ["manual"],
          position: 2,
        },
      ],
      label: "manual-import",
      inject_graph: true,
      inject_vector: true,
    });
    expect(structured.idempotency_key).to.equal(expectedIdempotencyKey);

    expect(capturedParameters?.sources).to.have.lengthOf(1);
    expect(capturedParameters?.sources[0]?.url).to.equal("https://example.net/doc");
    expect(capturedParameters?.label).to.equal("manual-import");
    expect(capturedParameters?.jobId).to.equal("job-index-1");
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const logger = new StructuredLogger();
    const pipeline = {
      async ingestDirect() {
        throw new Error("unexpected call");
      },
    } as unknown as import("../../../src/search/index.js").SearchPipeline;

    const handler = createSearchIndexHandler({ pipeline, logger });
    const extras = createRequestExtras("req-search-index-budget");
    const budget = new BudgetTracker({ toolCalls: 0, tokens: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${SEARCH_INDEX_TOOL_NAME}`, traceId: "trace-search-index-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              items: [{ url: "https://example.net/doc" }],
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(true);
    expect(structured.ok).to.equal(false);
    expect(structured.reason).to.equal("budget_exhausted");
    expect(structured.count).to.equal(0);
  });

  it("validates the input payload", async () => {
    const logger = new StructuredLogger();
    const pipeline = {
      async ingestDirect() {
        throw new Error("unexpected call");
      },
    } as unknown as import("../../../src/search/index.js").SearchPipeline;

    const handler = createSearchIndexHandler({ pipeline, logger });
    const extras = createRequestExtras("req-search-index-invalid");

    try {
      await handler(
        {
          items: [],
        },
        extras,
      );
      expect.fail("expected validation error");
    } catch (error) {
      expect(String(error)).to.match(/items/);
    }
  });
});
