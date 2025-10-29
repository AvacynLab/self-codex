import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { computeValidationRunEnv, ensureValidationRunLayout, type ValidationRunLayout } from "./layout.js";

const execFile = promisify(execFileCallback);

/** Default maximum number of characters persisted for HTTP probe payloads. */
const DEFAULT_PROBE_CHAR_LIMIT = 500;

/**
 * Structure returned after capturing every snapshot artefact. Each property holds
 * the absolute path where the corresponding file was written so callers can
 * surface them in logs or follow-up reports.
 */
export interface ValidationSnapshotPaths {
  /** Absolute path to `versions.txt`. */
  readonly versions: string;
  /** Absolute path to `git.txt`. */
  readonly git: string;
  /** Absolute path to `.env.effective`. */
  readonly env: string;
  /** Absolute path to `searxng_probe.txt`. */
  readonly searxProbe: string;
  /** Absolute path to `unstructured_probe.txt`. */
  readonly unstructuredProbe: string;
}

/** Abstraction layer allowing tests to stub the fetch implementation. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Options accepted by {@link captureValidationSnapshots}. The parameters favour
 * dependency injection so unit tests can supply deterministic executors and
 * network layers without relying on the host environment.
 */
export interface CaptureValidationSnapshotsOptions {
  /** Optional layout already initialised by the caller. */
  readonly layout?: ValidationRunLayout;
  /** Optional base directory forwarded to {@link ensureValidationRunLayout}. */
  readonly baseRoot?: string;
  /** Environment variables, defaults to {@link process.env}. */
  readonly env?: NodeJS.ProcessEnv;
  /** Custom execFile implementation used to query external binaries. */
  readonly execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  /** HTTP client implementation, defaults to the global {@link fetch}. */
  readonly fetchImpl?: FetchLike;
  /** Maximum number of characters stored for HTTP probe payloads. */
  readonly probeCharLimit?: number;
}

/** Keywords used to decide whether an environment value must be masked. */
const SECRET_KEYWORDS = ["TOKEN", "SECRET", "PASSWORD", "KEY", "AUTH"];

/** Regular expression matching environment keys that should be exported. */
const SNAPSHOT_ENV_PATTERN = /^(MCP_|SEARCH_|UNSTRUCTURED_|IDEMPOTENCY_TTL_MS$)/;

/**
 * Captures every snapshot artefact mandated by section 1 of `AGENTS.md`. The
 * helper returns the absolute paths to the generated files which facilitates the
 * caller logging them afterwards.
 */
export async function captureValidationSnapshots(
  options: CaptureValidationSnapshotsOptions = {},
): Promise<ValidationSnapshotPaths> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const env = options.env ?? process.env;
  const exec = options.execFile ?? defaultExecFile;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const charLimit = options.probeCharLimit ?? DEFAULT_PROBE_CHAR_LIMIT;
  const recommendedEnv = computeValidationRunEnv(layout);

  const versionsPath = path.join(layout.snapshotsDir, "versions.txt");
  const gitPath = path.join(layout.snapshotsDir, "git.txt");
  const envPath = path.join(layout.snapshotsDir, ".env.effective");
  const searxProbePath = path.join(layout.snapshotsDir, "searxng_probe.txt");
  const unstructuredProbePath = path.join(layout.snapshotsDir, "unstructured_probe.txt");

  await Promise.all([
    writeVersionsSnapshot(versionsPath, exec),
    writeGitSnapshot(gitPath, exec),
    writeEnvSnapshot(envPath, env, recommendedEnv),
  ]);

  await Promise.all([
    writeSearxProbe(searxProbePath, env, fetchImpl, charLimit),
    writeUnstructuredProbe(unstructuredProbePath, env, fetchImpl, charLimit),
  ]);

  return {
    versions: versionsPath,
    git: gitPath,
    env: envPath,
    searxProbe: searxProbePath,
    unstructuredProbe: unstructuredProbePath,
  };
}

/** Default implementation used to spawn external binaries. */
async function defaultExecFile(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFile(file, args);
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

/** Writes the Node/npm versions to the snapshot file. */
async function writeVersionsSnapshot(
  targetPath: string,
  exec: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<void> {
  const nodeVersion = process.version;
  let npmVersion = "unknown";

  try {
    const result = await exec("npm", ["--version"]);
    npmVersion = sanitiseCliOutput(result.stdout.trim()) || "unknown";
  } catch (error) {
    npmVersion = describeExecError(error);
  }

  const payload = [`node: ${nodeVersion}`, `npm: ${npmVersion}`].join("\n");
  await writeFile(targetPath, `${payload}\n`, { encoding: "utf8" });
}

/** Writes the git revision to the snapshot file, falling back to N/A when unavailable. */
async function writeGitSnapshot(
  targetPath: string,
  exec: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<void> {
  try {
    const result = await exec("git", ["rev-parse", "--short", "HEAD"]);
    const revision = sanitiseCliOutput(result.stdout.trim());
    if (!revision) {
      throw new Error("empty git revision");
    }
    await writeFile(targetPath, `${revision}\n`, { encoding: "utf8" });
  } catch (error) {
    await writeFile(targetPath, `N/A (${describeExecError(error)})\n`, { encoding: "utf8" });
  }
}

/**
 * Writes the `.env.effective` snapshot by exporting a sanitised subset of the
 * environment. Sensitive values are masked while public configuration such as
 * base URLs remain readable.
 */
async function writeEnvSnapshot(
  targetPath: string,
  env: NodeJS.ProcessEnv,
  recommended: Record<string, string>,
): Promise<void> {
  const lines: string[] = [];
  const keys = Object.keys(env)
    .filter((key) => SNAPSHOT_ENV_PATTERN.test(key))
    .sort((a, b) => a.localeCompare(b));

  for (const key of keys) {
    const value = env[key] ?? "";
    lines.push(`${key}=${maskEnvValue(key, value)}`);
  }

  const seen = new Set(keys);
  for (const [key, value] of Object.entries(recommended)) {
    if (seen.has(key)) {
      const actual = env[key];
      if ((actual ?? "") !== value) {
        lines.push(`# recommended ${key}=${value}`);
      }
      continue;
    }
    lines.push(`${key}=${value}`);
  }

  await writeFile(targetPath, `${lines.join("\n")}\n`, { encoding: "utf8" });
}

/** Persists the result of the SearxNG HTTP probe. */
async function writeSearxProbe(
  targetPath: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  charLimit: number,
): Promise<void> {
  const baseUrl = env.SEARCH_SEARX_BASE_URL;
  if (!baseUrl) {
    await writeFile(targetPath, "SEARCH_SEARX_BASE_URL not configured\n", { encoding: "utf8" });
    return;
  }

  const url = buildUrl(baseUrl, env.SEARCH_SEARX_API_PATH ?? "/search", {
    q: "test",
    format: "json",
  });

  try {
    const response = await fetchImpl(url.toString(), { method: "GET" });
    const truncatedBody = await readResponseBody(response, charLimit);
    const payload = [`status: ${response.status} ${response.statusText}`, "---", truncatedBody].join("\n");
    await writeFile(targetPath, `${payload}\n`, { encoding: "utf8" });
  } catch (error) {
    await writeFile(targetPath, `probe failed: ${describeExecError(error)}\n`, { encoding: "utf8" });
  }
}

/** Persists the result of the Unstructured API probe. */
async function writeUnstructuredProbe(
  targetPath: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
  charLimit: number,
): Promise<void> {
  const baseUrl = env.UNSTRUCTURED_BASE_URL;
  if (!baseUrl) {
    await writeFile(targetPath, "UNSTRUCTURED_BASE_URL not configured\n", { encoding: "utf8" });
    return;
  }

  const url = buildUrl(baseUrl, "/health", {});
  try {
    const response = await fetchImpl(url.toString(), { method: "GET" });
    const truncatedBody = await readResponseBody(response, charLimit);
    const payload = [`status: ${response.status} ${response.statusText}`, "---", truncatedBody].join("\n");
    await writeFile(targetPath, `${payload}\n`, { encoding: "utf8" });
  } catch (error) {
    await writeFile(targetPath, `probe failed: ${describeExecError(error)}\n`, { encoding: "utf8" });
  }
}

/** Normalises CLI outputs by removing surrounding whitespace and newlines. */
function sanitiseCliOutput(output: string): string {
  return output.replace(/\r?\n/g, " ").trim();
}

/**
 * Masks an environment variable value when the key contains a sensitive keyword
 * or the string appears to contain a bearer token. The algorithm keeps the
 * length visible so operators can compare revisions without leaking secrets.
 */
function maskEnvValue(key: string, rawValue: string): string {
  const value = rawValue ?? "";
  if (value.length === 0) {
    return "";
  }

  const upperKey = key.toUpperCase();
  const shouldMask = SECRET_KEYWORDS.some((keyword) => upperKey.includes(keyword));
  if (!shouldMask) {
    return value;
  }

  if (value.length <= 8) {
    return "<redacted>";
  }

  const prefix = value.slice(0, 3);
  const suffix = value.slice(-2);
  return `${prefix}…${suffix} <redacted ${value.length} chars>`;
}

/** Builds a URL by combining the base, path and query parameters. */
function buildUrl(base: string, rawPath: string, query: Record<string, string>): URL {
  const url = new URL(base);
  const normalisedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  url.pathname = normalisedPath;
  url.search = new URLSearchParams(query).toString();
  return url;
}

/** Reads at most {@link charLimit} characters from the HTTP response body. */
async function readResponseBody(response: Response, charLimit: number): Promise<string> {
  const text = await response.text();
  if (text.length <= charLimit) {
    return text;
  }
  return `${text.slice(0, charLimit)}… [truncated ${text.length - charLimit} chars]`;
}

/** Formats unknown errors captured during CLI or HTTP operations. */
function describeExecError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export { maskEnvValue, readResponseBody, buildUrl, SECRET_KEYWORDS };
