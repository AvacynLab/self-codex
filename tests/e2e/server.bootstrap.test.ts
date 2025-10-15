import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { HttpReadinessReport } from "../../src/http/readiness.js";

// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

type ObservedLogEntry = {
  raw: string;
  parsed?: {
    level?: string;
    message?: string;
    payload?: Record<string, unknown>;
  };
};

interface LogWaiter {
  predicate: (entry: ObservedLogEntry) => boolean;
  resolve: (entry: ObservedLogEntry) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Creates a line-oriented JSON log observer so the test can wait for specific
 * structured entries without resorting to brittle regular expressions.
 */
function createLogObserver(stream: NodeJS.ReadableStream): {
  waitFor(predicate: (entry: ObservedLogEntry) => boolean, timeoutMs?: number): Promise<ObservedLogEntry>;
} {
  let buffer = "";
  const waiters: LogWaiter[] = [];
  const history: ObservedLogEntry[] = [];

  const flushEntry = (line: string) => {
    if (!line) {
      return;
    }
    const entry: ObservedLogEntry = { raw: line };
    try {
      entry.parsed = JSON.parse(line) as ObservedLogEntry["parsed"];
    } catch {
      // Leave the raw payload untouched when the line is not valid JSON.
    }

    history.push(entry);

    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      if (waiter.predicate(entry)) {
        clearTimeout(waiter.timer);
        waiters.splice(index, 1);
        waiter.resolve(entry);
        return;
      }
    }
  };

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      flushEntry(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  const rejectPending = (reason: Error) => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  };

  stream.once("end", () => {
    rejectPending(new Error("log stream ended before condition was satisfied"));
  });
  stream.once("error", (error) => {
    rejectPending(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    waitFor(predicate: (entry: ObservedLogEntry) => boolean, timeoutMs = 30_000): Promise<ObservedLogEntry> {
      return new Promise<ObservedLogEntry>((resolve, reject) => {
        for (const entry of history) {
          if (predicate(entry)) {
            resolve(entry);
            return;
          }
        }

        const timer = setTimeout(() => {
          const message = "Timed out waiting for matching log entry.";
          const error = new Error(message);
          const index = waiters.findIndex((candidate) => candidate.timer === timer);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(error);
        }, timeoutMs).unref();

        waiters.push({ predicate, resolve, reject, timer });
      });
    },
  };
}

/**
 * Allocates an ephemeral localhost port so the orchestrator can bind its HTTP
 * surface without colliding with other tests executed in parallel.
 */
async function allocateHttpPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();

    const closeAndReject = (error: Error) => {
      server.close(() => {
        reject(error);
      });
    };

    server.on("error", (error) => {
      closeAndReject(error instanceof Error ? error : new Error(String(error)));
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        closeAndReject(new Error("Unable to determine listening port"));
        return;
      }
      const { port } = address as AddressInfo;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

/**
 * Polls `/readyz` until the orchestrator reports an healthy status or the
 * timeout expires. Network failures are tolerated while the transport starts.
 */
async function waitForHttpReadiness(baseUrl: string, token: string, timeoutMs: number): Promise<HttpReadinessReport> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const result = await fetchJson(baseUrl, "/readyz", token);
    if (result.status === 200 && result.body && typeof result.body === "object" && (result.body as HttpReadinessReport).ok) {
      return result.body as HttpReadinessReport;
    }
    lastError = result.body ?? result.error ?? result.status;
    await delay(500);
  }
  throw new Error(`Readiness probe did not succeed within ${timeoutMs}ms: ${JSON.stringify(lastError)}`);
}

async function fetchJson(baseUrl: string, path: string, token: string): Promise<{
  status: number | null;
  body: unknown;
  error?: unknown;
}> {
  return new Promise((resolve) => {
    const probeScript = fileURLToPath(new URL("../lib/httpProbe.cjs", import.meta.url));
    const probe = spawn(process.execPath, [probeScript], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HTTP_PROBE_BASE_URL: baseUrl,
        HTTP_PROBE_PATH: path,
        HTTP_PROBE_TOKEN: token,
      },
    });

    let stdout = "";
    let stderr = "";
    probe.stdout.setEncoding("utf8");
    probe.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    probe.stderr.setEncoding("utf8");
    probe.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    probe.on("error", (error) => {
      resolve({ status: null, body: null, error });
    });

    probe.on("exit", () => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({ status: null, body: null, error: stderr.trim() });
        return;
      }
      try {
        const payload = JSON.parse(trimmed) as { status: number | null; body: string; error?: string };
        let parsedBody: unknown = null;
        if (payload.body) {
          try {
            parsedBody = JSON.parse(payload.body);
          } catch {
            parsedBody = payload.body;
          }
        }
        resolve({ status: payload.status, body: parsedBody, error: payload.error });
      } catch (error) {
        resolve({ status: null, body: null, error: error instanceof Error ? error : new Error(String(error)) });
      }
    });
  });
}

async function waitForProcessExit(
  exitPromise: Promise<[number | null, NodeJS.Signals | null]>,
  timeoutMs: number,
): Promise<[number | null, NodeJS.Signals | null]> {
  return Promise.race([
    exitPromise,
    delay(timeoutMs).then(() => {
      throw new Error(`Server did not terminate within ${timeoutMs}ms`);
    }),
  ]);
}

describe("server bootstrap", function () {
  this.timeout(120_000);

  it("starts via CLI, exposes healthy probes, and shuts down gracefully", async function () {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "self-codex-server-"));
    const runsRoot = join(workspaceRoot, "runs");
    const childrenRoot = join(workspaceRoot, "children");
    await mkdir(runsRoot, { recursive: true });
    await mkdir(childrenRoot, { recursive: true });
    const logFile = join(workspaceRoot, "orchestrator.log");

    const port = await allocateHttpPort();
    const token = `test-${randomUUID()}`;

    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/server.ts",
        "--no-stdio",
        "--http",
        "--http-host",
        "127.0.0.1",
        "--http-port",
        String(port),
        "--http-path",
        "/mcp",
        "--http-json",
        "on",
        "--http-stateless",
        "yes",
        "--max-event-history",
        "32",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          MCP_RUNS_ROOT: runsRoot,
          MCP_CHILDREN_ROOT: childrenRoot,
          MCP_HTTP_TOKEN: token,
          MCP_LOG_FILE: logFile,
          MCP_LOG_ROTATE_SIZE: "1m",
          MCP_LOG_ROTATE_KEEP: "2",
          MCP_LOG_REDACT: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    if (!child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      throw new Error("Child process streams were not initialised");
    }

    const logs = createLogObserver(child.stdout);
    const stderrBuffer: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderrBuffer.push(chunk));

    let exitResult: [number | null, NodeJS.Signals | null] | null = null;
    const exitPromise = once(child, "exit").then((result) => {
      exitResult = result as [number | null, NodeJS.Signals | null];
      return exitResult;
    });

    try {
      await Promise.race([
        logs.waitFor((entry) => entry.parsed?.message === "runtime_started", 45_000),
        exitPromise.then(([code, signal]) => {
          const stderr = stderrBuffer.join("");
          throw new Error(
            `Server exited before signalling readiness (code=${code}, signal=${signal}). stderr=${stderr.trim()}`,
          );
        }),
      ]);

      const baseUrl = `http://127.0.0.1:${port}`;
      const readiness = await waitForHttpReadiness(baseUrl, token, 45_000);
      assert.ok(readiness.ok, "Readiness probe should succeed once the server finishes preloading");
      assert.equal(readiness.components.graphForge.ok, true, "Graph Forge must report ready status");
      assert.equal(readiness.components.runsDirectory.ok, true, "runs/ directory must be writable");
      assert.ok(
        readiness.components.runsDirectory.path.startsWith(runsRoot),
        `Expected runs directory to live under ${runsRoot}, received ${readiness.components.runsDirectory.path}`,
      );

      const health = await fetchJson(baseUrl, "/healthz", token);
      assert.equal(health.status, 200, "Health probe should return HTTP 200");
      assert.equal((health.body as { ok?: boolean } | null)?.ok, true, "Health payload should report ok=true");

      await logs
        .waitFor((entry) => entry.parsed?.message === "http_readyz" && entry.parsed?.payload?.status === 200, 10_000)
        .catch(() => undefined);
    } finally {
      if (!exitResult) {
        child.kill("SIGINT");
      }
    }

    let exitOutcome: [number | null, NodeJS.Signals | null];
    try {
      exitOutcome = await waitForProcessExit(exitPromise, 20_000);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }

    const [code, signal] = exitOutcome;
    assert.strictEqual(code, 0, `Server should exit cleanly after SIGINT (received code=${code}, signal=${signal})`);
    assert.strictEqual(signal, null, "Server should terminate via exit(0) and not due to a secondary signal");

    await logs.waitFor((entry) => entry.parsed?.message === "shutdown_signal", 10_000).catch(() => undefined);
  });
});
