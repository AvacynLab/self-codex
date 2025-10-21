import { z } from "zod";

import { runtimeTimers } from "../../runtime/timers.js";

import {
  type BTStatus,
  type BehaviorNode,
  type BehaviorTickResult,
  type ParallelPolicy,
  type TickRuntime,
} from "./types.js";
import { OperationCancelledError } from "../cancel.js";

/**
 * Error thrown when cooperative cancellation is triggered at runtime.
 * Exported so callers embedding the Behaviour Tree runtime can detect the
 * cancellation path without depending on implementation details.
 */
export class BehaviorTreeCancellationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BehaviorTreeCancellationError";
  }
}

type CancellationLike = BehaviorTreeCancellationError | OperationCancelledError;

/** Convenience guard ensuring errors raised by cancellation can be identified. */
function isCancellationError(error: unknown): error is CancellationLike {
  return error instanceof BehaviorTreeCancellationError || error instanceof OperationCancelledError;
}

/**
 * Determine whether the provided value represents an abort signal coming from
 * an `AbortController`/`AbortSignal` pair. MCP tools may surface these errors
 * when the orchestrator cancels an in-flight tool invocation.
 */
function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; code?: unknown };
    if (typeof candidate.name === "string" && candidate.name.toLowerCase() === "aborterror") {
      return true;
    }
    if (typeof candidate.code === "string" && candidate.code.toUpperCase() === "ABORT_ERR") {
      return true;
    }
    if (typeof candidate.code === "number") {
      const abortCode = typeof DOMException !== "undefined" ? DOMException.ABORT_ERR : 20;
      if (candidate.code === abortCode) {
        return true;
      }
    }
  }
  return false;
}

/** Standard message surfaced when cancellation preempts a Behaviour Tree run. */
const DEFAULT_CANCELLATION_MESSAGE = "Behaviour Tree execution cancelled";

/**
 * Convert arbitrary cancellation reasons into the orchestrator-level error used by
 * the Behaviour Tree runtime. Preserves the root cause when available.
 */
function throwCancellation(cause?: unknown): never {
  if (cause instanceof BehaviorTreeCancellationError) {
    throw cause;
  }
  if (cause instanceof OperationCancelledError) {
    throw cause;
  }
  if (cause instanceof Error) {
    const message = cause.message && cause.message.trim().length > 0 ? cause.message : DEFAULT_CANCELLATION_MESSAGE;
    throw new BehaviorTreeCancellationError(message, { cause });
  }
  if (typeof cause === "string") {
    throw new BehaviorTreeCancellationError(cause);
  }
  if (cause !== undefined) {
    throw new BehaviorTreeCancellationError(DEFAULT_CANCELLATION_MESSAGE, { cause });
  }
  throw new BehaviorTreeCancellationError(DEFAULT_CANCELLATION_MESSAGE);
}

/** Utility constant representing a successful tick result. */
const SUCCESS_RESULT: BehaviorTickResult = { status: "success" };

/** Utility constant representing a failed tick result. */
const FAILURE_RESULT: BehaviorTickResult = { status: "failure" };

/** Delay helper used by {@link RetryNode} when no runtime wait function is provided. */
async function defaultDelay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    runtimeTimers.setTimeout(resolve, ms);
  });
}

/** Determine whether the provided status represents a terminal outcome. */
function isTerminal(status: BTStatus): boolean {
  return status === "success" || status === "failure";
}

/** Guard helper executing the runtime cancellation callback when available. */
function ensureNotCancelled(runtime: TickRuntime): void {
  if (typeof runtime.throwIfCancelled === "function") {
    try {
      runtime.throwIfCancelled();
    } catch (error) {
      throwCancellation(error);
    }
  }
  if (typeof runtime.isCancelled === "function" && runtime.isCancelled()) {
    throwCancellation();
  }
  const signal = runtime.cancellationSignal;
  if (signal?.aborted) {
    throwCancellation(signal.reason);
  }
}

/** Behaviour Tree sequence composite node. */
export class SequenceNode implements BehaviorNode {
  private currentIndex = 0;

  constructor(
    public readonly id: string,
    private readonly children: BehaviorNode[],
  ) {}

  /**
   * Execute the sequence: each child must succeed for the composite to succeed.
   * When a child returns {@link BTStatus."running"} the current index is
   * preserved so the next tick resumes from the same child.
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    while (this.currentIndex < this.children.length) {
      const child = this.children[this.currentIndex];
      try {
        ensureNotCancelled(runtime);
      } catch (error) {
        if (isCancellationError(error)) {
          // Cooperative cancellation must rewind the sequence so future ticks start
          // from the first child instead of resuming mid-way through the cursor.
          this.reset();
        }
        throw error;
      }

      let result: BehaviorTickResult;
      try {
        result = await child.tick(runtime);
      } catch (error) {
        if (isCancellationError(error)) {
          // Child initiated cancellation should leave the composite in a clean state
          // so orchestrators can safely retry the sequence from scratch.
          this.reset();
        }
        throw error;
      }
      if (result.status === "running") {
        return result;
      }
      if (result.status === "failure") {
        this.reset();
        return FAILURE_RESULT;
      }
      this.currentIndex += 1;
    }
    this.reset();
    return SUCCESS_RESULT;
  }

  /** Reset the cursor and child nodes. */
  reset(): void {
    this.currentIndex = 0;
    for (const child of this.children) {
      child.reset();
    }
  }
}

/** Behaviour Tree selector composite node. */
export class SelectorNode implements BehaviorNode {
  private currentIndex = 0;

  constructor(
    public readonly id: string,
    private readonly children: BehaviorNode[],
  ) {}

  /**
   * Execute the selector: the first child to succeed wins. The cursor is stored
   * while waiting on running children so the selector resumes deterministically.
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    while (this.currentIndex < this.children.length) {
      const child = this.children[this.currentIndex];
      try {
        ensureNotCancelled(runtime);
      } catch (error) {
        if (isCancellationError(error)) {
          // Reset the selector so cancelled runs do not keep their previous cursor.
          this.reset();
        }
        throw error;
      }

      let result: BehaviorTickResult;
      try {
        result = await child.tick(runtime);
      } catch (error) {
        if (isCancellationError(error)) {
          // Cancellation bubbling from the child must clear the selector state.
          this.reset();
        }
        throw error;
      }
      if (result.status === "running") {
        return result;
      }
      if (result.status === "success") {
        this.reset();
        return SUCCESS_RESULT;
      }
      this.currentIndex += 1;
    }
    this.reset();
    return FAILURE_RESULT;
  }

  /** Reset the cursor and child nodes. */
  reset(): void {
    this.currentIndex = 0;
    for (const child of this.children) {
      child.reset();
    }
  }
}

/**
 * Normalised parallel policy used internally by {@link ParallelNode}. Using an
 * explicit discriminant simplifies the tick logic while maintaining backwards
 * compatibility with legacy string shorthands.
 */
type NormalisedParallelPolicy =
  | { kind: "all" }
  | { kind: "any" }
  | { kind: "quota"; successThreshold: number };

/** Convert user provided policy configuration into the internal representation. */
function normaliseParallelPolicy(
  policy: ParallelPolicy,
  childCount: number,
): NormalisedParallelPolicy {
  if (policy === "all" || policy === "any") {
    return { kind: policy };
  }

  const threshold = Number(policy.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error("Parallel quota threshold must be a positive integer");
  }

  const clamped = Math.max(1, Math.min(childCount, Math.floor(threshold)));
  return { kind: "quota", successThreshold: clamped };
}

/** Behaviour Tree parallel composite node. */
export class ParallelNode implements BehaviorNode {
  private readonly childStates: Map<string, BTStatus> = new Map();
  private readonly policy: NormalisedParallelPolicy;

  constructor(
    public readonly id: string,
    policy: ParallelPolicy,
    private readonly children: BehaviorNode[],
  ) {
    this.policy = normaliseParallelPolicy(policy, children.length);
  }

  /**
   * Execute all children concurrently. The policy controls the aggregation of
   * child statuses:
   * - `all`: success when every child succeeds, failure as soon as one fails
   * - `any`: success once one child succeeds, failure when all fail
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    try {
      ensureNotCancelled(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        // Cooperative cancellations should rewind cached child states so the next
        // tick restarts every branch from a clean slate.
        this.reset();
      }
      throw error;
    }

    const childPromises = this.children.map(async (child) => {
      const previous = this.childStates.get(child.id);
      if (previous && isTerminal(previous)) {
        return { status: previous } satisfies BehaviorTickResult;
      }

      ensureNotCancelled(runtime);

      try {
        const result = await child.tick(runtime);
        if (isTerminal(result.status)) {
          this.childStates.set(child.id, result.status);
        }
        return result;
      } catch (error) {
        if (isCancellationError(error)) {
          // The composite-level catch will perform the reset once every child
          // settled to avoid double rewinds while other branches complete.
        }
        throw error;
      }
    });

    let results: BehaviorTickResult[];
    try {
      results = await Promise.all(childPromises);
    } catch (error) {
      await Promise.allSettled(childPromises);
      if (isCancellationError(error)) {
        // Cancellation should evict cached terminal states to prevent partially
        // completed runs from being treated as finished once the orchestrator
        // retries the parallel composite.
        this.reset();
      }
      throw error;
    }

    try {
      ensureNotCancelled(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        this.reset();
      }
      throw error;
    }

    const statuses = results.map((result) => result.status);
    const successes = statuses.filter((status) => status === "success").length;
    const failures = statuses.filter((status) => status === "failure").length;
    const running = statuses.filter((status) => status === "running").length;

    switch (this.policy.kind) {
      case "all": {
        if (failures > 0) {
          this.reset();
          return FAILURE_RESULT;
        }
        if (running === 0 && successes === this.children.length) {
          this.reset();
          return SUCCESS_RESULT;
        }
        return { status: "running" };
      }
      case "any": {
        if (successes > 0) {
          this.reset();
          return SUCCESS_RESULT;
        }
        if (running === 0 && failures === this.children.length) {
          this.reset();
          return FAILURE_RESULT;
        }
        return { status: "running" };
      }
      case "quota": {
        if (successes >= this.policy.successThreshold) {
          this.reset();
          return SUCCESS_RESULT;
        }
        const remainingPotential = this.children.length - failures;
        if (remainingPotential < this.policy.successThreshold) {
          this.reset();
          return FAILURE_RESULT;
        }
        return { status: "running" };
      }
      default: {
        const exhaustive: never = this.policy;
        throw new Error(`unsupported parallel policy ${(exhaustive as { kind: string }).kind}`);
      }
    }
  }

  /** Reset cached statuses and child nodes. */
  reset(): void {
    this.childStates.clear();
    for (const child of this.children) {
      child.reset();
    }
  }
}

/** Behaviour Tree retry decorator node. */
export class RetryNode implements BehaviorNode {
  private attempts = 0;

  constructor(
    public readonly id: string,
    private readonly maxAttempts: number,
    private readonly child: BehaviorNode,
    private readonly backoffMs = 0,
    private readonly backoffJitterMs = 0,
  ) {}

  /**
   * Retry the child node when it fails, waiting for the configured backoff
   * between attempts.
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    let childStarted = false;
    let childReset = false;

    const handleCancellation = (error: unknown): never => {
      if (isCancellationError(error)) {
        this.resetAfterCancellation(childStarted, childReset);
      }
      throw error;
    };

    try {
      ensureNotCancelled(runtime);
    } catch (error) {
      handleCancellation(error);
      throw error;
    }

    let result: BehaviorTickResult;
    try {
      childStarted = true;
      result = await this.child.tick(runtime);
    } catch (error) {
      handleCancellation(error);
      throw error;
    }
    if (result.status === "success") {
      this.reset();
      return result;
    }
    if (result.status === "running") {
      return result;
    }

    this.attempts += 1;
    if (this.attempts >= this.maxAttempts) {
      this.reset();
      return FAILURE_RESULT;
    }

    this.child.reset();
    childReset = true;
    const delayFn = runtime.wait ?? defaultDelay;
    const delay = this.computeBackoffDelay(runtime);
    if (delay > 0) {
      try {
        ensureNotCancelled(runtime);
      } catch (error) {
        handleCancellation(error);
        throw error;
      }
      try {
        await delayFn(delay);
      } catch (error) {
        handleCancellation(error);
        throw error;
      }
      try {
        ensureNotCancelled(runtime);
      } catch (error) {
        handleCancellation(error);
        throw error;
      }
    }
    return { status: "running" };
  }

  /** Reset the attempts counter and the child node. */
  reset(): void {
    this.attempts = 0;
    this.child.reset();
  }

  /**
   * Restore the retry state after a cooperative cancellation so the next tick starts
   * from a clean slate without double-resetting children that were already rewound.
   */
  private resetAfterCancellation(childStarted: boolean, childAlreadyReset: boolean): void {
    this.attempts = 0;
    if (childStarted && !childAlreadyReset) {
      this.child.reset();
    }
  }

  /**
   * Compute the backoff delay enriched with jitter when configured. Jitter
   * relies on a runtime-provided pseudo-random source when available to keep
   * tests deterministic.
   */
  private computeBackoffDelay(runtime: TickRuntime): number {
    const base = Math.max(0, this.backoffMs);
    const jitter = Math.max(0, this.backoffJitterMs);
    if (jitter === 0) {
      return base;
    }

    const sampler = typeof runtime.random === "function" ? runtime.random : Math.random;
    let sample: number;
    try {
      sample = sampler();
    } catch {
      sample = Math.random();
    }
    if (!Number.isFinite(sample)) {
      sample = Math.random();
    }
    const boundedSample = Math.min(Math.max(sample, 0), 1);
    const jitterComponent = Math.round(boundedSample * jitter);
    return base + jitterComponent;
  }
}

/** Behaviour Tree timeout decorator node. */
const TIMEOUT_SENTINEL = Symbol("timeout");

interface TimeoutNodeOptions {
  readonly category?: string | null;
  readonly complexityScore?: number | null;
}

export class TimeoutNode implements BehaviorNode {
  constructor(
    public readonly id: string,
    private readonly fallbackTimeoutMs: number | null,
    private readonly child: BehaviorNode,
    private readonly options: TimeoutNodeOptions = {},
  ) {}

  /**
   * Wrap the child execution inside a timeout. When the timer elapses first the
   * decorator fails and resets the child. Successful completions report the
   * duration to the runtime so loop detectors can adjust future budgets.
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    try {
      ensureNotCancelled(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        // Align timeout cancellation semantics with other decorators by rewinding
        // the child when interrupted before execution begins.
        this.child.reset();
      }
      throw error;
    }
    const wait = runtime.wait ?? defaultDelay;
    const start = runtime.now ? runtime.now() : Date.now();
    const budget = this.resolveBudget(runtime);
    const timeoutPromise = wait(budget).then(() => TIMEOUT_SENTINEL);
    const childPromise = this.child.tick(runtime);
    let winner: typeof TIMEOUT_SENTINEL | BehaviorTickResult;
    try {
      winner = (await Promise.race([timeoutPromise, childPromise])) as typeof TIMEOUT_SENTINEL | BehaviorTickResult;
    } catch (error) {
      if (isCancellationError(error)) {
        this.child.reset();
      }
      throw error;
    }
    if (winner === TIMEOUT_SENTINEL) {
      const end = runtime.now ? runtime.now() : Date.now();
      this.recordOutcome(runtime, end - start, false, budget);
      this.child.reset();
      this.reset();
      return FAILURE_RESULT;
    }
    const result = winner as BehaviorTickResult;
    if (result.status !== "running") {
      const end = runtime.now ? runtime.now() : Date.now();
      this.recordOutcome(runtime, end - start, result.status === "success", budget);
      this.reset();
    }
    return result;
  }

  /** Reset simply proxies to the child to clear its state. */
  reset(): void {
    this.child.reset();
  }

  private resolveBudget(runtime: TickRuntime): number {
    const { category, complexityScore } = this.options;
    if (category && runtime.recommendTimeout) {
      const complexitySource = complexityScore;
      const complexityArg = complexitySource === null || complexitySource === undefined ? undefined : complexitySource;
      const fallbackSource = this.fallbackTimeoutMs;
      const fallbackArg: number | undefined = fallbackSource === null ? undefined : fallbackSource;
      const recommended = runtime.recommendTimeout(category, complexityArg, fallbackArg);
      if (recommended !== undefined && Number.isFinite(recommended) && recommended > 0) {
        return Math.round(recommended);
      }
    }
    if (this.fallbackTimeoutMs !== null && this.fallbackTimeoutMs !== undefined) {
      return this.fallbackTimeoutMs;
    }
    throw new Error(`TimeoutNode ${this.id} is missing a valid timeout budget`);
  }

  private recordOutcome(runtime: TickRuntime, durationMs: number, success: boolean, budgetMs: number): void {
    const { category } = this.options;
    if (!category || !runtime.recordTimeoutOutcome) {
      return;
    }
    const safeDuration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    try {
      runtime.recordTimeoutOutcome(category, {
        durationMs: Math.max(1, Math.round(safeDuration)),
        success,
        budgetMs,
      });
    } catch {
      // Recording telemetry must never break behaviour tree execution.
    }
  }
}

/** Behaviour Tree guard decorator node. */
export class GuardNode implements BehaviorNode {
  constructor(
    public readonly id: string,
    private readonly conditionKey: string,
    private readonly expected: unknown,
    private readonly child: BehaviorNode,
  ) {}

  /**
   * Evaluate the guard condition using the runtime variables. When the condition
   * does not hold the guard short-circuits with a failure and resets the child.
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    try {
      ensureNotCancelled(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        // Guard decorators do not maintain internal state, yet resetting the child
        // ensures partially evaluated work is abandoned when cooperative
        // cancellation interrupts before the condition is read.
        this.child.reset();
      }
      throw error;
    }
    const actual = runtime.variables[this.conditionKey];
    const matches = this.expected === undefined ? Boolean(actual) : actual === this.expected;
    if (!matches) {
      this.child.reset();
      return FAILURE_RESULT;
    }
    let result: BehaviorTickResult;
    try {
      result = await this.child.tick(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        // The child may surface cancellation while evaluating; reset before
        // bubbling the error so the next tick starts from a clean slate.
        this.child.reset();
      }
      throw error;
    }
    if (result.status !== "running") {
      this.reset();
      return result;
    }
    try {
      ensureNotCancelled(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        // Running children are rewound when cancellation triggers between ticks.
        this.child.reset();
      }
      throw error;
    }
    return result;
  }

  /** Reset proxies to the child node. */
  reset(): void {
    this.child.reset();
  }
}

/** Behaviour Tree task leaf calling an orchestrator tool. */
export class TaskLeaf implements BehaviorNode {
  private readonly inputKey?: string;
  private readonly schema?: z.ZodTypeAny;

  constructor(
    public readonly id: string,
    private readonly toolName: string,
    options: { inputKey?: string; schema?: z.ZodTypeAny } = {},
  ) {
    this.inputKey = options.inputKey;
    this.schema = options.schema;
  }

  /**
   * Resolve the task input, validate it and invoke the corresponding tool via
   * the runtime.
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    ensureNotCancelled(runtime);
    const rawInput = this.inputKey ? runtime.variables[this.inputKey] : undefined;
    const parsedInput = this.schema ? this.schema.parse(rawInput ?? {}) : rawInput ?? {};
    ensureNotCancelled(runtime);
    let output: unknown;
    try {
      output = await runtime.invokeTool(this.toolName, parsedInput);
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }
      if (isAbortLikeError(error)) {
        throwCancellation(error);
      }
      throw error;
    }
    ensureNotCancelled(runtime);
    return { status: "success", output };
  }

  /** Task leaves are stateless, nothing to reset. */
  reset(): void {
    // no-op
  }
}

/** Behaviour Tree decorator that enforces cooperative cancellation. */
export class CancellableNode implements BehaviorNode {
  constructor(
    public readonly id: string,
    private readonly child: BehaviorNode,
  ) {}

  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    try {
      ensureNotCancelled(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        this.child.reset();
      }
      throw error;
    }

    let result: BehaviorTickResult;
    try {
      result = await this.child.tick(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        this.child.reset();
      }
      this.reset();
      throw error;
    }

    if (result.status !== "running") {
      this.reset();
      return result;
    }

    try {
      ensureNotCancelled(runtime);
    } catch (error) {
      if (isCancellationError(error)) {
        this.child.reset();
      }
      throw error;
    }

    return result;
  }

  reset(): void {
    this.child.reset();
  }
}
