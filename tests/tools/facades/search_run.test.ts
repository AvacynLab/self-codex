import { createHash } from "node:crypto";

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
import { StructuredLogger } from "../../../src/logger.js";
import type {
  SearchJobParameters,
  SearchJobResult,
  StructuredDocument,
  StructuredSegment,
} from "../../../src/search/index.js";
import { createSearchRunHandler, SEARCH_RUN_TOOL_NAME } from "../../../src/tools/search_run.js";

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("search_run tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("search_run tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function createStructuredDocument(overrides: Partial<StructuredDocument> = {}): StructuredDocument {
  const baseSegments: StructuredSegment[] = [
    {
      id: "doc-1#seg-0",
      kind: "title",
      text: "Titre de démonstration",
    },
  ];

  return {
    id: "doc-1",
    url: "https://example.org/article",
    title: "Article d'exemple",
    language: "fr",
    description: "Résumé court pour valider la structuration",
    checksum: "abc123",
    mimeType: "text/html",
    size: 2048,
    fetchedAt: 1_700_000_000_000,
    segments: baseSegments,
    provenance: {
      searxQuery: "demo",
      engines: ["duckduckgo"],
      categories: ["general"],
      position: 0,
      sourceUrl: "https://example.org/article",
    },
    ...overrides,
  };
}

function createSearchJobResult(overrides: Partial<SearchJobResult> = {}): SearchJobResult {
  const documents = overrides.documents ?? [createStructuredDocument()];
  return {
    jobId: overrides.jobId ?? "search:job:test",
    query: "demo",
    results: [
      {
        id: "r1",
        url: documents[0]?.url ?? "https://example.org/article",
        title: "Résultat",
        snippet: "Snippet",
        engines: ["duckduckgo"],
        categories: ["general"],
        position: 0,
        thumbnailUrl: null,
        mimeType: "text/html",
        score: 0.5,
      },
    ],
    documents,
    errors: overrides.errors ?? [],
    stats:
      overrides.stats ??
      ({
        requestedResults: 4,
        receivedResults: 1,
        fetchedDocuments: documents.length,
        structuredDocuments: documents.length,
        graphIngested: documents.length,
        vectorIngested: documents.length,
      } as SearchJobResult["stats"]),
    rawSearxResponse: overrides.rawSearxResponse ?? null,
    metrics: overrides.metrics ?? null,
  };
}

function computeDeterministicIdempotencyKey(payload: {
  query: string;
  categories?: readonly string[];
  engines?: readonly string[];
  max_results?: number;
  language?: string | null;
  safe_search?: 0 | 1 | 2 | null;
  fetch_content?: boolean | null;
  inject_graph?: boolean | null;
  inject_vector?: boolean | null;
}): string {
  const fingerprint = {
    query: payload.query,
    categories: payload.categories ?? [],
    engines: payload.engines ?? [],
    max_results: payload.max_results ?? null,
    language: payload.language ?? null,
    safe_search: payload.safe_search ?? null,
    fetch_content: payload.fetch_content ?? null,
    inject_graph: payload.inject_graph ?? null,
    inject_vector: payload.inject_vector ?? null,
  } as const;
  const digest = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
  return `search.run:${digest}`;
}

describe("search.run facade", () => {
  it("returns structured documents and forwards pipeline parameters", async () => {
    const logger = new StructuredLogger();
    const resultPayload = createSearchJobResult({
      jobId: "job-search-run",
      errors: [
        {
          stage: "fetch",
          url: "https://example.org/broken",
          message: "timeout",
          code: "network_error",
        },
      ],
    });

    let capturedParameters: SearchJobParameters | undefined;
    const pipeline = {
      async runSearchJob(parameters: SearchJobParameters) {
        capturedParameters = parameters;
        return resultPayload;
      },
    } as unknown as import("../../../src/search/index.js").SearchPipeline;

    const handler = createSearchRunHandler({ pipeline, logger });
    const extras = createRequestExtras("req-search-run-success");
    const budget = new BudgetTracker({ toolCalls: 2, tokens: 5_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${SEARCH_RUN_TOOL_NAME}`, traceId: "trace-search-run", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              query: "benchmarks multimodaux",
              categories: ["general", "files"],
              engines: ["duckduckgo"],
              max_results: 4,
              fetch_content: true,
              inject_graph: true,
              inject_vector: true,
              job_id: "job-search-run",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(false);
    expect(structured.ok).to.equal(true);
    expect(structured.count).to.equal(1);
    expect(structured.docs[0]?.id).to.equal("doc-1");
    expect(structured.warnings).to.have.lengthOf(1);
    expect(structured.stats.requested).to.equal(4);
    expect(structured.job_id).to.equal("job-search-run");
    expect(structured.budget_used?.tool_calls).to.equal(1);
    expect(structured.budget_used?.tokens).to.equal(5);
    const expectedIdempotencyKey = computeDeterministicIdempotencyKey({
      query: "benchmarks multimodaux",
      categories: ["general", "files"],
      engines: ["duckduckgo"],
      max_results: 4,
      fetch_content: true,
      inject_graph: true,
      inject_vector: true,
      language: null,
      safe_search: null,
    });
    expect(structured.idempotency_key).to.equal(expectedIdempotencyKey);

    const snapshot = {
      ok: structured.ok,
      idempotency_key: structured.idempotency_key,
      summary: structured.summary,
      job_id: structured.job_id,
      count: structured.count,
      docs: structured.docs,
      warnings: structured.warnings,
      stats: structured.stats,
      budget_used: structured.budget_used,
    };
    expect(snapshot).to.deep.equal({
      ok: true,
      idempotency_key: expectedIdempotencyKey,
      summary: "recherche terminée (1 document)",
      job_id: "job-search-run",
      count: 1,
      docs: [
        {
          id: "doc-1",
          url: "https://example.org/article",
          title: "Article d'exemple",
          language: "fr",
        },
      ],
      warnings: [
        {
          stage: "fetch",
          url: "https://example.org/broken",
          message: "timeout",
          code: "network_error",
        },
      ],
      stats: {
        requested: 4,
        received: 1,
        fetched: 1,
        structured: 1,
        graph_ingested: 1,
        vector_ingested: 1,
      },
      budget_used: {
        tool_calls: 1,
        tokens: 5,
      },
    });

    expect(capturedParameters?.query).to.equal("benchmarks multimodaux");
    expect(capturedParameters?.categories).to.deep.equal(["general", "files"]);
    expect(capturedParameters?.engines).to.deep.equal(["duckduckgo"]);
    expect(capturedParameters?.jobId).to.equal("job-search-run");
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const logger = new StructuredLogger();
    const pipeline = {
      async runSearchJob(parameters: SearchJobParameters) {
        throw new Error(`unexpected call: ${JSON.stringify(parameters)}`);
      },
    } as unknown as import("../../../src/search/index.js").SearchPipeline;

    const handler = createSearchRunHandler({ pipeline, logger });
    const extras = createRequestExtras("req-search-run-budget");
    const budget = new BudgetTracker({ toolCalls: 0, tokens: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${SEARCH_RUN_TOOL_NAME}`, traceId: "trace-search-run-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              query: "llm",
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
    expect(structured.docs).to.be.an("array").that.is.empty;
  });

  it("validates the input payload", async () => {
    const logger = new StructuredLogger();
    const pipeline = {
      async runSearchJob(parameters: SearchJobParameters) {
        throw new Error(`unexpected call: ${JSON.stringify(parameters)}`);
      },
    } as unknown as import("../../../src/search/index.js").SearchPipeline;

    const handler = createSearchRunHandler({ pipeline, logger });

    let captured: unknown;
    try {
      const invalidPayload: Record<string, unknown> = {
        query: " ",
      };
      await handler(invalidPayload, createRequestExtras("req-search-run-invalid"));
    } catch (error) {
      captured = error;
    }

    expect(captured).to.be.instanceOf(z.ZodError);
  });

  it("defaults max_results to six when omitted", async () => {
    const logger = new StructuredLogger();
    let capturedParameters: SearchJobParameters | undefined;
    const pipeline = {
      async runSearchJob(parameters: SearchJobParameters) {
        capturedParameters = parameters;
        return createSearchJobResult({ documents: [] });
      },
    } as unknown as import("../../../src/search/index.js").SearchPipeline;

    const handler = createSearchRunHandler({ pipeline, logger });
    const extras = createRequestExtras("req-search-run-defaults");

    const result = await runWithRpcTrace(
      { method: `tools/${SEARCH_RUN_TOOL_NAME}`, traceId: "trace-search-run-defaults", requestId: extras.requestId },
      async () =>
        runWithJsonRpcContext({ requestId: extras.requestId }, () =>
          handler(
            {
              query: "benchmarks multimodaux",
            },
            extras,
          ),
        ),
    );

    expect(capturedParameters?.maxResults).to.equal(6);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.count).to.equal(0);
  });
});
