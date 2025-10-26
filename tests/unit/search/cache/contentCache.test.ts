import { expect } from "chai";

import { SearchContentCache } from "../../../../src/search/cache/contentCache.js";
import type { RawFetched } from "../../../../src/search/types.js";

function createFetched(url: string, overrides: Partial<RawFetched> = {}): RawFetched {
  const headers = new Map<string, string>([["etag", '"seed"']]);
  const base: RawFetched = {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    fetchedAt: 1700000000000,
    headers,
    contentType: "text/plain",
    size: 7,
    checksum: "abc123",
    body: Buffer.from("cached"),
  };
  if (overrides.headers) {
    overrides.headers.forEach((value, key) => headers.set(key, value));
  }
  return { ...base, ...overrides, headers };
}

describe("SearchContentCache", () => {
  it("stores and retrieves documents while cloning results", () => {
    const cache = new SearchContentCache({ now: () => 1_700_000_000_000 });
    const fetched = createFetched("https://example.com/doc");

    cache.store(fetched);
    const first = cache.get("https://example.com/doc");
    expect(first).to.not.equal(null);
    expect(first?.body.toString()).to.equal("cached");

    // Mutating the retrieved buffer should not alter the cached value.
    first?.body.write("mutated");
    const second = cache.get("https://example.com/doc");
    expect(second?.body.toString()).to.equal("cached");
  });

  it("expires entries according to domain-specific overrides", () => {
    let now = 0;
    const cache = new SearchContentCache({
      defaultTtlMs: 600_000,
      domainTtlOverrides: { "example.com": 5_000 },
      now: () => now,
    });

    cache.store(createFetched("https://example.com/resource"));
    expect(cache.get("https://example.com/resource")).to.not.equal(null);

    now = 10_000;
    expect(cache.get("https://example.com/resource")).to.equal(null);

    cache.store(createFetched("https://other.test/data", { finalUrl: "https://other.test/data" }));
    now = 100_000;
    expect(cache.get("https://other.test/data")).to.not.equal(null);
  });

  it("records failures and releases the backoff once cleared", () => {
    let now = 0;
    const cache = new SearchContentCache({
      serverErrorTtlMs: 60_000,
      now: () => now,
    });

    cache.recordFailure("https://unstable.example/doc", 503);
    const failure = cache.getFailure("https://unstable.example/doc");
    expect(failure).to.not.equal(null);
    expect(failure?.status).to.equal(503);

    expect(cache.getFailure("https://unstable.example/doc")).to.not.equal(null);

    now = 120_000;
    expect(cache.getFailure("https://unstable.example/doc")).to.equal(null);

    cache.recordFailure("https://unstable.example/doc", 503);
    cache.clearFailure("https://unstable.example/doc");
    expect(cache.getFailure("https://unstable.example/doc")).to.equal(null);
  });
});
