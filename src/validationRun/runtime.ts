import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { setTimeout as scheduleTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";

import {
  computeValidationRunEnv,
  ensureValidationRunLayout,
  type ValidationRunLayout,
} from "./layout";

/**
 * Shape of the runtime preparation result containing the resolved layout, the
 * recommended MCP environment variables and the optional children workspace
 * directory.
 */
export interface ValidationRuntimeContext {
  /** Canonical validation layout ensured on disk. */
  readonly layout: ValidationRunLayout;
  /** Recommended MCP environment variables computed from the layout. */
  readonly env: Record<string, string>;
  /** Optional absolute path to the `children/` directory when requested. */
  readonly childrenDir?: string;
}

/** Options accepted by {@link ensureValidationRuntime}. */
export interface EnsureValidationRuntimeOptions {
  /**
   * Optional root directory for the validation run structure. Defaults to the
   * repository-level `validation_run/`.
   */
  readonly root?: string;
  /**
   * Whether to ensure the existence of the `children/` directory used by the
   * MCP during HTTP sessions.
   */
  readonly createChildrenDir?: boolean;
  /**
   * Custom path for the `children/` directory. When omitted the function will
   * resolve a `children` folder next to the chosen validation root.
   */
  readonly childrenDir?: string;
}

/**
 * Ensures both the validation layout and optional runtime directories exist.
 *
 * The helper is intentionally idempotent so that operators can re-run it before
 * each scenario without losing artefacts. It reuses the same root directory as
 * {@link ensureValidationRunLayout} to align with the checklist expectations.
 */
export async function ensureValidationRuntime(
  options: EnsureValidationRuntimeOptions = {},
): Promise<ValidationRuntimeContext> {
  const layout = await ensureValidationRunLayout(options.root);
  const env = computeValidationRunEnv(layout);
  let childrenDir: string | undefined;

  if (options.createChildrenDir) {
    const resolvedChildrenDir = path.resolve(
      options.childrenDir ?? path.join(layout.root, "..", "children"),
    );
    await ensureDir(resolvedChildrenDir);
    childrenDir = resolvedChildrenDir;
  }

  if (childrenDir) {
    return { layout, env, childrenDir };
  }
  return { layout, env };
}

/**
 * Result of the search/unstructured environment validation routine.
 */
export interface SearchEnvValidationResult {
  /** Keys completely missing from the process environment. */
  readonly missingKeys: string[];
  /** Keys present but containing empty strings. */
  readonly emptyKeys: string[];
  /** Numeric keys with non-positive or NaN values. */
  readonly invalidNumericKeys: Array<{ key: string; value: string }>;
  /** Boolean-like keys that were expected to be `true`. */
  readonly expectedTrueKeys: Array<{ key: string; value: string }>;
  /** Optional warnings for recommended production settings. */
  readonly recommendations: Array<{ key: string; expected: string; actual?: string }>;
  /** Whether all mandatory checks succeeded. */
  readonly ok: boolean;
}

/** Descriptor of an environment variable requirement. */
interface EnvRequirement {
  readonly key: string;
  readonly type: "string" | "number" | "booleanTrue" | "url" | "path";
  readonly optional?: boolean;
  readonly recommendation?: string;
}

const REQUIRED_ENV: readonly EnvRequirement[] = [
  { key: "SEARCH_SEARX_BASE_URL", type: "url" },
  { key: "SEARCH_SEARX_API_PATH", type: "path" },
  { key: "SEARCH_SEARX_TIMEOUT_MS", type: "number" },
  { key: "SEARCH_SEARX_ENGINES", type: "string" },
  { key: "SEARCH_SEARX_CATEGORIES", type: "string" },
  { key: "UNSTRUCTURED_BASE_URL", type: "url" },
  { key: "UNSTRUCTURED_TIMEOUT_MS", type: "number" },
  { key: "UNSTRUCTURED_STRATEGY", type: "string" },
  { key: "SEARCH_FETCH_TIMEOUT_MS", type: "number" },
  { key: "SEARCH_FETCH_MAX_BYTES", type: "number" },
  { key: "SEARCH_FETCH_UA", type: "string" },
  { key: "SEARCH_INJECT_GRAPH", type: "booleanTrue" },
  { key: "SEARCH_INJECT_VECTOR", type: "booleanTrue" },
];

const RECOMMENDED_ENV: readonly EnvRequirement[] = [
  { key: "SEARCH_FETCH_RESPECT_ROBOTS", type: "booleanTrue", optional: true, recommendation: "1" },
  { key: "SEARCH_PARALLEL_FETCH", type: "number", optional: true, recommendation: "4" },
  { key: "SEARCH_PARALLEL_EXTRACT", type: "number", optional: true, recommendation: "2" },
  { key: "SEARCH_MAX_RESULTS", type: "number", optional: true, recommendation: "12" },
];

/**
 * Validates the Search/Unstructured environment variables required by the
 * validation scenarios. The function focuses on structural correctness instead
 * of strict equality so it remains compatible with deployments that tweak the
 * values (e.g. custom engines or timeouts).
 */
export function validateSearchEnvironment(env: NodeJS.ProcessEnv): SearchEnvValidationResult {
  const missingKeys: string[] = [];
  const emptyKeys: string[] = [];
  const invalidNumericKeys: Array<{ key: string; value: string }> = [];
  const expectedTrueKeys: Array<{ key: string; value: string }> = [];
  const recommendations: Array<{ key: string; expected: string; actual?: string }> = [];

  for (const requirement of REQUIRED_ENV) {
    const value = env[requirement.key];
    if (value === undefined) {
      missingKeys.push(requirement.key);
      continue;
    }

    if (value.trim() === "") {
      emptyKeys.push(requirement.key);
      continue;
    }

    switch (requirement.type) {
      case "number": {
        if (!isFiniteNumber(value)) {
          invalidNumericKeys.push({ key: requirement.key, value });
        }
        break;
      }
      case "booleanTrue": {
        if (!isTruthy(value)) {
          expectedTrueKeys.push({ key: requirement.key, value });
        }
        break;
      }
      case "url": {
        if (!isValidUrl(value)) {
          emptyKeys.push(requirement.key);
        }
        break;
      }
      case "path": {
        if (!value.startsWith("/")) {
          emptyKeys.push(requirement.key);
        }
        break;
      }
      default:
        break;
    }
  }

  for (const recommendation of RECOMMENDED_ENV) {
    const value = env[recommendation.key];
    if (value === undefined || value.trim() === "") {
      recommendations.push({ key: recommendation.key, expected: recommendation.recommendation ?? "(set)" });
      continue;
    }

    if (recommendation.type === "booleanTrue" && !isTruthy(value)) {
      recommendations.push({ key: recommendation.key, expected: recommendation.recommendation ?? "true", actual: value });
      continue;
    }

    if (recommendation.type === "number" && !isFiniteNumber(value)) {
      recommendations.push({ key: recommendation.key, expected: "numeric", actual: value });
      continue;
    }

    if (recommendation.recommendation && value !== recommendation.recommendation) {
      recommendations.push({ key: recommendation.key, expected: recommendation.recommendation, actual: value });
    }
  }

  const ok =
    missingKeys.length === 0 &&
    emptyKeys.length === 0 &&
    invalidNumericKeys.length === 0 &&
    expectedTrueKeys.length === 0;

  return { missingKeys, emptyKeys, invalidNumericKeys, expectedTrueKeys, recommendations, ok };
}

/**
 * Result returned by {@link verifyHttpHealth} and the probe helpers.
 */
export interface HttpProbeResult {
  /** Whether the remote endpoint responded successfully. */
  readonly ok: boolean;
  /** HTTP status code when available. */
  readonly statusCode?: number;
  /** Optional JSON/text snippet captured from the response. */
  readonly snippet?: string;
  /** Failure message when the probe could not complete. */
  readonly error?: string;
}

/** Options accepted by {@link verifyHttpHealth}. */
export interface HttpHealthOptions {
  /** Bearer token forwarded via the `Authorization` header. */
  readonly token?: string;
  /** Expected success status code. Defaults to 200. */
  readonly expectStatus?: number;
  /** Timeout in milliseconds for the probe. Defaults to 5000ms. */
  readonly timeoutMs?: number;
  /** Custom fetch implementation (useful for tests). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Verifies that an MCP server health endpoint responds successfully.
 */
export async function verifyHttpHealth(url: string, options: HttpHealthOptions = {}): Promise<HttpProbeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, error: "Global fetch implementation is not available" };
  }

  const controller = new AbortController();
  const timeout = options.timeoutMs ?? 5000;
  const timeoutId = scheduleTimeout(() => controller.abort(), timeout);

  try {
    const init: RequestInit = { method: "GET", signal: controller.signal };
    if (options.token) {
      init.headers = { Authorization: `Bearer ${options.token}` };
    }

    const response = await fetchImpl(url, init);

    if (options.expectStatus && response.status !== options.expectStatus) {
      const snippet = await safeReadSnippet(response);
      return {
        ok: false,
        statusCode: response.status,
        ...(snippet !== undefined ? { snippet } : {}),
        error: `Unexpected status code: ${response.status}`,
      };
    }

    return { ok: response.ok, statusCode: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    controller.abort();
    clearTimeout(timeoutId);
  }
}

/** Options for {@link probeSearx}. */
export interface SearxProbeOptions {
  /** Optional query used for the search. Defaults to a harmless probe string. */
  readonly query?: string;
  /** Timeout applied to the request. */
  readonly timeoutMs?: number;
  /** Custom fetch implementation. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Probes a SearxNG instance by issuing a lightweight JSON search query.
 */
export async function probeSearx(
  baseUrl: string,
  apiPath: string,
  options: SearxProbeOptions = {},
): Promise<HttpProbeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, error: "Global fetch implementation is not available" };
  }

  try {
    const base = new URL(baseUrl);
    const endpoint = new URL(apiPath, base);
    endpoint.searchParams.set("q", options.query ?? "codex_validation_probe");
    endpoint.searchParams.set("format", "json");

    return await probeJsonEndpoint(endpoint.toString(), {
      timeoutMs: options.timeoutMs ?? 5000,
      fetchImpl,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Options for {@link probeUnstructured}. */
export interface UnstructuredProbeOptions {
  /** Timeout applied to the request. */
  readonly timeoutMs?: number;
  /** Custom fetch implementation. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Probes an Unstructured ingestion service through its health endpoint.
 */
export async function probeUnstructured(
  baseUrl: string,
  options: UnstructuredProbeOptions = {},
): Promise<HttpProbeResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, error: "Global fetch implementation is not available" };
  }

  try {
    const base = new URL(baseUrl);
    const endpoint = new URL("/health", base);
    return await probeJsonEndpoint(endpoint.toString(), {
      timeoutMs: options.timeoutMs ?? 5000,
      fetchImpl,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface ProbeEndpointOptions {
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
}

async function probeJsonEndpoint(url: string, options: ProbeEndpointOptions): Promise<HttpProbeResult> {
  const controller = new AbortController();
  const timeoutId = scheduleTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const snippet = await safeReadSnippet(response);
    return {
      ok: response.ok,
      statusCode: response.status,
      ...(snippet !== undefined ? { snippet } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    controller.abort();
    clearTimeout(timeoutId);
  }
}

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

async function safeReadSnippet(response: FetchResponse): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function ensureDir(directory: string): Promise<void> {
  try {
    await access(directory, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    await mkdir(directory, { recursive: true });
  }
}

function isFiniteNumber(value: string): boolean {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0;
}

function isTruthy(value: string): boolean {
  return ["1", "true", "TRUE", "yes", "on"].includes(value.trim());
}

function isValidUrl(value: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch (error) {
    return false;
  }
}
