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
  .object({
    url: z.string().url(),
    title: z.string().optional().nullable(),
    content: z.string().optional().nullable(),
    snippet: z.string().optional().nullable(),
    engines: z.array(z.string()).optional(),
    engine: z.string().optional(),
    categories: z.array(z.string()).optional(),
    score: z.number().optional(),
    result_type: z.string().optional(),
    thumbnail: z.string().optional().nullable(),
    img_src: z.string().optional().nullable(),
    mimetype: z.string().optional().nullable(),
  })
  .passthrough();

/** Envelope returned by SearxNG when requesting the JSON format. */
const searxResponseSchema = z.object({
  query: z.string().optional().default(""),
  number_of_results: z.number().optional(),
  results: z.array(searxResultSchema),
});

/** Helper discriminating whether an error should trigger a retry. */
function isRetriableStatus(status: number): boolean {
  return status >= 500 && status < 600;
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

    const categories = options.categories && options.categories.length > 0 ? options.categories : this.config.categories;
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
        return { query: payload.query ?? query, results, raw: payload };
      } catch (error) {
        const asClientError = error instanceof SearxClientError ? error : null;
        lastError = error;
        const status = asClientError?.status;
        const retriable = asClientError ? asClientError.code !== ERROR_SEARX_SCHEMA && isRetriableStatus(status ?? 0) : false;
        if (!retriable || attempt >= maxAttempts) {
          throw error;
        }
        // Small exponential backoff to avoid hammering the instance on flaky responses.
        await delay(50 * attempt);
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
  readonly raw: z.infer<typeof searxResultSchema>;
  readonly position: number;
  readonly engines: readonly string[];
  readonly categories: readonly string[];
  readonly query: string;
}

function normaliseResult(context: NormaliseContext): SearxResult {
  const { raw, position, engines, categories, query } = context;
  const selectedEngines = Array.isArray(raw.engines) && raw.engines.length > 0 ? raw.engines : raw.engine ? [raw.engine] : engines;
  const selectedCategories = Array.isArray(raw.categories) && raw.categories.length > 0 ? raw.categories : categories;
  const thumbnail = raw.thumbnail ?? raw.img_src ?? null;
  const mimeType = raw.mimetype ?? null;
  const snippet = raw.snippet ?? raw.content ?? null;
  const score = Number.isFinite(raw.score) ? Number(raw.score) : null;

  const identifier = createHash("sha256")
    .update(raw.url)
    .update("|")
    .update(mimeType ?? "")
    .update("|")
    .update(query)
    .digest("hex");

  return {
    id: identifier,
    url: raw.url,
    title: raw.title ?? null,
    snippet,
    engines: Object.freeze(selectedEngines.map((engine) => engine.trim()).filter((engine) => engine.length > 0)),
    categories: Object.freeze(selectedCategories.map((category) => category.trim()).filter((category) => category.length > 0)),
    position,
    thumbnailUrl: thumbnail ?? null,
    mimeType,
    score,
  };
}
