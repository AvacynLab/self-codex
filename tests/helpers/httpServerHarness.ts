/**
 * Lightweight harness that boots the compiled MCP HTTP server in a child
 * process and exposes a convenient helper to issue JSON-RPC requests.  The
 * helper is intentionally minimal: it only covers the flows required by the
 * end-to-end authentication and statelessness suites while remaining fully
 * deterministic.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Shape of the harness configuration. */
export interface HttpServerHarnessOptions {
  host: string;
  port: number;
  path: string;
  /** Bearer token enforced by the server (empty string disables auth). */
  token?: string;
  /** Optional environment overrides applied to the child process. */
  env?: NodeJS.ProcessEnv;
}

interface JsonRpcResponse<T = unknown> {
  status: number;
  json: T;
}

/**
 * Spawns the HTTP server and exposes utilities for JSON-RPC interactions.
 * Instances are meant to be short-lived: call {@link start} before running the
 * test assertions and {@link stop} in an `after` hook to reclaim resources.
 */
export class HttpServerHarness {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly options: HttpServerHarnessOptions;
  private readonly baseUrl: URL;

  constructor(options: HttpServerHarnessOptions) {
    this.options = options;
    this.baseUrl = new URL(options.path, `http://${options.host}:${options.port}`);
  }

  /** Starts the child process and waits until the JSON-RPC endpoint responds. */
  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const args = [
      resolvePath("dist/server.js"),
      "--no-stdio",
      "--http",
      "--http-host",
      this.options.host,
      "--http-port",
      String(this.options.port),
      "--http-path",
      this.options.path,
      "--http-json",
      "--http-stateless",
      "--enable-child-ops-fine",
    ];

    this.child = spawn(process.execPath, args, {
      env: { ...process.env, ...this.options.env, MCP_HTTP_TOKEN: this.options.token ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await this.waitForReady();
  }

  /** Issues a JSON-RPC request and returns the parsed payload. */
  async request<T = unknown>(
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<JsonRpcResponse<T>> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const json = (await response.json()) as T;
    return { status: response.status, json };
  }

  /** Stops the child process if it is currently running. */
  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }
    this.child.kill("SIGTERM");
    await once(this.child, "exit").catch(() => undefined);
    this.child = null;
  }

  /** Polls the HTTP endpoint until a JSON-RPC status is observed. */
  private async waitForReady(): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.options.token) {
      headers.authorization = `Bearer ${this.options.token}`;
    }

    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(this.baseUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: "health", method: "mcp_info", params: {} }),
        });
        if (response.status === 200 || response.status === 401) {
          return;
        }
      } catch {
        // Ignore transient failures while the server binds the socket.
      }
      await delay(100);
    }
    throw new Error(`HTTP harness did not become ready at ${this.baseUrl.href}`);
  }
}
