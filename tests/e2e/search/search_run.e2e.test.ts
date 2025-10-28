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
  let vectorDir = "";
  const envBackup = new Map<string, string | undefined>();

  let knowledgeGraph: KnowledgeGraph;
  let vectorMemory: LocalVectorMemory;
  let eventStore: EventStore;
  let pipeline: SearchPipeline;

  before(async function () {
    contentServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (!request.url) {
        response.writeHead(400);
        response.end("missing URL");
        return;
      }
      if (request.url.startsWith("/robots.txt")) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("User-agent: *\nAllow: /\n");
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

    searxServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (!request.url || !request.url.startsWith("/search")) {
        response.writeHead(404);
        response.end("unknown endpoint");
        return;
      }
      const url = new URL(request.url, searxBaseUrl);
      const query = url.searchParams.get("q") ?? "";
      const payload = {
        query,
        number_of_results: 1,
        results: [
          {
            url: `${contentBaseUrl}/doc.html`,
            title: "Validating the multimodal search pipeline",
            content: "Structured search ingestion validation.",
            engine: "stub", // Keep explicit engine/category for observability.
            engines: ["stub"],
            categories: ["general"],
            result_type: "web",
            mimetype: "text/html",
            score: 1.0,
          },
        ],
      } as const;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
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

    vectorDir = await mkdtemp(join(tmpdir(), "search-e2e-vector-"));

    knowledgeGraph = new KnowledgeGraph();
    vectorMemory = await LocalVectorMemory.create({ directory: vectorDir });

    const logger = new StructuredLogger();
    eventStore = new EventStore({ maxHistory: 512, logger });
    const metrics = new SearchMetricsRecorder();
    const config = loadSearchConfig();
    pipeline = new SearchPipeline({
      config,
      searxClient: new SearxClient(config),
      downloader: new SearchDownloader(config.fetch),
      extractor: new UnstructuredExtractor(config),
      knowledgeIngestor: new KnowledgeGraphIngestor({ graph: knowledgeGraph }),
      vectorIngestor: new VectorStoreIngestor({ memory: vectorMemory }),
      eventStore,
      logger,
      metrics,
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
    if (vectorDir) {
      await rm(vectorDir, { recursive: true, force: true });
    }
  });

  it("ingests documents through Searx, unstructured and the storage layers", async () => {
    const job = await pipeline.runSearchJob({
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
    expect(knowledgeGraph.count()).to.be.greaterThan(0);

    // Vector memory stores at least one chunk derived from the structured
    // segments, proving that the unstructured server returned extractable text.
    expect(vectorMemory.size()).to.be.greaterThan(0);

    const events = eventStore.list();
    const kinds = new Set(events.map((event) => event.kind));
    expect(kinds.has("search:job_started"), "missing job_started event").to.equal(true);
    expect(kinds.has("search:job_completed"), "missing job_completed event").to.equal(true);
    expect(kinds.has("search:doc_ingested"), "missing doc_ingested event").to.equal(true);
  });
});
