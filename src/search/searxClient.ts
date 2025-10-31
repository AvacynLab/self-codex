import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import type { SearchConfig } from "./config.js";
import type { SearxResult } from "./types.js";

/** Error code emitted when SearxNG responds with a non-success status. */
const ERROR_SEARX_HTTP = "E-SEARCH-SEARX-HTTP" as const;
/** Error code emitted when the JSON payload returned by SearxNG is invalid. */
const ERROR_SEARX_SCHEMA = "E-SEARCH-SEARX-SCHEMA" as const;
/** Error code emitted when the request fails due to network errors/timeouts. */
const ERROR_SEARX_NETWORK = "E-SEARCH-SEARX-NETWORK" as const;

/** Raw structure returned by SearxNG for a single result entry. */
const searxResultSchema = z
  .strictObject({
    url: z.string().url(),
    title: z.string().optional().nullable(),
    snippet: z.string().optional().nullable(),
    content: z.string().optional().nullable(),
    engines: z.array(z.string()).optional(),
    engine: z.string().optional(),
    categories: z.array(z.string()).optional(),
    score: z.number().optional(),
    thumbnail: z.string().optional().nullable(),
    img_src: z.string().optional().nullable(),
    mimetype: z.string().optional().nullable(),
    published: z.union([z.string(), z.number(), z.date()]).optional().nullable(),
  })
  .transform((payload) => ({
    url: payload.url,
    title: payload.title ?? null,
    snippet: payload.snippet ?? payload.content ?? null,
    engines: payload.engines ?? (payload.engine ? [payload.engine] : []),
    categories: payload.categories ?? [],
    score: payload.score,
    thumbnail: payload.thumbnail ?? payload.img_src ?? null,
    mimetype: payload.mimetype ?? null,
    published: payload.published ?? null,
  }));

/** Envelope returned by SearxNG when requesting the JSON format. */
const searxResponseSchema = z
  .object({
    query: z.string().optional(),
    number_of_results: z.number().optional(),
    // Allow SearxNG responses that omit the results array (some engines fail and drop it).
    results: z.array(z.record(z.unknown())).default([]),
  })
  // SearxNG may include auxiliary fields such as answers/infoboxes; keep them without validation noise.
  .passthrough()
  .transform((payload) => ({
    query: payload.query ?? "",
    results: payload.results ?? [],
  }));

/** Helper discriminating whether an error should trigger a retry. */
function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Error thrown when the client cannot obtain a valid response from SearxNG. */
export class SearxClientError extends Error {
  public readonly code: typeof ERROR_SEARX_HTTP | typeof ERROR_SEARX_SCHEMA | typeof ERROR_SEARX_NETWORK;
  public readonly status: number | null;

  constructor(
    message: string,
    options: {
      code: typeof ERROR_SEARX_HTTP | typeof ERROR_SEARX_SCHEMA | typeof ERROR_SEARX_NETWORK;
      status?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "SearxClientError";
    this.code = options.code;
    this.status = options.status ?? null;
  }
}

/** Options accepted by {@link SearxClient.search}. */
export interface SearxQueryOptions {
  readonly categories?: readonly string[];
  readonly engines?: readonly string[];
  readonly count?: number;
  readonly language?: string;
  readonly safeSearch?: 0 | 1 | 2;
}

/** Response envelope produced by {@link SearxClient.search}. */
export interface SearxQueryResponse {
  readonly query: string;
  readonly results: readonly SearxResult[];
  readonly raw: z.infer<typeof searxResponseSchema>;
}

/**
 * Client responsible for querying SearxNG. The implementation focuses on
 * deterministic behaviour (timeouts, retries, schema validation) so the rest of
 * the pipeline can rely on predictable failures.
 */
export class SearxClient {
  private readonly config: SearchConfig["searx"];
  private readonly fetchImpl: typeof fetch;

  constructor(config: SearchConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config.searx;
    this.fetchImpl = fetchImpl;
  }

  /** Executes the provided {@link query} against SearxNG. */
  async search(query: string, options: SearxQueryOptions = {}): Promise<SearxQueryResponse> {
    if (query.trim().length === 0) {
      throw new SearxClientError("Search queries must be non-empty", {
        code: ERROR_SEARX_SCHEMA,
        status: null,
      });
    }

    const categories =
      options.categories && options.categories.length > 0 ? options.categories : this.config.categories;
    const engines = options.engines && options.engines.length > 0 ? options.engines : this.config.engines;
    const url = new URL(this.config.apiPath, this.config.baseUrl);

    const params = new URLSearchParams({
      q: query,
      format: "json",
      categories: categories.join(","),
      engines: engines.join(","),
    });

    if (options.count && options.count > 0) {
      params.set("count", String(Math.min(options.count, 20)));
    }
    if (options.language && options.language.trim().length > 0) {
      params.set("language", options.language.trim());
    }
    if (options.safeSearch !== undefined) {
      params.set("safesearch", String(options.safeSearch));
    }

    url.search = params.toString();

    const headers = new Headers({
      Accept: "application/json",
    });
    if (this.config.authToken) {
      headers.set("Authorization", `Bearer ${this.config.authToken}`);
    }

    const maxAttempts = Math.max(1, this.config.maxRetries + 1);
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const response = await this.performRequest(url, headers);
        const payload = await this.parseResponse(response);
        const results = payload.results.map((raw, index) =>
          normaliseResult({
            raw,
            position: index,
            engines,
            categories,
            query,
          }),
        );
        return { query: payload.query || query, results, raw: payload };
      } catch (error) {
        const asClientError = error instanceof SearxClientError ? error : null;
        lastError = error;
        const status = asClientError?.status;
        const retriable = asClientError ? asClientError.code !== ERROR_SEARX_SCHEMA && isRetriableStatus(status ?? 0) : false;
        if (!retriable || attempt >= maxAttempts) {
          throw error;
        }
        // Small exponential backoff with jitter to avoid hammering the instance on flaky responses.
        const backoffMs = 150 * attempt + Math.floor(Math.random() * 100);
        await delay(backoffMs);
      }
    }

    throw new SearxClientError("Failed to query SearxNG after retries", {
      code: ERROR_SEARX_NETWORK,
      status: null,
      cause: lastError,
    });
  }

  private async performRequest(url: URL, headers: Headers): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SearxClientError(`SearxNG responded with HTTP ${response.status}`, {
          code: ERROR_SEARX_HTTP,
          status: response.status,
        });
      }
      return response;
    } catch (error) {
      if (error instanceof SearxClientError) {
        throw error;
      }
      if ((error as { name?: string }).name === "AbortError") {
        throw new SearxClientError("SearxNG query timed out", {
          code: ERROR_SEARX_NETWORK,
          status: null,
          cause: error,
        });
      }
      throw new SearxClientError("Failed to execute request against SearxNG", {
        code: ERROR_SEARX_NETWORK,
        status: null,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async parseResponse(response: Response): Promise<z.infer<typeof searxResponseSchema>> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new SearxClientError("SearxNG returned a non-JSON payload", {
        code: ERROR_SEARX_HTTP,
        status: response.status,
      });
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new SearxClientError("Unable to parse SearxNG JSON payload", {
        code: ERROR_SEARX_SCHEMA,
        status: response.status,
        cause: error,
      });
    }

    try {
      return searxResponseSchema.parse(parsed);
    } catch (error) {
      throw new SearxClientError("SearxNG payload did not match the expected schema", {
        code: ERROR_SEARX_SCHEMA,
        status: response.status,
        cause: error,
      });
    }
  }
}

interface NormaliseContext {
  readonly raw: Record<string, unknown>;
  readonly position: number;
  readonly engines: readonly string[];
  readonly categories: readonly string[];
  readonly query: string;
}

function normaliseResult(context: NormaliseContext): SearxResult {
  const { raw, position, engines, categories, query } = context;
  const parsed = searxResultSchema.parse({
    url: typeof raw["url"] === "string" ? (raw["url"] as string) : "",
    title:
      typeof raw["title"] === "string" || raw["title"] === null ? (raw["title"] as string | null | undefined) : undefined,
    snippet:
      typeof raw["snippet"] === "string" || raw["snippet"] === null
        ? (raw["snippet"] as string | null | undefined)
        : undefined,
    content: typeof raw["content"] === "string" ? (raw["content"] as string) : undefined,
    engines: Array.isArray(raw["engines"]) ? (raw["engines"] as string[]) : undefined,
    engine: typeof raw["engine"] === "string" ? (raw["engine"] as string) : undefined,
    categories: Array.isArray(raw["categories"]) ? (raw["categories"] as string[]) : undefined,
    score: typeof raw["score"] === "number" ? (raw["score"] as number) : undefined,
    thumbnail: typeof raw["thumbnail"] === "string" ? (raw["thumbnail"] as string) : undefined,
    img_src: typeof raw["img_src"] === "string" ? (raw["img_src"] as string) : undefined,
    mimetype: typeof raw["mimetype"] === "string" ? (raw["mimetype"] as string) : undefined,
    published: extractPublished(raw),
  });

  const canonicalUrl = canonicalizeUrl(parsed.url);
  const identifier = createHash("sha256")
    .update(canonicalUrl)
    .update("|")
    .update(parsed.mimetype ?? "")
    .update("|")
    .update(query)
    .digest("hex");

  const selectedEngines = parsed.engines.length > 0 ? parsed.engines : engines;
  const selectedCategories = parsed.categories.length > 0 ? parsed.categories : categories;

  return {
    id: identifier,
    url: canonicalUrl,
    title: parsed.title,
    snippet: parsed.snippet ?? null,
    engines: Object.freeze(sanitiseList(selectedEngines)),
    categories: Object.freeze(sanitiseList(selectedCategories)),
    position,
    thumbnailUrl: parsed.thumbnail,
    mime: parsed.mimetype ?? null,
    publishedAt: normalisePublished(parsed.published),
    score: typeof parsed.score === "number" ? parsed.score : null,
  };
}

/**
 * Produces a deterministic list by trimming values and dropping duplicates while
 * preserving the first occurrence order. This avoids leaking empty strings to
 * downstream consumers and keeps analytics consistent across runs.
 */
function sanitiseList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

/**
 * Canonicalises a result URL by removing fragments, dropping noisy tracking
 * parameters and sorting the remaining query parameters. This keeps deduplication
 * stable across runs and engines.
 */
function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    const params = new URLSearchParams(url.search);
    const blockedPrefixes = [/^utm_/i, /^ref$/i, /^fbclid$/i, /^gclid$/i, /^mc_cid$/i, /^mc_eid$/i];
    for (const key of [...params.keys()]) {
      if (blockedPrefixes.some((pattern) => pattern.test(key))) {
        params.delete(key);
      }
    }
    const sortedParams = [...params.entries()].sort(([aKey, aValue], [bKey, bValue]) => {
      if (aKey === bKey) {
        return aValue.localeCompare(bValue);
      }
      return aKey.localeCompare(bKey);
    });
    url.search = sortedParams.length > 0 ? new URLSearchParams(sortedParams).toString() : "";
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Collects the most relevant publication candidate exposed by Searx. Engines
 * use different key names, therefore we check the most common variants while
 * preserving the original value for later normalisation.
 */
function extractPublished(raw: Record<string, unknown>): unknown {
  const candidates = [
    raw["published"],
    raw["publishedDate"],
    raw["published_date"],
    raw["pubdate"],
    raw["date"],
    raw["updated"],
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) {
      return candidate;
    }
  }
  return null;
}

/**
 * Converts the provided publication hint into an ISO-8601 string. Numeric
 * values are interpreted as seconds unless they look like a millisecond epoch.
 */
function normalisePublished(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value * (value < 10_000_000_000 ? 1000 : 1));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}
