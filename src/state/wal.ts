import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
import { readOptionalString } from "../config/env.js";

import { sanitizeFilename } from "../paths.js";

/**
 * Shape of a transaction log entry persisted inside the write-ahead log (WAL).
 * The payload is kept generic so higher level modules can attach arbitrary
 * metadata describing the mutation they are about to apply.
 */
export interface WalEntry<TPayload = unknown> {
  /** ISO-8601 timestamp representing when the entry was recorded. */
  readonly ts: string;
  /** Logical channel used to group related events (graph, tx, child, ...). */
  readonly topic: string;
  /** Event name providing coarse grained semantics (ex: tx_begin). */
  readonly event: string;
  /** Arbitrary payload associated with the event. */
  readonly payload: TPayload;
  /** Hex encoded SHA-256 checksum covering the entry sans checksum. */
  readonly checksum: string;
}

/** Options influencing how entries are appended to the WAL. */
export interface WalAppendOptions {
  /** Optional root directory overriding {@link process.env.MCP_RUNS_ROOT}. */
  readonly runsRoot?: string;
  /** Injected clock used by tests to deterministically control timestamps. */
  readonly clock?: () => Date;
}

/** Structured result returned by {@link appendWalEntry}. */
export interface WalAppendResult<TPayload> {
  /** Absolute path to the log file that received the new entry. */
  readonly filePath: string;
  /** Fully materialised entry including the computed checksum. */
  readonly entry: WalEntry<TPayload>;
}

/**
 * Appends an entry to the topic specific WAL. Files are rotated daily (UTC)
 * which keeps each log reasonably small while preserving chronological
 * ordering. The helper is intentionally side effect free besides touching the
 * filesystem which makes it trivial to fuzz in isolation.
 */
export async function appendWalEntry<TPayload>(
  topic: string,
  event: string,
  payload: TPayload,
  options: WalAppendOptions = {},
): Promise<WalAppendResult<TPayload>> {
  const trimmedTopic = topic.trim();
  if (trimmedTopic.length === 0) {
    throw new Error("wal topic must be a non-empty string");
  }

  const trimmedEvent = event.trim();
  if (trimmedEvent.length === 0) {
    throw new Error("wal event must be a non-empty string");
  }

  const timestamp = (options.clock?.() ?? new Date()).toISOString();
  const runsRoot = resolveRunsRoot(options.runsRoot);
  const topicDir = path.join(runsRoot, "wal", sanitizeFilename(trimmedTopic));
  const filePath = path.join(topicDir, `${formatDateForRotation(timestamp)}.log`);

  await mkdir(topicDir, { recursive: true });

  const envelope = { ts: timestamp, topic: trimmedTopic, event: trimmedEvent, payload } as const;
  const checksum = createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
  const entry: WalEntry<TPayload> = { ...envelope, checksum };
  const serialised = `${JSON.stringify(entry)}\n`;

  await appendFile(filePath, serialised, { encoding: "utf8" });

  return { filePath, entry };
}

/** Resolves the directory dedicated to WAL artefacts. */
function resolveRunsRoot(override?: string): string {
  const envOverride = readOptionalString("MCP_RUNS_ROOT");
  const base = typeof override === "string" && override.length > 0 ? override : envOverride ?? "runs";
  return path.resolve(process.cwd(), base);
}

/** Normalises an ISO timestamp into the rotation friendly YYYY-MM-DD token. */
function formatDateForRotation(isoTimestamp: string): string {
  // The timestamp is guaranteed to be at least 10 characters long as it was
  // produced via `Date#toISOString`. Slicing keeps the helper allocation free.
  return isoTimestamp.slice(0, 10);
}

export const __walInternals = {
  resolveRunsRoot,
  formatDateForRotation,
};
