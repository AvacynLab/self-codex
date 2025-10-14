import process from "node:process";

import { appendWalEntry } from "../state/wal.js";

/**
 * Generic payload accepted by the graph write-ahead log helpers. Individual
 * callers can enrich the envelope with any serialisable fields that make
 * debugging or replaying mutations easier down the line.
 */
export type GraphWalPayload = Record<string, unknown>;

/**
 * Append an event to the graph-specific WAL topic, awaiting persistence before
 * returning. Callers that need stricter durability guarantees (for instance the
 * idempotent HTTP fast-path) should await this helper to guarantee ordering.
 */
export async function recordGraphWal(event: string, payload: GraphWalPayload): Promise<void> {
  await appendWalEntry("graph", event, payload);
}

/**
 * Fire-and-forget variant used when the caller cannot easily become async.
 * Errors are surfaced as process warnings so operators can investigate while
 * ensuring the main execution flow remains resilient.
 */
export function fireAndForgetGraphWal(event: string, payload: GraphWalPayload): void {
  recordGraphWal(event, payload).catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    process.emitWarning(`failed to append graph wal entry (${event}): ${reason}`);
  });
}

