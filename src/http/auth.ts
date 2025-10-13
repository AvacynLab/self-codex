import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

/**
 * Performs a time-constant comparison between the bearer token supplied by the
 * client and the secret configured on the server. The guard avoids leaking
 * information about the expected token length through early returns while still
 * allowing the caller to check for missing credentials.
 */
export function tokenOk(reqToken: string | undefined, required: string): boolean {
  if (!reqToken) {
    return false;
  }

  // Convert both tokens to buffers to let {@link timingSafeEqual} operate on the
  // binary representation and avoid Unicode corner cases.
  const provided = Buffer.from(reqToken);
  const expected = Buffer.from(required);

  // Short-circuit when the lengths differ: timingSafeEqual would throw in that
  // situation, so the explicit check keeps the control flow predictable.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
