import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { expect } from "chai";

import { startValidationServer, type SpawnFunction } from "../../src/validationRun/server";
import { type HttpHealthOptions, type HttpProbeResult } from "../../src/validationRun/runtime";
import { type ChildProcessWithoutNullStreams } from "node:child_process";

type VerifyHealthFn = (url: string, options?: HttpHealthOptions) => Promise<HttpProbeResult>;

class FakeChildProcess extends EventEmitter implements ChildProcessWithoutNullStreams {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdio = [this.stdin, this.stdout, this.stderr] as const;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public killed = false;
  public connected = true;
  public readonly spawnargs: string[];
  public readonly spawnfile: string;
  public readonly killInvocations: Array<NodeJS.Signals | number> = [];
  public pid = Math.floor(Math.random() * 10_000) + 1000;

  constructor(command: string, args: readonly string[]) {
    super();
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.killInvocations.push(signal);
    if (this.killed) {
      return true;
    }
    this.killed = true;
    if (typeof signal === "string") {
      this.signalCode = signal;
    }
    queueMicrotask(() => {
      if (this.exitCode === null && this.signalCode === null) {
        this.exitCode = 0;
        this.signalCode = typeof signal === "string" ? signal : null;
      }
      this.connected = false;
      this.stdout.end();
      this.stderr.end();
      this.stdin.end();
      this.emit("exit", this.exitCode, this.signalCode);
    });
    return true;
  }

  send(): boolean {
    return false;
  }

  disconnect(): void {
    this.connected = false;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

}

async function createSandbox(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "validation-server-"));
}

describe("validationRun/server", () => {
  afterEach(async () => {
    // Ensure no listeners leak across tests.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("starts the validation server, configures env defaults and waits for readiness", async () => {
    const sandbox = await createSandbox();
    const root = path.join(sandbox, "validation_run");

    const spawnInvocations: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }>
      = [];
    const fakeProcesses: FakeChildProcess[] = [];
    const spawnImpl: SpawnFunction = (command, args, options) => {
      spawnInvocations.push({ command, args: [...args], env: { ...options.env }, cwd: options.cwd ?? "" });
      const fake = new FakeChildProcess(command, args);
      fakeProcesses.push(fake);
      return fake;
    };

    const probeInvocations: Array<{ url: string; token?: string; expectStatus?: number; timeoutMs?: number }> = [];
    let attempt = 0;
    const verifyHealthStub = async (
      url: string,
      opts?: HttpHealthOptions,
    ): Promise<HttpProbeResult> => {
      const typedOpts = opts ?? {};
      probeInvocations.push({ url, token: typedOpts.token, expectStatus: typedOpts.expectStatus, timeoutMs: typedOpts.timeoutMs });
      attempt += 1;
      if (attempt < 2) {
        return { ok: false, error: "still booting" };
      }
      return { ok: true, statusCode: 204 };
    };

    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };

    const previousToken = process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_TOKEN;

    try {
      const result = await startValidationServer({
        root,
        command: "npm-custom",
        args: ["run", "start:http"],
        logFileName: "custom-server.log",
        host: "0.0.0.0",
        port: 9000,
        path: "api",
        readiness: { maxAttempts: 4, retryIntervalMs: 25, expectStatus: 204, timeoutMs: 1500 },
        spawnImpl,
        verifyHealth: verifyHealthStub as VerifyHealthFn,
        sleep,
        tokenFactory: () => "fixed-token",
      });

      expect(result.handle.logFile).to.equal(path.join(root, "logs", "custom-server.log"));
      expect(result.healthUrl).to.equal("http://0.0.0.0:9000/api/health");
      expect(result.readiness.ok).to.equal(true);
      expect(result.readiness.attempts).to.equal(2);
      expect(sleeps).to.deep.equal([25]);

      expect(spawnInvocations).to.have.lengthOf(1);
      const invocation = spawnInvocations[0];
      expect(invocation.command).to.equal("npm-custom");
      expect(invocation.args).to.deep.equal(["run", "start:http"]);
      expect(invocation.cwd).to.equal(path.resolve(root, ".."));
      expect(invocation.env.MCP_HTTP_HOST).to.equal("0.0.0.0");
      expect(invocation.env.MCP_HTTP_PORT).to.equal("9000");
      expect(invocation.env.MCP_HTTP_PATH).to.equal("/api");
      expect(invocation.env.START_HTTP).to.equal("1");
      expect(invocation.env.MCP_HTTP_JSON).to.equal("on");
      expect(invocation.env.MCP_HTTP_STATELESS).to.equal("yes");
      expect(invocation.env.MCP_HTTP_TOKEN).to.equal("fixed-token");

      expect(probeInvocations).to.deep.equal([
        { url: "http://0.0.0.0:9000/api/health", token: "fixed-token", expectStatus: 204, timeoutMs: 1500 },
        { url: "http://0.0.0.0:9000/api/health", token: "fixed-token", expectStatus: 204, timeoutMs: 1500 },
      ]);

      const logContent = await readFile(result.handle.logFile, "utf8");
      expect(logContent).to.include("# Validation server start");
      expect(logContent).to.include("[health] attempt 1 failed");
      expect(logContent).to.include("[health] attempt 2 succeeded");

      await result.handle.stop();
      expect(fakeProcesses[0].killInvocations).to.deep.equal(["SIGTERM"]);
    } finally {
      if (previousToken === undefined) {
        delete process.env.MCP_HTTP_TOKEN;
      } else {
        process.env.MCP_HTTP_TOKEN = previousToken;
      }
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("stops the process and surfaces readiness failures", async () => {
    const sandbox = await createSandbox();
    const root = path.join(sandbox, "validation_run");

    const fakeProcesses: FakeChildProcess[] = [];
    const spawnImpl: SpawnFunction = (command, args, options) => {
      const fake = new FakeChildProcess(command, args);
      fakeProcesses.push(fake);
      return fake;
    };

    const sleepDurations: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleepDurations.push(ms);
    };

    let probeCount = 0;
    const verifyHealthStub = async (): Promise<HttpProbeResult> => {
      probeCount += 1;
      return { ok: false, error: `unreachable-${probeCount}` };
    };

    const previousToken = process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_TOKEN;

    try {
      const result = await startValidationServer({
        root,
        readiness: { maxAttempts: 3, retryIntervalMs: 10 },
        spawnImpl,
        verifyHealth: verifyHealthStub as VerifyHealthFn,
        sleep,
        tokenFactory: () => "token-failure",
      });

      expect(result.readiness.ok).to.equal(false);
      expect(result.readiness.attempts).to.equal(3);
      expect(result.readiness.lastResult?.error).to.equal("unreachable-3");
      expect(sleepDurations).to.deep.equal([10, 10]);
      expect(fakeProcesses[0].killInvocations).to.include("SIGTERM");

      const logContent = await readFile(result.handle.logFile, "utf8");
      expect(logContent).to.include("[health] attempt 1 failed");
      expect(logContent).to.include("[health] attempt 3 failed");

      await result.handle.stop();
    } finally {
      if (previousToken === undefined) {
        delete process.env.MCP_HTTP_TOKEN;
      } else {
        process.env.MCP_HTTP_TOKEN = previousToken;
      }
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

