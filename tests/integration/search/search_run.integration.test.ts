import { createHash } from "node:crypto";

import { expect } from "chai";
import nock from "nock";
import sinon from "sinon";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { EventStore } from "../../../src/eventStore.js";
import { StructuredLogger } from "../../../src/logger.js";
import {
  SearchDownloader,
  SearchMetricsRecorder,
  SearchPipeline,
  SearxClient,
  UnstructuredExtractor,
  KnowledgeGraphIngestor,
  VectorStoreIngestor,
  type SearchConfig,
} from "../../../src/search/index.js";
import { KnowledgeGraph } from "../../../src/knowledge/knowledgeGraph.js";
import {
  type VectorMemory,
  type VectorMemoryUpsertInput,
  type VectorMemorySearchHit,
} from "../../../src/memory/vectorMemory.js";
import type { VectorMemoryDocument } from "../../../src/memory/vector.js";
import type { Provenance } from "../../../src/types/provenance.js";
import { createSearchRunHandler } from "../../../src/tools/search_run.js";

class FakeVectorMemory implements VectorMemory {
  public upsertCalls: VectorMemoryUpsertInput[][] = [];
  public stored: VectorMemoryDocument[] = [];
  private sequence = 0;

  async upsert(inputs: VectorMemoryUpsertInput[]): Promise<VectorMemoryDocument[]> {
    if (inputs.length === 0) {
      return [];
    }

    const cloned = inputs.map((input) => ({ ...input }));
    this.upsertCalls.push(cloned);

    const now = Date.now();
    const documents = inputs.map((input) => {
      const id = input.id ?? `fake-${++this.sequence}`;
      const provenance = (input.provenance ?? []).filter((entry): entry is Provenance => entry != null);
      const document: VectorMemoryDocument = {
        id,
        text: input.text,
        tags: input.tags ? [...input.tags] : [],
        metadata: input.metadata ? { ...input.metadata } : {},
        provenance: [...provenance],
        createdAt: input.createdAt ?? now,
        updatedAt: input.createdAt ?? now,
        embedding: {},
        norm: 0,
        tokenCount: 0,
      };
      this.stored.push(document);
      return document;
    });

    return documents;
  }

  async search(_query: string): Promise<VectorMemorySearchHit[]> {
    return [];
  }

  async delete(_ids: Iterable<string>): Promise<number> {
    return 0;
  }

  async clear(): Promise<void> {
    this.upsertCalls = [];
    this.stored = [];
  }

  size(): number {
    return this.stored.length;
  }
}

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("search integration tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("search integration tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("search.run integration", () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    sinon.restore();
  });

  /**
   * Full pipeline smoke test ensuring a mixed result set (success + failure)
   * yields stored artefacts, typed warnings, and the deterministic job hash
   * surfaced by the `search.run` façade.
   */
  it("ingests documents, surfaces typed warnings, and returns a deterministic job id", async () => {
    const config: SearchConfig = {
      searx: {
        baseUrl: "http://searx.test",
        apiPath: "/search",
        timeoutMs: 5_000,
        engines: ["duckduckgo"],
        categories: ["general"],
        authToken: null,
        maxRetries: 0,
      },
      unstructured: {
        baseUrl: "http://unstructured.test",
        timeoutMs: 5_000,
        strategy: "hi_res",
        apiKey: null,
      },
      fetch: {
        timeoutMs: 5_000,
        maxBytes: 2_000_000,
        userAgent: "TestBot/1.0",
        respectRobotsTxt: false,
        parallelism: 2,
        minDomainDelayMs: 0,
        cache: null,
      },
      pipeline: {
        injectGraph: true,
        injectVector: true,
        parallelExtract: 2,
        // Provide an explicit ceiling so the pipeline fallback never yields NaN
        // when normalising `maxResults` in tests executed without env defaults.
        maxResults: 12,
      },
    };

    const searxScope = nock("http://searx.test")
      .get("/search")
      .query((queryObject) => queryObject.q === "llm integration" && queryObject.format === "json")
      .reply(200, {
        query: "llm integration",
        results: [
          {
            url: "https://content.test/doc-1.html",
            title: "Doc 1",
            content: "Snippet 1",
            engines: ["duckduckgo"],
            categories: ["general"],
          },
          {
            url: "https://content.test/missing.pdf",
            title: "Doc 2",
            content: "Snippet 2",
            engines: ["duckduckgo"],
            categories: ["general"],
          },
        ],
      });

    const unstructuredScope = nock("http://unstructured.test")
      .post("/general/v0/general")
      .reply(200, [
        { type: "title", text: "Doc 1" },
        { type: "narrative_text", text: "Paragraph about LLM integration." },
      ]);

    const fetchStub = sinon.stub();
    fetchStub
      .onCall(0)
      .resolves(
        new Response("<html><body>LLM integration document</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
          url: "https://content.test/doc-1.html",
        }),
      );
    fetchStub
      .onCall(1)
      .resolves(
        new Response("missing", {
          status: 404,
          headers: { "Content-Type": "text/plain" },
          url: "https://content.test/missing.pdf",
        }),
      );

    const logger = new StructuredLogger({ logFile: null, onEntry: () => {} });
    const eventStore = new EventStore({ maxHistory: 32, logger });
    const searxClient = new SearxClient(config, fetch);
    const downloader = new SearchDownloader(config.fetch, { fetchImpl: fetchStub });
    const extractor = new UnstructuredExtractor(config, fetch);
    const knowledgeGraph = new KnowledgeGraph();
    const knowledgeIngestor = new KnowledgeGraphIngestor({ graph: knowledgeGraph });
    const vectorMemory = new FakeVectorMemory();
    const vectorIngestor = new VectorStoreIngestor({ memory: vectorMemory });
    const metrics = new SearchMetricsRecorder();

    const pipeline = new SearchPipeline({
      config,
      searxClient,
      downloader,
      extractor,
      knowledgeIngestor,
      vectorIngestor,
      eventStore,
      logger,
      metrics,
    });

    const handler = createSearchRunHandler({ pipeline, logger });
    const extras = createRequestExtras("req-search-integration");

    const payload = {
      query: "llm integration",
      categories: ["general"],
      engines: ["duckduckgo"],
      max_results: 3,
      fetch_content: true,
      inject_graph: true,
      inject_vector: true,
    } as const;
    const result = await handler(payload, extras);

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.count).to.equal(1);
    expect(structured.docs[0]?.url).to.equal("https://content.test/doc-1.html");
    expect(structured.warnings).to.have.lengthOf(1);
    expect(structured.warnings?.[0]?.code).to.equal("network_error");

    // Build the same fingerprint the pipeline uses when deriving `jobId` so
    // the assertion covers the deterministic hashing logic as well.
    const fingerprint = createHash("sha1")
      .update(
        JSON.stringify({
          query: payload.query,
          categories: payload.categories,
          engines: payload.engines,
          max_results: payload.max_results,
          fetch_content: payload.fetch_content,
          inject_graph: payload.inject_graph,
          inject_vector: payload.inject_vector,
          language: null,
          safe_search: null,
        }),
      )
      .digest("hex");
    expect(structured.job_id).to.equal(`search:job:${fingerprint}`);

    expect(knowledgeGraph.count()).to.be.greaterThan(0);
    expect(vectorMemory.size()).to.be.greaterThan(0);
    expect(vectorMemory.upsertCalls).to.have.lengthOf(1);

    expect(searxScope.isDone()).to.equal(true);
    expect(unstructuredScope.isDone()).to.equal(true);
    sinon.assert.calledTwice(fetchStub);
  });
});
