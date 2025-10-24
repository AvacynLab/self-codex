/**
 * Spawn failure handling for child runtimes. These regression tests ensure
 * early crashes, gateway aborts and manifest logging remain observable while
 * resources are reclaimed deterministically.
 */
import process from "node:process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { ChildSpawnError, startChildRuntime } from "../../src/childRuntime.js";
import {
  ChildProcessTimeoutError,
  createChildProcessGateway,
  type ChildProcessGateway,
  type SpawnChildProcessOptions,
} from "../../src/gateways/childProcess.js";
import { childWorkspacePath } from "../../src/paths.js";
import { ControlledChildProcess } from "./stubs.js";

describe("child runtime spawn error handling", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "child-spawn-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("cleans up spawn handles and records diagnostics when the child crashes early", async () => {
    const crashError = new Error("spawn failed");
    let disposeCount = 0;

    const gateway: ChildProcessGateway = {
      spawn(options: SpawnChildProcessOptions) {
        const child = new ControlledChildProcess(options.command, options.args ?? []);
        queueMicrotask(() => {
          child.emit("error", crashError);
          child.emit("close", null, null);
        });
        return {
          child,
          signal: undefined,
          dispose() {
            disposeCount += 1;
          },
        };
      },
    };

    const childId = "spawn-error";
    let caught: unknown;
    try {
      await startChildRuntime({
        childId,
        childrenRoot: tempRoot,
        command: "/bin/false",
        args: [],
        env: {},
        metadata: {},
        processGateway: gateway,
        spawnRetry: { attempts: 1 },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(ChildSpawnError);
    const spawnError = caught as ChildSpawnError;
    expect(spawnError.attempts).to.equal(1);
    expect(spawnError.cause).to.equal(crashError);
    expect(disposeCount).to.equal(1);

    const logPath = childWorkspacePath(tempRoot, childId, "logs", "child.log");
    const logContents = await waitForLogContents(logPath);
    expect(logContents).to.contain("process-error:spawn failed");
  });

  it("propagates child gateway timeouts as child spawn errors", async () => {
    const gateway = createChildProcessGateway({
      spawnImpl(command, args, options) {
        const resolvedArgs = Array.isArray(args) ? [...args] : [];
        const child = new ControlledChildProcess(command, resolvedArgs);

        const signal = options?.signal as AbortSignal | undefined;
        if (signal) {
          const propagateAbort = () => {
            const abortError = new Error("The operation was aborted");
            abortError.name = "AbortError";
            (abortError as NodeJS.ErrnoException).code = "ABORT_ERR";
            (abortError as NodeJS.ErrnoException & { cause?: unknown }).cause = signal.reason;
            child.emit("error", abortError as Error);
          };

          if (signal.aborted) {
            propagateAbort();
          } else {
            signal.addEventListener("abort", propagateAbort, { once: true });
          }
        }

        return child;
      },
    });

    let caught: unknown;
    try {
      await startChildRuntime({
        childId: "spawn-timeout",
        childrenRoot: tempRoot,
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 1000);"],
        env: {},
        metadata: {},
        processGateway: gateway,
        spawnTimeoutMs: 25,
        spawnRetry: { attempts: 1 },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(ChildSpawnError);
    const spawnError = caught as ChildSpawnError;
    expect(spawnError.cause).to.be.instanceOf(ChildProcessTimeoutError);
  });
});

/**
 * Reads the child runtime log once it has been flushed to disk. The helper
 * retries for a short period to accommodate asynchronous stream teardown.
 */
async function waitForLogContents(path: string): Promise<string> {
  const deadline = Date.now() + 1_000;
  while (Date.now() <= deadline) {
    try {
      const contents = await readFile(path, "utf8");
      if (contents.length > 0) {
        return contents;
      }
    } catch {
      // File may not exist yet; retry until the timeout elapses.
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for log file at ${path}`);
}
