import { expect } from "chai";

import {
  collectSearchRedactionTokens,
  loadSearchConfig,
  parseCsvList,
  type SearchConfig,
} from "../../../src/search/config.js";

const SEARCH_ENV_KEYS = [
  "SEARCH_SEARX_BASE_URL",
  "SEARCH_SEARX_API_PATH",
  "SEARCH_SEARX_TIMEOUT_MS",
  "SEARCH_SEARX_ENGINES",
  "SEARCH_SEARX_CATEGORIES",
  "SEARCH_SEARX_AUTH_TOKEN",
  "SEARCH_SEARX_MAX_RETRIES",
  "UNSTRUCTURED_BASE_URL",
  "UNSTRUCTURED_TIMEOUT_MS",
  "UNSTRUCTURED_STRATEGY",
  "UNSTRUCTURED_API_KEY",
  "SEARCH_FETCH_TIMEOUT_MS",
  "SEARCH_FETCH_MAX_BYTES",
  "SEARCH_FETCH_UA",
  "SEARCH_FETCH_RESPECT_ROBOTS",
  "SEARCH_FETCH_PARALLEL",
  "SEARCH_FETCH_DOMAIN_DELAY_MS",
  "SEARCH_FETCH_CACHE_ENABLED",
  "SEARCH_FETCH_CACHE_TTL_MS",
  "SEARCH_FETCH_CACHE_MAX_ENTRIES",
  "SEARCH_FETCH_CACHE_CLIENT_ERROR_MS",
  "SEARCH_FETCH_CACHE_SERVER_ERROR_MS",
  "SEARCH_FETCH_CACHE_DOMAIN_TTLS",
  "SEARCH_INJECT_GRAPH",
  "SEARCH_INJECT_VECTOR",
  "SEARCH_EXTRACT_PARALLEL",
];

describe("search/config", () => {
  afterEach(() => {
    for (const key of SEARCH_ENV_KEYS) {
      delete process.env[key];
    }
  });

  it("splits CSV literals while removing duplicates", () => {
    expect(parseCsvList("a, b, a, c,, ,C")).to.deep.equal(["a", "b", "c"]);
  });

  it("returns default configuration when no overrides are provided", () => {
    const config = loadSearchConfig();
    assertConfigShape(config);
    expect(config.searx.baseUrl).to.equal("http://searxng:8080");
    expect(config.searx.apiPath).to.equal("/search");
    expect(config.searx.timeoutMs).to.equal(15000);
    expect(config.searx.engines).to.deep.equal(["bing", "ddg", "wikipedia", "arxiv", "github"]);
    expect(config.searx.categories).to.deep.equal(["general", "news", "images", "files"]);
    expect(config.searx.authToken).to.equal(null);
    expect(config.searx.maxRetries).to.equal(2);
    expect(config.unstructured.baseUrl).to.equal("http://unstructured:8000");
    expect(config.unstructured.timeoutMs).to.equal(30000);
    expect(config.unstructured.strategy).to.equal("hi_res");
    expect(config.unstructured.apiKey).to.equal(null);
    expect(config.fetch.timeoutMs).to.equal(20000);
    expect(config.fetch.maxBytes).to.equal(15000000);
    expect(config.fetch.userAgent).to.equal("CodexSearchBot/1.0");
    expect(config.fetch.respectRobotsTxt).to.equal(false);
    expect(config.fetch.parallelism).to.equal(4);
    expect(config.fetch.minDomainDelayMs).to.equal(0);
    expect(config.fetch.cache).to.equal(null);
    expect(config.pipeline.injectGraph).to.equal(true);
    expect(config.pipeline.injectVector).to.equal(true);
    expect(config.pipeline.parallelExtract).to.equal(2);
  });

  it("honours environment overrides", () => {
    process.env.SEARCH_SEARX_BASE_URL = "https://example.com";
    process.env.SEARCH_SEARX_API_PATH = "custom";
    process.env.SEARCH_SEARX_TIMEOUT_MS = "5000";
    process.env.SEARCH_SEARX_ENGINES = "ddg , ddg, brave";
    process.env.SEARCH_SEARX_CATEGORIES = "general,news";
    process.env.SEARCH_SEARX_AUTH_TOKEN = "secret";
    process.env.SEARCH_SEARX_MAX_RETRIES = "4";
    process.env.UNSTRUCTURED_BASE_URL = "https://extractor";
    process.env.UNSTRUCTURED_TIMEOUT_MS = "10000";
    process.env.UNSTRUCTURED_STRATEGY = "fast";
    process.env.UNSTRUCTURED_API_KEY = "api-key";
    process.env.SEARCH_FETCH_TIMEOUT_MS = "12000";
    process.env.SEARCH_FETCH_MAX_BYTES = "4096";
    process.env.SEARCH_FETCH_UA = "MyAgent/1.0";
    process.env.SEARCH_FETCH_RESPECT_ROBOTS = "true";
    process.env.SEARCH_FETCH_PARALLEL = "8";
    process.env.SEARCH_FETCH_DOMAIN_DELAY_MS = "1500";
    process.env.SEARCH_FETCH_CACHE_ENABLED = "true";
    process.env.SEARCH_FETCH_CACHE_TTL_MS = "450000";
    process.env.SEARCH_FETCH_CACHE_MAX_ENTRIES = "12";
    process.env.SEARCH_FETCH_CACHE_CLIENT_ERROR_MS = "600000";
    process.env.SEARCH_FETCH_CACHE_SERVER_ERROR_MS = "120000";
    process.env.SEARCH_FETCH_CACHE_DOMAIN_TTLS = "example.com=900000";
    process.env.SEARCH_INJECT_GRAPH = "false";
    process.env.SEARCH_INJECT_VECTOR = "0";
    process.env.SEARCH_EXTRACT_PARALLEL = "3";

    const config = loadSearchConfig();
    assertConfigShape(config);
    expect(config.searx.baseUrl).to.equal("https://example.com");
    expect(config.searx.apiPath).to.equal("/custom");
    expect(config.searx.timeoutMs).to.equal(5000);
    expect(config.searx.engines).to.deep.equal(["ddg", "brave"]);
    expect(config.searx.categories).to.deep.equal(["general", "news"]);
    expect(config.searx.authToken).to.equal("secret");
    expect(config.searx.maxRetries).to.equal(4);
    expect(config.unstructured.baseUrl).to.equal("https://extractor");
    expect(config.unstructured.timeoutMs).to.equal(10000);
    expect(config.unstructured.strategy).to.equal("fast");
    expect(config.unstructured.apiKey).to.equal("api-key");
    expect(config.fetch.timeoutMs).to.equal(12000);
    expect(config.fetch.maxBytes).to.equal(4096);
    expect(config.fetch.userAgent).to.equal("MyAgent/1.0");
    expect(config.fetch.respectRobotsTxt).to.equal(true);
    expect(config.fetch.parallelism).to.equal(8);
    expect(config.fetch.minDomainDelayMs).to.equal(1500);
    expect(config.fetch.cache).to.deep.equal({
      maxEntriesPerDomain: 12,
      defaultTtlMs: 450000,
      clientErrorTtlMs: 600000,
      serverErrorTtlMs: 120000,
      domainTtlOverrides: { "example.com": 900000 },
    });
    expect(config.pipeline.injectGraph).to.equal(false);
    expect(config.pipeline.injectVector).to.equal(false);
    expect(config.pipeline.parallelExtract).to.equal(3);
  });

  it("collects non-empty search secrets for log redaction", () => {
    const config = loadSearchConfig();
    expect(collectSearchRedactionTokens(config)).to.deep.equal([]);

    const patched: SearchConfig = {
      ...config,
      searx: { ...config.searx, authToken: "  token-one  " },
      unstructured: { ...config.unstructured, apiKey: "token-two" },
    };

    expect(collectSearchRedactionTokens(patched)).to.deep.equal(["token-one", "token-two"]);
  });

  it("deduplicates search secrets when identical values are provided", () => {
    const config = loadSearchConfig();
    const patched: SearchConfig = {
      ...config,
      searx: { ...config.searx, authToken: "shared" },
      unstructured: { ...config.unstructured, apiKey: "shared" },
    };

    expect(collectSearchRedactionTokens(patched)).to.deep.equal(["shared"]);
  });
});

/** Type guard ensuring the returned config exposes all mandatory sections. */
function assertConfigShape(config: SearchConfig): asserts config is SearchConfig {
  expect(config).to.have.property("searx");
  expect(config).to.have.property("unstructured");
  expect(config).to.have.property("fetch");
  expect(config).to.have.property("pipeline");
}
