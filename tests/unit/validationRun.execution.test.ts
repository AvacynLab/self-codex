import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "chai";

import { executeSearchScenario } from "../../src/validationRun/execution.js";
import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";
import type { SearchConfig } from "../../src/search/config.js";
import { SearxClient, type SearxQueryResponse } from "../../src/search/searxClient.js";
import { SearchDownloader } from "../../src/search/downloader.js";
import { UnstructuredExtractor } from "../../src/search/extractor.js";
import type { RawFetched, StructuredDocument } from "../../src/search/types.js";
import type { EmbedTextOptions, EmbedTextResult } from "../../src/memory/vector.js";

const tmpRoot = path.join(process.cwd(), "tmp", "validation-execution-test");

describe("validationRun/execution", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("runs a search scenario and records artefacts", async () => {
    const config = buildStubSearchConfig();
    const overrides = {
      config,
      searxClient: new StubSearxClient(config),
      downloader: new StubDownloader(config.fetch),
      extractor: new StubExtractor(config),
      vectorEmbed: stubEmbed,
    } as const;

    const result = await executeSearchScenario({
      scenarioId: 1,
      baseRoot: tmpRoot,
      overrides,
    });

    expect(result.documents).to.have.lengthOf(1);
    expect(result.events).to.not.be.empty;
    expect(result.knowledgeSummaries[0].tripleCount).to.be.greaterThan(0);
    expect(result.vectorSummaries[0].tokenCount).to.be.greaterThan(0);

    const eventsContent = await readFile(result.runPaths.events, "utf8");
    expect(eventsContent.trim().split("\n")).to.have.length.greaterThan(0);

    const kgChangesContent = await readFile(result.runPaths.kgChanges, "utf8");
    expect(kgChangesContent.trim().split("\n")).to.have.length.greaterThan(0);

    const vectorUpserts = JSON.parse(await readFile(result.runPaths.vectorUpserts, "utf8")) as unknown[];
    expect(vectorUpserts).to.be.an("array").that.is.not.empty;

    expect(result.timings).to.not.equal(undefined);
    const timings = JSON.parse(await readFile(result.runPaths.timings, "utf8")) as { documentsIngested: number };
    expect(timings.documentsIngested).to.be.a("number");
    expect(timings.documentsIngested).to.be.at.least(0);

    const artifactDir = result.artifactDir;
    await access(path.join(artifactDir, "knowledge_graph.json"));
    await access(path.join(artifactDir, "vector_chunks.json"));
    await access(path.join(artifactDir, "documents_summary.json"));

    const response = result.response as Record<string, unknown>;
    expect(response.mode).to.equal("search");
    expect(response.stats).to.be.an("object");
  });

  it("aggregates artefacts and answers the RAG scenario", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const artifactDir = path.join(layout.artifactsDir, "S01_pdf_science");
    await mkdir(path.join(artifactDir, "vector_index"), { recursive: true });

    const knowledgeTriples = [
      {
        id: "kg-1",
        subject: "Rapport RAG 2025",
        predicate: "résume",
        object: "Synthèse : le rapport RAG 2025 met en avant trois axes majeurs pour l'évaluation.",
        source: "https://example.com/rapport",
        confidence: 0.9,
        provenance: [{ sourceId: "url:https://example.com/rapport", type: "url" }],
        insertedAt: 1,
        updatedAt: 1,
        revision: 0,
        ordinal: 1,
      },
    ];
    await writeFile(path.join(artifactDir, "knowledge_graph.json"), `${JSON.stringify(knowledgeTriples, null, 2)}\n`);

    const vectorIndexRecords = [
      {
        id: "chunk-1",
        text: "Synthèse du rapport RAG 2025 : trois axes majeurs et recommandations concrètes.",
        tags: ["rapport"],
        metadata: { docId: "doc-1" },
        provenance: [{ sourceId: "url:https://example.com/rapport", type: "url" }],
        created_at: 1,
        updated_at: 1,
        embedding: { synthese: 1 },
        norm: 1,
        token_count: 8,
      },
    ];
    await writeFile(
      path.join(artifactDir, "vector_index", "index.json"),
      `${JSON.stringify(vectorIndexRecords, null, 2)}\n`,
    );

    const vectorChunks = [
      {
        chunkId: "chunk-1",
        tokenCount: 8,
        segmentIds: ["seg-1"],
        metadata: { docId: "doc-1" },
        tags: ["rapport"],
        provenance: [{ sourceId: "url:https://example.com/rapport", type: "url" }],
        createdAt: 1,
        updatedAt: 1,
        textLength: 72,
      },
    ];
    await writeFile(path.join(artifactDir, "vector_chunks.json"), `${JSON.stringify(vectorChunks, null, 2)}\n`);

    const result = await executeSearchScenario({
      scenarioId: 10,
      baseRoot: tmpRoot,
    });

    expect(result.timings).to.equal(undefined);
    expect(result.timingNotes).to.be.an("array");
    expect(result.events).to.have.lengthOf(2);

    const response = result.response as Record<string, unknown>;
    expect(response.mode).to.equal("rag_quality");
    expect(Array.isArray(response.citations) ? response.citations.length : 0).to.be.greaterThan(0);

    const ragCoverage = response.coverage as { knowledge_hits: number; rag_hits: number };
    expect(ragCoverage.knowledge_hits).to.be.greaterThan(0);

    const aggregatedKnowledge = JSON.parse(
      await readFile(path.join(result.artifactDir, "knowledge_graph.json"), "utf8"),
    ) as unknown[];
    expect(aggregatedKnowledge).to.have.length.greaterThan(0);

    const aggregatedVectorIndex = JSON.parse(
      await readFile(path.join(result.artifactDir, "vector_index", "index.json"), "utf8"),
    ) as unknown[];
    expect(aggregatedVectorIndex).to.have.length.greaterThan(0);

    const errors = JSON.parse(await readFile(result.runPaths.errors, "utf8")) as unknown[];
    expect(errors).to.be.an("array");
  });
});

function buildStubSearchConfig(): SearchConfig {
  return {
    searx: {
      baseUrl: "http://stub-searx",
      apiPath: "/search",
      timeoutMs: 1_000,
      engines: ["stub-engine"],
      categories: ["general"],
      authToken: null,
      maxRetries: 0,
    },
    unstructured: {
      baseUrl: "http://stub-unstructured",
      timeoutMs: 1_000,
      strategy: "hi_res",
      apiKey: null,
    },
    fetch: {
      timeoutMs: 1_000,
      maxBytes: 1_000_000,
      userAgent: "StubAgent/1.0",
      respectRobotsTxt: false,
      parallelism: 2,
      minDomainDelayMs: 0,
      cache: null,
    },
    pipeline: {
      injectGraph: true,
      injectVector: true,
      parallelExtract: 2,
    },
  };
}

class StubSearxClient extends SearxClient {
  private readonly response: SearxQueryResponse;

  constructor(config: SearchConfig) {
    super(config);
    this.response = {
      query: "stub query",
      results: [
        {
          id: "stub-result",
          url: "https://example.com/doc",
          title: "Stub Document",
          snippet: "Snippet",
          engines: ["stub-engine"],
          categories: ["general"],
          position: 0,
          thumbnailUrl: null,
          mimeType: "text/html",
          score: null,
        },
      ],
      raw: {
        query: "stub query",
        number_of_results: 1,
        results: [
          {
            url: "https://example.com/doc",
            title: "Stub Document",
            content: "",
            snippet: "Snippet",
            engines: ["stub-engine"],
            categories: ["general"],
            score: 1,
          },
        ],
      },
    };
  }

  override async search(): Promise<SearxQueryResponse> {
    return this.response;
  }
}

class StubDownloader extends SearchDownloader {
  constructor(config: SearchConfig["fetch"]) {
    super(config);
  }

  override async fetchUrl(url: string): Promise<RawFetched> {
    const body = Buffer.from("<html><body>Stub</body></html>");
    return {
      requestedUrl: url,
      finalUrl: url,
      status: 200,
      fetchedAt: Date.now(),
      headers: new Map([["content-type", "text/html"]]),
      contentType: "text/html",
      size: body.length,
      checksum: "stub-checksum",
      body,
    };
  }
}

class StubExtractor extends UnstructuredExtractor {
  constructor(config: SearchConfig) {
    super(config);
  }

  override async extract(request: Parameters<UnstructuredExtractor["extract"]>[0]): Promise<StructuredDocument> {
    return {
      id: request.docId,
      url: request.raw.finalUrl,
      title: "Stub Document",
      language: "en",
      description: "Stub description",
      checksum: request.raw.checksum,
      mimeType: request.raw.contentType,
      size: request.raw.size,
      fetchedAt: request.raw.fetchedAt,
      segments: [
        {
          id: `${request.docId}:s1`,
          kind: "paragraph",
          text: "Stub content for ingestion",
        },
      ],
      provenance: {
        searxQuery: request.provenance.query,
        engines: [...request.provenance.engines],
        categories: [...request.provenance.categories],
        position: request.provenance.position,
        sourceUrl: request.provenance.sourceUrl,
        titleHint: request.provenance.titleHint ?? null,
        snippetHint: request.provenance.snippetHint ?? null,
      },
    };
  }
}

function stubEmbed(options: EmbedTextOptions): EmbedTextResult {
  return {
    tokenCount: options.text.length,
    payload: {
      id: options.idHint ?? `stub-${Math.random().toString(16).slice(2)}`,
      text: options.text,
      tags: options.tags ? [...options.tags] : [],
      metadata: options.metadata ? { ...options.metadata } : {},
      provenance: options.provenance ? options.provenance.map((entry) => ({ ...entry })) : [],
      createdAt: options.createdAt ?? Date.now(),
    },
  };
}
