import { randomUUID } from "crypto";

import {
  ChildCollectedOutputs,
  ChildMessageStreamOptions,
  ChildMessageStreamResult,
  ChildRuntime,
  ChildRuntimeLimits,
  ChildRuntimeMessage,
  ChildRuntimeStatus,
  ChildShutdownResult,
  ChildSpawnRetryOptions,
  startChildRuntime,
} from "./childRuntime.js";
import { ChildrenIndex, ChildRecordSnapshot } from "./state/childrenIndex.js";

/**
 * Options used to bootstrap a {@link ChildSupervisor} instance.
 */
export interface ChildSupervisorOptions {
  /**
   * Directory that will contain all child workspaces. The structure mirrors the
   * one enforced by {@link startChildRuntime} so the supervisor can reuse the
   * runtime utilities implemented in previous tasks.
   */
  childrenRoot: string;
  /**
   * Command executed for every child unless explicitly overridden. In the real
   * orchestrator this will point to the Codex CLI entrypoint while the tests
   * rely on the mock runners located under `tests/fixtures/`.
   */
  defaultCommand: string;
  /**
   * Optional default arguments appended to the command invocation.
   */
  defaultArgs?: string[];
  /**
   * Extra environment variables propagated to each child.
   */
  defaultEnv?: NodeJS.ProcessEnv;
  /**
   * Shared in-memory index used to expose lifecycle metadata to the rest of
   * the orchestrator. When omitted, a fresh instance is created.
   */
  index?: ChildrenIndex;
  /**
   * Maximum period of inactivity tolerated before the child is marked idle. A
   * non-positive value disables the watchdog.
   */
  idleTimeoutMs?: number;
  /**
   * Interval at which the idle watchdog checks for inactivity. When omitted a
   * conservative default derived from {@link idleTimeoutMs} is used.
   */
  idleCheckIntervalMs?: number;
}

/**
 * Parameters accepted when creating a new child.
 */
export interface CreateChildOptions {
  /** Explicit identifier for the child. Auto-generated when omitted. */
  childId?: string;
  /** Custom command overriding {@link ChildSupervisorOptions.defaultCommand}. */
  command?: string;
  /** Additional command line arguments. */
  args?: string[];
  /** Extra environment variables for the child process. */
  env?: NodeJS.ProcessEnv;
  /** Metadata persisted in the runtime manifest and surfaced via the index. */
  metadata?: Record<string, unknown>;
  /** Additional manifest fields (handy for tooling). */
  manifestExtras?: Record<string, unknown>;
  /** Declarative limits applied to the child runtime (tokens, time, etc.). */
  limits?: ChildRuntimeLimits | null;
  /** Tools explicitly allowed for this child instance. */
  toolsAllow?: string[] | null;
  /** Custom retry strategy applied to the initial spawn. */
  spawnRetry?: ChildSpawnRetryOptions;
  /**
   * When true (default) the supervisor waits for a JSON message whose `type`
   * equals {@link readyType} before resolving the creation call. This provides
   * a deterministic rendezvous for downstream plan tests.
   */
  waitForReady?: boolean;
  /** Name of the JSON message type used to detect readiness. */
  readyType?: string;
  /** Maximum duration granted to the ready handshake. */
  readyTimeoutMs?: number;
}

/**
 * Shape returned once a child has been created.
 */
export interface CreateChildResult {
  /** Identifier assigned to the child. */
  childId: string;
  /** Snapshot captured immediately after registration. */
  index: ChildRecordSnapshot;
  /** Low level runtime handle (useful for waiters in tests). */
  runtime: ChildRuntime;
  /** JSON message that satisfied the ready handshake, if any. */
  readyMessage: ChildRuntimeMessage | null;
}

/**
 * Result returned by {@link ChildSupervisor.send}.
 */
export interface SendResult {
  /** Identifier generated for the message (handy for logging/tests). */
  messageId: string;
  /** Timestamp at which the payload has been flushed to stdin. */
  sentAt: number;
}

/**
 * Result returned by {@link ChildSupervisor.status}.
 */
export interface ChildStatusSnapshot {
  /** Snapshot captured from the runtime. */
  runtime: ChildRuntimeStatus;
  /** Metadata captured from the in-memory index. */
  index: ChildRecordSnapshot;
}

/**
 * Supervises child runtimes by orchestrating their lifecycle, heartbeats and
 * persistence metadata. The class is intentionally stateful so tools exposed by
 * the MCP server can share a single instance and tests can exercise the
 * high-level behaviour without going through JSON-RPC plumbing yet.
 */
export class ChildSupervisor {
  private readonly childrenRoot: string;
  private readonly defaultCommand: string;
  private readonly defaultArgs: string[];
  private readonly defaultEnv: NodeJS.ProcessEnv;
  private readonly index: ChildrenIndex;
  private readonly runtimes = new Map<string, ChildRuntime>();
  private readonly messageCounters = new Map<string, number>();
  private readonly exitEvents = new Map<string, ChildShutdownResult>();
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();
  private readonly idleTimeoutMs: number;
  private readonly idleCheckIntervalMs: number;

  constructor(options: ChildSupervisorOptions) {
    this.childrenRoot = options.childrenRoot;
    this.defaultCommand = options.defaultCommand;
    this.defaultArgs = options.defaultArgs ? [...options.defaultArgs] : [];
    this.defaultEnv = { ...(options.defaultEnv ?? {}) };
    this.index = options.index ?? new ChildrenIndex();

    const configuredIdle = options.idleTimeoutMs ?? 120_000;
    this.idleTimeoutMs = configuredIdle > 0 ? configuredIdle : 0;
    const defaultInterval = Math.max(250, Math.min(5_000, this.idleTimeoutMs || 5_000));
    const configuredInterval = options.idleCheckIntervalMs;
    const interval = configuredInterval ?? defaultInterval;
    this.idleCheckIntervalMs = interval > 0 ? Math.min(interval, Math.max(250, this.idleTimeoutMs || interval)) : defaultInterval;
  }

  /**
   * Generates a stable child identifier following the `child-<timestamp>-<id>`
   * convention required by the brief. A compact suffix is produced from a
   * UUID in order to minimise directory name length while retaining sufficient
   * entropy.
   */
  private static generateChildId(): string {
    const timestamp = Date.now();
    const randomSuffix = randomUUID().replace(/-/g, "").slice(0, 6).toLowerCase();
    return `child-${timestamp}-${randomSuffix}`;
  }

  /**
   * Access to the shared {@link ChildrenIndex}. Mainly used by tests to assert
   * lifecycle transitions.
   */
  get childrenIndex(): ChildrenIndex {
    return this.index;
  }

  /**
   * Registers listeners so heartbeat updates and exit information are
   * persisted automatically when the runtime emits messages or terminates.
   */
  private attachRuntime(childId: string, runtime: ChildRuntime): void {
    runtime.on("message", (message: ChildRuntimeMessage) => {
      this.index.updateHeartbeat(childId, message.receivedAt);

      const parsed = message.parsed as { type?: string } | null;
      const type = parsed?.type;
      if (type === "ready") {
        this.index.updateState(childId, "ready");
      } else if (type === "response" || type === "pong") {
        this.index.updateState(childId, "idle");
      } else if (type === "error") {
        this.index.updateState(childId, "error");
      }
    });

    this.scheduleIdleWatchdog(childId);

    runtime
      .waitForExit()
      .then((event) => {
        this.clearIdleWatchdog(childId);
        const result: ChildShutdownResult = {
          code: event.code,
          signal: event.signal,
          forced: event.forced,
          durationMs: Math.max(0, event.at - runtime.getStatus().startedAt),
        };
        this.exitEvents.set(childId, result);
        this.index.recordExit(childId, {
          code: event.code,
          signal: event.signal,
          at: event.at,
          forced: event.forced,
          reason: event.error ? event.error.message : undefined,
        });
      })
      .catch((error) => {
        // The exit promise should never reject, but we keep a defensive path
        // to ensure the index is not left in an inconsistent state.
        this.clearIdleWatchdog(childId);
        const fallback: ChildShutdownResult = {
          code: null,
          signal: null,
          forced: true,
          durationMs: 0,
        };
        this.exitEvents.set(childId, fallback);
        this.index.recordExit(childId, {
          code: null,
          signal: null,
          at: Date.now(),
          forced: true,
          reason: `exit-promise-error:${(error as Error).message}`,
        });
      });
  }

  /**
   * Spawns a new child runtime and registers it inside the supervisor index.
   */
  async createChild(options: CreateChildOptions = {}): Promise<CreateChildResult> {
    const childId = options.childId ?? ChildSupervisor.generateChildId();

    if (this.runtimes.has(childId)) {
      throw new Error(`A runtime is already registered for ${childId}`);
    }

    const command = options.command ?? this.defaultCommand;
    const args = options.args ? [...options.args] : [...this.defaultArgs];
    const env = { ...this.defaultEnv, ...(options.env ?? {}) };

    const runtime = await startChildRuntime({
      childId,
      childrenRoot: this.childrenRoot,
      command,
      args,
      env,
      metadata: options.metadata,
      manifestExtras: options.manifestExtras,
      limits: options.limits ?? null,
      toolsAllow: options.toolsAllow ?? null,
      spawnRetry: options.spawnRetry,
    });

    const snapshot = this.index.registerChild({
      childId,
      pid: runtime.pid,
      workdir: runtime.workdir,
      metadata: options.metadata,
      state: "starting",
    });

    this.runtimes.set(childId, runtime);
    this.attachRuntime(childId, runtime);

    let readyMessage: ChildRuntimeMessage | null = null;
    const waitForReady = options.waitForReady ?? true;
    if (waitForReady) {
      const readyType = options.readyType ?? "ready";
      readyMessage = await runtime.waitForMessage(
        (message) => {
          const parsed = message.parsed as { type?: string } | null;
          return parsed?.type === readyType;
        },
        options.readyTimeoutMs ?? 2000,
      );
      this.index.updateHeartbeat(childId, readyMessage.receivedAt);
      this.index.updateState(childId, "ready");
    }

    return { childId, index: snapshot, runtime, readyMessage };
  }

  /**
   * Sends a payload to a child and updates the lifecycle state to `running`.
   */
  async send(childId: string, payload: unknown): Promise<SendResult> {
    const runtime = this.requireRuntime(childId);
    await runtime.send(payload);
    this.index.updateState(childId, "running");
    const messageId = `${childId}:${this.nextMessageIndex(childId)}`;
    return { messageId, sentAt: Date.now() };
  }

  /**
   * Waits for a message emitted by the child. This is a thin wrapper around the
   * runtime helper but keeps the supervisor API cohesive for the tests.
   */
  async waitForMessage(
    childId: string,
    predicate: (message: ChildRuntimeMessage) => boolean,
    timeoutMs?: number,
  ): Promise<ChildRuntimeMessage> {
    const runtime = this.requireRuntime(childId);
    return runtime.waitForMessage(predicate, timeoutMs);
  }

  /**
   * Collects the latest outputs generated by the child.
   */
  async collect(childId: string): Promise<ChildCollectedOutputs> {
    const runtime = this.requireRuntime(childId);
    return runtime.collectOutputs();
  }

  /**
   * Provides paginated access to the buffered messages emitted by the child.
   */
  stream(childId: string, options?: ChildMessageStreamOptions): ChildMessageStreamResult {
    const runtime = this.requireRuntime(childId);
    return runtime.streamMessages(options);
  }

  /**
   * Retrieves a combined status snapshot from the runtime and the index.
   */
  status(childId: string): ChildStatusSnapshot {
    const runtime = this.requireRuntime(childId);
    const index = this.requireIndex(childId);
    return { runtime: runtime.getStatus(), index };
  }

  /**
   * Returns the set of tools explicitly allowed for the targeted child. An
   * empty array means the child is unrestricted.
   */
  getAllowedTools(childId: string): readonly string[] {
    const runtime = this.requireRuntime(childId);
    return runtime.toolsAllow;
  }

  /**
   * Requests a graceful shutdown of the child.
   */
  async cancel(childId: string, options?: { signal?: NodeJS.Signals; timeoutMs?: number }): Promise<ChildShutdownResult> {
    const runtime = this.requireRuntime(childId);
    this.index.updateState(childId, "stopping");
    return runtime.shutdown(options);
  }

  /**
   * Forcefully terminates the child.
   */
  async kill(childId: string, options?: { timeoutMs?: number }): Promise<ChildShutdownResult> {
    const runtime = this.requireRuntime(childId);
    this.index.updateState(childId, "stopping");
    return runtime.shutdown({ signal: "SIGTERM", timeoutMs: options?.timeoutMs ?? 100, force: true });
  }

  /**
   * Waits for the child to exit and returns the shutdown information.
   */
  async waitForExit(childId: string, timeoutMs?: number): Promise<ChildShutdownResult> {
    const runtime = this.runtimes.get(childId);
    if (runtime) {
      const exit = await runtime.waitForExit(timeoutMs);
      const result: ChildShutdownResult = {
        code: exit.code,
        signal: exit.signal,
        forced: exit.forced,
        durationMs: Math.max(0, exit.at - runtime.getStatus().startedAt),
      };
      this.exitEvents.set(childId, result);
      return result;
    }

    const recorded = this.exitEvents.get(childId);
    if (!recorded) {
      throw new Error(`Unknown child runtime: ${childId}`);
    }
    return recorded;
  }

  /**
   * Removes the child from the supervisor index once it has terminated.
   */
  gc(childId: string): void {
    this.index.removeChild(childId);
    this.runtimes.delete(childId);
    this.messageCounters.delete(childId);
    this.exitEvents.delete(childId);
    this.clearIdleWatchdog(childId);
  }

  /**
   * Stops all running children. Used as a best-effort cleanup helper in tests.
   */
  async disposeAll(): Promise<void> {
    const shutdowns: Promise<unknown>[] = [];
    for (const [childId, runtime] of this.runtimes.entries()) {
      this.index.updateState(childId, "stopping");
      shutdowns.push(
        runtime
          .shutdown({ signal: "SIGTERM", timeoutMs: 500 })
          .catch(() => runtime.shutdown({ signal: "SIGKILL", timeoutMs: 500 })),
      );
    }
    await Promise.allSettled(shutdowns);
    this.runtimes.clear();
    this.messageCounters.clear();
    this.exitEvents.clear();
    for (const timer of this.watchdogs.values()) {
      clearInterval(timer);
    }
    this.watchdogs.clear();
  }

  private requireRuntime(childId: string): ChildRuntime {
    const runtime = this.runtimes.get(childId);
    if (!runtime) {
      throw new Error(`Unknown child runtime: ${childId}`);
    }
    return runtime;
  }

  private requireIndex(childId: string): ChildRecordSnapshot {
    const snapshot = this.index.getChild(childId);
    if (!snapshot) {
      throw new Error(`Unknown child record: ${childId}`);
    }
    return snapshot;
  }

  private nextMessageIndex(childId: string): number {
    const current = this.messageCounters.get(childId) ?? 0;
    const next = current + 1;
    this.messageCounters.set(childId, next);
    return next;
  }

  /**
   * Periodically inspects the last heartbeat of the child to infer idleness.
   * When the inactivity window exceeds {@link idleTimeoutMs} the lifecycle
   * state transitions to `idle` so higher level tools can recycle the clone.
   */
  private scheduleIdleWatchdog(childId: string): void {
    if (this.idleTimeoutMs <= 0) {
      return;
    }

    const existing = this.watchdogs.get(childId);
    if (existing) {
      clearInterval(existing);
    }

    const interval = Math.min(this.idleCheckIntervalMs, this.idleTimeoutMs || this.idleCheckIntervalMs);
    const timer = setInterval(() => {
      const snapshot = this.index.getChild(childId);
      if (!snapshot) {
        this.clearIdleWatchdog(childId);
        return;
      }

      if (["terminated", "killed", "error"].includes(snapshot.state)) {
        this.clearIdleWatchdog(childId);
        return;
      }

      if (snapshot.state === "stopping" || snapshot.state === "running") {
        return;
      }

      if (snapshot.lastHeartbeatAt === null) {
        return;
      }

      const inactiveFor = Date.now() - snapshot.lastHeartbeatAt;
      if (inactiveFor >= this.idleTimeoutMs && snapshot.state !== "idle") {
        this.index.updateState(childId, "idle");
      }
    }, interval);

    if (typeof timer.unref === "function") {
      timer.unref();
    }

    this.watchdogs.set(childId, timer);
  }

  /** Clears the watchdog timer associated with the provided child identifier. */
  private clearIdleWatchdog(childId: string): void {
    const timer = this.watchdogs.get(childId);
    if (timer) {
      clearInterval(timer);
      this.watchdogs.delete(childId);
    }
  }
}
