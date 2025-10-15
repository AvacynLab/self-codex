import { expect } from "chai";
import { PassThrough } from "node:stream";

import {
  ChildProcessEnvViolationError,
  createChildProcessGateway,
} from "../../src/gateways/childProcess.js";
import type { ChildProcess, SpawnOptions } from "node:child_process";

/**
 * Lightweight child process double capturing spawn options for environment assertions.
 */
class RecordingChildProcess extends PassThrough implements ChildProcess {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly pid = 4242;
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

  override send(
    _message: unknown,
    _sendHandle?: unknown,
    _options?: unknown,
    _callback?: ((error: Error | null) => void) | undefined,
  ): boolean {
    throw new Error("IPC not implemented for recording child process");
  }

  override disconnect(): void {
    // No-op.
  }
}

function createGatewayRecorder() {
  const invocations: SpawnOptions[] = [];
  const gateway = createChildProcessGateway({
    spawnImpl(command, args, options) {
      invocations.push(options ?? {});
      return new RecordingChildProcess(command, Array.isArray(args) ? args : []);
    },
  });

  return { gateway, invocations };
}

describe("gateways/childProcess environment whitelisting", () => {
  it("propagates only allow-listed environment variables", () => {
    const { gateway, invocations } = createGatewayRecorder();

    const inheritEnv = {
      PATH: "/usr/bin",
      SAFE_TOKEN: "abc",
      SECRET: "should-not-leak",
    } satisfies NodeJS.ProcessEnv;

    const handle = gateway.spawn({
      command: "/bin/echo",
      allowedEnvKeys: ["PATH", "SAFE_TOKEN"],
      inheritEnv,
    });
    handle.dispose();

    expect(invocations).to.have.lengthOf(1);
    expect(invocations[0].env).to.deep.equal({
      PATH: "/usr/bin",
      SAFE_TOKEN: "abc",
    });
  });

  it("rejects overrides that are not allow-listed", () => {
    const { gateway } = createGatewayRecorder();

    expect(() =>
      gateway.spawn({
        command: "/bin/echo",
        allowedEnvKeys: ["PATH"],
        extraEnv: {
          SECRET: "nope",
        },
      }),
    ).to.throw(ChildProcessEnvViolationError);
  });

  it("allows explicit removal of inherited environment entries", () => {
    const { gateway, invocations } = createGatewayRecorder();

    const inheritEnv = {
      PATH: "/usr/bin",
      OPTIONAL: "flag",
    } satisfies NodeJS.ProcessEnv;

    const handle = gateway.spawn({
      command: "/bin/echo",
      allowedEnvKeys: ["PATH", "OPTIONAL"],
      inheritEnv,
      extraEnv: {
        OPTIONAL: undefined,
      },
    });
    handle.dispose();

    expect(invocations).to.have.lengthOf(1);
    expect(invocations[0].env).to.deep.equal({
      PATH: "/usr/bin",
    });
  });
});
