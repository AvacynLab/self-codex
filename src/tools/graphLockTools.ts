import { z } from "zod";

import type { GraphLockManager, GraphLockSnapshot, GraphLockReleaseResult } from "../graph/locks.js";

/** Context injected in the graph lock MCP tool handlers. */
export interface GraphLockToolContext {
  locks: GraphLockManager;
}

/** Schema accepted by the graph_lock tool. */
export const GraphLockInputSchema = z
  .object({
    graph_id: z.string().min(1, "graph_id is required"),
    holder: z.string().trim().min(1, "holder is required").max(120, "holder is too long"),
    ttl_ms: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict();

/** Schema accepted by the graph_unlock tool. */
export const GraphUnlockInputSchema = z
  .object({
    lock_id: z.string().uuid(),
  })
  .strict();

export const GraphLockInputShape = GraphLockInputSchema.shape;
export const GraphUnlockInputShape = GraphUnlockInputSchema.shape;

export type GraphLockInput = z.infer<typeof GraphLockInputSchema>;
export type GraphUnlockInput = z.infer<typeof GraphUnlockInputSchema>;

/** Result returned when a graph lock is acquired. */
export interface GraphLockResult extends Record<string, unknown> {
  lock_id: string;
  graph_id: string;
  holder: string;
  acquired_at: number;
  refreshed_at: number;
  expires_at: number | null;
}

/** Result returned when a graph lock is released. */
export interface GraphUnlockResult extends Record<string, unknown> {
  lock_id: string;
  graph_id: string;
  holder: string;
  released_at: number;
  expired: boolean;
  expires_at: number | null;
}

/** Acquire or refresh the lock guarding a graph. */
export function handleGraphLock(context: GraphLockToolContext, input: GraphLockInput): GraphLockResult {
  const snapshot = context.locks.acquire(input.graph_id, input.holder, { ttlMs: input.ttl_ms ?? null });
  return formatLockSnapshot(snapshot);
}

/** Release the lock guarding a graph. */
export function handleGraphUnlock(context: GraphLockToolContext, input: GraphUnlockInput): GraphUnlockResult {
  const result = context.locks.release(input.lock_id);
  return formatLockRelease(result);
}

function formatLockSnapshot(snapshot: GraphLockSnapshot): GraphLockResult {
  return {
    lock_id: snapshot.lockId,
    graph_id: snapshot.graphId,
    holder: snapshot.holder,
    acquired_at: snapshot.acquiredAt,
    refreshed_at: snapshot.refreshedAt,
    expires_at: snapshot.expiresAt,
  };
}

function formatLockRelease(result: GraphLockReleaseResult): GraphUnlockResult {
  return {
    lock_id: result.lockId,
    graph_id: result.graphId,
    holder: result.holder,
    released_at: result.releasedAt,
    expired: result.expired,
    expires_at: result.expiresAt,
  };
}
