import { mkdir, writeFile } from "fs/promises";
import { dirname, join, resolve as resolvePath } from "path";

/** Structure describing the critical HTTP environment expected by the MCP server. */
export interface HttpEnvironmentSummary {
  /** Host exposed by the server (0.0.0.0 is translated to 127.0.0.1 for client calls). */
  host: string;
  /** TCP port advertised in the runtime configuration. */
  port: number;
  /** HTTP path that exposes the JSON-RPC endpoint. */
  path: string;
  /** Raw bearer token communicated via MCP_HTTP_TOKEN, left empty if not configured. */
  token: string;
  /** Full base URL composed from host/port/path and ready to be used by fetch. */
  baseUrl: string;
}

/** Captures the HTTP request that was sent during a preflight verification. */
export interface HttpCheckRequestSnapshot {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Captures the HTTP response metadata for audit and troubleshooting. */
export interface HttpCheckResponseSnapshot {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Envelops the full lifecycle of a single HTTP check attempt. */
export interface HttpCheckSnapshot {
  name: string;
  startedAt: string;
  durationMs: number;
  request: HttpCheckRequestSnapshot;
  response: HttpCheckResponseSnapshot;
}

/** Data saved inside `report/context.json` so the next agent understands the setup. */
export interface ValidationContextDocument {
  generatedAt: string;
  runId: string;
  environment: HttpEnvironmentSummary;
  httpChecks: HttpCheckSnapshot[];
}

/**
 * List of sub-directories mandated by the validation playbook. They are created
 * eagerly so subsequent phases can safely append artefacts without defensive
 * checks.
 */
export const REQUIRED_SUBDIRECTORIES = ["inputs", "outputs", "events", "logs", "artifacts", "report"] as const;

/** A simple immutable tuple of request/response JSONL filenames used by the preflight. */
export const PREFLIGHT_JSONL_FILES = {
  inputs: "inputs/00_preflight.jsonl",
  outputs: "outputs/00_preflight.jsonl",
} as const;

/**
 * Mapping describing where a {@link HttpCheckSnapshot} should be persisted.
 * The helper intentionally keeps the contract minimal (inputs & outputs only)
 * so callers can reuse the function with their own log strategy.
 */
export interface HttpCheckArtefactTargets {
  /** Relative path to the `.jsonl` file that captures the requests. */
  inputs: string;
  /** Relative path to the `.jsonl` file that captures the responses. */
  outputs: string;
}

/** Default log file used when callers do not provide a custom location. */
const DEFAULT_HTTP_LOG_FILE = "logs/http_checks.json";

/**
 * Generates the canonical run identifier (`validation_<DATE-ISO>`).
 * The format purposely avoids characters (`:` or `+`) that would be awkward in
 * file paths.
 */
export function generateValidationRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:+]/g, "-").replace(/\..*/, "Z");
  return `validation_${iso}`;
}

/** Normalises a host advertised as 0.0.0.0 or :: so that client calls succeed. */
export function normaliseTargetHost(host: string | undefined): string {
  if (!host || host === "0.0.0.0" || host === "::") {
    return "127.0.0.1";
  }
  return host;
}

/** Extracts the HTTP runtime configuration from environment variables. */
export function collectHttpEnvironment(env: NodeJS.ProcessEnv): HttpEnvironmentSummary {
  const host = normaliseTargetHost(env.MCP_HTTP_HOST);
  const port = Number.parseInt(env.MCP_HTTP_PORT ?? "8765", 10);
  const path = env.MCP_HTTP_PATH ?? "/mcp";
  const token = env.MCP_HTTP_TOKEN ?? "";
  const baseUrl = `http://${host}:${Number.isFinite(port) ? port : 8765}${path}`;
  return { host, port: Number.isFinite(port) ? port : 8765, path, token, baseUrl };
}

/**
 * Ensures the validation directory exists with the expected children. The
 * function returns the absolute path to the run so callers can chain writes.
 */
export async function ensureRunStructure(baseDir: string, runId: string): Promise<string> {
  const runRoot = resolvePath(baseDir, runId);
  await mkdir(runRoot, { recursive: true });
  await Promise.all(REQUIRED_SUBDIRECTORIES.map((subdir) => mkdir(join(runRoot, subdir), { recursive: true })));
  return runRoot;
}

/** Serialises a JSON value as a single line to append in a `.jsonl` file. */
export function toJsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Writes a JSON payload with pretty indentation inside the validation folder. */
export async function writeJsonFile(targetPath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * Converts a {@link Headers} instance into a plain object that is easier to
 * inspect inside the generated artefacts.
 */
export function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Records the result of an HTTP preflight call by writing request/response data
 * to JSONL files alongside a richer JSON summary.
 */
/**
 * Persists a {@link HttpCheckSnapshot} into the provided JSONL files.
 * Callers may override the log file or disable it entirely by passing `null`.
 */
export async function appendHttpCheckArtefactsToFiles(
  runRoot: string,
  targets: HttpCheckArtefactTargets,
  check: HttpCheckSnapshot,
  logFile: string | null = DEFAULT_HTTP_LOG_FILE,
): Promise<void> {
  const inputEntry = toJsonlLine({
    name: check.name,
    startedAt: check.startedAt,
    request: check.request,
  });
  const outputEntry = toJsonlLine({
    name: check.name,
    startedAt: check.startedAt,
    durationMs: check.durationMs,
    response: check.response,
  });

  const operations: Promise<unknown>[] = [
    writeFile(join(runRoot, targets.inputs), inputEntry, { encoding: "utf8", flag: "a" }),
    writeFile(join(runRoot, targets.outputs), outputEntry, { encoding: "utf8", flag: "a" }),
  ];

  if (logFile) {
    operations.push(writeFile(join(runRoot, logFile), `${JSON.stringify(check, null, 2)}\n`, { encoding: "utf8", flag: "a" }));
  }

  await Promise.all(operations);
}

/** Convenience wrapper that keeps the historical preflight behaviour intact. */
export async function appendHttpCheckArtefacts(
  runRoot: string,
  check: HttpCheckSnapshot,
): Promise<void> {
  await appendHttpCheckArtefactsToFiles(runRoot, PREFLIGHT_JSONL_FILES, check, DEFAULT_HTTP_LOG_FILE);
}

/** Builds the payload persisted in `report/context.json`. */
export function buildContextDocument(
  runId: string,
  environment: HttpEnvironmentSummary,
  checks: HttpCheckSnapshot[],
): ValidationContextDocument {
  return {
    generatedAt: new Date().toISOString(),
    runId,
    environment,
    httpChecks: checks,
  };
}

/** Helper used by the CLI to persist the aggregated context document. */
export async function persistContextDocument(runRoot: string, context: ValidationContextDocument): Promise<void> {
  const contextPath = join(runRoot, "report", "context.json");
  await writeJsonFile(contextPath, context);
}

/**
 * Runs a fetch call and captures every component we need for traceability.
 * The `body` argument is stored exactly as provided so we can correlate with the
 * server logs if necessary.
 */
export async function performHttpCheck(
  name: string,
  request: HttpCheckRequestSnapshot,
): Promise<HttpCheckSnapshot> {
  const startedAt = new Date();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
    });

    const bodyText = await response.text();
    let parsedBody: unknown;
    try {
      parsedBody = bodyText ? JSON.parse(bodyText) : null;
    } catch (error) {
      parsedBody = { raw: bodyText, parseError: error instanceof Error ? error.message : String(error) };
    }

    return {
      name,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      request,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: headersToObject(response.headers),
        body: parsedBody,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      request,
      response: {
        status: 0,
        statusText: "NETWORK_ERROR",
        headers: {},
        body: { error: message },
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
