import process from "node:process";
import { PassThrough } from "node:stream";

import { expect } from "chai";

import {
  ChildProcessTimeoutError,
  createChildProcessGateway,
  type ChildProcessGateway,
  type SpawnChildProcessOptions,
} from "../../src/gateways/childProcess.js";
import type { ChildProcess, SpawnOptions } from "node:child_process";

/**
 * Minimal child process double returning deterministic streams for the gateway tests.
 */
class FakeChildProcess extends PassThrough implements ChildProcess {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 1337;
  public killed = false;
  public connected = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly spawnargs: string[];
  public readonly spawnfile: string;
  public readonly channel = null;
  public readonly stdio: [PassThrough, PassThrough, PassThrough];

  constructor(command: string, args: readonly string[]) {
    super();
    this.spawnargs = [command, ...args];
    this.spawnfile = command;
    this.stdio = [this.stdin, this.stdout, this.stderr];
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (typeof signal === "string") {
      this.signalCode = signal;
    }
    this.emit("exit", null, typeof signal === "string" ? signal : null);
    return true;
  }

  override ref(): this {
    return this;
  }

  override unref(): this {
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override send(
    _message: unknown,
    _sendHandle?: unknown,
    _options?: unknown,
    _callback?: ((error: Error | null) => void) | undefined,
  ): boolean {
    throw new Error("IPC channel not available on fake child process");
  }

  override disconnect(): void {
    // No-op: fake process does not manage IPC channels.
  }
}

type SpawnInvocation = {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions | undefined;
};

function createRecordingGateway(): {
  readonly gateway: ChildProcessGateway;
  readonly invocations: SpawnInvocation[];
} {
  const invocations: SpawnInvocation[] = [];
  const gateway = createChildProcessGateway({
    spawnImpl(command, args, options) {
      const resolvedArgs = Array.isArray(args) ? [...args] : [];
      invocations.push({ command, args: resolvedArgs, options });
      return new FakeChildProcess(command, resolvedArgs);
    },
  });

  return { gateway, invocations };
}

describe("gateways/childProcess.spawn", () => {
  it("enforces shell-less spawning with immutable argument arrays", () => {
    const { gateway, invocations } = createRecordingGateway();

    const options: SpawnChildProcessOptions = {
      command: "/bin/echo",
      args: ["hello", "world"],
      allowedEnvKeys: [],
    };

    const handle = gateway.spawn(options);
    handle.dispose();

    expect(invocations).to.have.lengthOf(1);
    const invocation = invocations[0];

    expect(invocation.command).to.equal(options.command);
    expect(invocation.args).to.deep.equal(options.args);
    expect(invocation.options?.shell).to.equal(false);
    expect(invocation.options?.windowsVerbatimArguments).to.equal(false);
    expect(invocation.options?.stdio).to.equal("pipe");
  });

  it("aborts processes that exceed their timeout budget", async () => {
    const gateway = createChildProcessGateway();
    const handle = gateway.spawn({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1_000);"],
      allowedEnvKeys: ["PATH"],
      timeoutMs: 75,
    });

    const termination = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        resolve({ code, signal });
      };
      const onError = (error: Error) => {
        cleanup();
        if (error.name === "AbortError") {
          resolve({ code: null, signal: null });
          return;
        }
        reject(error);
      };
      const cleanup = () => {
        handle.child.removeListener("exit", onExit);
        handle.child.removeListener("error", onError);
      };

      handle.child.once("exit", onExit);
      handle.child.once("error", onError);
    });

    expect(handle.signal?.aborted).to.equal(true);
    expect(handle.signal?.reason).to.be.instanceOf(ChildProcessTimeoutError);
    expect(termination.signal === "SIGKILL" || termination.signal === "SIGTERM" || termination.signal === null).to.equal(true);

    handle.dispose();
  }).timeout(5_000);
});
