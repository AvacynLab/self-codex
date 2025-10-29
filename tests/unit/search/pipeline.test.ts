import { expect } from "chai";
import sinon from "sinon";

import "./tinyldStub.js";

import { EventStore } from "../../../src/eventStore.js";
import { StructuredLogger } from "../../../src/logger.js";
import { SearchPipeline } from "../../../src/search/pipeline.js";
import { SearchMetricsRecorder } from "../../../src/search/metrics.js";
import { computeDocId, DownloadTimeoutError } from "../../../src/search/downloader.js";
import type { SearchConfig } from "../../../src/search/config.js";
import type { StructuredDocument } from "../../../src/search/types.js";
import type { SearchDownloader } from "../../../src/search/downloader.js";
import type { SearxClient } from "../../../src/search/searxClient.js";
import type { UnstructuredExtractor } from "../../../src/search/extractor.js";
import type { KnowledgeGraphIngestor } from "../../../src/search/ingest/toKnowledgeGraph.js";
import type { VectorStoreIngestor } from "../../../src/search/ingest/toVectorStore.js";
import type { SearchJobStats } from "../../../src/search/pipeline.js";

describe("search/pipeline", () => {
  afterEach(() => {
    sinon.restore();
  });

  const baseConfig: SearchConfig = {
    searx: {
      baseUrl: "http://searx.test",
      apiPath: "/search",
      timeoutMs: 1_000,
      engines: ["ddg"],
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
      maxBytes: 1_000_000,
      userAgent: "test-agent",
      respectRobotsTxt: false,
      parallelism: 4,
      minDomainDelayMs: 0,
      cache: null,
    },
    pipeline: {
      injectGraph: true,
      injectVector: true,
      parallelExtract: 2,
      maxResults: 6,
    },
  };

  it("processes results, ingests documents, and emits events", async () => {
    const eventStore = new EventStore({ maxHistory: 50, logger: new StructuredLogger({ onEntry: () => {} }) });
    const logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
    } as unknown as StructuredLogger;

    const searxResponse = {
      query: "llm",
      results: [
        {
          id: "res-1",
          url: "https://example.com/doc",
          title: "Document",
          snippet: "Snippet",
          engines: ["ddg"],
          categories: ["general"],
          position: 0,
          thumbnailUrl: null,
          mime: "text/html",
          publishedAt: null,
          score: null,
        },
      ],
      raw: { query: "llm", number_of_results: 1, results: [] },
    } satisfies Awaited<ReturnType<SearxClient["search"]>>;

    const searxClient = { search: sinon.stub().resolves(searxResponse) } as unknown as SearxClient;

    const headers = new Map<string, string>([
      ["etag", "v1"],
      ["last-modified", "Mon, 01 Jan 2024 00:00:00 GMT"],
    ]);
    const rawPayload = {
      requestedUrl: "https://example.com/doc",
      finalUrl: "https://example.com/doc",
      status: 200,
      fetchedAt: 1_700_000_000_000,
      headers,
      contentType: "text/html",
      size: 128,
      checksum: "deadbeef",
      body: Buffer.from("body"),
    } satisfies ReturnType<SearchDownloader["fetchUrl"]> extends Promise<infer T> ? T : never;

    const downloader = { fetchUrl: sinon.stub().resolves(rawPayload) } as unknown as SearchDownloader;

    const extractor = {
      extract: sinon.stub().callsFake(async (request) => {
        const docId = request.docId;
        return {
          id: docId,
          url: rawPayload.finalUrl,
          title: "Document",
          language: "en",
          description: "Snippet",
          checksum: rawPayload.checksum,
          mimeType: rawPayload.contentType,
          size: rawPayload.size,
          fetchedAt: rawPayload.fetchedAt,
          segments: [
            { id: `${docId}#raw-1`, kind: "paragraph", text: "Segment text" },
            { id: `${docId}#raw-2`, kind: "paragraph", text: "Segment text" },
          ],
          provenance: request.provenance,
        } satisfies StructuredDocument;
      }),
    } as unknown as UnstructuredExtractor;

    const knowledgeIngestResult = {
      subject: "search:document:abc",
      triples: [],
      mentions: [],
    } satisfies ReturnType<KnowledgeGraphIngestor["ingest"]>;
    const knowledgeIngestStub = sinon.stub().returns(knowledgeIngestResult);
    const knowledgeIngestor = { ingest: knowledgeIngestStub } as unknown as KnowledgeGraphIngestor;
    const vectorIngestStub = sinon.stub().resolves({ chunks: [], descriptors: [] });
    const vectorIngestor = {
      ingest: vectorIngestStub,
    } as unknown as VectorStoreIngestor;

    let tick = 0;
    const pipeline = new SearchPipeline({
      config: baseConfig,
      searxClient,
      downloader,
      extractor,
      knowledgeIngestor,
      vectorIngestor,
      eventStore,
      logger,
      metrics: new SearchMetricsRecorder({ now: () => (tick += 10) }),
    });

    const result = await pipeline.runSearchJob({ query: "llm", jobId: "job-1", maxResults: 5 });

    expect(result.documents).to.have.lengthOf(1);
    const expectedDocId = computeDocId(rawPayload.finalUrl, rawPayload.headers);
    expect(result.documents[0].id).to.equal(expectedDocId);
    sinon.assert.calledOnceWithExactly(knowledgeIngestStub, result.documents[0]);
    sinon.assert.calledOnceWithExactly(vectorIngestStub, result.documents[0]);

    const events = eventStore.getSnapshot();
    expect(events.some((entry) => entry.kind === "search:job_started")).to.equal(true);
    expect(events.some((entry) => entry.kind === "search:doc_ingested")).to.equal(true);
    expect(events.some((entry) => entry.kind === "search:job_completed")).to.equal(true);

    expect(result.errors).to.be.empty;
    expect(result.stats).to.deep.include({ fetchedDocuments: 1, structuredDocuments: 1 } satisfies Partial<SearchJobStats>);
  });

  it("continues processing when some downloads fail", async () => {
    const eventStore = new EventStore({ maxHistory: 50, logger: new StructuredLogger({ onEntry: () => {} }) });
    const logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
    } as unknown as StructuredLogger;

    const searxResponse = {
      query: "llm",
      results: [
        {
          id: "res-1",
          url: "https://example.com/a",
          title: "Doc A",
          snippet: null,
          engines: ["ddg"],
          categories: ["general"],
          position: 0,
          thumbnailUrl: null,
          mime: "text/html",
          publishedAt: null,
          score: null,
        },
        {
          id: "res-2",
          url: "https://example.com/b",
          title: "Doc B",
          snippet: null,
          engines: ["ddg"],
          categories: ["general"],
          position: 1,
          thumbnailUrl: null,
          mime: "text/html",
          publishedAt: null,
          score: null,
        },
      ],
      raw: { query: "llm", number_of_results: 2, results: [] },
    } satisfies Awaited<ReturnType<SearxClient["search"]>>;

    const searxClient = { search: sinon.stub().resolves(searxResponse) } as unknown as SearxClient;

    const headers = new Map<string, string>([
      ["etag", "v2"],
      ["last-modified", "Tue, 02 Jan 2024 00:00:00 GMT"],
    ]);
    const successPayload = {
      requestedUrl: "https://example.com/a",
      finalUrl: "https://example.com/a",
      status: 200,
      fetchedAt: 1_700_000_000_001,
      headers,
      contentType: "text/html",
      size: 256,
      checksum: "cafebabe",
      body: Buffer.from("content"),
    } satisfies ReturnType<SearchDownloader["fetchUrl"]> extends Promise<infer T> ? T : never;

    const downloader = {
      fetchUrl: sinon.stub().onFirstCall().resolves(successPayload).onSecondCall().rejects(new DownloadTimeoutError(5_000)),
    } as unknown as SearchDownloader;

    const extractor = {
      extract: sinon.stub().callsFake(async (request) => ({
        id: request.docId,
        url: successPayload.finalUrl,
        title: "Doc A",
        language: "en",
        description: null,
        checksum: successPayload.checksum,
        mimeType: successPayload.contentType,
        size: successPayload.size,
        fetchedAt: successPayload.fetchedAt,
        segments: [{ id: `${request.docId}#raw-1`, kind: "paragraph", text: "Content" }],
        provenance: request.provenance,
      })),
    } as unknown as UnstructuredExtractor;

    const knowledgeIngestor = { ingest: sinon.stub().returns({ subject: "search:document", triples: [], mentions: [] }) } as unknown as KnowledgeGraphIngestor;
    const vectorIngestor = { ingest: sinon.stub().resolves({ chunks: [], descriptors: [] }) } as unknown as VectorStoreIngestor;

    let tick = 0;
    const pipeline = new SearchPipeline({
      config: baseConfig,
      searxClient,
      downloader,
      extractor,
      knowledgeIngestor,
      vectorIngestor,
      eventStore,
      logger,
      metrics: new SearchMetricsRecorder({ now: () => (tick += 7) }),
    });

    const result = await pipeline.runSearchJob({ query: "llm" });

    expect(result.documents).to.have.lengthOf(1);
    expect(result.errors.some((error) => error.stage === "fetch")).to.equal(true);
    expect(result.stats.fetchedDocuments).to.equal(1);
    expect(result.stats.receivedResults).to.equal(2);

    const events = eventStore.getSnapshot();
    expect(events.filter((entry) => entry.kind === "search:error")).to.have.lengthOf(1);
    expect(events.some((entry) => entry.kind === "search:doc_ingested")).to.equal(true);
  });

  it("ingests explicit URLs without invoking Searx", async () => {
    const eventStore = new EventStore({ maxHistory: 50, logger: new StructuredLogger({ onEntry: () => {} }) });
    const logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
    } as unknown as StructuredLogger;

    const searxClient = { search: sinon.stub().rejects(new Error("should not be called")) } as unknown as SearxClient;

    const headers = new Map<string, string>([["etag", "v3"], ["last-modified", "Wed, 03 Jan 2024 00:00:00 GMT"]]);
    const rawPayload = {
      requestedUrl: "https://example.org/manual",
      finalUrl: "https://example.org/manual",
      status: 200,
      fetchedAt: 1_700_000_000_100,
      headers,
      contentType: "text/html",
      size: 512,
      checksum: "feedface",
      body: Buffer.from("manual body"),
    } satisfies ReturnType<SearchDownloader["fetchUrl"]> extends Promise<infer T> ? T : never;

    const downloader = { fetchUrl: sinon.stub().resolves(rawPayload) } as unknown as SearchDownloader;

    const extractor = {
      extract: sinon.stub().callsFake(async (request) => ({
        id: request.docId,
        url: rawPayload.finalUrl,
        title: "Manual doc",
        language: "en",
        description: null,
        checksum: rawPayload.checksum,
        mimeType: rawPayload.contentType,
        size: rawPayload.size,
        fetchedAt: rawPayload.fetchedAt,
        segments: [{ id: `${request.docId}#seg-0`, kind: "paragraph", text: "Manual" }],
        provenance: request.provenance,
      })),
    } as unknown as UnstructuredExtractor;

    const knowledgeIngestor = { ingest: sinon.stub().returns({ subject: "search:doc", triples: [], mentions: [] }) } as unknown as KnowledgeGraphIngestor;
    const vectorIngestor = { ingest: sinon.stub().resolves({ chunks: [], descriptors: [] }) } as unknown as VectorStoreIngestor;

    const pipeline = new SearchPipeline({
      config: baseConfig,
      searxClient,
      downloader,
      extractor,
      knowledgeIngestor,
      vectorIngestor,
      eventStore,
      logger,
      metrics: new SearchMetricsRecorder(),
    });

    const result = await pipeline.ingestDirect({
      sources: [
        {
          url: "https://example.org/manual",
          title: "Manual doc",
          snippet: "Snippet",
          engines: ["manual"],
          categories: ["general"],
        },
      ],
      label: "manual-import",
      injectGraph: true,
      injectVector: true,
    });

    expect(result.documents).to.have.lengthOf(1);
    sinon.assert.notCalled(searxClient.search as sinon.SinonStub);
    sinon.assert.calledOnceWithExactly(knowledgeIngestor.ingest as sinon.SinonStub, result.documents[0]);
    sinon.assert.calledOnceWithExactly(vectorIngestor.ingest as sinon.SinonStub, result.documents[0]);

    const events = eventStore.getSnapshot();
    expect(events.some((entry) => entry.kind === "search:job_started")).to.equal(true);
    expect(events.some((entry) => entry.kind === "search:doc_ingested")).to.equal(true);
    expect(events.some((entry) => entry.kind === "search:job_completed")).to.equal(true);
  });
});
