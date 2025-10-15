import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

/**
 * Performs a constant-time equality check between the token extracted from the
 * HTTP request and the secret configured on the server. Returning `false`
 * rather than throwing keeps the caller logic straightforward while ensuring we
 * never leak information about partial matches or missing credentials.
 *
 * @param reqToken - Value extracted from the `Authorization` header, if any.
 * @param expected - Secret the server expects clients to present.
 */
export function checkToken(reqToken: string | undefined, expected: string): boolean {
  if (!reqToken || expected.length === 0) {
    // Refuse authentication attempts when the caller omitted the header or the
    // server configuration is empty. Returning `false` here ensures the caller
    // consistently routes missing-token scenarios through the rejection path.
    return false;
  }

  // Convert both operands to buffers to provide a consistent representation for
  // {@link timingSafeEqual}, making the comparison independent from the input
  // encoding used by the HTTP client.
  const provided = Buffer.from(reqToken);
  const reference = Buffer.from(expected);

  if (provided.length !== reference.length) {
    // `timingSafeEqual` throws when buffers have different lengths; returning
    // `false` keeps the calling code simple and makes length mismatches
    // indistinguishable from any other authentication failure.
    return false;
  }

  try {
    return timingSafeEqual(provided, reference);
  } catch (error) {
    // In theory converting strings to buffers can still surface runtime errors
    // (for example if the environment lacks sufficient memory). Failing closed
    // prevents an attacker from weaponising such conditions to bypass auth.
    return false;
  }
}
