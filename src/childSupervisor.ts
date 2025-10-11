import { randomUUID } from "node:crypto";
import { runtimeTimers, type IntervalHandle } from "./runtime/timers.js";
import process from "node:process";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import type { ProcessEnv, Signal } from "./nodePrimitives.js";

import { defaultFileSystemGateway, type FileSystemGateway } from "./gateways/fs.js";

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
import type { EventBus } from "./events/bus.js";
import { bridgeChildRuntimeEvents, type ChildRuntimeBridgeContext } from "./events/bridges.js";
import { extractCorrelationHints, mergeCorrelationHints, type EventCorrelationHints } from "./events/correlation.js";
import { ChildrenIndex, ChildRecordSnapshot } from "./state/childrenIndex.js";
import { childWorkspacePath, ensureDirectory } from "./paths.js";

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
  defaultEnv?: ProcessEnv;
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
  /** Optional safety guardrails enforced while spawning children. */
  safety?: ChildSupervisorSafetyOptions;
  /**
   * Optional event bus used to publish child lifecycle and IO events. When
   * provided the supervisor automatically bridges every runtime.
   */
  eventBus?: EventBus;
  /**
   * Optional resolver injecting correlation metadata into bus events derived
   * from child payloads or index state.
   */
  resolveChildCorrelation?: (context: ChildRuntimeBridgeContext) => EventCorrelationHints | void;
  /**
   * Optional sink invoked whenever the supervisor receives a child log entry.
   * Allows callers to persist IO streams alongside correlation metadata.
   */
  recordChildLogEntry?: (childId: string, entry: ChildLogEventSnapshot) => void;
  /** File-system gateway used to persist manifests and other artefacts. */
  fileSystem?: FileSystemGateway;
}

/** Snapshot persisted when forwarding child logs to downstream observers. */
export interface ChildLogEventSnapshot {
  /** Timestamp at which the runtime delivered the log entry. */
  ts: number;
  /** Stream that produced the output (stdout/stderr/meta). */
  stream: "stdout" | "stderr" | "meta";
  /** Human readable representation (usually the raw line). */
  message: string;
  /** Identifier of the child that produced the log entry. */
  childId?: string;
  /** Optional job identifier correlated to the log entry. */
  jobId?: string | null;
  /** Optional run identifier correlated to the log entry. */
  runId?: string | null;
  /** Optional operation identifier correlated to the log entry. */
  opId?: string | null;
  /** Optional graph identifier correlated to the log entry. */
  graphId?: string | null;
  /** Optional node identifier correlated to the log entry. */
  nodeId?: string | null;
  /** Raw representation forwarded by the runtime, if any. */
  raw?: string | null;
  /** Parsed payload decoded from the runtime output when available. */
  parsed?: unknown;
}

/**
 * Declarative guardrails enforced by the supervisor. When configured, the
 * supervisor refuses to spawn new children beyond the maximum threshold and
 * annotates each manifest with the configured resource ceilings.
 */
export interface ChildSupervisorSafetyOptions {
  /** Maximum number of concurrent children allowed. */
  maxChildren?: number | null;
  /** Upper bound on the memory (in megabytes) granted to each child. */
  memoryLimitMb?: number | null;
  /** Upper bound on the CPU usage percentage granted to each child. */
  cpuPercent?: number | null;
}

/** Snapshot describing the currently enforced safety limits. */
export interface ChildSupervisorSafetySnapshot {
  maxChildren: number | null;
  memoryLimitMb: number | null;
  cpuPercent: number | null;
}

/** Descriptor persisted for logical HTTP children managed without spawning processes. */
interface LogicalChildSession {
  /** Identifier allocated to the logical child. */
  childId: string;
  /** Timestamp recorded when the logical session was registered. */
  startedAt: number;
  /** Last heartbeat timestamp used to keep the index coherent. */
  lastHeartbeatAt: number;
  /** Normalised HTTP endpoint reused by Codex children when calling back the server. */
  endpoint: { url: string; headers: Record<string, string> };
  /** Absolute path to the manifest mirrored on disk for observability. */
  manifestPath: string;
  /** Absolute path to the log file associated with the logical child. */
  logPath: string;
  /** Workspace directory reserved for the logical child. */
  workdir: string;
  /** Metadata snapshot exposed through the children index. */
  metadata: Record<string, unknown>;
  /** Declarative limits advertised for the logical child. */
  limits: ChildRuntimeLimits | null;
  /** High level role attached to the child if provided by the caller. */
  role: string | null;
  /** Additional manifest fields persisted alongside the runtime metadata. */
  manifestExtras: Record<string, unknown>;
  /** Tool allow-list applied to this logical child. */
  allowedTools: readonly string[];
}

/** Options accepted when registering a logical HTTP child. */
export interface RegisterHttpChildOptions {
  /** Optional identifier pre-allocated by the caller. */
  childId?: string;
  /** HTTP endpoint (URL + headers) pointing back to the orchestrator. */
  endpoint: { url: string; headers: Record<string, string> };
  /** Arbitrary metadata mirrored into the manifest and children index. */
  metadata?: Record<string, unknown>;
  /** Declarative limits tracked for the logical child. */
  limits?: ChildRuntimeLimits | null;
  /** Optional human readable role advertised for observability. */
  role?: string | null;
  /** Additional manifest fields persisted on disk. */
  manifestExtras?: Record<string, unknown>;
  /** Tools explicitly allowed for the logical child. */
  allowedTools?: string[] | null;
  /** Timestamp override used primarily by tests. */
  startedAt?: number;
}

/** Snapshot returned once a logical HTTP child has been registered. */
export interface RegisterHttpChildResult {
  childId: string;
  index: ChildRecordSnapshot;
  manifestPath: string;
  logPath: string;
  workdir: string;
  startedAt: number;
}

/** Error raised when the caller attempts to exceed the configured child cap. */
export class ChildLimitExceededError extends Error {
  public readonly code = "E-CHILD-LIMIT";

  public readonly hint = "max_children_reached";

  constructor(readonly maxChildren: number, readonly activeChildren: number) {
    super(
      `Cannot spawn more than ${maxChildren} child(ren); ${activeChildren} already running`,
    );
    this.name = "ChildLimitExceededError";
  }
}

/**
 * Error raised when a caller requests limits above the configured ceilings. We
 * expose a dedicated code so the server can map the violation to a structured
 * MCP error payload.
 */
export class ChildLimitOverrideError extends Error {
  public readonly code = "E-CHILD-LIMIT";

  public readonly hint = "limit_override_rejected";

  constructor(readonly limit: "memory_mb" | "cpu_percent", readonly maximum: number, readonly requested: number) {
    super(`Limit ${limit}=${requested} exceeds configured maximum ${maximum}`);
    this.name = "ChildLimitOverrideError";
  }
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
  env?: ProcessEnv;
  /** Metadata persisted in the runtime manifest and surfaced via the index. */
  metadata?: Record<string, unknown>;
  /** Additional manifest fields (handy for tooling). */
  manifestExtras?: Record<string, unknown>;
  /** Declarative limits applied to the child runtime (tokens, time, etc.). */
  limits?: ChildRuntimeLimits | null;
  /** Optional human readable role advertised for observability purposes. */
  role?: string | null;
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
  private readonly defaultEnv: ProcessEnv;
  private readonly index: ChildrenIndex;
  private readonly runtimes = new Map<string, ChildRuntime>();
  private readonly logicalChildren = new Map<string, LogicalChildSession>();
  private readonly messageCounters = new Map<string, number>();
  private readonly exitEvents = new Map<string, ChildShutdownResult>();
  private readonly watchdogs = new Map<string, IntervalHandle>();
  private readonly eventBus?: EventBus;
  private readonly resolveChildCorrelation?: (
    context: ChildRuntimeBridgeContext,
  ) => EventCorrelationHints | void;
  private readonly recordChildLogEntry?: (childId: string, entry: ChildLogEventSnapshot) => void;
  private readonly fileSystem: FileSystemGateway;
  private readonly childEventBridges = new Map<string, () => void>();
  private readonly childLogRecorders = new Map<string, (message: ChildRuntimeMessage) => void>();
  private readonly idleTimeoutMs: number;
  private readonly idleCheckIntervalMs: number;
  private maxChildren: number | null = null;
  private memoryLimitMb: number | null = null;
  private cpuPercent: number | null = null;
  private baseLimitsTemplate: ChildRuntimeLimits | null = null;

  constructor(options: ChildSupervisorOptions) {
    this.childrenRoot = options.childrenRoot;
    this.defaultCommand = options.defaultCommand;
    this.defaultArgs = options.defaultArgs ? [...options.defaultArgs] : [];
    this.defaultEnv = { ...(options.defaultEnv ?? {}) };
    this.index = options.index ?? new ChildrenIndex();
    this.eventBus = options.eventBus;
    this.resolveChildCorrelation = options.resolveChildCorrelation;
    this.recordChildLogEntry = options.recordChildLogEntry;
    this.fileSystem = options.fileSystem ?? defaultFileSystemGateway;

    const configuredIdle = options.idleTimeoutMs ?? 120_000;
    this.idleTimeoutMs = configuredIdle > 0 ? configuredIdle : 0;
    const defaultInterval = Math.max(250, Math.min(5_000, this.idleTimeoutMs || 5_000));
    const configuredInterval = options.idleCheckIntervalMs;
    const interval = configuredInterval ?? defaultInterval;
    this.idleCheckIntervalMs = interval > 0 ? Math.min(interval, Math.max(250, this.idleTimeoutMs || interval)) : defaultInterval;

    this.configureSafety(options.safety ?? {});
  }

  /** Returns the safety guardrails currently enforced by the supervisor. */
  getSafetySnapshot(): ChildSupervisorSafetySnapshot {
    return {
      maxChildren: this.maxChildren,
      memoryLimitMb: this.memoryLimitMb,
      cpuPercent: this.cpuPercent,
    };
  }

  /**
   * Updates the safety guardrails. Thresholds are clamped to safe bounds so a
   * misconfiguration never disables protections entirely.
   */
  configureSafety(options: ChildSupervisorSafetyOptions): void {
    const { maxChildren, memoryLimitMb, cpuPercent } = options;

    if (typeof maxChildren === "number" && Number.isFinite(maxChildren) && maxChildren > 0) {
      this.maxChildren = Math.max(1, Math.trunc(maxChildren));
    } else {
      this.maxChildren = null;
    }

    if (typeof memoryLimitMb === "number" && Number.isFinite(memoryLimitMb) && memoryLimitMb > 0) {
      this.memoryLimitMb = Math.max(1, Math.trunc(memoryLimitMb));
    } else {
      this.memoryLimitMb = null;
    }

    if (typeof cpuPercent === "number" && Number.isFinite(cpuPercent) && cpuPercent > 0) {
      this.cpuPercent = Math.max(1, Math.min(100, Math.trunc(cpuPercent)));
    } else {
      this.cpuPercent = null;
    }

    const template: ChildRuntimeLimits = {};
    if (this.memoryLimitMb !== null) {
      template.memory_mb = this.memoryLimitMb;
    }
    if (this.cpuPercent !== null) {
      template.cpu_percent = this.cpuPercent;
    }

    this.baseLimitsTemplate = Object.keys(template).length > 0 ? template : null;
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
   * Allocates a fresh child identifier compatible with the on-disk layout. The helper
   * guarantees uniqueness across both process-backed and logical children.
   */
  createChildId(): string {
    while (true) {
      const candidate = ChildSupervisor.generateChildId();
      if (this.runtimes.has(candidate) || this.logicalChildren.has(candidate) || this.index.getChild(candidate)) {
        continue;
      }
      return candidate;
    }
  }

  /**
   * Registers a logical HTTP child that routes work back to the orchestrator instead of spawning a
   * dedicated process. A manifest is still persisted to keep observability tooling consistent.
   */
  async registerHttpChild(options: RegisterHttpChildOptions): Promise<RegisterHttpChildResult> {
    const childId = options.childId ?? this.createChildId();

    if (this.runtimes.has(childId) || this.logicalChildren.has(childId)) {
      throw new Error(`A child is already registered under identifier ${childId}`);
    }

    if (this.maxChildren !== null) {
      const activeChildren = this.countActiveChildren();
      if (activeChildren >= this.maxChildren) {
        throw new ChildLimitExceededError(this.maxChildren, activeChildren);
      }
    }

    const startedAt = options.startedAt ?? Date.now();
    const limits = options.limits ? { ...options.limits } : null;
    const role = options.role ?? null;
    const allowedTools = options.allowedTools ? [...new Set(options.allowedTools)] : [];

    await ensureDirectory(this.childrenRoot, childId);
    await ensureDirectory(this.childrenRoot, childId, "logs");
    await ensureDirectory(this.childrenRoot, childId, "outbox");
    await ensureDirectory(this.childrenRoot, childId, "inbox");

    const workdir = childWorkspacePath(this.childrenRoot, childId);
    const manifestPath = childWorkspacePath(this.childrenRoot, childId, "manifest.json");
    const logPath = childWorkspacePath(this.childrenRoot, childId, "logs", "child.log");

    const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };
    metadata.transport = "http";
    metadata.endpoint = { ...options.endpoint };

    const manifestExtras = { ...(options.manifestExtras ?? {}) };
    delete manifestExtras.role;
    delete manifestExtras.limits;

    const indexSnapshot = this.index.registerChild({
      childId,
      pid: -1,
      workdir,
      state: "ready",
      startedAt,
      metadata,
      role,
      limits,
      attachedAt: startedAt,
    });

    this.index.updateHeartbeat(childId, startedAt);

    const session: LogicalChildSession = {
      childId,
      startedAt,
      lastHeartbeatAt: startedAt,
      endpoint: { url: options.endpoint.url, headers: { ...options.endpoint.headers } },
      manifestPath,
      logPath,
      workdir,
      metadata,
      limits,
      role,
      manifestExtras,
      allowedTools,
    };

    await this.writeLogicalManifest(session);

    this.logicalChildren.set(childId, session);

    return { childId, index: indexSnapshot, manifestPath, logPath, workdir, startedAt };
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

    const inferCorrelation = (context: ChildRuntimeBridgeContext): EventCorrelationHints => {
      const hints: EventCorrelationHints = { childId };

      mergeCorrelationHints(hints, extractCorrelationHints(runtime.metadata));
      const indexSnapshot = this.index.getChild(childId);
      if (indexSnapshot) {
        mergeCorrelationHints(hints, extractCorrelationHints(indexSnapshot.metadata));
      }

      if (context.kind === "message") {
        // When the child surfaces structured payloads we opportunistically
        // reuse the embedded identifiers to correlate stdout/stderr events
        // with their originating run/operation.
        const payload = context.message.parsed as Record<string, unknown> | null;
        if (payload && typeof payload === "object") {
          const runId = payload.runId;
          const opId = payload.opId;
          const jobId = payload.jobId;
          const graphId = payload.graphId;
          const nodeId = payload.nodeId;
          if (typeof runId === "string" && runId.length > 0) {
            hints.runId = runId;
          }
          if (typeof opId === "string" && opId.length > 0) {
            hints.opId = opId;
          }
          if (typeof jobId === "string" && jobId.length > 0) {
            hints.jobId = jobId;
          }
          if (typeof graphId === "string" && graphId.length > 0) {
            hints.graphId = graphId;
          }
          if (typeof nodeId === "string" && nodeId.length > 0) {
            hints.nodeId = nodeId;
          }
        }
      }

      const extra = this.resolveChildCorrelation?.(context);
      // Merge external correlation hints without letting sparse resolvers wipe
      // the identifiers inferred from the child payload (undefined should
      // never override concrete hints such as the childId).
      if (extra) {
        mergeCorrelationHints(hints, extra);
      }
      return hints;
    };

    if (this.eventBus) {
      const disposeBridge = bridgeChildRuntimeEvents({
        runtime,
        bus: this.eventBus,
        resolveCorrelation: inferCorrelation,
      });
      this.childEventBridges.set(childId, disposeBridge);
    }

    if (this.recordChildLogEntry) {
      const recorder = (message: ChildRuntimeMessage) => {
        const correlation = inferCorrelation({ kind: "message", runtime, message });
        const snapshot: ChildLogEventSnapshot = {
          ts: message.receivedAt,
          stream: message.stream,
          message: message.raw,
          childId,
          jobId: correlation.jobId ?? null,
          runId: correlation.runId ?? null,
          opId: correlation.opId ?? null,
          graphId: correlation.graphId ?? null,
          nodeId: correlation.nodeId ?? null,
          raw: message.raw,
          parsed: message.parsed,
        };
        this.recordChildLogEntry?.(childId, snapshot);
      };
      runtime.on("message", recorder);
      this.childLogRecorders.set(childId, recorder);
    }

    runtime
      .waitForExit()
      .then((event) => {
        this.clearIdleWatchdog(childId);
        this.detachEventBridge(childId);
        this.detachChildLogRecorder(childId);
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
        this.detachEventBridge(childId);
        this.detachChildLogRecorder(childId);
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

    if (this.maxChildren !== null) {
      const activeChildren = this.countActiveChildren();
      if (activeChildren >= this.maxChildren) {
        throw new ChildLimitExceededError(this.maxChildren, activeChildren);
      }
    }

    const command = options.command ?? this.defaultCommand;
    const args = options.args ? [...options.args] : [...this.defaultArgs];
    const env = { ...this.defaultEnv, ...(options.env ?? {}) };

    const resolvedLimits = this.resolveChildLimits(options.limits ?? null);
    const resolvedRole = options.role ?? (typeof options.metadata?.role === "string" ? String(options.metadata.role) : null);

    const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };
    if (resolvedRole !== null) {
      metadata.role = resolvedRole;
    }
    if (resolvedLimits) {
      metadata.limits = structuredClone(resolvedLimits);
    }

    const runtime = await startChildRuntime({
      childId,
      childrenRoot: this.childrenRoot,
      command,
      args,
      env,
      metadata,
      manifestExtras: options.manifestExtras,
      limits: resolvedLimits,
      role: resolvedRole,
      toolsAllow: options.toolsAllow ?? null,
      spawnRetry: options.spawnRetry,
    });

    const snapshot = this.index.registerChild({
      childId,
      pid: runtime.pid,
      workdir: runtime.workdir,
      metadata,
      state: "starting",
      limits: resolvedLimits,
      role: resolvedRole,
      attachedAt: Date.now(),
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
    const logical = this.getLogicalChild(childId);
    if (logical) {
      throw new Error(`Logical child ${childId} does not support direct send operations`);
    }
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
    const logical = this.getLogicalChild(childId);
    if (logical) {
      throw new Error(`Logical child ${childId} cannot emit process messages`);
    }
    const runtime = this.requireRuntime(childId);
    return runtime.waitForMessage(predicate, timeoutMs);
  }

  /**
   * Collects the latest outputs generated by the child.
   */
  async collect(childId: string): Promise<ChildCollectedOutputs> {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      return {
        childId,
        manifestPath: logical.manifestPath,
        logPath: logical.logPath,
        messages: [],
        artifacts: [],
      };
    }
    const runtime = this.requireRuntime(childId);
    return runtime.collectOutputs();
  }

  /**
   * Updates the advertised role for a running child and rewrites its manifest so
   * observers can react to the change without restarting the process.
   */
  async setChildRole(
    childId: string,
    role: string | null,
    options: { manifestExtras?: Record<string, unknown> } = {},
  ): Promise<ChildStatusSnapshot> {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      logical.role = role;
      const metadata = { ...logical.metadata };
      if (role === null) {
        delete metadata.role;
      } else {
        metadata.role = role;
      }
      logical.metadata = metadata;
      this.mergeLogicalManifestExtras(logical, options.manifestExtras);
      await this.writeLogicalManifest(logical);
      const index = this.index.setRole(childId, role);
      return { runtime: this.buildLogicalRuntimeStatus(logical), index };
    }
    const runtime = this.requireRuntime(childId);
    await runtime.setRole(role, options.manifestExtras ?? {});
    const index = this.index.setRole(childId, role);
    return { runtime: runtime.getStatus(), index };
  }

  /**
   * Applies new declarative limits to the runtime after enforcing supervisor
   * guardrails. The manifest is rewritten to surface the new ceilings.
   */
  async setChildLimits(
    childId: string,
    limits: ChildRuntimeLimits | null,
    options: { manifestExtras?: Record<string, unknown> } = {},
  ): Promise<ChildStatusSnapshot & { limits: ChildRuntimeLimits | null }> {
    const resolved = this.resolveChildLimits(limits ?? null);
    const logical = this.getLogicalChild(childId);
    const publishLimitsEvent = (limitsSnapshot: ChildRuntimeLimits | null) => {
      if (!this.eventBus) {
        return;
      }
      // Surface the update on the unified event bus so validation tooling can
      // assert declarative guardrails were actually refreshed. The message
      // mirrors the checklist wording while the structured payload retains the
      // resolved limits for downstream consumers.
      this.eventBus.publish({
        cat: "child",
        level: "info",
        childId,
        component: "child_supervisor",
        stage: "limits",
        msg: "child.limits.updated",
        data: { childId, limits: limitsSnapshot },
      });
    };
    if (logical) {
      logical.limits = resolved ? { ...resolved } : null;
      const metadata = { ...logical.metadata };
      if (logical.limits) {
        metadata.limits = structuredClone(logical.limits);
      } else {
        delete metadata.limits;
      }
      logical.metadata = metadata;
      this.mergeLogicalManifestExtras(logical, options.manifestExtras);
      await this.writeLogicalManifest(logical);
      const index = this.index.setLimits(childId, resolved);
      publishLimitsEvent(resolved);
      return { runtime: this.buildLogicalRuntimeStatus(logical), index, limits: resolved };
    }
    const runtime = this.requireRuntime(childId);
    await runtime.setLimits(resolved, options.manifestExtras ?? {});
    const index = this.index.setLimits(childId, resolved);
    publishLimitsEvent(resolved);
    return { runtime: runtime.getStatus(), index, limits: resolved };
  }

  /**
   * Refreshes the manifest of an already running child and records the
   * attachment timestamp for observability.
   */
  async attachChild(
    childId: string,
    options: { manifestExtras?: Record<string, unknown> } = {},
  ): Promise<ChildStatusSnapshot> {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      this.mergeLogicalManifestExtras(logical, options.manifestExtras);
      await this.writeLogicalManifest(logical);
      const existing = this.index.getChild(childId);
      const attachTimestamp = existing?.attachedAt ?? Date.now();
      const index = this.index.markAttached(childId, attachTimestamp);
      logical.lastHeartbeatAt = Date.now();
      this.index.updateHeartbeat(childId, logical.lastHeartbeatAt);
      return { runtime: this.buildLogicalRuntimeStatus(logical), index };
    }
    const runtime = this.requireRuntime(childId);
    await runtime.attach(options.manifestExtras ?? {});
    const index = this.index.markAttached(childId);
    return { runtime: runtime.getStatus(), index };
  }

  /**
   * Provides paginated access to the buffered messages emitted by the child.
   */
  stream(childId: string, options?: ChildMessageStreamOptions): ChildMessageStreamResult {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      return {
        childId,
        totalMessages: 0,
        matchedMessages: 0,
        hasMore: false,
        nextCursor: null,
        messages: [],
      };
    }
    const runtime = this.requireRuntime(childId);
    return runtime.streamMessages(options);
  }

  /**
   * Retrieves a combined status snapshot from the runtime and the index.
   */
  status(childId: string): ChildStatusSnapshot {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      const index = this.requireIndex(childId);
      return { runtime: this.buildLogicalRuntimeStatus(logical), index };
    }

    const runtime = this.requireRuntime(childId);
    const index = this.requireIndex(childId);
    return { runtime: runtime.getStatus(), index };
  }

  /**
   * Returns the set of tools explicitly allowed for the targeted child. An
   * empty array means the child is unrestricted.
   */
  getAllowedTools(childId: string): readonly string[] {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      return logical.allowedTools;
    }
    const runtime = this.requireRuntime(childId);
    return runtime.toolsAllow;
  }

  /**
   * Returns a shallow clone of the HTTP endpoint descriptor registered for the
   * provided logical child. Process-backed runtimes return `null` since they do
   * not expose an HTTP loopback endpoint.
   */
  getHttpEndpoint(childId: string): { url: string; headers: Record<string, string> } | null {
    const logical = this.getLogicalChild(childId);
    if (!logical) {
      return null;
    }
    return {
      url: logical.endpoint.url,
      headers: { ...logical.endpoint.headers },
    };
  }

  /**
   * Requests a graceful shutdown of the child.
   */
  async cancel(childId: string, options?: { signal?: Signal; timeoutMs?: number }): Promise<ChildShutdownResult> {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      this.index.updateState(childId, "stopping");
      return this.finalizeLogicalChild(logical, false);
    }
    const runtime = this.requireRuntime(childId);
    this.index.updateState(childId, "stopping");
    return runtime.shutdown(options);
  }

  /**
   * Forcefully terminates the child.
   */
  async kill(childId: string, options?: { timeoutMs?: number }): Promise<ChildShutdownResult> {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      this.index.updateState(childId, "stopping");
      return this.finalizeLogicalChild(logical, true);
    }
    const runtime = this.requireRuntime(childId);
    this.index.updateState(childId, "stopping");
    return runtime.shutdown({ signal: "SIGTERM", timeoutMs: options?.timeoutMs ?? 100, force: true });
  }

  /**
   * Waits for the child to exit and returns the shutdown information.
   */
  async waitForExit(childId: string, timeoutMs?: number): Promise<ChildShutdownResult> {
    const logical = this.getLogicalChild(childId);
    if (logical) {
      const recorded = this.exitEvents.get(childId);
      if (recorded) {
        return recorded;
      }
      throw new Error(`Logical child ${childId} is still active`);
    }
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
    this.logicalChildren.delete(childId);
    this.messageCounters.delete(childId);
    this.exitEvents.delete(childId);
    this.clearIdleWatchdog(childId);
    this.detachEventBridge(childId);
    this.detachChildLogRecorder(childId);
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
    for (const [childId, listener] of this.childLogRecorders.entries()) {
      const runtime = this.runtimes.get(childId);
      runtime?.off("message", listener);
    }
    this.childLogRecorders.clear();
    this.runtimes.clear();
    this.logicalChildren.clear();
    this.messageCounters.clear();
    this.exitEvents.clear();
    for (const dispose of this.childEventBridges.values()) {
      try {
        dispose();
      } catch {
        // Ignore bridge teardown errors during shutdown.
      }
    }
    this.childEventBridges.clear();
    for (const timer of this.watchdogs.values()) {
      runtimeTimers.clearInterval(timer);
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

  /** Returns the logical HTTP session if registered. */
  private getLogicalChild(childId: string): LogicalChildSession | undefined {
    return this.logicalChildren.get(childId);
  }

  /** Builds a runtime status snapshot for logical HTTP children. */
  private buildLogicalRuntimeStatus(session: LogicalChildSession): ChildRuntimeStatus {
    return {
      childId: session.childId,
      pid: -1,
      command: "http-loopback",
      args: [],
      workdir: session.workdir,
      startedAt: session.startedAt,
      lastHeartbeatAt: session.lastHeartbeatAt,
      lifecycle: "running",
      closed: false,
      exit: null,
      resourceUsage: null,
    };
  }

  /** Persists the manifest describing a logical HTTP child. */
  private async writeLogicalManifest(session: LogicalChildSession): Promise<void> {
    const manifest = {
      childId: session.childId,
      command: "http-loopback",
      args: [] as string[],
      pid: -1,
      startedAt: new Date(session.startedAt).toISOString(),
      workdir: session.workdir,
      workspace: session.workdir,
      logs: { child: session.logPath },
      envKeys: [] as string[],
      metadata: session.metadata,
      limits: session.limits,
      role: session.role,
      tools_allow: session.allowedTools,
      endpoint: session.endpoint,
      ...session.manifestExtras,
    };

    await this.fileSystem.writeFileUtf8(session.manifestPath, JSON.stringify(manifest, null, 2));
  }

  /** Merges extra manifest fields while filtering reserved keys. */
  private mergeLogicalManifestExtras(
    session: LogicalChildSession,
    extras: Record<string, unknown> | undefined,
  ): void {
    if (!extras || Object.keys(extras).length === 0) {
      return;
    }

    const merged = { ...session.manifestExtras };
    for (const [key, value] of Object.entries(extras)) {
      if (key === "role" || key === "limits") {
        continue;
      }
      merged[key] = structuredClone(value) as unknown;
    }
    session.manifestExtras = merged;
  }

  /** Records exit information and removes the logical child from the supervisor. */
  private finalizeLogicalChild(session: LogicalChildSession, forced: boolean): ChildShutdownResult {
    const durationMs = Math.max(0, Date.now() - session.startedAt);
    this.index.recordExit(session.childId, {
      code: 0,
      signal: null,
      forced,
      at: Date.now(),
      reason: forced ? "logical_child_forced" : "logical_child_completed",
    });

    const result: ChildShutdownResult = { code: 0, signal: null, forced, durationMs };
    this.exitEvents.set(session.childId, result);
    this.logicalChildren.delete(session.childId);
    return result;
  }

  /** Counts the number of children that are still running or spawning. */
  private countActiveChildren(): number {
    let active = 0;
    for (const runtime of this.runtimes.values()) {
      const lifecycle = runtime.getStatus().lifecycle;
      if (lifecycle === "spawning" || lifecycle === "running") {
        active += 1;
      }
    }
    active += this.logicalChildren.size;
    return active;
  }

  /**
   * Merges configured safety limits with caller-provided overrides while
   * guarding against attempts to exceed the configured ceilings.
   */
  private resolveChildLimits(overrides: ChildRuntimeLimits | null): ChildRuntimeLimits | null {
    const resolved: ChildRuntimeLimits = this.baseLimitsTemplate ? { ...this.baseLimitsTemplate } : {};

    if (overrides) {
      for (const [key, rawValue] of Object.entries(overrides)) {
        if (rawValue === undefined || rawValue === null) {
          continue;
        }

        if (key === "memory_mb" && this.memoryLimitMb !== null && typeof rawValue === "number") {
          if (rawValue > this.memoryLimitMb) {
            throw new ChildLimitOverrideError("memory_mb", this.memoryLimitMb, rawValue);
          }
        }

        if (key === "cpu_percent" && this.cpuPercent !== null && typeof rawValue === "number") {
          if (rawValue > this.cpuPercent) {
            throw new ChildLimitOverrideError("cpu_percent", this.cpuPercent, rawValue);
          }
        }

        resolved[key] = rawValue as ChildRuntimeLimits[keyof ChildRuntimeLimits];
      }
    }

    return Object.keys(resolved).length > 0 ? resolved : null;
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
      runtimeTimers.clearInterval(existing);
    }

    const interval = Math.min(this.idleCheckIntervalMs, this.idleTimeoutMs || this.idleCheckIntervalMs);
    const timer = runtimeTimers.setInterval(() => {
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
      runtimeTimers.clearInterval(timer);
      this.watchdogs.delete(childId);
    }
  }

  /** Detaches the event bridge associated with the child, if any. */
  private detachEventBridge(childId: string): void {
    const dispose = this.childEventBridges.get(childId);
    if (!dispose) {
      return;
    }
    try {
      dispose();
    } finally {
      this.childEventBridges.delete(childId);
    }
  }

  /** Detaches the log recorder associated with the child, if any. */
  private detachChildLogRecorder(childId: string): void {
    const listener = this.childLogRecorders.get(childId);
    if (!listener) {
      return;
    }
    try {
      this.runtimes.get(childId)?.off("message", listener);
    } finally {
      this.childLogRecorders.delete(childId);
    }
  }
}
