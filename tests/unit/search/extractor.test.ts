import { expect } from "chai";

import {
  UnstructuredExtractor,
  UnstructuredExtractorError,
  type ExtractionRequest,
  type RawFetched,
  type SearchConfig,
  type StructuredDocument,
} from "../../../src/search/index.js";

describe("search/extractor", () => {
  const baseConfig: SearchConfig = {
    searx: {
      baseUrl: "https://searx.example",
      apiPath: "/search",
      timeoutMs: 1000,
      engines: ["ddg"],
      categories: ["general"],
      authToken: null,
      maxRetries: 0,
    },
    unstructured: {
      baseUrl: "https://unstructured.example",
      timeoutMs: 2000,
      strategy: "hi_res",
      apiKey: "secret",
    },
    fetch: {
      timeoutMs: 5000,
      maxBytes: 1024,
      userAgent: "test",
      respectRobotsTxt: false,
      parallelism: 1,
      minDomainDelayMs: 0,
      cache: null,
    },
    pipeline: {
      injectGraph: true,
      injectVector: true,
      parallelExtract: 1,
      // Explicit fallback keeps helper utilities stable when they inspect the
      // search config outside of the pipeline tests.
      maxResults: 12,
    },
  };

  it("maps unstructured elements to structured segments", async () => {
    const recorder: FetchRecorder = [];
    const payload = [
      {
        type: "Title",
        id: "seg-1",
        text: "Search powered knowledge",
        metadata: { page_number: 1 },
      },
      {
        type: "NarrativeText",
        id: "seg-2",
        text: "Search pipelines connect searx results to downstream ingestion.",
        metadata: { page_number: 1 },
      },
      {
        type: "ListItem",
        id: "seg-3",
        text: "Fetch content",
        metadata: { page_number: 2 },
      },
      {
        type: "Image",
        id: "seg-4",
        text: "",
        metadata: { page_number: 2, bbox: [0, 0, 100, 100] },
      },
      {
        type: "Table",
        id: "seg-5",
        text: "A,B\n1,2",
        metadata: { page_number: 2 },
      },
      {
        type: "Figure_Caption",
        id: "seg-6",
        text: "Figure illustrating ingestion.",
        metadata: { page_number: 3 },
      },
      {
        type: "Code",
        id: "seg-7",
        text: "console.log('search');",
        metadata: { page_number: 3 },
      },
    ];

    const extractor = new UnstructuredExtractor(
      baseConfig,
      createFetchStub([createJsonResponse(payload, 200, "application/json")], recorder),
    );

    const request: ExtractionRequest = {
      docId: "doc-1",
      raw: createRawFetched({ url: "https://example.com/doc.pdf" }),
      provenance: {
        query: "search pipeline",
        engines: ["ddg", "wikipedia"],
        categories: ["general"],
        position: 2,
        sourceUrl: "https://example.com/source",
        snippetHint: "Search pipelines connect searx results to downstream ingestion.",
      },
    };

    const document = await extractor.extract(request);
    expect(recorder).to.have.lengthOf(1);
    const [call] = recorder;
    expect(call.url).to.equal("https://unstructured.example/general/v0/general");
    expect(call.init?.method).to.equal("POST");
    const headers = call.init?.headers as Headers | undefined;
    expect(headers?.get("accept")).to.equal("application/json");
    expect(headers?.get("authorization")).to.equal("Bearer secret");
    expect(headers?.get("accept-language")).to.equal("en");

    expect(document.id).to.equal("doc-1");
    expect(document.url).to.equal("https://example.com/doc.pdf");
    expect(document.title).to.equal("Search powered knowledge");
    expect(document.description).to.equal(
      "Search pipelines connect searx results to downstream ingestion.",
    );
    expect(document.language).to.equal("en");
    expect(document.provenance).to.deep.equal({
      searxQuery: "search pipeline",
      engines: ["ddg", "wikipedia"],
      categories: ["general"],
      position: 2,
      sourceUrl: "https://example.com/source",
    });

    expect(document.segments).to.have.lengthOf(7);
    const [titleSegment] = document.segments;
    expect(titleSegment.kind).to.equal("title");
    expect(titleSegment.pageNumber).to.equal(1);
    const paragraphSegment = document.segments.find((segment) => segment.kind === "paragraph");
    expect(paragraphSegment?.text).to.include("Search pipelines connect searx results");
    expect(document.segments.some((segment) => segment.kind === "table")).to.equal(true);
    expect(document.segments.some((segment) => segment.kind === "caption")).to.equal(true);
    expect(document.segments.some((segment) => segment.kind === "code")).to.equal(true);
  });

  it("caps PDF extraction at 40 pages and flags truncation", async () => {
    const payload = Array.from({ length: 45 }, (_, index) => ({
      type: "NarrativeText",
      id: `seg-${index + 1}`,
      text: `Paragraph ${index + 1}`,
      metadata: { page_number: index + 1 },
    }));

    const recorder: FetchRecorder = [];
    const extractor = new UnstructuredExtractor(
      baseConfig,
      createFetchStub([createJsonResponse(payload, 200, "application/json")], recorder),
    );

    const request: ExtractionRequest = {
      docId: "doc-truncated",
      raw: createRawFetched({ url: "https://example.com/truncated.pdf" }),
      provenance: {
        query: "pdf truncation",
        engines: ["ddg"],
        categories: ["files"],
        position: 1,
        sourceUrl: "https://example.com/truncated",
      },
    };

    const document = await extractor.extract(request);
    expect(recorder).to.have.lengthOf(1);
    expect(document.metadata?.truncated).to.equal(true);
    expect(document.segments).to.have.lengthOf(40);
    expect(document.segments.every((segment) => (segment.pageNumber ?? 0) <= 40)).to.equal(true);
  });

  it("skips segments without page metadata once the PDF limit is reached", async () => {
    const payload = [
      ...Array.from({ length: 40 }, (_, index) => ({
        type: "NarrativeText",
        id: `seg-${index + 1}`,
        text: `Page ${index + 1}`,
        metadata: { page_number: index + 1 },
      })),
      {
        type: "NarrativeText",
        id: "seg-41",
        text: "Overflow page",
        metadata: { page_number: 41 },
      },
      {
        type: "NarrativeText",
        id: "seg-42",
        text: "Trailing without metadata",
        metadata: {},
      },
    ];

    const recorder: FetchRecorder = [];
    const extractor = new UnstructuredExtractor(
      baseConfig,
      createFetchStub([createJsonResponse(payload, 200, "application/json")], recorder),
    );

    const request: ExtractionRequest = {
      docId: "doc-overflow",
      raw: createRawFetched({ url: "https://example.com/overflow.pdf" }),
      provenance: {
        query: "pdf overflow",
        engines: ["ddg"],
        categories: ["files"],
        position: 1,
        sourceUrl: "https://example.com/overflow",
      },
    };

    const document = await extractor.extract(request);
    expect(recorder).to.have.lengthOf(1);
    expect(document.metadata?.truncated).to.equal(true);
    expect(document.segments).to.have.lengthOf(40);
    expect(document.segments.at(-1)?.pageNumber).to.equal(40);
    expect(document.segments.some((segment) => segment.text.includes("Overflow"))).to.equal(false);
  });

  it("derives the language hint from HTTP headers when provided", async () => {
    const recorder: FetchRecorder = [];
    const extractor = new UnstructuredExtractor(
      baseConfig,
      createFetchStub(
        [
          createJsonResponse(
            [
              { type: "Title", id: "seg-1", text: "Bonjour", metadata: { page_number: 1 } },
              { type: "NarrativeText", id: "seg-2", text: "Le document est en français.", metadata: { page_number: 1 } },
            ],
            200,
            "application/json",
          ),
        ],
        recorder,
      ),
    );

    const request: ExtractionRequest = {
      docId: "doc-fr",
      raw: createRawFetched({
        url: "https://example.com/fr.pdf",
        headers: [["content-language", "fr-FR"]],
      }),
      provenance: {
        query: "document français",
        engines: ["ddg"],
        categories: ["general"],
        position: 1,
        sourceUrl: "https://example.com/fr",
      },
    };

    const document = await extractor.extract(request);
    const [call] = recorder;
    const headers = call.init?.headers as Headers | undefined;
    expect(headers?.get("accept-language")).to.equal("fr-fr");
    expect(document.language).to.equal("fr");
  });

  it("wraps HTTP failures into extractor errors", async () => {
    const extractor = new UnstructuredExtractor(
      baseConfig,
      createFetchStub([createJsonResponse({}, 503, "application/json")]),
    );

    const request: ExtractionRequest = {
      docId: "doc-err",
      raw: createRawFetched({ url: "https://example.com" }),
      provenance: {
        query: "failure",
        engines: [],
        categories: [],
        position: null,
        sourceUrl: "https://example.com",
      },
    };

    const error = await expectExtractorFailure(extractor.extract(request));
    expect(error.code).to.equal("E-SEARCH-UNSTRUCTURED-HTTP");
    expect(error.status).to.equal(503);
  });

  it("validates the response schema", async () => {
    const extractor = new UnstructuredExtractor(
      baseConfig,
      createFetchStub([createJsonResponse({ invalid: true }, 200, "application/json")]),
    );

    const request: ExtractionRequest = {
      docId: "doc-schema",
      raw: createRawFetched({ url: "https://example.com" }),
      provenance: {
        query: "schema",
        engines: [],
        categories: [],
        position: null,
        sourceUrl: "https://example.com",
      },
    };

    const error = await expectExtractorFailure(extractor.extract(request));
    expect(error.code).to.equal("E-SEARCH-UNSTRUCTURED-SCHEMA");
  });
});

type FetchRecorder = Array<{ url: string; init: RequestInit | undefined }>;

type FetchSequenceEntry = Response | (() => Response);

function createFetchStub(sequence: FetchSequenceEntry[], recorder?: FetchRecorder): typeof fetch {
  const entries = [...sequence];
  const actualRecorder: FetchRecorder = recorder ?? [];
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    actualRecorder.push({ url: String(input), init });
    const next = entries.shift();
    if (!next) {
      throw new Error("Unexpected fetch call in test");
    }
    return typeof next === "function" ? (next as () => Response)() : next;
  }) as typeof fetch;
}

function createJsonResponse(payload: unknown, status = 200, contentType = "application/json"): () => Response {
  return () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": contentType },
    });
}

function createRawFetched(overrides: {
  url: string;
  headers?: ReadonlyArray<[string, string]>;
  contentType?: string;
}): RawFetched {
  const contentType = overrides.contentType ?? "application/pdf";
  const headerMap = new Map<string, string>();
  headerMap.set("content-type", contentType);
  for (const [key, value] of overrides.headers ?? []) {
    headerMap.set(key.toLowerCase(), value);
  }
  return {
    requestedUrl: overrides.url,
    finalUrl: overrides.url,
    status: 200,
    fetchedAt: Date.now(),
    notModified: false,
    headers: headerMap,
    contentType,
    size: 100,
    checksum: "abc123",
    body: Buffer.from("test"),
  };
}

async function expectExtractorFailure(promise: Promise<StructuredDocument>): Promise<UnstructuredExtractorError> {
  try {
    await promise;
    throw new Error("Expected extractor to fail");
  } catch (error) {
    expect(error).to.be.instanceOf(UnstructuredExtractorError);
    return error as UnstructuredExtractorError;
  }
}

