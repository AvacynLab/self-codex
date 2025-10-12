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

import { after, before } from "mocha";
import type { ErrnoException } from "../src/nodePrimitives.js";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

type RestoreHook = () => void | Promise<void>;

const restores: RestoreHook[] = [];

/**
 * Default test environment variables guaranteeing the HTTP harness boots with a
 * predictable configuration.  The values mirror the checklist expectations so
 * end-to-end suites can rely on them without having to guard for undefined
 * `process.env` entries.
 */
const TEST_ENV_DEFAULTS: Record<string, string> = {
  MCP_HTTP_HOST: "127.0.0.1",
  MCP_HTTP_PORT: "8765",
  MCP_HTTP_PATH: "/mcp",
  MCP_HTTP_JSON: "on",
  MCP_HTTP_STATELESS: "yes",
  MCP_HTTP_TOKEN: "test-token",
  MCP_RUNS_ROOT: "runs",
  MCP_LOG_FILE: "/tmp/self-codex.test.log",
};

for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
  if (!process.env[key] || process.env[key]?.length === 0) {
    process.env[key] = value;
  }
}

/**
 * Parses a comma-separated list of ports and returns the successfully parsed
 * integers.  The helper accepts empty strings and silently drops malformed
 * entries so the guard keeps running even if an environment variable is
 * misconfigured.
 */
function parseAllowedPorts(raw: string | undefined): number[] {
  if (!raw) {
    return [];
  }
  const ports: number[] = [];
  for (const token of raw.split(",")) {
    const trimmed = token.trim();
    if (!trimmed.length) {
      continue;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      ports.push(parsed);
    }
  }
  return ports;
}

/** Normalises IPv4/IPv6 textual representations for comparison. */
function normaliseHost(host: string | undefined): string | undefined {
  if (!host) {
    return undefined;
  }
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface ConnectionTarget {
  host?: string;
  port?: number;
  path?: string;
}

/**
 * Extracts the target host/port/path tuple from the various connection
 * signatures exposed by Node's networking primitives.
 */
function deriveConnectionTarget(args: unknown[]): ConnectionTarget {
  if (args.length === 0) {
    return {};
  }
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const record = first as { host?: string; hostname?: string; port?: number; path?: string };
    return {
      host: record.host ?? record.hostname,
      port: typeof record.port === "number" ? record.port : undefined,
      path: typeof record.path === "string" ? record.path : undefined,
    };
  }
  if (typeof first === "number") {
    const host = typeof args[1] === "string" ? (args[1] as string) : undefined;
    return { host, port: first };
  }
  if (typeof first === "string") {
    // `net.Socket#connect(path)` for UNIX sockets.
    if (first.startsWith("/")) {
      return { path: first };
    }
    const numeric = Number(first);
    if (Number.isInteger(numeric)) {
      const host = typeof args[1] === "string" ? (args[1] as string) : undefined;
      return { host, port: numeric };
    }
    return { host: first };
  }
  return {};
}

/**
 * Validates whether the requested target is whitelisted for loopback traffic.
 * Only explicit loopback hosts and the configured port range are accepted to
 * keep the guard hermetic for external destinations.
 */
function isAllowedLoopback(target: ConnectionTarget, hosts: Set<string>, ports: Set<number>): boolean {
  if (target.path && !target.path.startsWith("\\\\.\\pipe\\")) {
    return false;
  }
  const normalised = normaliseHost(target.host ?? "127.0.0.1");
  if (!normalised || !hosts.has(normalised)) {
    return false;
  }
  if (!target.port) {
    return ports.size === 0;
  }
  if (ports.size === 0) {
    return true;
  }
  return ports.has(target.port);
}

/**
 * Wraps a network primitive so it throws for disallowed destinations while
 * still permitting loopback calls needed by the HTTP end-to-end suites.
 */
function wrapConnectionFunction<T extends (...args: any[]) => any>(
  original: T,
  moduleName: string,
  hosts: Set<string>,
  ports: Set<number>,
  allowLoopback: boolean,
): T {
  const wrapped: T = ((...args: unknown[]) => {
    if (allowLoopback && isAllowedLoopback(deriveConnectionTarget(args), hosts, ports)) {
      return original.apply(this, args as never);
    }
    const error = new Error(
      `network access via ${moduleName} is disabled during tests`,
    ) as ErrnoException;
    error.code = "E-NETWORK-BLOCKED";
    throw error;
  }) as T;

  return wrapped;
}

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
function installNetworkGuards(): void {
  const allowLoopback = (process.env.MCP_TEST_ALLOW_LOOPBACK ?? "no").toLowerCase() !== "no";
  const allowedHosts = new Set(["127.0.0.1", "::1", "localhost"]);

  const extraPorts = parseAllowedPorts(process.env.MCP_TEST_ALLOWED_PORTS);
  const restrictPorts = extraPorts.length > 0;
  const allowedPorts = new Set<number>();

  if (restrictPorts) {
    const configuredPort = Number.parseInt(process.env.MCP_HTTP_PORT ?? "", 10);
    if (Number.isInteger(configuredPort) && configuredPort > 0) {
      allowedPorts.add(configuredPort);
    }
    for (const extra of extraPorts) {
      allowedPorts.add(extra);
    }
  }

  const originalHttpCreate = HttpAgent.prototype.createConnection;
  HttpAgent.prototype.createConnection = wrapConnectionFunction(
    originalHttpCreate,
    "http.Agent#createConnection",
    allowedHosts,
    allowedPorts,
    allowLoopback,
  );
  restores.push(() => {
    HttpAgent.prototype.createConnection = originalHttpCreate;
  });

  const originalHttpsCreate = HttpsAgent.prototype.createConnection;
  HttpsAgent.prototype.createConnection = wrapConnectionFunction(
    originalHttpsCreate,
    "https.Agent#createConnection",
    allowedHosts,
    allowedPorts,
    allowLoopback,
  );
  restores.push(() => {
    HttpsAgent.prototype.createConnection = originalHttpsCreate;
  });

  const originalSocketConnect = Socket.prototype.connect;
  Socket.prototype.connect = wrapConnectionFunction(
    originalSocketConnect,
    "net.Socket#connect",
    allowedHosts,
    allowedPorts,
    allowLoopback,
  );
  restores.push(() => {
    Socket.prototype.connect = originalSocketConnect;
  });

  const originalTlsConnect = TLSSocket.prototype.connect;
  TLSSocket.prototype.connect = wrapConnectionFunction(
    originalTlsConnect,
    "tls.TLSSocket#connect",
    allowedHosts,
    allowedPorts,
    allowLoopback,
  );
  restores.push(() => {
    TLSSocket.prototype.connect = originalTlsConnect;
  });

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const targetUrl = extractRequestUrl(input);
      if (
        allowLoopback &&
        targetUrl &&
        isAllowedLoopback(
          {
            host: targetUrl.hostname,
            port: inferPortFromUrl(targetUrl),
          },
          allowedHosts,
          allowedPorts,
        )
      ) {
        return originalFetch(input, init);
      }
      const error = new Error("network access via fetch is disabled during tests") as ErrnoException;
      error.code = "E-NETWORK-BLOCKED";
      throw error;
    }) as typeof fetch;

    restores.push(() => {
      globalThis.fetch = originalFetch;
    });
  }

  (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__ = allowLoopback
    ? "loopback-only"
    : "network-blocked";
}

/** Extracts a URL instance from the WHATWG fetch signature. */
function extractRequestUrl(input: Parameters<typeof fetch>[0]): URL | null {
  if (typeof input === "string") {
    try {
      return new URL(input);
    } catch {
      return null;
    }
  }
  if (input instanceof URL) {
    return input;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return new URL(input.url);
  }
  return null;
}

/**
 * Infers the numeric port from a URL, accounting for protocol defaults when no
 * explicit port is present.
 */
function inferPortFromUrl(url: URL): number | undefined {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  if (url.protocol === "http:") {
    return 80;
  }
  if (url.protocol === "https:") {
    return 443;
  }
  return undefined;
}

installDeterministicRandom();
installNetworkGuards();

let autoHttpServer: ChildProcessWithoutNullStreams | null = null;

/**
 * Launches the compiled HTTP server in a detached child process when requested
 * via `MCP_TEST_AUTO_SERVER=yes`.  The harness removes the need for manual
 * setup before running the end-to-end suites while keeping the default
 * behaviour (no extra processes) untouched.
 */
before(async function () {
  if ((process.env.MCP_TEST_AUTO_SERVER ?? "no").toLowerCase() !== "yes") {
    return;
  }

  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? "8765", 10);
  const path = process.env.MCP_HTTP_PATH ?? "/mcp";
  const args = [
    resolvePath("dist/server.js"),
    "--no-stdio",
    "--http",
    "--http-host",
    host,
    "--http-port",
    String(port),
    "--http-path",
    path,
    "--http-json",
    "--http-stateless",
  ];

  autoHttpServer = spawn(process.execPath, args, {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const readinessUrl = new URL(path, `http://${host}:${port}`);
  try {
    await waitForHttpServer(readinessUrl);
  } catch (error) {
    autoHttpServer.kill("SIGTERM");
    await once(autoHttpServer, "exit").catch(() => undefined);
    autoHttpServer = null;
    throw error;
  }
});

/** Polls the HTTP endpoint until the orchestrator responds with JSON-RPC. */
async function waitForHttpServer(url: URL): Promise<void> {
  const token = process.env.MCP_HTTP_TOKEN;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: "health-check", method: "mcp_info", params: {} }),
      });
      if (response.status === 200 || response.status === 401) {
        return;
      }
    } catch {
      // Intentionally ignored: the server might not be ready yet.
    }
    await delay(100);
  }
  throw new Error(`HTTP server at ${url.toString()} did not become ready in time`);
}

after(async () => {
  while (restores.length > 0) {
    const restore = restores.pop();
    await restore?.();
  }

  if (autoHttpServer) {
    autoHttpServer.kill("SIGTERM");
    await once(autoHttpServer, "exit").catch(() => undefined);
    autoHttpServer = null;
  }
});

