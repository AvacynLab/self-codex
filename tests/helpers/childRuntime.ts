import type {
  ChildCollectedOutputs,
  ChildMessageStreamOptions,
  ChildMessageStreamResult,
  ChildRuntimeContract,
  ChildRuntimeExitEvent,
  ChildRuntimeLimits,
  ChildRuntimeMessage,
  ChildRuntimeStatus,
  ChildShutdownResult,
} from "../../src/childRuntime.js";

/**
 * Runtime payload emitted by Codex children. Child responses always expose a
 * discriminant `type` field and may embed arbitrary metadata depending on the
 * tool that produced the output, hence the `Record<string, unknown>` extension.
 */
export interface ChildRuntimeTypedPayload<Type extends string = string>
  extends Record<string, unknown> {
  type: Type;
}

/** Message wrapper guaranteeing the discriminant exposed by the payload. */
export type ChildRuntimeTypedMessage<Type extends string> = ChildRuntimeMessage<
  ChildRuntimeTypedPayload<Type>
>;

/**
 * Narrows the payload attached to a child runtime message. The helper is
 * intentionally permissive—only guarding the `type` field—so tests can probe
 * additional properties without forcing exhaustive runtime validation.
 */
export function hasChildRuntimeMessageType<Type extends string>(
  message: ChildRuntimeMessage,
  expectedType: Type,
): message is ChildRuntimeTypedMessage<Type> {
  return hasChildRuntimePayloadType(message.parsed, expectedType);
}

/**
 * Narrows arbitrary parsed payloads (e.g. log snapshots) to a specific child
 * message type. A dedicated helper keeps the type guard reusable across the
 * suite, including places where only the raw payload is available.
 */
export function hasChildRuntimePayloadType<Type extends string>(
  payload: unknown,
  expectedType: Type,
): payload is ChildRuntimeTypedPayload<Type> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const candidate = (payload as { type?: unknown }).type;
  return typeof candidate === "string" && candidate === expectedType;
}

/**
 * Asserts the presence of the expected discriminant on a runtime message and
 * returns the narrowed instance. Throwing an error keeps the helper compatible
 * with promise chains used by `waitForMessage` predicates.
 */
export function expectChildRuntimeMessageType<Type extends string>(
  message: ChildRuntimeMessage,
  expectedType: Type,
): ChildRuntimeTypedMessage<Type> {
  if (!hasChildRuntimeMessageType(message, expectedType)) {
    let detail = String(message.parsed);
    if (message.parsed && typeof message.parsed === "object") {
      try {
        detail = JSON.stringify(message.parsed);
      } catch {
        detail = "[unserializable payload]";
      }
    }
    throw new Error(`Expected child runtime message of type "${expectedType}" but received ${detail}`);
  }
  return message;
}

/**
 * Options configuring the {@link createStubChildRuntime} helper. Tests can supply callbacks to
 * customise the behaviour they exercise while the helper provides deterministic defaults that
 * satisfy the {@link ChildRuntimeContract} without reaching for structural casts.
 */
export interface StubChildRuntimeOptions {
  /** Identifier advertised by the runtime. */
  childId: string;
  /** Path to the manifest surfaced to callers. */
  manifestPath: string;
  /** Path to the runtime log file. */
  logPath: string;
  /** Snapshot returned by {@link ChildRuntimeContract.getStatus}. */
  status: ChildRuntimeStatus;
  /** Optional whitelist of tools surfaced by {@link ChildRuntimeContract.toolsAllow}. */
  toolsAllow?: readonly string[];
  /** Result returned by {@link ChildRuntimeContract.shutdown}. */
  shutdownResult?: ChildShutdownResult;
  /** Exit event returned by {@link ChildRuntimeContract.waitForExit}. */
  exitEvent?: ChildRuntimeExitEvent;
  /** Custom collector invoked by {@link ChildRuntimeContract.collectOutputs}. */
  collectOutputs?: () => Promise<ChildCollectedOutputs> | ChildCollectedOutputs;
  /** Custom stream implementation used by {@link ChildRuntimeContract.streamMessages}. */
  streamMessages?: (options?: ChildMessageStreamOptions) => ChildMessageStreamResult;
  /** Custom waiter invoked when {@link ChildRuntimeContract.waitForMessage} is called. */
  waitForMessage?: (
    predicate: (message: ChildRuntimeMessage) => boolean,
    timeoutMs?: number,
  ) => Promise<ChildRuntimeMessage>;
  /** Optional hook invoked whenever {@link ChildRuntimeContract.send} is called. */
  send?: (payload: unknown) => Promise<void> | void;
  /** Optional hook invoked whenever {@link ChildRuntimeContract.setRole} is called. */
  setRole?: (role: string | null, extras: Record<string, unknown>) => Promise<void> | void;
  /** Optional hook invoked whenever {@link ChildRuntimeContract.setLimits} is called. */
  setLimits?: (
    limits: ChildRuntimeLimits | null,
    extras: Record<string, unknown>,
  ) => Promise<void> | void;
  /** Optional hook invoked whenever {@link ChildRuntimeContract.attach} is called. */
  attach?: (extras: Record<string, unknown>) => Promise<void> | void;
}

/**
 * Builds a lightweight implementation of {@link ChildRuntimeContract} tailored for tests. The
 * helper clones structured payloads to keep assertions side-effect free and defaults every
 * behaviour to a deterministic no-op so suites only customise the pieces they need.
 */
export function createStubChildRuntime(options: StubChildRuntimeOptions): ChildRuntimeContract {
  const toolsAllow = Object.freeze([...(options.toolsAllow ?? [])]);
  const shutdownResult: ChildShutdownResult = options.shutdownResult ?? {
    code: 0,
    signal: null,
    forced: false,
    durationMs: 0,
  };
  const exitEvent: ChildRuntimeExitEvent = options.exitEvent ?? {
    code: shutdownResult.code,
    signal: shutdownResult.signal,
    forced: shutdownResult.forced,
    at: Date.now(),
    error: null,
  };

  const baseStatus: ChildRuntimeStatus = {
    childId: options.status.childId,
    pid: options.status.pid,
    command: options.status.command,
    args: [...options.status.args],
    workdir: options.status.workdir,
    startedAt: options.status.startedAt,
    lastHeartbeatAt: options.status.lastHeartbeatAt,
    lifecycle: options.status.lifecycle,
    closed: options.status.closed,
    exit: options.status.exit ? { ...options.status.exit } : null,
    resourceUsage: options.status.resourceUsage ?? null,
  };

  return {
    childId: options.childId,
    manifestPath: options.manifestPath,
    logPath: options.logPath,
    toolsAllow,
    async shutdown() {
      return shutdownResult;
    },
    async waitForExit() {
      return exitEvent;
    },
    async waitForMessage(predicate, timeoutMs) {
      if (!options.waitForMessage) {
        throw new Error("Stub child runtime waitForMessage not implemented");
      }
      return options.waitForMessage(predicate, timeoutMs);
    },
    async collectOutputs() {
      if (options.collectOutputs) {
        const outputs = await options.collectOutputs();
        return {
          ...outputs,
          artifacts: [...outputs.artifacts],
          messages: outputs.messages.map((message) => ({ ...message })),
        };
      }
      return {
        childId: options.childId,
        manifestPath: options.manifestPath,
        logPath: options.logPath,
        artifacts: [],
        messages: [],
      } satisfies ChildCollectedOutputs;
    },
    streamMessages(streamOptions) {
      if (options.streamMessages) {
        return options.streamMessages(streamOptions);
      }
      return {
        childId: options.childId,
        totalMessages: 0,
        matchedMessages: 0,
        hasMore: false,
        nextCursor: null,
        messages: [],
      } satisfies ChildMessageStreamResult;
    },
    async send(payload) {
      if (options.send) {
        await options.send(payload);
      }
    },
    async setRole(role, extras = {}) {
      if (options.setRole) {
        await options.setRole(role ?? null, extras);
      }
    },
    async setLimits(limits, extras = {}) {
      if (options.setLimits) {
        await options.setLimits(limits ?? null, extras);
      }
    },
    async attach(extras = {}) {
      if (options.attach) {
        await options.attach(extras);
      }
    },
    getStatus() {
      return {
        ...baseStatus,
        args: [...baseStatus.args],
        exit: baseStatus.exit ? { ...baseStatus.exit } : null,
      } satisfies ChildRuntimeStatus;
    },
  } satisfies ChildRuntimeContract;
}
