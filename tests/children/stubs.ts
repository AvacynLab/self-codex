/**
 * Test doubles for child process interactions. These helpers expose deterministic
 * lifecycle controls so the runtime shutdown logic can be exercised without
 * spawning real Node.js subprocesses.
 */
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

/**
 * Controllable child process stub exposing explicit hooks to emit lifecycle
 * events and record `kill()` invocations.
 */
export class ControlledChildProcess
  extends EventEmitter
  implements ChildProcessWithoutNullStreams
{
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdio: [PassThrough, PassThrough, PassThrough];
  public readonly pid: number;
  public killed = false;
  public connected = false;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly spawnargs: string[];
  public readonly spawnfile: string;
  public readonly channel = null;

  /** Ordered list of signals observed via {@link kill}. */
  public readonly killInvocations: Array<NodeJS.Signals | number | undefined> = [];

  /** Optional callback invoked whenever {@link kill} is called. */
  public killHandler: ((signal?: NodeJS.Signals | number) => void) | null = null;

  constructor(command: string, args: readonly string[] = [], pid = 4242) {
    super();
    this.spawnargs = [command, ...args];
    this.spawnfile = command;
    this.pid = pid;
    this.stdio = [this.stdin, this.stdout, this.stderr];
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killInvocations.push(signal);
    this.killed = true;
    if (typeof signal === "string") {
      this.signalCode = signal;
    }
    if (this.killHandler) {
      this.killHandler(signal);
    }
    return true;
  }

  override send(): boolean {
    throw new Error("IPC channel not available in ControlledChildProcess");
  }

  override disconnect(): void {
    // No-op for the stub child process.
  }

  override ref(): this {
    return this;
  }

  override unref(): this {
    return this;
  }

  /** Emits the Node.js `spawn` lifecycle event. */
  public emitSpawn(): void {
    this.emit("spawn");
  }

  /** Emits the Node.js `exit` lifecycle event. */
  public emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  /** Emits the Node.js `close` lifecycle event. */
  public emitClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit("close", code, signal);
  }
}
