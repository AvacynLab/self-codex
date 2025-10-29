import type { RawFetched } from "../types.js";

/** Default number of cached documents maintained per domain. */
const DEFAULT_MAX_ENTRIES_PER_DOMAIN = 16;
/** Default success TTL (10 minutes) applied when no override is provided. */
const DEFAULT_SUCCESS_TTL_MS = 10 * 60 * 1000;
/** Default backoff applied to client errors (5 minutes). */
const DEFAULT_CLIENT_ERROR_TTL_MS = 5 * 60 * 1000;
/** Default backoff applied to transient server errors (60 seconds). */
const DEFAULT_SERVER_ERROR_TTL_MS = 60 * 1000;

/** Internal snapshot of a cached document. */
interface CacheEntry {
  readonly key: string;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly validator: string;
  readonly value: RawFetched;
}

/** Tracking structure recording failures so subsequent calls can be throttled. */
interface FailureEntry {
  readonly status: number;
  readonly retryAt: number;
  readonly attempts: number;
}

/** Maintains both document cache entries and throttling metadata for a domain. */
interface DomainBucket {
  readonly entries: Map<string, CacheEntry>;
  readonly order: string[];
  readonly byUrl: Map<string, Set<string>>;
  readonly failures: Map<string, FailureEntry>;
}

/** Structured snapshot returned when a failure forces a backoff. */
export interface CachedFailureBackoff {
  readonly status: number;
  readonly retryAt: number;
  readonly attempts: number;
}

/** Options accepted when instantiating the content cache. */
export interface ContentCacheOptions {
  readonly maxEntriesPerDomain?: number;
  readonly defaultTtlMs?: number;
  readonly clientErrorTtlMs?: number;
  readonly serverErrorTtlMs?: number;
  readonly domainTtlOverrides?: Readonly<Record<string, number>>;
  readonly now?: () => number;
}

/**
 * In-memory cache deduplicating downloaded documents. Entries are scoped per
 * domain and keyed using the canonical URL combined with HTTP validators (etag
 * or last-modified). The cache also tracks failing URLs to enforce a temporary
 * backoff when repeated 4xx/5xx responses are observed.
 */
export class SearchContentCache {
  private readonly maxEntriesPerDomain: number;
  private readonly defaultTtlMs: number;
  private readonly clientErrorTtlMs: number;
  private readonly serverErrorTtlMs: number;
  private readonly domainTtlOverrides: Readonly<Record<string, number>>;
  private readonly now: () => number;
  private readonly domains = new Map<string, DomainBucket>();

  constructor(options: ContentCacheOptions = {}) {
    this.maxEntriesPerDomain = options.maxEntriesPerDomain ?? DEFAULT_MAX_ENTRIES_PER_DOMAIN;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
    this.clientErrorTtlMs = options.clientErrorTtlMs ?? DEFAULT_CLIENT_ERROR_TTL_MS;
    this.serverErrorTtlMs = options.serverErrorTtlMs ?? DEFAULT_SERVER_ERROR_TTL_MS;
    this.domainTtlOverrides = options.domainTtlOverrides ?? {};
    this.now = options.now ?? Date.now;
  }

  /**
   * Retrieves a cached document when available and not expired. Optional HTTP
   * validator hints can be provided to disambiguate multiple variants of the
   * same URL.
   */
  get(url: string, validatorHint?: string | null): RawFetched | null {
    const canonicalUrl = normaliseUrl(url);
    const bucket = this.domains.get(canonicalUrl.domain);
    if (!bucket) {
      return null;
    }

    this.pruneExpired(bucket);
    const normalisedHint = normaliseValidator(validatorHint);
    const lookupKey = buildCacheKey(canonicalUrl.href, normalisedHint);

    let entry = bucket.entries.get(lookupKey);
    if (!entry && !normalisedHint) {
      const keys = bucket.byUrl.get(canonicalUrl.href);
      if (keys) {
        for (const key of keys) {
          const candidate = bucket.entries.get(key);
          if (candidate) {
            entry = candidate;
            break;
          }
        }
      }
    }

    if (!entry) {
      return null;
    }

    this.touch(bucket, entry.key);
    return cloneRawFetched(entry.value);
  }

  /** Stores a successful fetch into the cache under both requested and final URLs. */
  store(fetched: RawFetched): void {
    const validator = extractValidator(fetched.headers);
    const record = cloneRawFetched(fetched);
    const now = this.now();

    this.insert(record.requestedUrl, validator, record, now);
    if (record.finalUrl !== record.requestedUrl) {
      this.insert(record.finalUrl, validator, record, now);
    }
  }

  /** Clears throttling metadata for the provided URL following a successful fetch. */
  clearFailure(url: string): void {
    const canonicalUrl = normaliseUrl(url);
    const bucket = this.domains.get(canonicalUrl.domain);
    bucket?.failures.delete(canonicalUrl.href);
  }

  /** Records a failing status code so subsequent requests are throttled. */
  recordFailure(url: string, status: number): void {
    const canonicalUrl = normaliseUrl(url);
    const bucket = this.obtainDomainBucket(canonicalUrl.domain);
    const now = this.now();
    const ttl = status >= 500 ? this.serverErrorTtlMs : this.clientErrorTtlMs;
    const retryAt = now + this.resolveDomainTtl(canonicalUrl.domain, ttl);

    const existing = bucket.failures.get(canonicalUrl.href);
    bucket.failures.set(canonicalUrl.href, {
      status,
      retryAt,
      attempts: (existing?.attempts ?? 0) + 1,
    });
  }

  /** Returns the throttling metadata for a URL when an active backoff exists. */
  getFailure(url: string): CachedFailureBackoff | null {
    const canonicalUrl = normaliseUrl(url);
    const bucket = this.domains.get(canonicalUrl.domain);
    if (!bucket) {
      return null;
    }

    const entry = bucket.failures.get(canonicalUrl.href);
    if (!entry) {
      return null;
    }

    if (entry.retryAt <= this.now()) {
      bucket.failures.delete(canonicalUrl.href);
      return null;
    }

    return entry;
  }

  /**
   * Exposes the HTTP validators (ETag / Last-Modified) associated with a URL when
   * the cache still holds a successful entry.  The downloader relies on these
   * hints to issue conditional requests (`If-None-Match` / `If-Modified-Since`)
   * so large documents can be revalidated without re-downloading their payload.
   */
  getValidatorMetadata(url: string): {
    readonly validator: string;
    readonly etag: string | null;
    readonly lastModified: string | null;
  } | null {
    const canonicalUrl = normaliseUrl(url);
    const bucket = this.domains.get(canonicalUrl.domain);
    if (!bucket) {
      return null;
    }

    this.pruneExpired(bucket);
    const keys = bucket.byUrl.get(canonicalUrl.href);
    if (!keys || keys.size === 0) {
      return null;
    }

    for (const key of keys) {
      const entry = bucket.entries.get(key);
      if (!entry) {
        continue;
      }
      const etag = entry.value.headers.get("etag") ?? null;
      const lastModified = entry.value.headers.get("last-modified") ?? null;
      return {
        validator: entry.validator,
        etag,
        lastModified,
      };
    }

    return null;
  }

  private insert(url: string, validator: string, value: RawFetched, now: number): void {
    const canonicalUrl = normaliseUrl(url);
    const bucket = this.obtainDomainBucket(canonicalUrl.domain);
    const ttl = this.resolveDomainTtl(canonicalUrl.domain, this.defaultTtlMs);
    const key = buildCacheKey(canonicalUrl.href, validator);
    const entry: CacheEntry = {
      key,
      validator,
      storedAt: now,
      expiresAt: now + ttl,
      value,
    };

    bucket.entries.set(key, entry);
    bucket.failures.delete(canonicalUrl.href);

    let keys = bucket.byUrl.get(canonicalUrl.href);
    if (!keys) {
      keys = new Set();
      bucket.byUrl.set(canonicalUrl.href, keys);
    }
    keys.add(key);

    this.touch(bucket, key);
    this.enforceCapacity(bucket);
  }

  private obtainDomainBucket(domain: string): DomainBucket {
    let bucket = this.domains.get(domain);
    if (!bucket) {
      bucket = {
        entries: new Map(),
        order: [],
        byUrl: new Map(),
        failures: new Map(),
      };
      this.domains.set(domain, bucket);
    }
    return bucket;
  }

  private pruneExpired(bucket: DomainBucket): void {
    const now = this.now();
    while (bucket.order.length > 0) {
      const key = bucket.order[0];
      const entry = bucket.entries.get(key);
      if (!entry || entry.expiresAt > now) {
        break;
      }
      bucket.entries.delete(key);
      bucket.order.shift();
      for (const [url, keys] of bucket.byUrl) {
        if (keys.delete(key) && keys.size === 0) {
          bucket.byUrl.delete(url);
        }
      }
    }
  }

  private enforceCapacity(bucket: DomainBucket): void {
    while (bucket.order.length > this.maxEntriesPerDomain) {
      const oldestKey = bucket.order.shift();
      if (!oldestKey) {
        break;
      }
      bucket.entries.delete(oldestKey);
      for (const [url, keys] of bucket.byUrl) {
        if (keys.delete(oldestKey) && keys.size === 0) {
          bucket.byUrl.delete(url);
        }
      }
    }
  }

  private touch(bucket: DomainBucket, key: string): void {
    const index = bucket.order.indexOf(key);
    if (index !== -1) {
      bucket.order.splice(index, 1);
    }
    bucket.order.push(key);
  }

  private resolveDomainTtl(domain: string, fallback: number): number {
    return this.domainTtlOverrides[domain] ?? fallback;
  }
}

function normaliseUrl(input: string): { href: string; domain: string } {
  const url = new URL(input);
  return { href: url.toString(), domain: url.host.toLowerCase() };
}

function buildCacheKey(url: string, validator: string): string {
  return `${url}|${validator}`;
}

function extractValidator(headers: ReadonlyMap<string, string>): string {
  return headers.get("etag") ?? headers.get("last-modified") ?? "";
}

function normaliseValidator(validator: string | null | undefined): string {
  if (!validator) {
    return "";
  }
  return validator.trim();
}

function cloneRawFetched(fetched: RawFetched): RawFetched {
  return {
    ...fetched,
    headers: new Map(fetched.headers),
    body: Buffer.from(fetched.body),
  };
}
