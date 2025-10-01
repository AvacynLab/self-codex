import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { inspect } from "node:util";

import { scanArtifacts, type ArtifactManifestEntry } from "./artifacts.js";
import { childWorkspacePath, ensureDirectory } from "./paths.js";

/**
 * Message emitted by a child process runtime.
 */
export interface ChildRuntimeMessage<T = unknown> {
  raw: string;
  parsed: T | null;
  stream: "stdout" | "stderr";
  receivedAt: number;
  sequence: number;
}

/**
 * Exit event returned when a child is terminated.
 */
interface ChildExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
  forced: boolean;
  error: Error | null;
}

/**
 * Options used to launch a child runtime.
 */
/**
 * Declarative limits enforced (or at least tracked) for a child runtime. The
 * structure intentionally stays flexible so the orchestrator can surface
 * heterogeneous constraints such as token ceilings, execution budgets or
 * memory quotas. Values are serialised verbatim inside the manifest for later
 * inspection by monitoring tooling.
 */
export interface ChildRuntimeLimits {
  [key: string]: number | string | boolean | null | undefined;
}

/**
 * Configuration driving the retry strategy when spawning a new child process.
 * The exponential backoff keeps pressure low on the host system while still
 * providing a deterministic bound on the number of attempts before surfacing
 * an error to the caller.
 */
export interface ChildSpawnRetryOptions {
  /** Maximum amount of spawn attempts. Defaults to a single try (no retry). */
  attempts?: number;
  /** Delay applied before the *second* attempt. Defaults to 250ms. */
  initialDelayMs?: number;
  /** Multiplicative factor applied after every failure. Defaults to x2. */
  backoffFactor?: number;
  /** Upper bound applied to the computed delay. Defaults to 10 seconds. */
  maxDelayMs?: number;
}

/**
 * Parameters accepted when launching a child runtime. The additional knobs keep
 * the function testable (custom spawn factory) and configurable (retry
 * strategy, manifest metadata).
 */
export interface StartChildRuntimeOptions {
  childId: string;
  childrenRoot: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  metadata?: Record<string, unknown>;
  manifestExtras?: Record<string, unknown>;
  limits?: ChildRuntimeLimits | null;
  toolsAllow?: string[] | null;
  spawnRetry?: ChildSpawnRetryOptions;
  /**
   * Optional factory used to spawn the process. Tests provide a stub so the
   * retry behaviour can be exercised deterministically without touching the
   * real filesystem or relying on brittle command failures.
   */
  spawnFactory?: (
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ) => ChildProcessWithoutNullStreams;
}

/**
 * Parameters configuring the shutdown sequence.
 */
export interface ChildShutdownOptions {
  signal?: NodeJS.Signals;
  timeoutMs?: number;
  /**
   * When true the shutdown request is considered forceful even if the child
   * exits cooperatively before the timeout elapses. This enables the
   * supervisor `kill` helper to expose deterministic semantics across Node.js
   * versions where signal handling behaviour may vary.
   */
  force?: boolean;
}

/**
 * Result returned after a shutdown sequence.
 */
export interface ChildShutdownResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
  durationMs: number;
}

/**
 * Error raised when the runtime fails to spawn after exhausting all retry
 * attempts. The original cause is exposed for diagnostic purposes so the
 * supervisor can bubble up actionable hints to operators.
 */
export class ChildSpawnError extends Error {
  public readonly attempts: number;
  public readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    const rootMessage = cause instanceof Error ? cause.message : String(cause ?? "unknown");
    super(`Failed to spawn child after ${attempts} attempt(s): ${rootMessage}`);
    this.name = "ChildSpawnError";
    this.attempts = attempts;
    this.cause = cause;
  }
}

interface ChildRuntimeParams {
  childId: string;
  command: string;
  args: string[];
  childrenRoot: string;
  workdir: string;
  logPath: string;
  manifestPath: string;
  metadata: Record<string, unknown>;
  envKeys: string[];
  /** Declarative constraints propagated from the orchestrator. */
  limits: ChildRuntimeLimits | null;
  /** Whitelisted tool identifiers for this child instance. */
  toolsAllow: string[];
  child: ChildProcessWithoutNullStreams;
}

/**
 * Snapshot describing the runtime state of a spawned child process.
 */
export interface ChildRuntimeStatus {
  childId: string;
  pid: number;
  command: string;
  args: string[];
  workdir: string;
  startedAt: number;
  lastHeartbeatAt: number | null;
  lifecycle: "spawning" | "running" | "exited";
  closed: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null; forced: boolean; at: number } | null;
  resourceUsage: NodeJS.ResourceUsage | null;
}

/**
 * Collected outputs produced by the child (logs, manifest metadata and
 * artifacts). These snapshots are useful for `child_collect` tools that need a
 * single payload aggregating text outputs and file manifests.
 */
export interface ChildCollectedOutputs {
  childId: string;
  manifestPath: string;
  logPath: string;
  messages: ChildRuntimeMessage[];
  artifacts: ArtifactManifestEntry[];
}

/**
 * Options accepted when slicing the in-memory message buffer for streaming
 * purposes. `afterSequence` is inclusive of the cursor returned by the
 * previous call (set to `-1` to start from the beginning). The handler may
 * filter by stream type and cap the amount of messages returned to keep the
 * payload compact for JSON-RPC responses.
 */
export interface ChildMessageStreamOptions {
  afterSequence?: number;
  limit?: number;
  streams?: Array<"stdout" | "stderr">;
}

/**
 * Result returned when streaming child messages. `nextCursor` points to the
 * last sequence included in the slice so the caller can request the next page.
 */
export interface ChildMessageStreamResult {
  childId: string;
  totalMessages: number;
  matchedMessages: number;
  hasMore: boolean;
  nextCursor: number | null;
  messages: ChildRuntimeMessage[];
}

/**
 * Wraps a spawned child process and exposes helpers for messaging, logging and
 * heartbeat tracking. The class is intentionally event based so it can be
 * composed easily with orchestrator tools.
 */
export class ChildRuntime extends EventEmitter {
  public readonly childId: string;
  public readonly command: string;
  public readonly args: string[];
  public readonly childrenRoot: string;
  public readonly workdir: string;
  public readonly logPath: string;
  public readonly manifestPath: string;
  public readonly metadata: Record<string, unknown>;
  public readonly envKeys: readonly string[];
  /** Constraints persisted in the manifest for monitoring and guards. */
  public readonly limits: ChildRuntimeLimits | null;
  /** Tools explicitly allowed for the child (used by guard rails). */
  public readonly toolsAllow: readonly string[];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logStream: WriteStream;
  private readonly messages: ChildRuntimeMessage[] = [];
  private readonly spawnPromise: Promise<void>;
  private spawnSettled = false;
  private spawnResolve: (() => void) | null = null;
  private spawnReject: ((error: Error) => void) | null = null;

  private readonly exitPromise: Promise<ChildExitEvent>;
  private exitResolve: ((event: ChildExitEvent) => void) | null = null;
  private exitEvent: ChildExitEvent | null = null;

  private stdoutBuffer = "";
  private stderrBuffer = "";
  private forcedKill = false;
  private closed = false;
  private readonly startedAt: number;
  private lastHeartbeatAt: number | null = null;

  constructor(params: ChildRuntimeParams) {
    super();
    this.childId = params.childId;
    this.command = params.command;
    this.args = params.args;
    this.childrenRoot = params.childrenRoot;
    this.workdir = params.workdir;
    this.logPath = params.logPath;
    this.manifestPath = params.manifestPath;
    this.metadata = Object.freeze({ ...params.metadata });
    this.envKeys = Object.freeze([...params.envKeys]);
    this.limits = params.limits ? { ...params.limits } : null;
    this.toolsAllow = Object.freeze([...params.toolsAllow]);
    this.child = params.child;
    this.startedAt = Date.now();
    this.logStream = createWriteStream(this.logPath, { flags: "a" });

    this.spawnPromise = new Promise((resolve, reject) => {
      this.spawnResolve = resolve;
      this.spawnReject = reject;
    });

    this.exitPromise = new Promise<ChildExitEvent>((resolve) => {
      this.exitResolve = resolve;
    });

    this.setupListeners();
  }

  /**
   * Number of the process created by the runtime.
   */
  get pid(): number {
    return this.child.pid ?? -1;
  }

  /**
   * Timestamp of the last IO event observed for the child.
   */
  get lastHeartbeat(): number | null {
    return this.lastHeartbeatAt;
  }

  /**
   * Accessor for the recorded messages (JSON lines emitted by the child).
   */
  getRecordedMessages(): ChildRuntimeMessage[] {
    this.flushStdout();
    this.flushStderr();
    return this.messages.map((message) => ({ ...message }));
  }

  /**
   * Streams messages recorded so far. The method clamps pagination bounds and
   * performs stream filtering before cloning the payloads to avoid exposing
   * mutable references outside of the runtime.
   */
  streamMessages(options: ChildMessageStreamOptions = {}): ChildMessageStreamResult {
    this.flushStdout();
    this.flushStderr();

    const totalMessages = this.messages.length;
    const after = options.afterSequence ?? -1;
    if (!Number.isInteger(after) || after < -1) {
      throw new Error("afterSequence must be an integer >= -1");
    }

    const rawLimit = options.limit ?? 50;
    if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
      throw new Error("limit must be a positive integer");
    }
    const limit = Math.min(rawLimit, 200);

    const streamsFilter = options.streams ? new Set(options.streams) : null;
    if (streamsFilter && streamsFilter.size === 0) {
      throw new Error("streams filter must contain at least one entry");
    }

    const slice: ChildRuntimeMessage[] = [];
    let lastSequence = after;

    for (let index = Math.max(0, after + 1); index < totalMessages; index += 1) {
      const candidate = this.messages[index];
      if (streamsFilter && !streamsFilter.has(candidate.stream)) {
        continue;
      }

      slice.push({ ...candidate });
      lastSequence = candidate.sequence;
      if (slice.length >= limit) {
        break;
      }
    }

    let hasMore = false;
    if (lastSequence < totalMessages - 1) {
      for (let index = lastSequence + 1; index < totalMessages; index += 1) {
        const candidate = this.messages[index];
        if (!streamsFilter || streamsFilter.has(candidate.stream)) {
          hasMore = true;
          break;
        }
      }
    }

    return {
      childId: this.childId,
      totalMessages,
      matchedMessages: slice.length,
      hasMore,
      nextCursor: slice.length > 0 ? slice[slice.length - 1].sequence : lastSequence >= 0 ? lastSequence : null,
      messages: slice,
    };
  }

  /**
   * Reports the current execution status of the child process including the
   * most recent heartbeat and the exit information when available.
   */
  getStatus(): ChildRuntimeStatus {
    let resourceUsage: NodeJS.ResourceUsage | null = null;
    const resourceUsageFn = (this.child as ChildProcessWithoutNullStreams & {
      resourceUsage?: () => NodeJS.ResourceUsage;
    }).resourceUsage;

    if (typeof resourceUsageFn === "function") {
      try {
        resourceUsage = resourceUsageFn.call(this.child);
      } catch {
        resourceUsage = null;
      }
    }

    let lifecycle: ChildRuntimeStatus["lifecycle"] = "spawning";
    if (this.spawnSettled && !this.exitEvent) {
      lifecycle = "running";
    } else if (this.exitEvent) {
      lifecycle = "exited";
    }

    return {
      childId: this.childId,
      pid: this.pid,
      command: this.command,
      args: [...this.args],
      workdir: this.workdir,
      startedAt: this.startedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lifecycle,
      closed: this.closed,
      exit: this.exitEvent
        ? {
            code: this.exitEvent.code,
            signal: this.exitEvent.signal,
            forced: this.exitEvent.forced,
            at: this.exitEvent.at,
          }
        : null,
      resourceUsage,
    };
  }

  /**
   * Waits until the underlying process has been spawned successfully.
   */
  async waitUntilSpawned(): Promise<void> {
    return this.spawnPromise;
  }

  /**
   * Aggregates all outputs produced by the child so far. This includes
   * buffered messages and the current artifact manifest within the outbox.
   */
  async collectOutputs(): Promise<ChildCollectedOutputs> {
    this.flushStdout();
    this.flushStderr();

    const artifacts = await scanArtifacts(this.childrenRoot, this.childId);

    return {
      childId: this.childId,
      manifestPath: this.manifestPath,
      logPath: this.logPath,
      messages: this.getRecordedMessages(),
      artifacts,
    };
  }

  /**
   * Sends a payload to the child over STDIN. Strings are transmitted as-is
   * while other values are serialised as JSON.
   */
  async send(payload: unknown): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot send message to a closed child runtime");
    }

    if (!this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("Child stdin is not available");
    }

    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
    const line = `${serialized}\n`;

    await new Promise<void>((resolve, reject) => {
      const stream = this.child.stdin!;
      const cleanup = () => {
        stream.off("error", onError);
        stream.off("drain", onDrain);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onDrain = () => {
        cleanup();
        resolve();
      };

      stream.once("error", onError);
      const wrote = stream.write(line, (err) => {
        if (err) {
          cleanup();
          reject(err);
        } else if (wrote) {
          cleanup();
          resolve();
        }
      });

      if (!wrote) {
        stream.once("drain", onDrain);
      }
    });

    this.recordInternal("stdin", serialized);
  }

  /**
   * Waits for the next message matching a predicate. Throws after the provided
   * timeout (default 2 seconds).
   */
  async waitForMessage(
    predicate: (message: ChildRuntimeMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<ChildRuntimeMessage> {
    for (const message of this.messages) {
      if (predicate(message)) {
        return message;
      }
    }

    return new Promise<ChildRuntimeMessage>((resolve, reject) => {
      const timer = timeoutMs >= 0 ? setTimeout(() => {
        this.off("message", onMessage);
        reject(new Error(`Timed out after ${timeoutMs}ms while waiting for child message`));
      }, timeoutMs) : null;

      const onMessage = (message: ChildRuntimeMessage) => {
        if (predicate(message)) {
          if (timer) clearTimeout(timer);
          this.off("message", onMessage);
          resolve(message);
        }
      };

      this.on("message", onMessage);
    });
  }

  /**
   * Requests the child to terminate gracefully. If the timeout elapses the
   * child is forcefully killed with SIGKILL.
   */
  async shutdown(options: ChildShutdownOptions = {}): Promise<ChildShutdownResult> {
    const { signal = "SIGINT", timeoutMs = 2000, force = false } = options;
    const started = Date.now();

    if (this.closed) {
      const exit = await this.exitPromise;
      return { code: exit.code, signal: exit.signal, forced: exit.forced, durationMs: Date.now() - started };
    }

    this.recordInternal("lifecycle", `shutdown-request:${signal}:${timeoutMs}`);

    if (force) {
      // Mark the runtime as forcefully terminated up-front so exit metadata
      // reflects the caller intent even if the child acknowledges the signal
      // quickly (observed differences across Node.js 18/20/22).
      this.forcedKill = true;
    }

    try {
      this.child.kill(signal);
    } catch (error) {
      this.recordInternal("lifecycle", `kill-error:${(error as Error).message}`);
      throw error;
    }

    let exit: ChildExitEvent;
    try {
      exit = await this.waitForExit(timeoutMs);
    } catch (err) {
      this.forcedKill = true;
      this.recordInternal("lifecycle", "shutdown-timeout");
      this.child.kill("SIGKILL");
      exit = await this.waitForExit();
    }

    return { code: exit.code, signal: exit.signal, forced: exit.forced, durationMs: Date.now() - started };
  }

  /**
   * Persists a manifest describing the child runtime.
   */
  async writeManifest(extras: Record<string, unknown> = {}): Promise<void> {
    const manifest = {
      childId: this.childId,
      command: this.command,
      args: this.args,
      pid: this.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      workdir: this.workdir,
      workspace: this.workdir,
      logs: {
        child: this.logPath,
      },
      envKeys: this.envKeys,
      metadata: this.metadata,
      limits: this.limits,
      tools_allow: this.toolsAllow,
      ...extras,
    };

    await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  /**
   * Resolves once the underlying process exits.
   */
  async waitForExit(timeoutMs?: number): Promise<ChildExitEvent> {
    if (timeoutMs === undefined) {
      return this.exitPromise;
    }

    return new Promise<ChildExitEvent>((resolve, reject) => {
      const timer = timeoutMs >= 0 ? setTimeout(() => {
        reject(new Error("Timed out waiting for child exit"));
      }, timeoutMs) : null;

      this.exitPromise
        .then((event) => {
          if (timer) clearTimeout(timer);
          resolve(event);
        })
        .catch((error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Releases resources (listeners and log stream).
   */
  private cleanup(): void {
    if (!this.closed) {
      this.closed = true;
      if (this.child.stdout) {
        this.child.stdout.removeAllListeners();
      }
      if (this.child.stderr) {
        this.child.stderr.removeAllListeners();
      }
      if (this.child.stdin) {
        this.child.stdin.removeAllListeners();
      }
      this.logStream.end();
    }
  }

  private setupListeners(): void {
    if (this.child.stdout) {
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk: string) => {
        this.consumeStdout(chunk);
      });
      this.child.stdout.on("end", () => {
        this.flushStdout();
      });
    }

    if (this.child.stderr) {
      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (chunk: string) => {
        this.consumeStderr(chunk);
      });
      this.child.stderr.on("end", () => {
        this.flushStderr();
      });
    }

    this.child.once("spawn", () => {
      this.spawnSettled = true;
      this.lastHeartbeatAt = Date.now();
      this.recordInternal("lifecycle", "spawned");
      this.spawnResolve?.();
    });

    this.child.on("error", (error: Error) => {
      if (!this.spawnSettled) {
        this.spawnSettled = true;
        this.spawnReject?.(error);
      }
      this.recordInternal("stderr", `process-error:${error.message}`);
      if (!this.exitEvent) {
        const event: ChildExitEvent = {
          code: null,
          signal: null,
          at: Date.now(),
          forced: this.forcedKill,
          error,
        };
        this.exitEvent = event;
        this.exitResolve?.(event);
      }
      this.cleanup();
    });

    this.child.once("exit", (code, signal) => {
      const event: ChildExitEvent = {
        code,
        signal,
        at: Date.now(),
        forced: this.forcedKill,
        error: null,
      };
      this.exitEvent = event;
      this.recordInternal("lifecycle", `exit:${code ?? "null"}:${signal ?? "null"}`);
      this.exitResolve?.(event);
      this.cleanup();
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.recordLine("stdout", rawLine);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private flushStdout(): void {
    if (this.stdoutBuffer.length > 0) {
      this.recordLine("stdout", this.stdoutBuffer);
      this.stdoutBuffer = "";
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let newlineIndex = this.stderrBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      this.recordLine("stderr", rawLine);
      newlineIndex = this.stderrBuffer.indexOf("\n");
    }
  }

  private flushStderr(): void {
    if (this.stderrBuffer.length > 0) {
      this.recordLine("stderr", this.stderrBuffer);
      this.stderrBuffer = "";
    }
  }

  private recordLine(stream: "stdout" | "stderr", line: string): void {
    const cleaned = line.replace(/\r$/, "");
    if (!cleaned.trim()) {
      return;
    }

    this.recordInternal(stream, cleaned);

    const receivedAt = Date.now();
    this.lastHeartbeatAt = receivedAt;

    let parsed: unknown | null = null;
    if (stream === "stdout") {
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = null;
      }
    }

    const sequence = this.messages.length;
    const message: ChildRuntimeMessage = {
      raw: cleaned,
      parsed,
      stream,
      receivedAt,
      sequence,
    };

    this.messages.push(message);
    this.emit("message", message);
  }

  private recordInternal(kind: string, data: string): void {
    const entry = {
      ts: Date.now(),
      kind,
      data,
    };
    this.logStream.write(`${JSON.stringify(entry)}\n`);
  }
}

/**
 * Creates a new child runtime and ensures its workspace exists before the
 * process is spawned.
 */
export async function startChildRuntime(options: StartChildRuntimeOptions): Promise<ChildRuntime> {
  const childRoot = await ensureDirectory(options.childrenRoot, options.childId);
  await ensureDirectory(options.childrenRoot, options.childId, "logs");
  await ensureDirectory(options.childrenRoot, options.childId, "outbox");
  await ensureDirectory(options.childrenRoot, options.childId, "inbox");

  const workdir = childRoot;
  const logPath = childWorkspacePath(options.childrenRoot, options.childId, "logs", "child.log");
  const manifestPath = childWorkspacePath(options.childrenRoot, options.childId, "manifest.json");

  const args = options.args ? [...options.args] : [];
  const env = { ...process.env, ...(options.env ?? {}) };
  const envKeys = Object.keys(env).sort();
  const metadata = options.metadata ? { ...options.metadata } : {};
  const limits = options.limits ? { ...options.limits } : null;
  const toolsAllow = options.toolsAllow ? Array.from(new Set(options.toolsAllow)) : [];

  const spawnFactory = options.spawnFactory ?? spawn;
  const retry = options.spawnRetry ?? {};
  const attempts = Math.max(1, Math.trunc(retry.attempts ?? 1));
  const factor = Math.max(1, retry.backoffFactor ?? 2);
  const maxDelay = Math.max(0, retry.maxDelayMs ?? 10_000);
  let delay = Math.max(0, retry.initialDelayMs ?? 250);

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFactory(options.command, args, {
        cwd: workdir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        throw new ChildSpawnError(attempts, error);
      }

      if (delay > 0) {
        await sleep(delay);
      }
      delay = computeNextDelay(delay, factor, maxDelay);
      continue;
    }

    const runtime = new ChildRuntime({
      childId: options.childId,
      command: options.command,
      args,
      childrenRoot: options.childrenRoot,
      workdir,
      logPath,
      manifestPath,
      metadata,
      envKeys,
      limits,
      toolsAllow,
      child,
    });

    try {
      await runtime.waitUntilSpawned();
      await runtime.writeManifest(options.manifestExtras ?? {});
      return runtime;
    } catch (error) {
      lastError = error;
      try {
        await runtime.waitForExit(500);
      } catch {
        // Ignore errors while tearing down a failed spawn attempt.
      }

      if (attempt >= attempts) {
        throw new ChildSpawnError(attempts, error);
      }

      if (delay > 0) {
        await sleep(delay);
      }
      delay = computeNextDelay(delay, factor, maxDelay);
    }
  }

  throw new ChildSpawnError(attempts, lastError);
}

/**
 * Pretty printer primarily used by tests for debugging purposes.
 */
export function formatChildMessages(messages: ChildRuntimeMessage[]): string {
  return messages
    .map((message) =>
      `${new Date(message.receivedAt).toISOString()} [${message.stream}#${message.sequence}] ${message.raw} ` +
      (message.parsed ? inspect(message.parsed, { depth: 4 }) : "<raw>"),
    )
    .join("\n");
}

/**
 * Wait helper used by the spawn retry loop. The promise resolves after the
 * specified delay, giving the system some breathing room before attempting a
 * new process launch.
 */
async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Computes the next backoff delay while enforcing the configured ceiling.
 * When the initial delay is zero the helper introduces a conservative
 * fallback to avoid spinning aggressively.
 */
function computeNextDelay(currentDelay: number, factor: number, maxDelay: number): number {
  if (maxDelay === 0) {
    return 0;
  }

  const base = currentDelay > 0 ? currentDelay * factor : Math.max(50, factor * 10);
  return Math.min(maxDelay, base);
}
