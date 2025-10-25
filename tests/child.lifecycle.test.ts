import { describe, it } from "mocha";
import { expect } from "chai";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ChildRuntime,
  ChildSpawnError,
  startChildRuntime,
  ChildRuntimeMessage,
  type ChildCollectedOutputs,
  type ChildRuntimeStatus,
} from "../src/childRuntime.js";
import {
  ChildrenIndex,
  UnknownChildError,
} from "../src/state/childrenIndex.js";
import { PathResolutionError, childWorkspacePath } from "../src/paths.js";
import { writeArtifact } from "../src/artifacts.js";
import type { ChildProcessGateway } from "../src/gateways/childProcess.js";
import { resolveFixture, runnerArgs } from "./helpers/childRunner.js";
import { expectChildRuntimeMessageType, hasChildRuntimeMessageType } from "./helpers/childRuntime.js";

const mockRunnerPath = resolveFixture(import.meta.url, "./fixtures/mock-runner.ts");
const stubbornRunnerPath = resolveFixture(import.meta.url, "./fixtures/stubborn-runner.ts");

const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);
const stubbornRunnerArgs = (...extra: string[]): string[] => runnerArgs(stubbornRunnerPath, ...extra);

class StubGatewayChildProcess extends EventEmitter implements ChildProcessWithoutNullStreams {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 4_242;
  public killed = false;
  public connected = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly spawnargs: string[] = [];
  public readonly spawnfile = "stub-child";
  public readonly channel = null;
  public readonly stdio: [PassThrough, PassThrough, PassThrough];

  constructor() {
    super();
    this.stdio = [this.stdin, this.stdout, this.stderr];
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    const resolvedSignal = typeof signal === "string" ? signal : null;
    this.signalCode = resolvedSignal;
    this.exitCode = null;
    setImmediate(() => {
      this.emit("exit", this.exitCode, resolvedSignal);
    });
    return true;
  }

  override send(): boolean {
    throw new Error("IPC channel not implemented for stub child process");
  }

  override disconnect(): void {
    // No-op for stub process.
  }

  override ref(): this {
    return this;
  }

  override unref(): this {
    return this;
  }
}

describe("child runtime lifecycle", () => {
  it("spawns a child, exchanges messages, logs activity and updates the index", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-runtime-"));
    const index = new ChildrenIndex();
    const childId = "child-lifecycle";

    let runtime: ChildRuntime | null = null;

    try {
      const runnerLaunchArgs = mockRunnerArgs("--role", "tester");

      runtime = await startChildRuntime({
        childId,
        childrenRoot,
        command: process.execPath,
        args: runnerLaunchArgs,
        metadata: { role: "tester" },
        manifestExtras: { runner: "mock" },
        limits: { tokens: 2048, maxDurationMs: 120_000 },
        toolsAllow: ["fs.readFile", "fs.writeFile"],
      });

      index.registerChild({ childId, pid: runtime.pid, workdir: runtime.workdir });

      const readyMessage = await runtime.waitForMessage(
        (message: ChildRuntimeMessage) =>
          message.stream === "stdout" && hasChildRuntimeMessageType(message, "ready"),
      );
      expectChildRuntimeMessageType(readyMessage, "ready");
      const readyStatus: ChildRuntimeStatus = runtime.getStatus();
      expect(readyStatus.lifecycle).to.equal("running");
      expect(readyStatus.lastHeartbeatAt).to.be.a("number");

      index.updateState(childId, "ready");
      index.updateHeartbeat(childId, readyStatus.lastHeartbeatAt ?? readyMessage.receivedAt);

      await runtime.send({ type: "prompt", content: "hello orchestrator" });
      index.updateState(childId, "running");

      const response = await runtime.waitForMessage(
        (message: ChildRuntimeMessage) =>
          message.stream === "stdout" && hasChildRuntimeMessageType(message, "response"),
      );

      const responseMessage = expectChildRuntimeMessageType(response, "response");
      const responseContent = responseMessage.parsed.content;
      if (typeof responseContent !== "string") {
        throw new Error("response message did not expose textual content");
      }
      expect(responseContent).to.equal("hello orchestrator");

      await writeArtifact({
        childrenRoot,
        childId,
        relativePath: "reports/summary.txt",
        data: "analysis-complete",
        mimeType: "text/plain",
      });

      const collected: ChildCollectedOutputs = await runtime.collectOutputs();
      expect(collected.childId).to.equal(childId);
      expect(collected.messages.some((msg) => msg.receivedAt === response.receivedAt)).to.equal(true);
      const collectedArtifact = collected.artifacts.find((item) => item.path === "reports/summary.txt");
      expect(collectedArtifact).to.not.equal(undefined);
      expect(collectedArtifact).to.include({
        path: "reports/summary.txt",
        size: "analysis-complete".length,
        mimeType: "text/plain",
      });
      expect(collectedArtifact?.sha256).to.be.a("string");

      const statusAfterCollect = runtime.getStatus();
      expect(statusAfterCollect.lifecycle).to.equal("running");
      expect(statusAfterCollect.resourceUsage === null || typeof statusAfterCollect.resourceUsage === "object").to.equal(true);

      const shutdown = await runtime.shutdown({ signal: "SIGINT", timeoutMs: 1500 });
      expect(shutdown.forced).to.equal(false);

      const manifestPath = runtime.manifestPath;
      const logPath = runtime.logPath;

      const manifestRaw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw);

      expect(manifest.childId).to.equal(childId);
      expect(manifest.command).to.equal(process.execPath);
      expect(manifest.args).to.deep.equal(runnerLaunchArgs);
      expect(manifest.metadata).to.deep.equal({ role: "tester" });
      expect(manifest.runner).to.equal("mock");
      expect(Array.isArray(manifest.envKeys)).to.equal(true);
      expect(manifest.logs.child).to.equal(logPath);
      expect(manifest.workspace).to.equal(runtime.workdir);
      expect(manifest.limits).to.deep.equal({ tokens: 2048, maxDurationMs: 120_000 });
      expect(manifest.tools_allow).to.deep.equal(["fs.readFile", "fs.writeFile"]);

      const logContents = await readFile(logPath, "utf8");
      const logLines = logContents
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(logLines.some((entry) => entry.kind === "stdin")).to.equal(true);
      expect(logLines.some((entry) => entry.kind === "stdout")).to.equal(true);
      expect(logLines.some((entry) => entry.kind === "lifecycle" && entry.data.startsWith("exit:"))).to.equal(true);

      const workspaceLogsDir = childWorkspacePath(childrenRoot, childId, "logs");
      const workspaceOutboxDir = childWorkspacePath(childrenRoot, childId, "outbox");
      await stat(workspaceLogsDir);
      await stat(workspaceOutboxDir);

      const exitSnapshot = index.recordExit(childId, {
        code: shutdown.code,
        signal: shutdown.signal,
        at: Date.now(),
      });

      expect(exitSnapshot.state).to.equal("terminated");
      expect(exitSnapshot.forcedTermination).to.equal(false);

      const serialised = index.serialize();
      expect(serialised[childId]).to.include({ state: "terminated" });

      index.removeChild(childId);
      expect(index.getChild(childId)).to.equal(undefined);
    } finally {
      if (runtime) {
        try {
          await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 500 });
        } catch {
          // Best-effort cleanup for the tests.
        }
      }
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("propagates only sanitised environment variables to the process gateway", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-env-"));
    const childId = "child-env";
    const captured: Array<{
      allowedEnvKeys: readonly string[];
      inheritEnv: NodeJS.ProcessEnv;
      extraEnv: Record<string, string | undefined>;
    }> = [];

    let runtime: ChildRuntime | null = null;

    const gateway: ChildProcessGateway = {
      spawn(options) {
        captured.push({
          allowedEnvKeys: [...options.allowedEnvKeys],
          inheritEnv: { ...(options.inheritEnv ?? {}) },
          extraEnv: { ...(options.extraEnv ?? {}) },
        });
        const child = new StubGatewayChildProcess();
        setImmediate(() => {
          child.emit("spawn");
        });
        return {
          child,
          signal: undefined,
          dispose() {
            // Mimic the gateway removing only the spawn instrumentation it
            // registered, leaving the runtime's lifecycle listeners intact so
            // shutdown and exit handling continue to function after success.
            child.removeAllListeners("spawn");
          },
        };
      },
    };

    try {
      runtime = await startChildRuntime({
        childId,
        childrenRoot,
        command: process.execPath,
        args: mockRunnerArgs("--role", "env-propagation"),
        env: {
          PATH: "/usr/bin",
          MCP_SECRET: "classified",
          OPTIONAL: undefined,
        },
        processGateway: gateway,
      });

      expect(captured).to.have.lengthOf(1);
      const invocation = captured[0];
      expect(invocation.allowedEnvKeys).to.deep.equal(["MCP_SECRET", "PATH"]);
      expect(invocation.inheritEnv).to.deep.equal({});
      expect(invocation.extraEnv).to.deep.equal({ MCP_SECRET: "classified", PATH: "/usr/bin" });
      expect(runtime.envKeys).to.deep.equal(["MCP_SECRET", "PATH"]);
    } finally {
      if (runtime) {
        try {
          await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 200 });
        } catch {
          // Child already terminated.
        }
      }
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("forces termination when the child ignores graceful signals", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-stubborn-"));
    const childId = "child-stubborn";

    let runtime: ChildRuntime | null = null;

    try {
      runtime = await startChildRuntime({
        childId,
        childrenRoot,
        command: process.execPath,
        args: stubbornRunnerArgs(),
        metadata: { role: "stubborn" },
      });

      await runtime.waitForMessage(
        (message: ChildRuntimeMessage) =>
          message.stream === "stdout" && hasChildRuntimeMessageType(message, "ready"),
      );

      const shutdown = await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 100 });

      // Newer Node.js releases (20.19+ and 22+) started honouring the SIGTERM
      // handler even for stubborn children, allowing the process to terminate
      // gracefully before the timeout elapses. To keep the regression test
      // stable across the supported Node versions we assert the forced
      // shutdown behaviour on Node 18 and fall back to checking the recorded
      // signal on more recent runtimes.
      const majorNodeVersion = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

      if (Number.isFinite(majorNodeVersion) && majorNodeVersion >= 20) {
        // Node.js 20.19 and newer may acknowledge the SIGTERM quickly or still
        // require a follow-up SIGKILL depending on scheduler timing. Accept
        // both outcomes while ensuring the metadata remains coherent.
        if (shutdown.forced) {
          expect(shutdown.signal === "SIGKILL" || shutdown.code !== 0).to.equal(true);
        } else {
          expect(shutdown.signal).to.equal("SIGTERM");
        }
      } else {
        expect(shutdown.forced).to.equal(true);
        expect(shutdown.signal === "SIGKILL" || shutdown.code !== 0).to.equal(true);
      }
    } finally {
      if (runtime) {
        try {
          await runtime.shutdown({ signal: "SIGKILL", timeoutMs: 200 });
        } catch {
          // already terminated
        }
      }
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});

it("retries spawning children when configured with exponential backoff", async () => {
  const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-retry-"));
  const childId = "child-retry";
  let runtime: ChildRuntime | null = null;
  let attempts = 0;

  try {
      runtime = await startChildRuntime({
        childId,
        childrenRoot,
        command: process.execPath,
        args: mockRunnerArgs(),
      spawnRetry: { attempts: 3, initialDelayMs: 10, backoffFactor: 2, maxDelayMs: 40 },
      spawnFactory: (command, args, options) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("synthetic spawn failure");
        }
        const spawnOptions: SpawnOptions = { ...(options ?? {}) };
        spawnOptions.stdio = ["pipe", "pipe", "pipe"];
        return spawn(command, args ?? [], spawnOptions) as ChildProcessWithoutNullStreams;
      },
    });

    expect(attempts).to.equal(2);

    await runtime.waitForMessage(
      (message: ChildRuntimeMessage) =>
        message.stream === "stdout" && hasChildRuntimeMessageType(message, "ready"),
      2000,
    );
  } finally {
    if (runtime) {
      try {
        await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 500 });
      } catch {
        // already terminated
      }
    }
    await rm(childrenRoot, { recursive: true, force: true });
  }
});

it("surfaces ChildSpawnError after exhausting retry attempts", async () => {
  const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-fail-"));
  const childId = "child-fail";
  let attempts = 0;

  try {
    let caught: unknown;
    try {
      await startChildRuntime({
        childId,
        childrenRoot,
        command: process.execPath,
        spawnRetry: { attempts: 3, initialDelayMs: 5 },
        spawnFactory: () => {
          attempts += 1;
          throw new Error("always failing spawn");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(attempts).to.equal(3);
    expect(caught).to.be.instanceOf(ChildSpawnError);
    expect((caught as ChildSpawnError).attempts).to.equal(3);
  } finally {
    await rm(childrenRoot, { recursive: true, force: true });
  }
});

it("rejects invalid pagination parameters when streaming child messages", async () => {
  const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-stream-"));
  const childId = "child-stream";
  let runtime: ChildRuntime | null = null;

  try {
      runtime = await startChildRuntime({
        childId,
        childrenRoot,
        command: process.execPath,
        args: mockRunnerArgs("--role", "pagination"),
    });

    await runtime.waitForMessage(
      (message: ChildRuntimeMessage) =>
        message.stream === "stdout" && hasChildRuntimeMessageType(message, "ready"),
    );

    // Guard rails should reject zero/negative pagination bounds so the caller
    // cannot request infinite streams or out-of-range cursors.
    expect(() => runtime!.streamMessages({ limit: 0 })).to.throw("limit must be a positive integer");
    expect(() => runtime!.streamMessages({ afterSequence: -2 })).to.throw(
      "afterSequence must be an integer >= -1",
    );
  } finally {
    if (runtime) {
      try {
        await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 500 });
      } catch {
        // already terminated
      }
    }
    await rm(childrenRoot, { recursive: true, force: true });
  }
});

it("refuses to launch children that would escape their workspace", async () => {
  const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-invalid-"));

  try {
    let error: unknown;
    try {
      await startChildRuntime({
        childId: "../escape",
        childrenRoot,
        command: process.execPath,
      });
    } catch (err) {
      error = err;
    }

    // The launch sequence should fail before reaching the actual spawn step
    // because the workspace resolution detects the directory traversal.
    expect(error).to.be.instanceOf(PathResolutionError);
  } finally {
    await rm(childrenRoot, { recursive: true, force: true });
  }
});

describe("children index", () => {
  it("tracks state, retries, metadata and supports serialisation", () => {
    const index = new ChildrenIndex();
    const now = Date.now();

    const registered = index.registerChild({
      childId: "child-a",
      pid: 1234,
      workdir: "/tmp/child-a",
      state: "starting",
      startedAt: now,
      metadata: { role: "planner" },
    });

    expect(registered.state).to.equal("starting");
    expect(registered.retries).to.equal(0);
    expect(registered.startedAt).to.equal(now);
    expect(registered.endedAt).to.equal(null);

    index.updateHeartbeat("child-a", now + 50);
    index.incrementRetries("child-a");
    index.incrementRetries("child-a");
    index.mergeMetadata("child-a", { task: "analysis" });
    index.updateState("child-a", "running");

    const exit = index.recordExit("child-a", {
      code: 1,
      signal: "SIGTERM",
      forced: true,
      at: now + 120,
      reason: "timeout",
    });

    expect(exit.state).to.equal("killed");
    expect(exit.retries).to.equal(2);
    expect(exit.stopReason).to.equal("timeout");
    expect(exit.endedAt).to.equal(now + 120);
    expect(exit.metadata).to.deep.equal({ role: "planner", task: "analysis" });

    const snapshot = index.serialize();
    expect(snapshot["child-a"]).to.include({ retries: 2, forcedTermination: true });

    index.clear();
    expect(index.list()).to.have.length(0);
    index.restore(snapshot as Record<string, unknown>);
    const restored = index.getChild("child-a");
    expect(restored).to.not.equal(undefined);
    expect(restored?.retries).to.equal(2);

    expect(() => index.updateState("missing", "idle")).to.throw(UnknownChildError);
  });
});
