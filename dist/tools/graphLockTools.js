import { z } from "zod";
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
/** Acquire or refresh the lock guarding a graph. */
export function handleGraphLock(context, input) {
    const snapshot = context.locks.acquire(input.graph_id, input.holder, { ttlMs: input.ttl_ms ?? null });
    return formatLockSnapshot(snapshot);
}
/** Release the lock guarding a graph. */
export function handleGraphUnlock(context, input) {
    const result = context.locks.release(input.lock_id);
    return formatLockRelease(result);
}
function formatLockSnapshot(snapshot) {
    return {
        lock_id: snapshot.lockId,
        graph_id: snapshot.graphId,
        holder: snapshot.holder,
        acquired_at: snapshot.acquiredAt,
        refreshed_at: snapshot.refreshedAt,
        expires_at: snapshot.expiresAt,
    };
}
function formatLockRelease(result) {
    return {
        lock_id: result.lockId,
        graph_id: result.graphId,
        holder: result.holder,
        released_at: result.releasedAt,
        expired: result.expired,
        expires_at: result.expiresAt,
    };
}
