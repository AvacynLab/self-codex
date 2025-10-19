import { readOptionalBool, readOptionalNumber } from "../config/env.js";

/**
 * Token-bucket rate limiter keyed by caller identity. The buckets are stored in
 * memory because stateless HTTP requests only require a lightweight guard to
 * prevent accidental overload; limits are intentionally conservative so the
 * server can still absorb short bursts.
 */
const buckets = new Map<string, { tokens: number; ts: number }>();

/**
 * Consumes a single token from the bucket associated with {@link key}. The
 * bucket refills at the configured rate and is capped by the provided burst
 * size. Callers should drop the request when the function returns `false`.
 */
export function rateLimitOk(key: string, rps = 10, burst = 20): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: burst, ts: now };

  // Refill proportionally to the elapsed time since the last check. Fractional
  // tokens are kept to provide smoother refills even at low rates.
  const refill = ((now - bucket.ts) / 1000) * rps;
  bucket.tokens = Math.min(burst, bucket.tokens + refill);
  bucket.ts = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

/**
 * Resets all buckets. Exposed for unit tests to keep deterministic behaviour
 * across runs and to avoid coupling tests through shared limiter state.
 */
export function resetRateLimitBuckets(): void {
  buckets.clear();
}

/**
 * Parses a boolean environment variable while tolerating common human-friendly
 * variants. Returning `undefined` allows callers to fall back to defaults when
 * the variable is not provided or contains an unexpected value.
 */
export function parseRateLimitEnvBoolean(name: string): boolean | undefined {
  return readOptionalBool(name);
}

/** Reads a numeric rate limit tuning parameter from the environment. */
export function parseRateLimitEnvNumber(name: string): number | undefined {
  return readOptionalNumber(name);
}
