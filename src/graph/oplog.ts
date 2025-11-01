import { mkdir, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";

/**
 * Root directory storing the JSONL operation logs. Tests can override the path
 * by providing the {@link append} options; production defaults to
 * `validation_run/oplog/<YYYYMMDD>.log` in the current working directory.
 */
const DEFAULT_OPLOG_ROOT = resolve("validation_run", "oplog");

/**
 * Minimal payload captured for every graph-related state transition. The
 * `kind` field indicates which subsystem produced the entry while additional
 * metadata exposes contextual hints (owner, op identifiers, ...).
 */
export interface GraphOperation {
  /** Discriminator describing the nature of the recorded operation. */
  kind:
    | "tx_begin"
    | "graph_patch"
    | "tx_commit"
    | "tx_rollback"
    | "graph_batch_mutate"
    | "tx_apply"
    | "graph_apply_change_set";
  /** Identifier of the graph impacted by the mutation. */
  graph_id: string;
  /** Additional metadata associated with the operation. */
  [key: string]: unknown;
}

/** Options accepted when appending entries to the operation log. */
export interface AppendOptions {
  /** Root directory where JSONL files should be written. */
  rootDir?: string;
}

/**
 * Resolve the JSONL file receiving entries for the provided timestamp. Entries
 * are grouped by day (UTC) to keep files human navigable.
 */
export function resolveOplogPath(timestamp: number, rootDir = DEFAULT_OPLOG_ROOT): string {
  const date = new Date(timestamp);
  const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
  return join(rootDir, `${stamp}.log`);
}

/**
 * Append a graph operation to the JSONL log. Callers provide the transaction
 * identifier and timestamp so the helper can be reused when replaying cached
 * responses. The function guarantees directory existence before writing.
 */
export async function append(
  operation: GraphOperation,
  txId: string,
  timestamp: number,
  options: AppendOptions = {},
): Promise<void> {
  const root = resolve(options.rootDir ?? DEFAULT_OPLOG_ROOT);
  await mkdir(root, { recursive: true });
  const file = resolveOplogPath(timestamp, root);
  const line = JSON.stringify({ ts: timestamp, tx_id: txId, op: operation });
  await appendFile(file, `${line}\n`, { encoding: "utf8" });
}

/**
 * Convenience helper used by the transaction pipeline to record operations
 * without coupling business logic to filesystem concerns.
 */
export async function recordOperation(
  operation: GraphOperation,
  txId: string,
  options: AppendOptions = {},
): Promise<number> {
  const timestamp = Date.now();
  try {
    await append(operation, txId, timestamp, options);
  } catch (error) {
    // Persisting the op-log must never prevent commits from succeeding. Emit a
    // process warning so operators can investigate while the pipeline
    // continues. The warning is concise to avoid leaking sensitive data.
    const reason = error instanceof Error ? error.message : String(error);
    process.emitWarning(`failed to append graph operation log: ${reason}`);
  }
  return timestamp;
}
