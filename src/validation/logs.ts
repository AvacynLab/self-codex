import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import { writeJsonFile } from "./runSetup.js";

/**
 * Regular expression capturing common latency/duration field names.  The helper
 * remains intentionally permissive so it extracts metrics from heterogeneous
 * logging formats (plain text, JSON records, structured logging libraries...).
 */
const LATENCY_FIELD_PATTERN = /(latency|duration|elapsed)([_-]?(ms|millis|milliseconds))?$/i;

/**
 * Structure summarising the HTTP log file exported by the MCP runtime.
 */
export interface HttpLogSummary {
  /** ISO timestamp describing when the summary was generated. */
  generatedAt: string;
  /** Absolute path to the analysed log file. */
  sourcePath: string;
  /** Size of the source file in bytes. */
  fileSizeBytes: number;
  /** Total number of lines present in the file. */
  totalLines: number;
  /** Lines containing only whitespace characters. */
  emptyLines: number;
  /** Number of lines that failed JSON parsing during the analysis. */
  parseFailures: number;
  /** Histogram of log levels (lower-cased keys). */
  levelCounts: Record<string, number>;
  /** Convenience counter for ERROR-level entries. */
  errorLines: number;
  /** Convenience counter for WARN-level entries. */
  warnLines: number;
  /** Convenience counter for INFO-level entries. */
  infoLines: number;
  /** Top messages ranked by frequency (ties broken by recency and lexicographic order). */
  topMessages: Array<{ text: string; count: number }>;
  /** Latency statistics extracted from structured log fields. */
  latency: {
    /** Number of latency samples successfully extracted. */
    samples: number;
    /** Field names that contributed latency metrics. */
    fields: string[];
    /** Minimum observed latency in milliseconds. */
    min: number | null;
    /** Maximum observed latency in milliseconds. */
    max: number | null;
    /** 50th percentile (median) when samples are available. */
    p50: number | null;
    /** 95th percentile when samples are available. */
    p95: number | null;
    /** 99th percentile when samples are available. */
    p99: number | null;
  };
}

/**
 * Normalises log levels so the summary exposes predictable counters.  The
 * function prefers structured `level` fields when available but gracefully
 * falls back to keyword detection for plain-text logs.
 */
function normaliseLevel(parsedLevel: unknown, rawLine: string): string {
  if (typeof parsedLevel === "string" && parsedLevel.trim()) {
    return parsedLevel.trim().toLowerCase();
  }

  if (/error/i.test(rawLine)) {
    return "error";
  }
  if (/warn/i.test(rawLine)) {
    return "warn";
  }
  if (/info/i.test(rawLine)) {
    return "info";
  }
  if (/debug/i.test(rawLine)) {
    return "debug";
  }
  return "unknown";
}

/**
 * Fields that are typically associated with human-readable log messages.  The
 * list intentionally covers variations emitted by common logging libraries so
 * the summary can highlight meaningful excerpts even when the schema changes
 * slightly across environments.
 */
const MESSAGE_FIELD_PRIORITY = ["message", "msg", "text", "description", "detail"];

/** Secondary string fields that occasionally carry a message payload. */
const MESSAGE_FIELD_SECONDARY = ["error", "warning", "event", "note", "reason"];

/** Keys ignored when scanning for fallback string values. */
const MESSAGE_FIELD_IGNORED = new Set(["level", "severity", "timestamp", "time", "ts", "category", "logger"]);

/** Maximum length (in characters) preserved for message excerpts. */
const MESSAGE_PREVIEW_MAX_LENGTH = 200;

/** Normalises whitespace and truncates message excerpts for readability. */
function normaliseMessagePreview(candidate: string): string {
  const normalised = candidate.replace(/\s+/g, " ").trim();
  if (normalised.length <= MESSAGE_PREVIEW_MAX_LENGTH) {
    return normalised;
  }
  return `${normalised.slice(0, MESSAGE_PREVIEW_MAX_LENGTH - 1)}…`;
}

/**
 * Attempts to extract a meaningful message from a structured log record.
 *
 * The helper explores the record recursively with a shallow depth budget to
 * avoid expensive traversals while still capturing nested fields such as
 * `event.message`. It prioritises the standard message fields first, then
 * checks secondary candidates, and finally falls back to any non-trivial
 * string that does not look like metadata (level, timestamp, ...).
 */
function deriveMessageFromStructuredLog(
  record: Record<string, unknown>,
  depth = 0,
  visited: Set<unknown> = new Set(),
): string | null {
  if (visited.has(record) || depth > 4) {
    return null;
  }

  visited.add(record);

  for (const field of MESSAGE_FIELD_PRIORITY) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return normaliseMessagePreview(value);
    }
  }

  for (const field of MESSAGE_FIELD_SECONDARY) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return normaliseMessagePreview(value);
    }
    if (value && typeof value === "object") {
      const nested = Array.isArray(value)
        ? value.map((entry) => (entry && typeof entry === "object" ? deriveMessageFromStructuredLog(entry as Record<string, unknown>, depth + 1, visited) : null)).find((entry) => entry)
        : deriveMessageFromStructuredLog(value as Record<string, unknown>, depth + 1, visited);
      if (nested) {
        return nested;
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim() && !MESSAGE_FIELD_IGNORED.has(key.toLowerCase())) {
      return normaliseMessagePreview(value);
    }

    if (value && typeof value === "object") {
      const nested = Array.isArray(value)
        ? value
            .map((entry) => (entry && typeof entry === "object" ? deriveMessageFromStructuredLog(entry as Record<string, unknown>, depth + 1, visited) : null))
            .find((entry) => entry)
        : deriveMessageFromStructuredLog(value as Record<string, unknown>, depth + 1, visited);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

/**
 * Computes a percentile using linear interpolation between samples.  The
 * implementation matches the behaviour of statistical packages (`pandas`,
 * `numpy`) so future analyses remain consistent with external tooling.
 */
function computePercentile(sortedValues: number[], percentile: number): number | null {
  if (!sortedValues.length) {
    return null;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position = (sortedValues.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex];
  }

  const weight = position - lowerIndex;
  return lowerValue + (upperValue - lowerValue) * weight;
}

/**
 * Traverses structured log objects to collect latency-like numeric fields.
 * Nested objects are explored up to a small depth to balance accuracy and
 * performance.
 */
function collectLatencySamples(
  candidate: unknown,
  accumulator: number[],
  contributingFields: Set<string>,
  depth = 0,
  visited: Set<unknown> = new Set(),
): void {
  if (!candidate || typeof candidate !== "object" || depth > 4 || visited.has(candidate)) {
    return;
  }

  visited.add(candidate);

  if (Array.isArray(candidate)) {
    for (const element of candidate) {
      collectLatencySamples(element, accumulator, contributingFields, depth + 1, visited);
    }
    return;
  }

  const record = candidate as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && LATENCY_FIELD_PATTERN.test(key)) {
      accumulator.push(value);
      contributingFields.add(key);
      continue;
    }

    if (value && typeof value === "object") {
      collectLatencySamples(value, accumulator, contributingFields, depth + 1, visited);
    }
  }
}

/**
 * Analyses the MCP HTTP log located at {@link sourcePath} and returns summary
 * statistics suitable for `logs/summary.json`.
 */
export async function summariseHttpLogFile(sourcePath: string): Promise<HttpLogSummary> {
  if (!sourcePath) {
    throw new Error("summariseHttpLogFile requires a sourcePath");
  }

  const [content, fileStats] = await Promise.all([
    readFile(sourcePath, "utf8"),
    stat(sourcePath),
  ]);

  const lines = content.split(/\r?\n/);
  const levelHistogram = new Map<string, number>();
  const latencySamples: number[] = [];
  const latencyFields = new Set<string>();
  const messageHistogram = new Map<string, { count: number; lastIndex: number; derivedRank: number }>();
  let parseFailures = 0;
  let emptyLines = 0;

  const registerMessage = (message: string | null, index: number, derived: boolean): void => {
    if (!message) {
      return;
    }
    const candidate = normaliseMessagePreview(message);
    if (!candidate) {
      return;
    }
    const rank = derived ? 0 : 1;
    const current = messageHistogram.get(candidate);
    if (current) {
      current.count += 1;
      current.lastIndex = index;
      if (rank < current.derivedRank) {
        current.derivedRank = rank;
      }
    } else {
      messageHistogram.set(candidate, { count: 1, lastIndex: index, derivedRank: rank });
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line) {
      emptyLines += 1;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      emptyLines += 1;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      parseFailures += 1;
      parsed = null;
    }

    const level = normaliseLevel((parsed as Record<string, unknown> | null)?.level, line);
    levelHistogram.set(level, (levelHistogram.get(level) ?? 0) + 1);

    if (parsed) {
      collectLatencySamples(parsed, latencySamples, latencyFields);
      const parsedRecord = parsed as Record<string, unknown>;
      const message = deriveMessageFromStructuredLog(parsedRecord);
      if (message) {
        registerMessage(message, lineIndex, true);
      } else {
        registerMessage(trimmed, lineIndex, false);
      }
    } else {
      registerMessage(trimmed, lineIndex, false);
    }
  }

  latencySamples.sort((a, b) => a - b);

  const topMessages = Array.from(messageHistogram.entries())
    .map(([text, stats]) => ({ text, count: stats.count, lastIndex: stats.lastIndex, derivedRank: stats.derivedRank }))
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      if (a.derivedRank !== b.derivedRank) {
        return a.derivedRank - b.derivedRank;
      }
      if (a.lastIndex !== b.lastIndex) {
        return b.lastIndex - a.lastIndex;
      }
      return a.text.localeCompare(b.text);
    })
    .slice(0, 3)
    .map(({ text, count }) => ({ text, count }));

  const summary: HttpLogSummary = {
    generatedAt: new Date().toISOString(),
    sourcePath,
    fileSizeBytes: fileStats.size,
    totalLines: lines.length,
    emptyLines,
    parseFailures,
    levelCounts: Object.fromEntries(levelHistogram.entries()),
    errorLines: levelHistogram.get("error") ?? 0,
    warnLines: levelHistogram.get("warn") ?? 0,
    infoLines: levelHistogram.get("info") ?? 0,
    topMessages,
    latency: {
      samples: latencySamples.length,
      fields: Array.from(latencyFields.values()).sort(),
      min: latencySamples.length ? latencySamples[0] : null,
      max: latencySamples.length ? latencySamples[latencySamples.length - 1] : null,
      p50: computePercentile(latencySamples, 0.5),
      p95: computePercentile(latencySamples, 0.95),
      p99: computePercentile(latencySamples, 0.99),
    },
  };

  return summary;
}

export interface CaptureHttpLogOptions {
  /** Absolute path to the MCP HTTP log (defaults to `/tmp/mcp_http.log`). */
  sourcePath?: string;
  /** File name to use inside the validation run `logs/` directory. */
  targetFileName?: string;
  /** Summary file name to use inside the validation run `logs/` directory. */
  summaryFileName?: string;
}

/**
 * Copies the MCP HTTP log into the validation run folder and writes
 * `logs/summary.json` containing aggregated metrics.
 */
export async function captureHttpLog(
  runRoot: string,
  options: CaptureHttpLogOptions = {},
): Promise<{ logPath: string; summaryPath: string; summary: HttpLogSummary }> {
  if (!runRoot) {
    throw new Error("captureHttpLog requires a runRoot directory");
  }

  const { sourcePath = "/tmp/mcp_http.log", targetFileName = "mcp_http.log", summaryFileName = "summary.json" } = options;

  const logsDir = join(runRoot, "logs");
  await mkdir(logsDir, { recursive: true });

  const logPath = join(logsDir, targetFileName);
  await copyFile(sourcePath, logPath);

  const summary = await summariseHttpLogFile(logPath);
  const summaryPath = join(logsDir, summaryFileName);
  await writeJsonFile(summaryPath, summary);

  return { logPath, summaryPath, summary };
}
