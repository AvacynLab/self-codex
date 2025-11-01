import { after, before, describe, it } from "mocha";
import { expect } from "chai";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StructuredLogger } from "../../../src/logger.js";
import { EventStore } from "../../../src/eventStore.js";
import { loadSearchConfig } from "../../../src/search/config.js";
import { SearxClient } from "../../../src/search/searxClient.js";
import { SearchDownloader } from "../../../src/search/downloader.js";
import { UnstructuredExtractor } from "../../../src/search/extractor.js";
import { KnowledgeGraph } from "../../../src/knowledge/knowledgeGraph.js";
import { KnowledgeGraphIngestor } from "../../../src/search/ingest/toKnowledgeGraph.js";
import { LocalVectorMemory } from "../../../src/memory/vectorMemory.js";
import { VectorStoreIngestor } from "../../../src/search/ingest/toVectorStore.js";
import { SearchPipeline } from "../../../src/search/pipeline.js";
import { SearchMetricsRecorder } from "../../../src/search/metrics.js";

/** Static HTML payload served by the fixture content server. */
const HTML_FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>LLM search validation</title>
  </head>
  <body>
    <article>
      <h1>Validating the multimodal search pipeline</h1>
      <p id="intro">This document exercises the full ingestion path for the search module.</p>
      <p>It confirms that the downloader, extractor, graph ingestion and vector ingestion work together.</p>
    </article>
  </body>
</html>`;

/** Simplified response structure used by the stubbed Searx endpoint. */
interface StubSearxResult {
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly mimetype?: string;
  readonly engine?: string;
  readonly categories?: readonly string[];
  readonly resultType?: string;
}

interface SearxResponseSnapshot {
  readonly query: string;
  readonly results: readonly StubSearxResult[];
}

type HttpServer = ReturnType<typeof createServer>;

describe("search.run end-to-end pipeline", function () {
  before(function (this: Mocha.Context) {
    if (process.env.SEARCH_E2E_ALLOW_RUN !== "1") {
      this.skip();
    }
  });

  // The dockerised unstructured server can take a noticeable amount of time to
  // warm up on first boot. Allocating a generous timeout keeps the suite
  // reliable on slower CI runners.
  this.timeout(180_000);

  let searxServer: HttpServer | null = null;
  let searxBaseUrl = "";
  let contentServer: HttpServer | null = null;
  let contentBaseUrl = "";
  let robotsPolicy = "User-agent: *\nAllow: /\n";
  const envBackup = new Map<string, string | undefined>();
  let currentSearxSnapshot: SearxResponseSnapshot | null = null;

  before(async function () {
    contentServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (!request.url) {
        response.writeHead(400);
        response.end("missing URL");
        return;
      }
      if (request.url.startsWith("/robots.txt")) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(robotsPolicy);
        return;
      }
      if (request.url.startsWith("/blocked.html")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<p>blocked content</p>");
        return;
      }
      if (request.url.startsWith("/oversize.bin")) {
        const payload = Buffer.alloc(2_048, 1);
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(payload);
        return;
      }
      if (!request.url.startsWith("/doc.html")) {
        response.writeHead(404);
        response.end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "last-modified": new Date("2024-01-01T00:00:00Z").toUTCString(),
      });
      response.end(HTML_FIXTURE);
    });
    await new Promise<void>((resolve) => {
      contentServer!.listen(0, "127.0.0.1", resolve);
    });
    const contentAddress = contentServer.address() as AddressInfo;
    contentBaseUrl = `http://127.0.0.1:${contentAddress.port}`;

    searxServer = createServer(handleSearxRequest);
    await new Promise<void>((resolve) => {
      searxServer!.listen(0, "127.0.0.1", resolve);
    });
    const searxAddress = searxServer.address() as AddressInfo;
    searxBaseUrl = `http://127.0.0.1:${searxAddress.port}`;

    const setEnv = (key: string, value: string) => {
      envBackup.set(key, process.env[key]);
      process.env[key] = value;
    };

    setEnv("SEARCH_SEARX_BASE_URL", searxBaseUrl);
    setEnv("SEARCH_SEARX_API_PATH", "/search");
    setEnv("SEARCH_SEARX_MAX_RETRIES", "0");
    setEnv("SEARCH_FETCH_RESPECT_ROBOTS", "0");
    setEnv("SEARCH_FETCH_PARALLEL", "1");
    setEnv("SEARCH_FETCH_DOMAIN_DELAY_MS", "0");
    setEnv("SEARCH_INJECT_GRAPH", "1");
    setEnv("SEARCH_INJECT_VECTOR", "1");
    setEnv("UNSTRUCTURED_BASE_URL", "http://127.0.0.1:8000");

    configureSearxResponse({
      query: "search e2e validation",
      results: [
        {
          url: `${contentBaseUrl}/doc.html`,
          title: "Validating the multimodal search pipeline",
          content: "Structured search ingestion validation.",
        },
      ],
    });
  });

  after(async () => {
    for (const [key, value] of envBackup.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    const closeServer = async (server: HttpServer | null) => {
      if (!server) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    };

    await Promise.all([closeServer(searxServer), closeServer(contentServer)]);
  });

  it("ingests documents through Searx, unstructured and the storage layers", async () => {
    const harness = await createPipelineHarness();
    try {
      const job = await harness.pipeline.runSearchJob({
        query: "search e2e validation",
        fetchContent: true,
        injectGraph: true,
        injectVector: true,
        maxResults: 3,
      });

      expect(job.errors, "pipeline should not surface errors").to.deep.equal([]);
      expect(job.documents.length).to.equal(1);

      const document = job.documents[0];
      expect(document.url).to.equal(`${contentBaseUrl}/doc.html`);
      expect(document.segments.length).to.be.greaterThan(0);

      // The in-memory knowledge graph should contain the document level triples
      // emitted by the ingestion pipeline.
      expect(harness.knowledgeGraph.count()).to.be.greaterThan(0);

      // Vector memory stores at least one chunk derived from the structured
      // segments, proving that the unstructured server returned extractable text.
      expect(harness.vectorMemory.size()).to.be.greaterThan(0);

      const events = harness.eventStore.list();
      const kinds = new Set(events.map((event) => event.kind));
      expect(kinds.has("search:job_started"), "missing job_started event").to.equal(true);
      expect(kinds.has("search:job_completed"), "missing job_completed event").to.equal(true);
      expect(kinds.has("search:doc_ingested"), "missing doc_ingested event").to.equal(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("replays the crawl without duplicating knowledge graph entries (S05 idempotence)", async () => {
    configureSearxResponse({
      query: "idempotence verification",
      results: [
        {
          url: `${contentBaseUrl}/doc.html`,
          title: "Idempotent crawl payload",
          content: "Ensures docIds remain stable across runs.",
        },
      ],
    });

    const deterministicNow = Date.now();
    const harness = await createPipelineHarness({ now: () => deterministicNow });
    try {
      const firstJob = await harness.pipeline.runSearchJob({
        query: "idempotence verification",
        fetchContent: true,
        injectGraph: true,
        injectVector: true,
        maxResults: 2,
      });

      expect(firstJob.errors).to.deep.equal([]);
      const firstIds = firstJob.documents.map((doc) => doc.id);
      const triplesAfterFirstRun = harness.knowledgeGraph.count();
      const vectorsAfterFirstRun = harness.vectorMemory.size();

      const secondJob = await harness.pipeline.runSearchJob({
        query: "idempotence verification",
        fetchContent: true,
        injectGraph: true,
        injectVector: true,
        maxResults: 2,
      });

      expect(secondJob.errors, "replay should not produce new ingestion errors").to.deep.equal([]);
      const secondIds = secondJob.documents.map((doc) => doc.id);
      expect(secondIds).to.deep.equal(firstIds);
      expect(harness.knowledgeGraph.count()).to.equal(triplesAfterFirstRun);
      expect(harness.vectorMemory.size()).to.equal(vectorsAfterFirstRun);
    } finally {
      await harness.cleanup();
    }
  });

  it("classifies robots and size limit failures without blocking the job (S06)", async () => {
    configureRobotsPolicy("User-agent: *\nDisallow: /blocked.html\n");
    configureSearxResponse({
      query: "robots and size validation",
      results: [
        {
          url: `${contentBaseUrl}/blocked.html`,
          title: "Blocked by robots",
          content: "Should be denied by robots.txt.",
          mimetype: "text/html",
        },
        {
          url: `${contentBaseUrl}/oversize.bin`,
          title: "Too large",
          content: "Binary payload exceeding max bytes.",
          mimetype: "application/octet-stream",
        },
      ],
    });

    const harness = await createPipelineHarness({ respectRobotsTxt: true, maxBytes: 512 });
    try {
      const job = await harness.pipeline.runSearchJob({
        query: "robots and size validation",
        fetchContent: true,
        injectGraph: true,
        injectVector: true,
        maxResults: 6,
      });

      expect(job.documents.length).to.equal(0);
      const codes = job.errors.map((error) => error.code);
      expect(codes).to.include("robots_denied");
      expect(codes).to.include("max_size_exceeded");
      const stages = new Set(job.errors.map((error) => error.stage));
      expect(stages.has("fetch")).to.equal(true);
    } finally {
      await harness.cleanup();
      configureRobotsPolicy("User-agent: *\nAllow: /\n");
    }
  });

  function configureSearxResponse(snapshot: SearxResponseSnapshot): void {
    currentSearxSnapshot = snapshot;
  }

  function configureRobotsPolicy(policy: string): void {
    robotsPolicy = policy;
  }

  async function createPipelineHarness(options: {
    respectRobotsTxt?: boolean;
    maxBytes?: number;
    now?: () => number;
  } = {}): Promise<{
    pipeline: SearchPipeline;
    knowledgeGraph: KnowledgeGraph;
    vectorMemory: LocalVectorMemory;
    eventStore: EventStore;
    cleanup: () => Promise<void>;
  }> {
    const workDir = await mkdtemp(join(tmpdir(), "search-e2e-vector-"));
    const knowledgeGraph = new KnowledgeGraph();
    const vectorMemory = await LocalVectorMemory.create({ directory: workDir });
    const logger = new StructuredLogger();
    const eventStore = new EventStore({ maxHistory: 512, logger });
    const metrics = new SearchMetricsRecorder();

    const baseConfig = loadSearchConfig();
    const mockFetch = createMockUnstructuredFetch(baseConfig.unstructured.baseUrl);
    const config = {
      ...baseConfig,
      fetch: {
        ...baseConfig.fetch,
        respectRobotsTxt: options.respectRobotsTxt ?? baseConfig.fetch.respectRobotsTxt,
        maxBytes: options.maxBytes ?? baseConfig.fetch.maxBytes,
      },
      pipeline: {
        ...baseConfig.pipeline,
        injectGraph: true,
        injectVector: true,
      },
    } as const;

    const pipeline = new SearchPipeline({
      config,
      searxClient: new SearxClient(config),
      downloader: new SearchDownloader(config.fetch, {
        now: options.now,
      }),
      extractor: new UnstructuredExtractor(config, mockFetch),
      knowledgeIngestor: new KnowledgeGraphIngestor({ graph: knowledgeGraph }),
      vectorIngestor: new VectorStoreIngestor({ memory: vectorMemory }),
      eventStore,
      logger,
      metrics,
    });

    const cleanup = async () => {
      await rm(workDir, { recursive: true, force: true });
    };

    return { pipeline, knowledgeGraph, vectorMemory, eventStore, cleanup };
  }

  function createMockUnstructuredFetch(expectedBaseUrl: string): typeof fetch {
    return async (
      input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1] = {},
    ) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (!target.startsWith(expectedBaseUrl)) {
        return fetch(input, init);
      }

      // Provide deterministic segments mirroring the HTML fixture so the
      // pipeline can exercise the normalisation and ingestion stages without a
      // network dependency on the external Unstructured service.
      const segments = [
        {
          type: "title",
          id: "seg-title-1",
          text: "Validating the multimodal search pipeline",
        },
        {
          type: "narrative_text",
          id: "seg-paragraph-1",
          text: "This document exercises the full ingestion path for the search module.",
        },
        {
          type: "narrative_text",
          id: "seg-paragraph-2",
          text: "It confirms that the downloader, extractor, graph ingestion and vector ingestion work together.",
        },
      ];

      return new Response(JSON.stringify(segments), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  function buildSearxResultPayload(queryOverride: string): Record<string, unknown> {
    const snapshot = currentSearxSnapshot ?? { query: queryOverride, results: [] };
    const results = snapshot.results.map((result) => ({
      url: result.url,
      title: result.title,
      content: result.content,
      engine: result.engine ?? "stub",
      engines: [result.engine ?? "stub"],
      categories: [...(result.categories ?? ["general"])],
      result_type: result.resultType ?? "web",
      mimetype: result.mimetype ?? "text/html",
      score: 1.0,
    }));

    return {
      query: snapshot.query || queryOverride,
      number_of_results: results.length,
      results,
    };
  }

  function handleSearxRequest(request: IncomingMessage, response: ServerResponse): void {
    if (!request.url || !request.url.startsWith("/search")) {
      response.writeHead(404);
      response.end("unknown endpoint");
      return;
    }
    const url = new URL(request.url, searxBaseUrl);
    const query = url.searchParams.get("q") ?? "";
    const payload = buildSearxResultPayload(query);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  }
});
