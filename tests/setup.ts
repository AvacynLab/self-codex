/**
 * Mocha bootstrap that enforces the hygiene guarantees mandated by the
 * repository checklist:
 *
 * 1. All sources of pseudo-randomness must be seeded deterministically so that
 *    flaky behaviour caused by different RNG sequences is eliminated.  We
 *    replace `Math.random` with a lightweight linear congruential generator
 *    whose seed is derived from the `TEST_RANDOM_SEED` environment variable (or
 *    a stable default).  The implementation follows the Park–Miller LCG
 *    (modulus 2^31-1, multiplier 48271) which has well-documented statistical
 *    properties and is sufficient for predictable test runs.
 *
 * 2. Any attempt to reach the network layer must fail fast.  Tests are
 *    required to stay hermetic, so we patch the low-level connection factories
 *    (`http.Agent#createConnection`, `https.Agent#createConnection`,
 *    `net.Socket#connect`, `tls.TLSSocket#connect`) and the WHATWG `fetch` API
 *    to throw a clear `E-NETWORK-BLOCKED` error that explains why the access is
 *    denied.  The
 *    original implementations are restored once the Mocha process finishes so
 *    developers can keep using the runtime normally outside of the test suite.
 */

import { after } from "mocha";
import type { ErrnoException } from "../src/nodePrimitives.js";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Socket } from "node:net";
import { TLSSocket } from "node:tls";

type RestoreHook = () => void;

const restores: RestoreHook[] = [];

/**
 * Public token mirroring the default deterministic seed.  Exported so unit
 * tests can validate reproducibility without duplicating environment logic.
 */
export const DEFAULT_TEST_RANDOM_SEED =
  process.env.TEST_RANDOM_SEED ?? "self-codex::tests";

/**
 * Computes a strictly positive 31-bit seed from the provided token by folding
 * the string with a simple polynomial rolling hash.  The modulus mirrors the
 * Park–Miller generator to guarantee the resulting state remains inside the
 * expected range even for long input strings.
 */
function deriveSeed(token: string): number {
  let hash = 0;
  for (let index = 0; index < token.length; index += 1) {
    hash = (hash * 31 + token.charCodeAt(index)) % 2147483647;
  }
  // The LCG expects a non-zero seed.  Fall back to 1 when the hash collapses
  // to zero (for example when `token` is an empty string).
  return hash === 0 ? 1 : hash;
}

/**
 * Installs the deterministic RNG and registers a restoration hook so we do not
 * leak the patched implementation outside the test lifecycle.
 */
export function createDeterministicRandom(seedToken = DEFAULT_TEST_RANDOM_SEED) {
  const modulus = 2147483647; // 2^31 - 1
  const multiplier = 48271; // Park–Miller recommended multiplier
  let state = deriveSeed(seedToken);

  return () => {
    state = (state * multiplier) % modulus;
    return (state - 1) / (modulus - 1);
  };
}

function installDeterministicRandom(): void {
  const originalRandom = Math.random;
  const prng = createDeterministicRandom(DEFAULT_TEST_RANDOM_SEED);

  Math.random = () => prng();

  restores.push(() => {
    Math.random = originalRandom;
  });
}

/**
 * Utility that replaces a network primitive by a throwing shim explaining that
 * outbound access is forbidden inside the tests.  The shim preserves the
 * synchronous/asynchronous nature of the original function by always throwing
 * synchronously which causes immediate rejection for Promise-returning APIs
 * such as `fetch`.
 */
function blockFunction<T extends (...args: any[]) => any>(
  target: { [key: string]: unknown },
  name: string,
  moduleName: string,
): void {
  const original = target[name] as T;
  const blocker: T = ((..._args: unknown[]) => {
    const error = new Error(
      `network access via ${moduleName}.${name} is disabled during tests`,
    ) as ErrnoException;
    error.code = "E-NETWORK-BLOCKED";
    throw error;
  }) as T;

  target[name] = blocker;
  restores.push(() => {
    target[name] = original;
  });
}

/**
 * Installs the network guards across Node's classic HTTP clients and the
 * WHATWG `fetch` API.
 */
function installNetworkGuards(): void {
  blockFunction(HttpAgent.prototype as Record<string, unknown>, "createConnection", "http.Agent#");
  blockFunction(HttpsAgent.prototype as Record<string, unknown>, "createConnection", "https.Agent#");
  blockFunction(Socket.prototype as Record<string, unknown>, "connect", "net.Socket#");
  blockFunction(TLSSocket.prototype as Record<string, unknown>, "connect", "tls.TLSSocket#");

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      const error = new Error(
        "network access via fetch is disabled during tests",
      ) as ErrnoException;
      error.code = "E-NETWORK-BLOCKED";
      return Promise.reject(error);
    }) as typeof fetch;

    restores.push(() => {
      globalThis.fetch = originalFetch;
    });
  }
}

installDeterministicRandom();
installNetworkGuards();

/**
 * Signal to higher-level suites that network access has been disabled so they
 * can gracefully opt-out instead of tripping the guard intentionally.  The
 * HTTP end-to-end suites check this flag in their Mocha `before` hooks and
 * call `this.skip()` when the hermetic environment forbids real socket
 * connections.  Keeping the flag in sync with the guard helps the suites make
 * an explicit decision instead of relying on an exception being thrown.
 */
(globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__ =
  "network-blocked";

after(() => {
  while (restores.length > 0) {
    const restore = restores.pop();
    restore?.();
  }
});

