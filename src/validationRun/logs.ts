import { readFile } from "node:fs/promises";
import path from "node:path";

import { ensureValidationRunLayout, type ValidationRunLayout } from "./layout.js";

/**
 * Describes the options accepted when extracting a server log excerpt for a
 * validation scenario. The helper focuses on the canonical MCP log file
 * (`self-codex.log`) and attempts to capture a small window around the scenario
 * execution so operators can archive relevant context.
 */
export interface ExtractServerLogOptions {
  /** Job identifier emitted by the search pipeline / scenario orchestrator. */
  readonly jobId: string;
  /** Scenario slug (e.g. `S01_pdf_science`) used as a secondary matching hint. */
  readonly scenarioSlug: string;
  /** Optional precomputed validation layout to avoid recomputing it. */
  readonly layout?: ValidationRunLayout;
  /** Optional base root forwarded to {@link ensureValidationRunLayout}. */
  readonly baseRoot?: string;
  /** Maximum number of lines to return in the excerpt (defaults to 10). */
  readonly maxEntries?: number;
  /**
   * Number of surrounding lines preserved on each side of a match (defaults to
   * two). Increasing the radius helps operators capture additional context when
   * multiple services interleave their logs.
   */
  readonly contextRadius?: number;
}

/** Result returned when an excerpt is successfully captured. */
export interface ServerLogExcerpt {
  /** Absolute path to the source log file. */
  readonly sourcePath: string;
  /** Ordered lines forming the excerpt. */
  readonly lines: readonly string[];
}

/**
 * Attempts to extract a short excerpt from `validation_run/logs/self-codex.log`
 * that covers the provided scenario job identifier. The helper scans the log
 * for JSON lines containing the job id (or scenario slug) and returns a
 * deduplicated set of lines with a small contextual window.
 *
 * When the log file does not exist or the job identifier cannot be found, the
 * function falls back to returning the last `maxEntries` lines. This keeps the
 * workflow robust even when the orchestrator fails to emit structured entries
 * (for example during early boot).
 */
export async function extractServerLogExcerpt(
  options: ExtractServerLogOptions,
): Promise<ServerLogExcerpt | null> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const logPath = path.join(layout.logsDir, "self-codex.log");
  const maxEntries = Math.max(1, options.maxEntries ?? 10);
  const contextRadius = Math.max(0, options.contextRadius ?? 2);

  let raw: string;
  try {
    raw = await readFile(logPath, { encoding: "utf8" });
  } catch (error) {
    // Missing log files are expected when the operator has not yet started the
    // server. Returning `null` allows callers to skip writing `server.log` while
    // surfacing the absence through audit tooling.
    return null;
  }

  const lines = raw.split(/\r?\n/);
  if (lines.length === 0) {
    return null;
  }

  const matchIndices = collectMatchingLineIndices(lines, {
    jobId: options.jobId,
    scenarioSlug: options.scenarioSlug,
    contextRadius,
    maxEntries,
  });

  let excerptLines: string[];
  if (matchIndices.length > 0) {
    excerptLines = matchIndices.map((index) => lines[index]).filter((line) => line !== undefined);
  } else {
    excerptLines = fallbackTail(lines, maxEntries);
  }

  if (excerptLines.length === 0) {
    return null;
  }

  return {
    sourcePath: logPath,
    lines: excerptLines,
  };
}

interface CollectMatchingOptions {
  readonly jobId: string;
  readonly scenarioSlug: string;
  readonly contextRadius: number;
  readonly maxEntries: number;
}

/**
 * Scans the provided log lines, returning the line indices that should be kept
 * in the excerpt. The function searches both raw substrings and structured JSON
 * payloads to maximise the chance of matching the scenario job identifier.
 */
function collectMatchingLineIndices(
  lines: readonly string[],
  options: CollectMatchingOptions,
): number[] {
  const matches = new Set<number>();
  const patterns = buildMatchPatterns(options.jobId, options.scenarioSlug);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim().length === 0) {
      continue;
    }

    if (patterns.some((pattern) => line.includes(pattern))) {
      includeWithContext(matches, index, options);
      continue;
    }

    const parsed = parseJsonLine(line);
    if (!parsed) {
      continue;
    }

    if (matchStructuredEntry(parsed, patterns)) {
      includeWithContext(matches, index, options);
    }
  }

  if (matches.size === 0) {
    return [];
  }

  const sorted = Array.from(matches).sort((a, b) => a - b);
  if (sorted.length <= options.maxEntries) {
    return sorted;
  }

  // When the window is larger than requested, trim it symmetrically around the
  // median to keep lines closest to the matching entries.
  const trimmed: number[] = [];
  const midpoint = Math.floor(sorted.length / 2);
  const halfWindow = Math.floor(options.maxEntries / 2);
  let start = midpoint - halfWindow;
  if (start < 0) {
    start = 0;
  }
  let end = start + options.maxEntries;
  if (end > sorted.length) {
    end = sorted.length;
    start = Math.max(0, end - options.maxEntries);
  }

  for (let idx = start; idx < end; idx += 1) {
    trimmed.push(sorted[idx]);
  }
  return trimmed;
}

/** Builds the list of substrings that should trigger a match. */
function buildMatchPatterns(jobId: string, scenarioSlug: string): string[] {
  const patterns = new Set<string>();
  if (jobId.trim().length > 0) {
    patterns.add(jobId.trim());
  }
  if (scenarioSlug.trim().length > 0) {
    patterns.add(scenarioSlug.trim());
  }
  return Array.from(patterns);
}

/** Safely parses a JSON log line. Returns `null` when parsing fails. */
function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Determines whether the structured log entry matches any of the known
 * patterns. The helper inspects both top-level `job_id` fields and nested
 * payloads.
 */
function matchStructuredEntry(entry: Record<string, unknown>, patterns: readonly string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  const topLevel = typeof entry.job_id === "string" ? entry.job_id : null;
  if (topLevel && patterns.some((pattern) => topLevel.includes(pattern))) {
    return true;
  }

  const payload = entry.payload;
  if (payload && typeof payload === "object") {
    const candidate = payload as Record<string, unknown>;
    const jobId = typeof candidate.job_id === "string" ? candidate.job_id : null;
    if (jobId && patterns.some((pattern) => jobId.includes(pattern))) {
      return true;
    }
    const message = typeof candidate.message === "string" ? candidate.message : null;
    if (message && patterns.some((pattern) => message.includes(pattern))) {
      return true;
    }
  }

  return false;
}

/** Adds a line index and its surrounding context to the excerpt. */
function includeWithContext(
  target: Set<number>,
  index: number,
  options: CollectMatchingOptions,
): void {
  const { contextRadius, maxEntries } = options;
  for (let offset = -contextRadius; offset <= contextRadius; offset += 1) {
    const candidate = index + offset;
    if (candidate < 0) {
      continue;
    }
    target.add(candidate);
    if (target.size >= maxEntries * 2) {
      // Avoid growing unboundedly when multiple matches are close together.
      break;
    }
  }
}

/** Returns the last `maxEntries` non-empty lines from the log file. */
function fallbackTail(lines: readonly string[], maxEntries: number): string[] {
  const filtered = lines.filter((line) => line && line.trim().length > 0);
  if (filtered.length === 0) {
    return [];
  }
  const start = Math.max(0, filtered.length - maxEntries);
  return filtered.slice(start);
}
