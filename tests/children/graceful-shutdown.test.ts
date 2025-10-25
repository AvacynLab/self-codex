/**
 * Shutdown behaviour for child runtimes. The scenarios ensure cooperative
 * exits resolve promptly while unresponsive processes are forcefully killed
 * after the configured timeout elapses.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { ChildRuntime, type ChildRuntimeExitEvent } from "../../src/childRuntime.js";
import type { ChildRuntimeLimits } from "../../src/childRuntime.js";
import { ControlledChildProcess } from "./stubs.js";

async function createChildWorkspace(root: string, childId: string): Promise<string> {
  const childRoot = join(root, childId);
  await mkdir(childRoot, { recursive: true });
  await mkdir(join(childRoot, "logs"), { recursive: true });
  await mkdir(join(childRoot, "outbox"), { recursive: true });
  await mkdir(join(childRoot, "inbox"), { recursive: true });
  return childRoot;
}

function createRuntime({
  childRoot,
  childId,
  child,
  limits = null,
}: {
  childRoot: string;
  childId: string;
  child: ControlledChildProcess;
  limits?: ChildRuntimeLimits | null;
}): ChildRuntime {
  return new ChildRuntime({
    childId,
    command: child.spawnfile,
    args: [],
    childrenRoot: join(childRoot, ".."),
    workdir: childRoot,
    logPath: join(childRoot, "logs", "child.log"),
    manifestPath: join(childRoot, "manifest.json"),
    metadata: {},
    manifestExtras: {},
    envKeys: [],
    limits,
    role: null,
    toolsAllow: [],
    child,
  });
}

describe("child runtime shutdown", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "child-runtime-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves gracefully when the child acknowledges the shutdown signal", async () => {
    const childId = "graceful";
    const childRoot = await createChildWorkspace(tempRoot, childId);
    const child = new ControlledChildProcess(process.execPath, ["-e", "setTimeout(()=>{}, 10);"]);
    const runtime = createRuntime({ childRoot, childId, child });
    child.emitSpawn();

    child.killHandler = (signal) => {
      const exitSignal = typeof signal === "string" ? signal : null;
      queueMicrotask(() => {
        child.emitExit(0, exitSignal);
        child.emitClose(0, exitSignal);
      });
    };

    const result = await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 200 });

    expect(result.forced).to.equal(false);
    expect(child.killInvocations).to.deep.equal(["SIGTERM"]);
  });

  it("escalates to SIGKILL when the child ignores the graceful signal", async () => {
    const childId = "forceful";
    const childRoot = await createChildWorkspace(tempRoot, childId);
    const child = new ControlledChildProcess(process.execPath, ["-e", "setTimeout(()=>{}, 10);"]);
    const runtime = createRuntime({ childRoot, childId, child });
    child.emitSpawn();

    child.killHandler = (signal) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => {
          child.emitExit(null, "SIGKILL");
          child.emitClose(null, "SIGKILL");
        });
      }
    };

    const result = await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 50 });

    expect(child.killInvocations).to.deep.equal(["SIGTERM", "SIGKILL"]);
    expect(result.forced).to.equal(true);
    expect(result.signal).to.equal("SIGKILL");
  });

  it("settles the exit promise when the process only emits close", async () => {
    const childId = "close-only";
    const childRoot = await createChildWorkspace(tempRoot, childId);
    const child = new ControlledChildProcess(process.execPath, ["-e", "setTimeout(()=>{}, 10);"]);
    const runtime = createRuntime({ childRoot, childId, child });
    child.emitSpawn();

    const exitPromise: Promise<ChildRuntimeExitEvent> = runtime.waitForExit(250);
    child.emitClose(0, null);
    const exit = await exitPromise;

    expect(exit.code).to.equal(0);
    expect(exit.signal).to.equal(null);
  });

  it("uses environment overrides when shutting down without explicit options", async () => {
    const originalGrace = process.env.MCP_CHILD_SHUTDOWN_GRACE_MS;
    const originalForce = process.env.MCP_CHILD_SHUTDOWN_FORCE_MS;
    process.env.MCP_CHILD_SHUTDOWN_GRACE_MS = "25";
    process.env.MCP_CHILD_SHUTDOWN_FORCE_MS = "50";

    try {
      const childId = "env-shutdown";
      const childRoot = await createChildWorkspace(tempRoot, childId);
      const child = new ControlledChildProcess(process.execPath, ["-e", "setTimeout(()=>{}, 10);"]);
      const runtime = createRuntime({ childRoot, childId, child });
      child.emitSpawn();

      child.killHandler = (signal) => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => {
            child.emitExit(null, "SIGKILL");
            child.emitClose(null, "SIGKILL");
          });
        }
      };

      const result = await runtime.shutdown();

      expect(child.killInvocations).to.deep.equal(["SIGINT", "SIGKILL"]);
      expect(result.forced).to.equal(true);
      expect(result.signal).to.equal("SIGKILL");
    } finally {
      if (originalGrace === undefined) {
        delete process.env.MCP_CHILD_SHUTDOWN_GRACE_MS;
      } else {
        process.env.MCP_CHILD_SHUTDOWN_GRACE_MS = originalGrace;
      }
      if (originalForce === undefined) {
        delete process.env.MCP_CHILD_SHUTDOWN_FORCE_MS;
      } else {
        process.env.MCP_CHILD_SHUTDOWN_FORCE_MS = originalForce;
      }
    }
  });

  it("rejects when the child ignores SIGKILL beyond the forced timeout", async () => {
    const originalGrace = process.env.MCP_CHILD_SHUTDOWN_GRACE_MS;
    const originalForce = process.env.MCP_CHILD_SHUTDOWN_FORCE_MS;
    process.env.MCP_CHILD_SHUTDOWN_GRACE_MS = "10";
    process.env.MCP_CHILD_SHUTDOWN_FORCE_MS = "25";

    try {
      const childId = "force-timeout";
      const childRoot = await createChildWorkspace(tempRoot, childId);
      const child = new ControlledChildProcess(process.execPath, ["-e", "setTimeout(()=>{}, 1000);"]);
      const runtime = createRuntime({ childRoot, childId, child });
      child.emitSpawn();

      child.killHandler = () => {
        // Intentionally ignore all signals so both the graceful and forced
        // waits expire, exercising the timeout path.
      };

      let caught: unknown;
      try {
        await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 5 });
      } catch (error) {
        caught = error;
      }

      expect(child.killInvocations).to.deep.equal(["SIGTERM", "SIGKILL"]);
      expect(caught).to.be.instanceOf(Error);
      expect((caught as Error).message).to.equal("Timed out waiting for child exit");

      // Manually release listeners so the runtime can flush buffers before the test tears down.
      child.emitExit(null, "SIGKILL");
      child.emitClose(null, "SIGKILL");
    } finally {
      if (originalGrace === undefined) {
        delete process.env.MCP_CHILD_SHUTDOWN_GRACE_MS;
      } else {
        process.env.MCP_CHILD_SHUTDOWN_GRACE_MS = originalGrace;
      }
      if (originalForce === undefined) {
        delete process.env.MCP_CHILD_SHUTDOWN_FORCE_MS;
      } else {
        process.env.MCP_CHILD_SHUTDOWN_FORCE_MS = originalForce;
      }
    }
  });
});
