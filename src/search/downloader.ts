import { createHash } from "node:crypto";
import { FetchConfig } from "./config.js";
import { SearchContentCache } from "./cache/contentCache.js";
import type { RawFetched } from "./types.js";

/** Maximum size (bytes) accepted for a robots.txt payload. */
const MAX_ROBOTS_TXT_BYTES = 64_000;
/** TTL (ms) applied to cached robots.txt evaluations. */
const ROBOTS_CACHE_TTL_MS = 10 * 60 * 1000;

/** Mapping from common extensions to MIME types used for sniffing. */
const EXTENSION_MIME_FALLBACK: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  json: "application/json",
  xml: "application/xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Generic error thrown by the downloader when the network operation fails or a
 * local constraint is violated.
 */
export class DownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DownloadError";
  }
}

/** Error raised when the HTTP status code indicates a failure. */
export class HttpStatusError extends DownloadError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

/** Error raised whenever the payload exceeds the configured byte limit. */
export class DownloadSizeExceededError extends DownloadError {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Payload exceeds maximum allowed size of ${maxBytes} bytes.`);
    this.name = "DownloadSizeExceededError";
    this.maxBytes = maxBytes;
  }
}

/** Error raised when robots.txt denies access to the requested URL. */
export class RobotsNotAllowedError extends DownloadError {
  readonly url: string;

  constructor(url: string) {
    super(`Access to ${url} denied by robots.txt policy.`);
    this.name = "RobotsNotAllowedError";
    this.url = url;
  }
}

/** Error raised when the operation is aborted due to timeout. */
export class DownloadTimeoutError extends DownloadError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Download timed out after ${timeoutMs} ms.`);
    this.name = "DownloadTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Error raised when a cached failure enforces a temporary backoff. */
export class DownloadBackoffError extends DownloadError {
  readonly url: string;
  readonly retryAt: number;
  readonly status: number;
  readonly attempts: number;

  constructor(url: string, status: number, retryAt: number, attempts: number) {
    super(`Backoff active for ${url} after ${status} responses until ${retryAt}.`);
    this.name = "DownloadBackoffError";
    this.url = url;
    this.retryAt = retryAt;
    this.status = status;
    this.attempts = attempts;
  }
}

/**
 * Internal representation of a compiled robots.txt rule used for matching
 * request paths.
 */
interface RobotsPattern {
  readonly raw: string;
  readonly regex: RegExp;
}

/** Collection of allow/disallow rules for a given user agent. */
interface RobotsRuleset {
  readonly allows: readonly RobotsPattern[];
  readonly disallows: readonly RobotsPattern[];
}

/** Cached robots evaluation for a specific origin. */
interface RobotsCacheEntry {
  readonly expiresAt: number;
  readonly rules: RobotsRuleset | null;
}

/**
 * Lightweight robots.txt evaluator focusing on the subset required by the
 * crawler. Only `User-agent`, `Allow` and `Disallow` directives are parsed, with
 * wildcard support mirroring the standard behaviour of mainstream crawlers.
 */
class RobotsEvaluator {
  private readonly cache = new Map<string, RobotsCacheEntry>();
  private readonly userAgentLower: string;

  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly userAgent: string,
    private readonly timeoutMs: number,
    private readonly now: () => number,
  ) {
    this.userAgentLower = userAgent.toLowerCase();
  }

  /** Ensures the provided URL is allowed to be fetched. */
  async assertAllowed(target: URL): Promise<void> {
    const origin = target.origin;
    const cached = this.cache.get(origin);
    const currentTime = this.now();

    if (cached && cached.expiresAt > currentTime) {
      if (!this.isAllowed(cached.rules, target)) {
        throw new RobotsNotAllowedError(target.href);
      }
      return;
    }

    const rules = await this.fetchRules(target);
    this.cache.set(origin, {
      expiresAt: currentTime + ROBOTS_CACHE_TTL_MS,
      rules,
    });

    if (!this.isAllowed(rules, target)) {
      throw new RobotsNotAllowedError(target.href);
    }
  }

  private isAllowed(rules: RobotsRuleset | null, target: URL): boolean {
    if (!rules) {
      // No directives → allow by default.
      return true;
    }

    const path = `${target.pathname}${target.search}`;
    const decision = this.resolveDecision(path, rules);
    return decision !== "disallow";
  }

  private resolveDecision(path: string, rules: RobotsRuleset): "allow" | "disallow" | null {
    let best: { type: "allow" | "disallow"; length: number } | null = null;

    for (const pattern of rules.disallows) {
      if (pattern.regex.test(path)) {
        const length = pattern.raw.length;
        if (!best || length > best.length || (length === best.length && best.type === "allow")) {
          best = { type: "disallow", length };
        }
      }
    }

    for (const pattern of rules.allows) {
      if (pattern.regex.test(path)) {
        const length = pattern.raw.length;
        if (!best || length > best.length) {
          best = { type: "allow", length };
        }
      }
    }

    return best?.type ?? null;
  }

  private async fetchRules(target: URL): Promise<RobotsRuleset | null> {
    const robotsUrl = new URL("/robots.txt", target.origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(robotsUrl, {
        headers: {
          "user-agent": this.userAgent,
          accept: "text/plain, text/*;q=0.8, */*;q=0.1",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        // Unavailable robots.txt → default allow.
        return null;
      }

      const text = await response.text();
      const truncated = text.length > MAX_ROBOTS_TXT_BYTES ? text.slice(0, MAX_ROBOTS_TXT_BYTES) : text;
      return this.parseRobots(truncated);
    } catch (error) {
      if (controller.signal.aborted) {
        // Timeouts or aborted requests → default allow to avoid false negatives.
        return null;
      }
      // Network error → default allow while logging at higher layers.
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Clears the cached robots.txt directives so future runs refetch policies. */
  clear(): void {
    this.cache.clear();
  }

  private parseRobots(content: string): RobotsRuleset | null {
    const lines = content.split(/\r?\n/);
    let activeAgents: string[] = [];
    let lastDirective: "user-agent" | "rule" | null = null;
    const rulesByAgent = new Map<string, { allows: string[]; disallows: string[] }>();

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        continue;
      }

      const directive = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();

      if (directive === "user-agent") {
        const agent = value.toLowerCase();
        if (!rulesByAgent.has(agent)) {
          rulesByAgent.set(agent, { allows: [], disallows: [] });
        }
        if (lastDirective === "user-agent") {
          if (!activeAgents.includes(agent)) {
            activeAgents = [...activeAgents, agent];
          }
        } else {
          activeAgents = [agent];
        }
        lastDirective = "user-agent";
        continue;
      }

      if (directive === "allow" || directive === "disallow") {
        if (value.length === 0) {
          lastDirective = "rule";
          continue;
        }
        if (activeAgents.length === 0) {
          // The directive applies to all agents implicitly.
          activeAgents = ["*"];
          if (!rulesByAgent.has("*")) {
            rulesByAgent.set("*", { allows: [], disallows: [] });
          }
        }
        for (const agent of activeAgents) {
          const bucket = rulesByAgent.get(agent);
          if (!bucket) {
            continue;
          }
          if (directive === "allow") {
            bucket.allows.push(value);
          } else {
            bucket.disallows.push(value);
          }
        }
        lastDirective = "rule";
      }
    }

    const agentKey = this.selectAgentKey(rulesByAgent);
    if (!agentKey) {
      return null;
    }

    const bucket = rulesByAgent.get(agentKey);
    if (!bucket) {
      return null;
    }

    return {
      allows: bucket.allows.map((pattern) => this.compilePattern(pattern)),
      disallows: bucket.disallows.map((pattern) => this.compilePattern(pattern)),
    };
  }

  private selectAgentKey(map: Map<string, { allows: string[]; disallows: string[] }>): string | null {
    if (map.has(this.userAgentLower)) {
      return this.userAgentLower;
    }
    if (map.has("*")) {
      return "*";
    }
    return null;
  }

  private compilePattern(pattern: string): RobotsPattern {
    const hasEndAnchor = pattern.endsWith("$");
    const body = hasEndAnchor ? pattern.slice(0, -1) : pattern;
    const escaped = body.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
    const wildcardExpanded = escaped.replace(/\*/g, ".*");
    const regex = new RegExp(`^${wildcardExpanded}${hasEndAnchor ? "$" : ""}`);
    return { raw: pattern, regex };
  }
}

/**
 * Transforms the Headers object returned by fetch into a lower-cased map so
 * lookups remain case-insensitive within the rest of the pipeline.
 */
function normaliseHeaders(headers: Headers): Map<string, string> {
  const normalised = new Map<string, string>();
  for (const [key, value] of headers.entries()) {
    normalised.set(key.toLowerCase(), value);
  }
  return normalised;
}

/**
 * Merges header updates received during a conditional request into the cached
 * snapshot while preserving the original map immutability expected by callers.
 */
function mergeHeaders(
  base: ReadonlyMap<string, string>,
  updates: ReadonlyMap<string, string>,
): Map<string, string> {
  const merged = new Map<string, string>();
  for (const [key, value] of base.entries()) {
    merged.set(key, value);
  }
  for (const [key, value] of updates.entries()) {
    merged.set(key, value);
  }
  return merged;
}

/** Removes charset parameters from a Content-Type header. */
function sanitiseContentType(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const [type] = raw.split(";");
  const trimmed = type.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Attempts to guess the MIME type when the server omits the Content-Type
 * header, falling back to the file extension present in the URL.
 */
function guessContentTypeFromUrl(url: string): string | null {
  const pathname = new URL(url).pathname;
  const lastDot = pathname.lastIndexOf(".");
  if (lastDot === -1 || lastDot === pathname.length - 1) {
    return null;
  }
  const ext = pathname.slice(lastDot + 1).toLowerCase();
  return EXTENSION_MIME_FALLBACK[ext] ?? null;
}

/**
 * Attempts to detect the MIME type using well known file signatures.  The
 * method intentionally keeps the heuristics small to avoid false positives
 * while still recognising the binary formats we regularly ingest.
 */
function sniffContentType(buffer: Buffer): string | null {
  if (buffer.length === 0) {
    return null;
  }

  if (buffer.slice(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }

  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }

  if (buffer.length >= 3 && buffer.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }

  if (buffer.length >= 4 && buffer.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return "application/zip";
  }

  return null;
}

/** Content-Types considered too generic to trust without signature confirmation. */
const GENERIC_CONTENT_TYPES = new Set([
  "text/plain",
  "text/html",
  "text/xml",
  "application/octet-stream",
  "binary/octet-stream",
  "application/json",
]);

/**
 * Chooses the most reliable content type by preferring the server declaration
 * unless it is missing or clearly contradicts the sniffed payload signature.
 */
function resolveContentType(
  declared: string | null,
  sniffed: string | null,
  guessed: string | null,
): string | null {
  if (!declared) {
    return sniffed ?? guessed ?? null;
  }

  if (sniffed && isDeclaredIncoherent(declared, sniffed)) {
    return sniffed;
  }

  return declared ?? sniffed ?? guessed ?? null;
}

/**
 * Flags declared MIME values that conflict with the detected payload signature.
 * The heuristics stay conservative to avoid overriding precise declarations.
 */
function isDeclaredIncoherent(declared: string, sniffed: string): boolean {
  if (declared === sniffed) {
    return false;
  }

  if (GENERIC_CONTENT_TYPES.has(declared)) {
    return true;
  }

  if (declared.startsWith("text/") && !sniffed.startsWith("text/")) {
    return true;
  }

  return false;
}

/** Reads the response body while enforcing the maximum size constraint. */
async function readClampedBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    return Buffer.alloc(0);
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      controller.abort();
      throw new DownloadSizeExceededError(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

/**
 * Computes a deterministic identifier for the downloaded document using the
 * canonical URL combined with HTTP validators.
 */
export function computeDocId(
  url: string,
  headers: ReadonlyMap<string, string>,
  bodySample?: Buffer | null,
): string {
  const etag = headers.get("etag") ?? "";
  const lastModified = headers.get("last-modified") ?? "";
  const hash = createHash("sha256");
  hash.update(url);
  hash.update("|");

  if (etag || lastModified) {
    hash.update(etag);
    hash.update("|");
    hash.update(lastModified);
  } else {
    const sample = bodySample && bodySample.length > 0 ? bodySample.slice(0, 1024) : Buffer.alloc(0);
    hash.update(sample);
  }

  return hash.digest("hex");
}

/**
 * Deterministic checksum of the payload, used for deduplicating the raw binary
 * data before structured extraction occurs.
 */
function computePayloadChecksum(buffer: Buffer): string {
  const hash = createHash("sha256");
  hash.update(buffer);
  return hash.digest("hex");
}

/** Optional dependencies injected into the downloader for testing. */
export interface DownloaderDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly contentCache?: SearchContentCache | null;
}

/**
 * Responsible for fetching raw documents from the web while enforcing the
 * platform constraints (timeouts, size limits, robots.txt compliance).
 */
export class SearchDownloader {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly robots: RobotsEvaluator | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly domainLocks = new Map<string, Promise<void>>();
  private readonly domainAvailableAt = new Map<string, number>();
  private readonly contentCache: SearchContentCache | null;

  constructor(private readonly config: FetchConfig, deps: DownloaderDependencies = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.robots = config.respectRobotsTxt
      ? new RobotsEvaluator(this.fetchImpl, config.userAgent, config.timeoutMs, this.now)
      : null;
    this.contentCache =
      deps.contentCache ??
      (config.cache
        ? new SearchContentCache({
            maxEntriesPerDomain: config.cache.maxEntriesPerDomain,
            defaultTtlMs: config.cache.defaultTtlMs,
            clientErrorTtlMs: config.cache.clientErrorTtlMs,
            serverErrorTtlMs: config.cache.serverErrorTtlMs,
            domainTtlOverrides: config.cache.domainTtlOverrides,
            now: this.now,
          })
        : null);
  }

  /** Downloads the target URL and returns the raw payload alongside metadata. */
  async fetchUrl(url: string): Promise<RawFetched> {
    const parsed = new URL(url);
    const canonicalUrl = parsed.toString();

    const cached = this.contentCache?.get(canonicalUrl);
    if (cached) {
      return cached;
    }

    const validatorMetadata = this.contentCache?.getValidatorMetadata(canonicalUrl);
    const failure = this.contentCache?.getFailure(canonicalUrl);
    if (failure) {
      throw new DownloadBackoffError(canonicalUrl, failure.status, failure.retryAt, failure.attempts);
    }

    if (this.robots) {
      await this.robots.assertAllowed(parsed);
    }

    await this.enforceDomainDelay(parsed);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.timeoutMs);

    const requestHeaders = new Headers({
      "user-agent": this.config.userAgent,
      accept: "*/*",
    });
    if (validatorMetadata?.etag) {
      requestHeaders.set("If-None-Match", validatorMetadata.etag);
    }
    if (validatorMetadata?.lastModified) {
      requestHeaders.set("If-Modified-Since", validatorMetadata.lastModified);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(parsed.href, {
        headers: requestHeaders,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new DownloadTimeoutError(this.config.timeoutMs);
      }
      if (error instanceof DownloadError) {
        throw error;
      }
      throw new DownloadError(`Failed to download ${url}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }

    clearTimeout(timeout);

    if (response.status === 304) {
      if (!validatorMetadata) {
        throw new DownloadError(`Received HTTP 304 for ${url} without cached validators.`);
      }
      const cachedRevalidated = this.contentCache?.get(canonicalUrl, validatorMetadata.validator);
      if (!cachedRevalidated) {
        throw new DownloadError(`Received HTTP 304 for ${url} but no cached payload was found.`);
      }

      const responseHeaders = normaliseHeaders(response.headers);
      const mergedHeaders = mergeHeaders(cachedRevalidated.headers, responseHeaders);
      const refreshedAt = this.now();
      const finalUrl = response.url || parsed.href;

      const refreshed: RawFetched = {
        ...cachedRevalidated,
        finalUrl,
        fetchedAt: refreshedAt,
        headers: mergedHeaders,
        notModified: false,
      };

      this.contentCache?.store(refreshed);
      this.contentCache?.clearFailure(canonicalUrl);
      if (finalUrl !== canonicalUrl) {
        this.contentCache?.clearFailure(finalUrl);
      }

      return {
        ...refreshed,
        status: response.status,
        notModified: true,
      };
    }

    if (response.status >= 400) {
      this.contentCache?.recordFailure(canonicalUrl, response.status);
      const failureUrl = response.url || canonicalUrl;
      if (failureUrl !== canonicalUrl) {
        this.contentCache?.recordFailure(failureUrl, response.status);
      }
      throw new HttpStatusError(response.status, `Received status ${response.status} when fetching ${url}`);
    }

    const headers = normaliseHeaders(response.headers);
    const body = await readClampedBody(response, this.config.maxBytes, controller);
    const finalUrl = response.url || parsed.href;
    const fetchedAt = this.now();
    const declaredContentType = sanitiseContentType(headers.get("content-type") ?? null);
    const sniffedContentType = sniffContentType(body);
    const guessedContentType = guessContentTypeFromUrl(finalUrl);
    const contentType = resolveContentType(declaredContentType, sniffedContentType, guessedContentType);
    const checksum = computePayloadChecksum(body);

    const result: RawFetched = {
      requestedUrl: url,
      finalUrl,
      status: response.status,
      fetchedAt,
      notModified: false,
      headers,
      contentType,
      size: body.byteLength,
      checksum,
      body,
    };

    this.contentCache?.store(result);
    this.contentCache?.clearFailure(canonicalUrl);
    if (finalUrl !== canonicalUrl) {
      this.contentCache?.clearFailure(finalUrl);
    }

    return result;
  }

  /**
   * Releases cached content, throttling metadata and robots decisions. Invoked
   * when the orchestrator shuts down so subsequent validation runs start with a
   * clean slate and reclaim memory held by large downloads.
   */
  dispose(): void {
    this.domainLocks.clear();
    this.domainAvailableAt.clear();
    this.contentCache?.clear();
    this.robots?.clear();
  }

  /** Ensures sequential requests to the same domain respect the configured delay. */
  private async enforceDomainDelay(target: URL): Promise<void> {
    if (this.config.minDomainDelayMs <= 0) {
      return;
    }

    const hostKey = target.host.toLowerCase();
    const previous = this.domainLocks.get(hostKey) ?? Promise.resolve();

    // lockPromise handles the waiting logic before we expose the cancellable wrapper.
    const lockPromise = previous
      .catch(() => undefined)
      .then(async () => {
        const now = this.now();
        const availableAt = this.domainAvailableAt.get(hostKey) ?? now;
        const waitMs = availableAt > now ? availableAt - now : 0;
        if (waitMs > 0) {
          await this.sleep(waitMs);
        }
        const base = Math.max(availableAt, this.now());
        this.domainAvailableAt.set(hostKey, base + this.config.minDomainDelayMs);
      });

    // finalPromise is what we store, so cleanup only happens for the currently active lock.
    const finalPromise = lockPromise.finally(() => {
      if (this.domainLocks.get(hostKey) === finalPromise) {
        this.domainLocks.delete(hostKey);
      }
    });

    this.domainLocks.set(hostKey, finalPromise);
    await finalPromise;
  }
}
