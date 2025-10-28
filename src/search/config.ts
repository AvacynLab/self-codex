import { readBool, readInt, readOptionalString, readString } from "../config/env.js";

/** Default timeout (ms) applied when querying SearxNG. */
const DEFAULT_SEARX_TIMEOUT_MS = 15_000;
/** Default timeout (ms) for downloading remote content prior to extraction. */
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
/** Maximum payload size accepted during the download phase (15 MiB). */
const DEFAULT_FETCH_MAX_BYTES = 15_000_000;
/** Timeout (ms) applied to calls against the unstructured API. */
const DEFAULT_UNSTRUCTURED_TIMEOUT_MS = 30_000;
/** Default list of engines enabled when none is specified. */
const DEFAULT_ENGINES = ["duckduckgo", "wikipedia", "arxiv", "github", "qwant"] as const;
/** Default set of categories requested from SearxNG. */
const DEFAULT_CATEGORIES = ["general", "news", "images", "files"] as const;
/** Default concurrency used by the pipeline when fetching documents. */
const DEFAULT_PARALLEL_FETCH = 4;
/** Default concurrency used during the extraction phase. */
const DEFAULT_PARALLEL_EXTRACT = 2;
/** Default delay (ms) enforced between requests hitting the same domain. */
const DEFAULT_DOMAIN_DELAY_MS = 0;

/**
 * Splits a CSV literal into a deduplicated array, trimming whitespace and
 * ignoring empty segments. The helper keeps insertion order so operators can
 * prioritise engines/categories explicitly.
 */
export function parseCsvList(value: string): string[] {
  const seen = new Set<string>();
  const items = value
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const ordered: string[] = [];
  for (const item of items) {
    const lower = item.toLowerCase();
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    ordered.push(item);
  }
  return ordered;
}

/** Configuration block dedicated to SearxNG. */
export interface SearxConfig {
  readonly baseUrl: string;
  readonly apiPath: string;
  readonly timeoutMs: number;
  readonly engines: readonly string[];
  readonly categories: readonly string[];
  readonly authToken: string | null;
  readonly maxRetries: number;
}

/** Configuration block covering the `unstructured` API. */
export interface UnstructuredConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly strategy: string;
  readonly apiKey: string | null;
}

/** Configuration applied to the HTTP downloader. */
export interface FetchConfig {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly userAgent: string;
  readonly respectRobotsTxt: boolean;
  readonly parallelism: number;
  readonly minDomainDelayMs: number;
  readonly cache: FetchCacheConfig | null;
}

/** Global switches enabling graph and vector ingestion downstream. */
export interface PipelineConfig {
  readonly injectGraph: boolean;
  readonly injectVector: boolean;
  readonly parallelExtract: number;
}

/** Aggregated search configuration consumed by the runtime. */
export interface SearchConfig {
  readonly searx: SearxConfig;
  readonly unstructured: UnstructuredConfig;
  readonly fetch: FetchConfig;
  readonly pipeline: PipelineConfig;
}

/**
 * Returns the list of secret tokens that must be redacted from log entries
 * when the search pipeline is enabled. Only non-empty values are surfaced so
 * consumers can append them directly to logger configurations without
 * post-filtering boilerplate.
 */
export function collectSearchRedactionTokens(config: SearchConfig): string[] {
  const deduped = new Set<string>();

  const candidates = [config.searx.authToken, config.unstructured.apiKey];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    deduped.add(trimmed);
  }

  return [...deduped];
}

/**
 * Configuration block governing the optional HTTP content cache. The cache is
 * scoped per-domain to avoid mixing policies between origins while keeping the
 * in-memory footprint predictable.
 */
export interface FetchCacheConfig {
  readonly maxEntriesPerDomain: number;
  readonly defaultTtlMs: number;
  readonly clientErrorTtlMs: number;
  readonly serverErrorTtlMs: number;
  readonly domainTtlOverrides: Readonly<Record<string, number>>;
}

function resolveSearxEngines(): string[] {
  const override = readOptionalString("SEARCH_SEARX_ENGINES");
  if (!override) {
    return [...DEFAULT_ENGINES];
  }
  const parsed = parseCsvList(override);
  return parsed.length > 0 ? parsed : [...DEFAULT_ENGINES];
}

function resolveSearxCategories(): string[] {
  const override = readOptionalString("SEARCH_SEARX_CATEGORIES");
  if (!override) {
    return [...DEFAULT_CATEGORIES];
  }
  const parsed = parseCsvList(override);
  return parsed.length > 0 ? parsed : [...DEFAULT_CATEGORIES];
}

/**
 * Loads the configuration from environment variables while applying sensible
 * defaults that work out-of-the-box in development.
 */
export function loadSearchConfig(): SearchConfig {
  const searxBaseUrl = readString("SEARCH_SEARX_BASE_URL", "http://searxng:8080");
  const searxApiPath = readString("SEARCH_SEARX_API_PATH", "/search");
  const searxTimeoutMs = readInt("SEARCH_SEARX_TIMEOUT_MS", DEFAULT_SEARX_TIMEOUT_MS, { min: 1 });
  const searxAuthToken = readOptionalString("SEARCH_SEARX_AUTH_TOKEN") ?? null;
  const searxMaxRetries = readInt("SEARCH_SEARX_MAX_RETRIES", 2, { min: 0, max: 10 });

  const unstructuredBaseUrl = readString("UNSTRUCTURED_BASE_URL", "http://unstructured:8000");
  const unstructuredTimeoutMs = readInt("UNSTRUCTURED_TIMEOUT_MS", DEFAULT_UNSTRUCTURED_TIMEOUT_MS, { min: 1 });
  const unstructuredStrategy = readString("UNSTRUCTURED_STRATEGY", "hi_res");
  const unstructuredApiKey = readOptionalString("UNSTRUCTURED_API_KEY") ?? null;

  const fetchTimeoutMs = readInt("SEARCH_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS, { min: 1 });
  const fetchMaxBytes = readInt("SEARCH_FETCH_MAX_BYTES", DEFAULT_FETCH_MAX_BYTES, { min: 1 });
  const fetchUserAgent = readString("SEARCH_FETCH_UA", "CodexSearchBot/1.0");
  const fetchRespectRobots = readBool("SEARCH_FETCH_RESPECT_ROBOTS", false);
  const fetchParallelism = readInt("SEARCH_FETCH_PARALLEL", DEFAULT_PARALLEL_FETCH, { min: 1, max: 16 });
  const fetchDomainDelay = readInt("SEARCH_FETCH_DOMAIN_DELAY_MS", DEFAULT_DOMAIN_DELAY_MS, {
    min: 0,
    max: 60_000,
  });
  const fetchCacheEnabled = readBool("SEARCH_FETCH_CACHE_ENABLED", false);
  const fetchCache: FetchCacheConfig | null = fetchCacheEnabled
    ? {
        maxEntriesPerDomain: readInt("SEARCH_FETCH_CACHE_MAX_ENTRIES", 16, { min: 1, max: 512 }),
        defaultTtlMs: readInt("SEARCH_FETCH_CACHE_TTL_MS", 10 * 60 * 1000, { min: 1_000, max: 24 * 60 * 60 * 1000 }),
        clientErrorTtlMs: readInt("SEARCH_FETCH_CACHE_CLIENT_ERROR_MS", 5 * 60 * 1000, {
          min: 5_000,
          max: 24 * 60 * 60 * 1000,
        }),
        serverErrorTtlMs: readInt("SEARCH_FETCH_CACHE_SERVER_ERROR_MS", 60 * 1000, {
          min: 5_000,
          max: 24 * 60 * 60 * 1000,
        }),
        domainTtlOverrides: parseDomainTtlOverrides(
          readOptionalString("SEARCH_FETCH_CACHE_DOMAIN_TTLS") ?? "",
        ),
      }
    : null;

  const injectGraph = readBool("SEARCH_INJECT_GRAPH", true);
  const injectVector = readBool("SEARCH_INJECT_VECTOR", true);
  const parallelExtract = readInt("SEARCH_EXTRACT_PARALLEL", DEFAULT_PARALLEL_EXTRACT, { min: 1, max: 16 });

  return {
    searx: {
      baseUrl: searxBaseUrl,
      apiPath: searxApiPath.startsWith("/") ? searxApiPath : `/${searxApiPath}`,
      timeoutMs: searxTimeoutMs,
      engines: resolveSearxEngines(),
      categories: resolveSearxCategories(),
      authToken: searxAuthToken,
      maxRetries: searxMaxRetries,
    },
    unstructured: {
      baseUrl: unstructuredBaseUrl,
      timeoutMs: unstructuredTimeoutMs,
      strategy: unstructuredStrategy,
      apiKey: unstructuredApiKey,
    },
    fetch: {
      timeoutMs: fetchTimeoutMs,
      maxBytes: fetchMaxBytes,
      userAgent: fetchUserAgent,
      respectRobotsTxt: fetchRespectRobots,
      parallelism: fetchParallelism,
      minDomainDelayMs: fetchDomainDelay,
      cache: fetchCache,
    },
    pipeline: {
      injectGraph,
      injectVector,
      parallelExtract,
    },
  };
}

/**
 * Parses a comma-separated list of `domain=ttl` pairs where the TTL is expressed
 * in milliseconds. Malformed entries are ignored so operators can experiment
 * without breaking the orchestrator startup.
 */
function parseDomainTtlOverrides(raw: string): Readonly<Record<string, number>> {
  if (!raw.trim()) {
    return {};
  }

  const overrides: Record<string, number> = {};
  for (const entry of raw.split(",")) {
    const [domainRaw, ttlRaw] = entry.split("=");
    const domain = domainRaw?.trim().toLowerCase();
    const ttl = Number.parseInt(ttlRaw ?? "", 10);
    if (!domain || !Number.isFinite(ttl) || ttl <= 0) {
      continue;
    }
    overrides[domain] = ttl;
  }
  return overrides;
}
