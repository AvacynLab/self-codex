import { expect } from "chai";
import sinon from "sinon";
import {
  DownloadBackoffError,
  DownloadSizeExceededError,
  DownloadTimeoutError,
  HttpStatusError,
  RobotsNotAllowedError,
  SearchDownloader,
  computeDocId,
} from "../../../src/search/downloader.js";
import type { DownloaderDependencies } from "../../../src/search/downloader.js";
import type { FetchConfig } from "../../../src/search/config.js";
import type { RawFetched } from "../../../src/search/types.js";

/** Minimal Response wrapper letting tests control the final URL value. */
class TestResponse extends Response {
  private readonly resolvedUrl: string;

  constructor(body?: BodyInit | null, init: ResponseInit & { url?: string } = {}) {
    const { url, ...rest } = init;
    super(body, rest);
    this.resolvedUrl = url ?? "https://example.com/resource";
  }

  override get url(): string {
    return this.resolvedUrl;
  }
}

const BASE_CONFIG: FetchConfig = {
  timeoutMs: 1_000,
  maxBytes: 1_048_576,
  userAgent: "TestBot/1.0",
  respectRobotsTxt: false,
  parallelism: 1,
  minDomainDelayMs: 0,
  cache: null,
};

async function expectRejectedWith<T extends Error>(
  promise: Promise<unknown>,
  ctor: new (...args: any[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    expect(error).to.be.instanceOf(ctor);
    return error as T;
  }
  throw new Error(`Expected promise to reject with ${ctor.name}`);
}

describe("SearchDownloader", () => {
  it("downloads content and normalises headers", async () => {
    const fetchStub = sinon.stub().resolves(
      new TestResponse("<html><title>Doc</title></html>", {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "ETag": "\"abc\"",
        },
        url: "https://example.com/final",
      }),
    );

    const downloader = new SearchDownloader(BASE_CONFIG, { fetchImpl: fetchStub, now: () => 1700000000000 });
    const result = await downloader.fetchUrl("https://example.com/start");

    expect(result.finalUrl).to.equal("https://example.com/final");
    expect(result.status).to.equal(200);
    expect(result.contentType).to.equal("text/html");
    expect(result.headers.get("etag")).to.equal("\"abc\"");
    expect(result.size).to.be.greaterThan(0);
    expect(result.fetchedAt).to.equal(1700000000000);
    expect(result.checksum).to.have.length(64);
    sinon.assert.calledOnce(fetchStub);
  });

  it("throws when HTTP status indicates an error", async () => {
    const fetchStub = sinon.stub().resolves(
      new TestResponse("missing", {
        status: 404,
        url: "https://example.com/missing",
      }),
    );

    const downloader = new SearchDownloader(BASE_CONFIG, { fetchImpl: fetchStub });

    await expectRejectedWith(downloader.fetchUrl("https://example.com/missing"), HttpStatusError);
  });

  it("enforces the configured payload size limit", async () => {
    const fetchStub = sinon.stub().resolves(
      new TestResponse(Buffer.alloc(10), {
        status: 200,
        url: "https://example.com/large",
      }),
    );

    const config: FetchConfig = { ...BASE_CONFIG, maxBytes: 5 };
    const downloader = new SearchDownloader(config, { fetchImpl: fetchStub });

    await expectRejectedWith(downloader.fetchUrl("https://example.com/large"), DownloadSizeExceededError);
  });

  it("computes deterministic document identifiers from validators", () => {
    const headers = new Map<string, string>([
      ["etag", "\"123\""],
      ["last-modified", "Tue, 19 Nov 2024 10:00:00 GMT"],
    ]);

    const id = computeDocId("https://example.com/doc.pdf", headers);
    expect(id).to.have.length(64);

    const id2 = computeDocId("https://example.com/doc.pdf", headers);
    expect(id2).to.equal(id);
  });

  it("falls back to the payload sample when validators are missing", () => {
    const headers = new Map<string, string>();
    const bodyA = Buffer.from("sample-a");
    const bodyB = Buffer.from("sample-b");

    const idA = computeDocId("https://example.com/no-validators", headers, bodyA);
    const idB = computeDocId("https://example.com/no-validators", headers, bodyB);

    expect(idA).to.have.length(64);
    expect(idB).to.have.length(64);
    expect(idA).to.not.equal(idB);
  });

  it("guesses the content type using the file extension when missing", async () => {
    const fetchStub = sinon.stub().resolves(
      new TestResponse(Buffer.from("%PDF-1.7"), {
        status: 200,
        headers: {},
        url: "https://example.com/report.pdf",
      }),
    );

    const downloader = new SearchDownloader(BASE_CONFIG, { fetchImpl: fetchStub });
    const result = await downloader.fetchUrl("https://example.com/report.pdf");
    expect(result.contentType).to.equal("application/pdf");
  });

  it("sniffs the content type when the URL lacks an extension", async () => {
    const fetchStub = sinon.stub().resolves(
      new TestResponse(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), {
        status: 200,
        headers: {},
        url: "https://cdn.example.com/resource",
      }),
    );

    const downloader = new SearchDownloader(BASE_CONFIG, { fetchImpl: fetchStub });
    const result = await downloader.fetchUrl("https://cdn.example.com/resource");
    expect(result.contentType).to.equal("image/png");
  });

  it("overrides misleading declared content types using signature sniffing", async () => {
    const payload = Buffer.from("%PDF-1.7 sample body");
    const fetchStub = sinon.stub().resolves(
      new TestResponse(payload, {
        status: 200,
        headers: { "Content-Type": "text/html" },
        url: "https://example.com/doc",
      }),
    );

    const downloader = new SearchDownloader(BASE_CONFIG, { fetchImpl: fetchStub });
    const result = await downloader.fetchUrl("https://example.com/doc");
    expect(result.contentType).to.equal("application/pdf");
  });

  it("wraps timeouts into a DownloadTimeoutError", async () => {
    const fetchStub = sinon.stub().callsFake((_: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const config: FetchConfig = { ...BASE_CONFIG, timeoutMs: 20 };
    const downloader = new SearchDownloader(config, { fetchImpl: fetchStub });

    await expectRejectedWith(downloader.fetchUrl("https://example.com/slow"), DownloadTimeoutError);
  });

  it("denies access when robots.txt forbids the path", async () => {
    const fetchStub = sinon.stub();
    fetchStub.callsFake((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/robots.txt")) {
        return Promise.resolve(
          new TestResponse("User-agent: *\nDisallow: /private", {
            status: 200,
            url,
          }),
        );
      }
      throw new Error("Robots policy should have prevented the fetch");
    });

    const config: FetchConfig = { ...BASE_CONFIG, respectRobotsTxt: true };
    const downloader = new SearchDownloader(config, { fetchImpl: fetchStub });

    await expectRejectedWith(
      downloader.fetchUrl("https://example.com/private/doc"),
      RobotsNotAllowedError,
    );
    sinon.assert.calledOnce(fetchStub);
  });

  it("reuses robots.txt evaluation for subsequent requests", async () => {
    const fetchStub = sinon.stub();
    fetchStub.onCall(0).callsFake((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.endsWith("/robots.txt")) {
        throw new Error("First call should target robots.txt");
      }
      return Promise.resolve(
        new TestResponse("User-agent: *\nDisallow: /blocked\nAllow: /", {
          status: 200,
          url,
        }),
      );
    });
    fetchStub.onCall(1).resolves(
      new TestResponse("ok", {
        status: 200,
        url: "https://example.com/allowed",
      }),
    );
    fetchStub.onCall(2).resolves(
      new TestResponse("ok", {
        status: 200,
        url: "https://example.com/another",
      }),
    );

    const config: FetchConfig = { ...BASE_CONFIG, respectRobotsTxt: true };
    const downloader = new SearchDownloader(config, { fetchImpl: fetchStub });

    const first = await downloader.fetchUrl("https://example.com/allowed");
    expect(first.finalUrl).to.equal("https://example.com/allowed");

    const second = await downloader.fetchUrl("https://example.com/another");
    expect(second.finalUrl).to.equal("https://example.com/another");

    sinon.assert.callCount(fetchStub, 3);
  });

  it("issues conditional requests using cached validators and returns cached payload on 304", async () => {
    const canonicalUrl = "https://example.com/asset";
    const cachedPayload: RawFetched = {
      requestedUrl: canonicalUrl,
      finalUrl: canonicalUrl,
      status: 200,
      fetchedAt: 1,
      notModified: false,
      headers: new Map<string, string>([["etag", "\"v1\""]]),
      contentType: "text/plain",
      size: 4,
      checksum: "hash",
      body: Buffer.from("data"),
    };

    const storeStub = sinon.stub();
    const clearFailureStub = sinon.stub();
    const cache: NonNullable<DownloaderDependencies["contentCache"]> = {
      get: sinon.stub().callsFake((url: string, validator?: string) => {
        if (validator) {
          expect(validator).to.equal("\"v1\"");
          return cachedPayload;
        }
        expect(url).to.equal(canonicalUrl);
        return null;
      }),
      getValidatorMetadata: sinon.stub().returns({ validator: "\"v1\"", etag: "\"v1\"", lastModified: null }),
      getFailure: sinon.stub().returns(null),
      recordFailure: sinon.stub(),
      store: storeStub,
      clearFailure: clearFailureStub,
    };

    const fetchStub = sinon.stub().callsFake((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("If-None-Match")).to.equal("\"v1\"");
      return Promise.resolve(
        new TestResponse(null, {
          status: 304,
          headers: {},
          url: typeof input === "string" ? input : input.toString(),
        }),
      );
    });

    const downloader = new SearchDownloader(BASE_CONFIG, { fetchImpl: fetchStub, contentCache: cache });
    const result = await downloader.fetchUrl(canonicalUrl);
    expect(result.notModified).to.equal(true);
    expect(result.status).to.equal(304);
    expect(result.body.equals(cachedPayload.body)).to.equal(true);
    sinon.assert.calledOnce(storeStub);
    const stored = storeStub.firstCall.firstArg as RawFetched;
    expect(stored.notModified).to.equal(false);
    expect(stored.fetchedAt).to.equal(result.fetchedAt);
    sinon.assert.calledWithExactly(clearFailureStub, canonicalUrl);
  });

  it("throttles sequential requests hitting the same domain", async () => {
    let now = 0;
    const sleepStub = sinon.stub().callsFake(async (delay: number) => {
      now += delay;
    });

    const fetchStub = sinon.stub();
    fetchStub
      .onCall(0)
      .resolves(new TestResponse("first", { status: 200, url: "https://example.com/doc-1" }));
    fetchStub
      .onCall(1)
      .resolves(new TestResponse("second", { status: 200, url: "https://example.com/doc-2" }));

    const config: FetchConfig = { ...BASE_CONFIG, minDomainDelayMs: 2_000 };
    const downloader = new SearchDownloader(config, {
      fetchImpl: fetchStub,
      now: () => now,
      sleep: sleepStub,
    });

    await downloader.fetchUrl("https://example.com/doc-1");
    await downloader.fetchUrl("https://example.com/doc-2");

    sinon.assert.calledTwice(fetchStub);
    sinon.assert.calledOnce(sleepStub);
    expect(sleepStub.firstCall.firstArg).to.equal(2_000);
    expect(now).to.equal(2_000);
  });

  it("returns cached documents without issuing a second network call", async () => {
    const fetchStub = sinon.stub();
    fetchStub.resolves(
      new TestResponse("cached", {
        status: 200,
        headers: { "ETag": "\"abc\"" },
        url: "https://example.com/cache",
      }),
    );

    const config: FetchConfig = {
      ...BASE_CONFIG,
      cache: {
        maxEntriesPerDomain: 8,
        defaultTtlMs: 600_000,
        clientErrorTtlMs: 300_000,
        serverErrorTtlMs: 60_000,
        domainTtlOverrides: {},
      },
    };

    const downloader = new SearchDownloader(config, {
      fetchImpl: fetchStub,
      now: () => 1_700_000_000_000,
    });

    const first = await downloader.fetchUrl("https://example.com/cache");
    expect(first.body.toString()).to.equal("cached");

    const second = await downloader.fetchUrl("https://example.com/cache");
    expect(second.body.toString()).to.equal("cached");

    sinon.assert.calledOnce(fetchStub);
  });

  it("enforces backoff after repeated failures and releases after the TTL", async () => {
    let now = 0;
    const fetchStub = sinon.stub();
    fetchStub
      .onCall(0)
      .resolves(new TestResponse("error", { status: 503, url: "https://example.com/unreliable" }));
    fetchStub
      .onCall(1)
      .resolves(
        new TestResponse("ok", {
          status: 200,
          headers: { "ETag": "\"v2\"" },
          url: "https://example.com/unreliable",
        }),
      );

    const config: FetchConfig = {
      ...BASE_CONFIG,
      cache: {
        maxEntriesPerDomain: 4,
        defaultTtlMs: 600_000,
        clientErrorTtlMs: 300_000,
        serverErrorTtlMs: 60_000,
        domainTtlOverrides: {},
      },
    };

    const downloader = new SearchDownloader(config, {
      fetchImpl: fetchStub,
      now: () => now,
    });

    await expectRejectedWith(downloader.fetchUrl("https://example.com/unreliable"), HttpStatusError);
    sinon.assert.calledOnce(fetchStub);

    await expectRejectedWith(
      downloader.fetchUrl("https://example.com/unreliable"),
      DownloadBackoffError,
    );
    sinon.assert.calledOnce(fetchStub);

    now = 120_000;
    const recovered = await downloader.fetchUrl("https://example.com/unreliable");
    expect(recovered.body.toString()).to.equal("ok");
    sinon.assert.calledTwice(fetchStub);
  });

  it("clears cached entries and throttling state when disposed", async () => {
    const fetchStub = sinon.stub();
    fetchStub.onCall(0).resolves(
      new TestResponse("first", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
        url: "https://example.com/cache",
      }),
    );
    fetchStub.onCall(1).resolves(
      new TestResponse("second", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
        url: "https://example.com/cache",
      }),
    );

    const config: FetchConfig = {
      ...BASE_CONFIG,
      cache: {
        maxEntriesPerDomain: 4,
        defaultTtlMs: 60_000,
        clientErrorTtlMs: 60_000,
        serverErrorTtlMs: 60_000,
        domainTtlOverrides: {},
      },
    };

    const downloader = new SearchDownloader(config, { fetchImpl: fetchStub, now: () => 1_700_000_000_000 });

    await downloader.fetchUrl("https://example.com/cache");
    await downloader.fetchUrl("https://example.com/cache");
    sinon.assert.calledOnce(fetchStub);

    downloader.dispose();

    await downloader.fetchUrl("https://example.com/cache");
    sinon.assert.calledTwice(fetchStub);
  });
});
