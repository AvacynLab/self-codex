import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
type HttpHeaders = Record<string, string | string[] | undefined>;

const AUTH_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*\s+/;
const RELAXED_BEARER_PATTERN = /^Bearer\s+(.+)$/i;
const STRICT_BEARER_PATTERN = /^Bearer\s+([^\s,;]+)(?:$|[\s,;])/i;

/**
 * Splits comma-separated HTTP header values while preserving quoted segments.
 * The helper keeps digest-style parameters (which use commas within the same
 * credential) grouped together and only performs the split when subsequent
 * fragments look like a new authentication scheme (e.g. `Basic …`).
 *
 * @param rawValue - Header payload exactly as received from the transport.
 */
function splitAuthorizationHeader(rawValue: string): string[] {
  if (!rawValue.includes(",")) {
    return [rawValue];
  }

  const segments: string[] = [];
  let buffer = "";
  let insideQuotes = false;

  for (const char of rawValue) {
    if (char === "\"") {
      insideQuotes = !insideQuotes;
      buffer += char;
      continue;
    }

    if (char === "," && !insideQuotes) {
      segments.push(buffer);
      buffer = "";
      continue;
    }

    buffer += char;
  }

  segments.push(buffer);

  const trimmed = segments.map((segment) => segment.trim()).filter(Boolean);
  const hasFollowUpScheme = trimmed
    .slice(1)
    .some((segment) => AUTH_SCHEME_PATTERN.test(segment));

  return hasFollowUpScheme ? segments : [rawValue];
}

/**
 * Normalises a header entry to an array so callers can iterate deterministically
 * regardless of the shape Node.js used to represent the incoming value.
 */
function normaliseHeaderValues(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

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

/**
 * Extracts the authentication token presented by the HTTP client. The helper
 * first attempts to parse the canonical `Authorization: Bearer …` header and
 * falls back to the `X-MCP-Token` override when present. Returning `undefined`
 * keeps the guard logic straightforward while ensuring callers never receive
 * empty strings that could accidentally pass validation.
 *
 * @param headers - Raw HTTP headers provided by Node's server implementation.
 */
export function resolveHttpAuthToken(headers: HttpHeaders): string | undefined {
  const authorizationValues = normaliseHeaderValues(headers["authorization"]);

  let nonBearerCandidate: string | undefined;

  for (const rawValue of authorizationValues) {
    if (typeof rawValue !== "string") {
      continue;
    }

    const fragments = splitAuthorizationHeader(rawValue);
    const bearerPattern = fragments.length > 1 ? STRICT_BEARER_PATTERN : RELAXED_BEARER_PATTERN;

    for (const fragment of fragments) {
      const trimmed = fragment.trim();
      if (!trimmed) {
        // Skip empty entries that can appear when intermediaries forward
        // duplicated headers or serialise empty strings for optional fields.
        continue;
      }

      const bearerMatch = bearerPattern.exec(trimmed);
      if (bearerMatch) {
        const bearerToken = bearerMatch[1].trim();
        if (bearerToken.length > 0) {
          return bearerToken;
        }
        // Ignore entries such as `Bearer   ` and keep iterating so we can still
        // honour a fallback header value or a later Authorization candidate.
        continue;
      }

      // Remember the first non-empty, non-bearer entry so callers that expect a
      // different scheme (for example custom HMAC signatures) can still receive
      // the raw payload when no bearer token is present. We do not return
      // immediately in order to prefer Bearer tokens that may appear later in the
      // list when multiple headers were provided.
      nonBearerCandidate = nonBearerCandidate ?? trimmed;
    }
  }

  if (nonBearerCandidate) {
    return nonBearerCandidate;
  }

  const fallbackValues = normaliseHeaderValues(headers["x-mcp-token"]);

  for (const rawValue of fallbackValues) {
    if (typeof rawValue !== "string") {
      continue;
    }

    const trimmed = rawValue.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}
