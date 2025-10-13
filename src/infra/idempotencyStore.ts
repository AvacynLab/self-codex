import { resolve as resolvePath } from "node:path";

/**
 * Contract implemented by idempotency stores capable of persisting HTTP
 * responses. Implementations are expected to survive orchestrator restarts so
 * stateless transports can replay completed side effects when clients retry
 * requests with the same idempotency key.
 */
export interface IdempotencyStore {
  /**
   * Retrieves a previously stored HTTP response.
   *
   * @param key Stable identifier derived from the JSON-RPC method, idempotency
   * key header and request parameters.
   * @returns The persisted response when the entry is still valid, otherwise
   * `null` so the caller can execute the request.
   */
  get(key: string): Promise<{ status: number; body: string } | null>;

  /**
   * Persists an HTTP response so subsequent retries can reuse it.
   *
   * @param key Stable identifier derived from the JSON-RPC request.
   * @param status HTTP status code returned to the caller.
   * @param body JSON serialised payload sent to the client.
   * @param ttlMs Time to live (milliseconds) advertised by the orchestrator.
   */
  set(key: string, status: number, body: string, ttlMs: number): Promise<void>;

  /**
   * Optional maintenance hook removing expired entries and compacting on-disk
   * artefacts. Implementations can ignore the call if they already prune lazily.
   */
  purge?(now?: number): Promise<void>;

  /**
   * Optional readiness probe used by health endpoints. Implementations should
   * resolve when the backing store can accept writes and reject when the
   * orchestrator should temporarily refuse idempotent requests.
   */
  checkHealth?(): Promise<void>;
}

/**
 * Helper resolving the default storage directory used by persistent idempotency
 * stores. Placed here to avoid duplicating the filesystem layout across
 * implementations and tests.
 */
export function resolveIdempotencyDirectory(root: string = process.cwd()): string {
  return resolvePath(root, "runs", "idempotency");
}

/**
 * Small discriminated union describing the JSON Lines format used on disk. The
 * structure is kept intentionally narrow so legacy entries can be forward
 * compatible with future iterations that may add additional metadata.
 */
export type PersistedIdempotencyEntry = {
  /** Canonical cache key computed from the JSON-RPC request. */
  key: string;
  /** HTTP status code originally returned to the caller. */
  status: number;
  /** Serialised JSON payload sent back to the client. */
  body: string;
  /** Expiration timestamp (milliseconds since epoch). */
  exp: number;
  /** Optional diagnostic payload reserved for future features. */
  meta?: unknown;
};
