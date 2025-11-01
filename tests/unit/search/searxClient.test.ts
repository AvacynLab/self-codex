import { expect } from "chai";
import sinon from "sinon";

import {
  SearxClient,
  SearxClientError,
  type SearchConfig,
  type SearxResult,
} from "../../../src/search/index.js";

describe("search/searxClient", () => {
  const baseConfig: SearchConfig = {
    searx: {
      baseUrl: "https://searx.example",
      apiPath: "/search",
      timeoutMs: 2000,
      engines: ["ddg", "wikipedia"],
      categories: ["general"],
      authToken: null,
      maxRetries: 1,
    },
    unstructured: {
      baseUrl: "https://unstructured",
      timeoutMs: 1000,
      strategy: "hi_res",
      apiKey: null,
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
      maxResults: 6,
    },
  };

  it("builds the expected query and normalises results", async () => {
    const payload = {
      query: "llm",
      results: [
        {
          url: "https://example.com/article",
          title: "Interesting article",
          snippet: "A synthetic snippet",
          engines: ["ddg"],
          categories: ["general"],
          score: 1.23,
          thumbnail: "https://example.com/thumb.jpg",
          mimetype: "text/html",
        },
      ],
    };

    const recorder: FetchRecorder = [];
    const client = new SearxClient(baseConfig, createFetchStub([createJsonResponse(payload, 200, "application/json")], recorder));

    const response = await client.search("llm");
    expect(recorder).to.have.lengthOf(1);
    const [request] = recorder;
    expect(request.url).to.equal("https://searx.example/search?q=llm&format=json&categories=general&engines=ddg%2Cwikipedia");
    expect(request.init?.method).to.equal("GET");
    expect(request.init?.headers).to.be.instanceOf(Headers);
    expect((request.init?.headers as Headers | undefined)?.get("Accept")).to.equal("application/json");

    expect(response.query).to.equal("llm");
    expect(response.results).to.have.lengthOf(1);
    const result = response.results[0] as SearxResult;
    expect(result.url).to.equal("https://example.com/article");
    expect(result.title).to.equal("Interesting article");
    expect(result.snippet).to.equal("A synthetic snippet");
    expect(result.engines).to.deep.equal(["ddg"]);
    expect(result.categories).to.deep.equal(["general"]);
    expect(result.mime).to.equal("text/html");
    expect(result.thumbnailUrl).to.equal("https://example.com/thumb.jpg");
    expect(result.score).to.equal(1.23);
    expect(result.id).to.have.length(64);
  });

  it("ignores additional keys returned by SearxNG", async () => {
    const payload = {
      query: "llm",
      results: [
        {
          url: "https://example.com/extra",
          title: "Extra fields",
        },
      ],
      answers: ["42"],
      corrections: { original: "lln", correction: "llm" },
      suggestions: ["llm research"],
    };

    const client = new SearxClient(
      baseConfig,
      createFetchStub([createJsonResponse(payload, 200, "application/json")]),
    );

    const response = await client.search("llm");
    expect(response.query).to.equal("llm");
    expect(response.results).to.have.lengthOf(1);
    expect((response.results[0] as SearxResult).url).to.equal("https://example.com/extra");
  });

  it("throws informative errors when Searx responds with HTTP failures", async () => {
    const client = new SearxClient(
      { ...baseConfig, searx: { ...baseConfig.searx, maxRetries: 0 } },
      createFetchStub([createJsonResponse({}, 503)]),
    );
    try {
      await client.search("failure");
      expect.fail("Expected the search to throw");
    } catch (error) {
      expect(error).to.be.instanceOf(SearxClientError);
      const typed = error as SearxClientError;
      expect(typed.code).to.equal("E-SEARCH-SEARX-HTTP");
      expect(typed.status).to.equal(503);
    }
  });

  it("validates the response schema", async () => {
    const client = new SearxClient(
      baseConfig,
      createFetchStub([createJsonResponse({ query: "bad", results: "oops" }, 200)]),
    );
    const error = await expectSearxFailure(client.search("oops"));
    expect(error.code).to.equal("E-SEARCH-SEARX-SCHEMA");
  });

  it("retries transient failures", async () => {
    const recorder: FetchRecorder = [];
    const client = new SearxClient(
      { ...baseConfig, searx: { ...baseConfig.searx, maxRetries: 1 } },
      createFetchStub([
        createJsonResponse({}, 502, "application/json"),
        createJsonResponse({ query: "retry", results: [] }, 200, "application/json"),
      ], recorder),
    );

    const response = await client.search("retry");
    expect(response.results).to.be.empty;
    expect(recorder).to.have.lengthOf(2);
  });

  it("canonicalises URLs by stripping fragments, tracking params and sorting queries", async () => {
    const payload = {
      query: "tracking",
      results: [
        {
          url: "https://example.com/path?utm_source=newsletter&b=2&ref=promo&a=1#fragment",
          title: "Tracked",
          engines: ["ddg"],
          categories: ["general"],
        },
      ],
    };

    const client = new SearxClient(
      baseConfig,
      createFetchStub([createJsonResponse(payload, 200, "application/json")]),
    );

    const response = await client.search("tracking");
    expect(response.results).to.have.lengthOf(1);
    const [result] = response.results;
    // The canonical form retains only meaningful parameters and sorts them for determinism.
    expect(result.url).to.equal("https://example.com/path?a=1&b=2");
  });

  it("does not retry on non-retriable HTTP statuses", async () => {
    const recorder: FetchRecorder = [];
    const client = new SearxClient(
      { ...baseConfig, searx: { ...baseConfig.searx, maxRetries: 3 } },
      createFetchStub([createJsonResponse({ query: "notfound" }, 404, "application/json")], recorder),
    );

    const error = await expectSearxFailure(client.search("notfound"));
    expect(error.code).to.equal("E-SEARCH-SEARX-HTTP");
    // 4xx client errors must fail fast without exhausting the retry budget.
    expect(recorder).to.have.lengthOf(1);
  });

  it("aborts slow requests according to the configured timeout", async () => {
    const clock = sinon.useFakeTimers();
    try {
      let callCount = 0;
      // Simulate a fetch call that only rejects once the abort signal fires.
      const fetchStub: typeof fetch = (async (_input, init) => {
        callCount += 1;
        return new Promise((_, reject) => {
          const abortSignal = init?.signal;
          if (!abortSignal) {
            reject(new Error("Missing abort signal"));
            return;
          }
          abortSignal.addEventListener("abort", () => {
            const abortError = new Error("Aborted");
            abortError.name = "AbortError";
            reject(abortError);
          });
        });
      }) as typeof fetch;

      const client = new SearxClient(
        { ...baseConfig, searx: { ...baseConfig.searx, timeoutMs: 50, maxRetries: 0 } },
        fetchStub,
      );

      const pending = client.search("slow");
      const failure = expectSearxFailure(pending);
      await clock.tickAsync(60);
      const error = await failure;
      expect(error.code).to.equal("E-SEARCH-SEARX-NETWORK");
      expect(callCount).to.equal(1);
    } finally {
      clock.restore();
    }
  });

  it("rejects empty queries", async () => {
    const client = new SearxClient(baseConfig, createFetchStub([]));
    const error = await expectSearxFailure(client.search("   "));
    expect(error.code).to.equal("E-SEARCH-SEARX-SCHEMA");
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

function createJsonResponse(
  payload: unknown,
  status = 200,
  contentType = "application/json",
): () => Response {
  return () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: {
        "content-type": contentType,
      },
    });
}

async function expectSearxFailure<T>(promise: Promise<T>): Promise<SearxClientError> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    expect(error).to.be.instanceOf(SearxClientError);
    return error as SearxClientError;
  }
}
