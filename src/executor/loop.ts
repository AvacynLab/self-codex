import { setTimeout as defaultSetTimeout, clearTimeout as defaultClearTimeout } from "node:timers";

/**
 * Context made available to every tick executed by the {@link ExecutionLoop}.
 * The loop supplies helpers so ticks can observe time, react to stop signals
 * and cooperate with the scheduler when work risks exceeding the allotted
 * budget.
 */
export interface LoopTickContext {
  /** Timestamp at which the tick started, according to {@link now}. */
  readonly startedAt: number;
  /** Monotonic clock provided to the loop (defaults to {@link Date.now}). */
  readonly now: () => number;
  /** Progressive number identifying the tick order (0-based). */
  readonly tickIndex: number;
  /** Signal aborted when {@link ExecutionLoop.stop} is invoked. */
  readonly signal: AbortSignal;
  /** Cooperative budget utilities if a per-tick time budget is configured. */
  readonly budget?: CooperativeBudget;
}

/** Options accepted by the {@link ExecutionLoop} constructor. */
export interface ExecutionLoopOptions {
  /** Interval between two ticks, in milliseconds. */
  readonly intervalMs: number;
  /** Function executed at every tick. */
  readonly tick: (context: LoopTickContext) => Promise<void> | void;
  /** Optional reconcilers invoked after each tick (autoscaler, monitors…). */
  readonly reconcilers?: LoopReconciler[];
  /** Optional hook executed once the tick and reconcilers completed. */
  readonly afterTick?: (details: LoopAfterTickDetails) => void;
  /** Custom clock used for diagnostics (defaults to {@link Date.now}). */
  readonly now?: () => number;
  /** Optional budget (in ms) after which ticks should yield cooperatively. */
  readonly budgetMs?: number;
  /** Error hook invoked when a tick throws. */
  readonly onError?: (error: unknown) => void;
  /** Injection points easing deterministic tests. */
  readonly setIntervalFn?: (handler: () => void, interval: number) => NodeJS.Timeout;
  readonly clearIntervalFn?: (handle: NodeJS.Timeout) => void;
  readonly scheduleYield?: (resume: () => void) => unknown;
  readonly cancelYield?: (handle: unknown) => void;
}

/**
 * Component observing the execution loop after every tick to reconcile
 * high-level invariants (autoscaling, supervision, metrics collection…).
 */
export interface LoopReconciler {
  /** Optional identifier surfaced in loop diagnostics and lifecycle events. */
  readonly id?: string;
  /** Reacts to the completion of a tick. */
  reconcile(context: LoopTickContext): Promise<void> | void;
}

/** Structured telemetry describing the execution of a reconciler during a tick. */
export interface LoopReconcilerRun {
  /** Identifier advertised by the reconciler or derived from its constructor name. */
  readonly id: string;
  /** Execution status reported after the reconciler returned. */
  readonly status: "ok" | "error";
  /** Duration spent executing the reconciler in milliseconds. */
  readonly durationMs: number;
  /** Optional error message surfaced when the reconciler threw. */
  readonly errorMessage?: string;
}

/**
 * Snapshot emitted after every tick so observers can correlate loop progress
 * with the reconcilers that executed. Plan lifecycle events leverage this to
 * document autoscaler/supervisor activity when the feature is toggled back on.
 */
export interface LoopAfterTickDetails {
  readonly context: LoopTickContext;
  readonly reconcilers: LoopReconcilerRun[];
}

/**
 * Cooperative helper used by long-running ticks to voluntarily yield control
 * when a time budget is exceeded. The loop provides an instance per tick when
 * a {@link ExecutionLoopOptions.budgetMs} value is configured.
 */
export class CooperativeBudget {
  private checkpoint: number;

  constructor(
    private readonly budgetMs: number,
    private readonly now: () => number,
    private readonly scheduleYield: (resume: () => void) => unknown,
    private readonly cancelYield: (handle: unknown) => void,
    private readonly signal: AbortSignal,
  ) {
    this.checkpoint = now();
  }

  /** Timestamp (via {@link now}) when the budget started tracking. */
  get startedAt(): number {
    return this.checkpoint;
  }

  /** Milliseconds elapsed since the last checkpoint. */
  get elapsed(): number {
    return this.now() - this.checkpoint;
  }

  /** Remaining milliseconds before the budget is exceeded (floored at 0). */
  get remaining(): number {
    return Math.max(0, this.budgetMs - this.elapsed);
  }

  /** Whether the budget has been exhausted (optionally with a margin). */
  shouldYield(marginMs = 0): boolean {
    return this.elapsed >= Math.max(0, this.budgetMs - marginMs);
  }

  /**
   * Requests an asynchronous yield and resets the checkpoint once resumed.
   * If the loop stops while waiting, the promise resolves silently.
   */
  async yield(): Promise<void> {
    if (this.signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      let finished = false;
      let handle: unknown | undefined;

      const finalize = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (handle != null) {
          this.cancelYield(handle);
          handle = undefined;
        }
        this.signal.removeEventListener("abort", onAbort);
        resolve();
      };

      const onAbort = () => {
        finalize();
      };

      this.signal.addEventListener("abort", onAbort, { once: true });
      handle = this.scheduleYield(() => {
        handle = undefined;
        finalize();
      });
    });

    this.checkpoint = this.now();
  }

  /**
   * Convenience helper combining {@link shouldYield} and {@link yield}.
   * Returns `true` when a yield actually occurred.
   */
  async yieldIfExceeded(marginMs = 0): Promise<boolean> {
    if (!this.shouldYield(marginMs)) {
      return false;
    }
    await this.yield();
    return true;
  }
}

/** Possible states of the execution loop. */
type LoopState = "idle" | "running" | "paused";

/**
 * Periodic execution loop based on {@link setInterval}. The loop provides
 * pause/resume semantics, exposes cooperative budgets for long ticks and keeps
 * track of the executed tick count for diagnostics.
 */
export class ExecutionLoop {
  private readonly intervalMs: number;
  private readonly tick: (context: LoopTickContext) => Promise<void> | void;
  private readonly now: () => number;
  private readonly setIntervalFn: (handler: () => void, interval: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;
  private readonly scheduleYield: (resume: () => void) => unknown;
  private readonly cancelYield: (handle: unknown) => void;
  private readonly budgetMs?: number;
  private readonly onError?: (error: unknown) => void;
  private readonly reconcilers: LoopReconciler[];
  private readonly afterTick?: (details: LoopAfterTickDetails) => void;

  private state: LoopState = "idle";
  private timer: NodeJS.Timeout | null = null;
  private abortController: AbortController = new AbortController();
  private processing = false;
  private idlePromise: Promise<void> | null = null;
  private idleResolver: (() => void) | null = null;
  private tickCountInternal = 0;

  constructor(options: ExecutionLoopOptions) {
    this.intervalMs = Math.max(0, options.intervalMs);
    this.tick = options.tick;
    this.now = options.now ?? Date.now;
    this.budgetMs = options.budgetMs;
    this.onError = options.onError;
    this.setIntervalFn = options.setIntervalFn ?? ((handler, interval) => setInterval(handler, interval));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle));
    this.scheduleYield = options.scheduleYield ?? ((resume) => defaultSetTimeout(resume, 0));
    this.cancelYield = options.cancelYield ?? ((handle) => defaultClearTimeout(handle as NodeJS.Timeout));
    this.reconcilers = options.reconcilers ? [...options.reconcilers] : [];
    this.afterTick = options.afterTick;
  }

  /** Total number of ticks successfully executed so far. */
  get tickCount(): number {
    return this.tickCountInternal;
  }

  /** Whether the loop is currently active (not paused nor idle). */
  get isRunning(): boolean {
    return this.state === "running";
  }

  /** Whether the loop is started but temporarily paused. */
  get isPaused(): boolean {
    return this.state === "paused";
  }

  /** Starts the loop. Throws if already running or paused. */
  start(): void {
    if (this.state !== "idle") {
      throw new Error("ExecutionLoop already started");
    }
    this.state = "running";
    this.abortController = new AbortController();
    this.timer = this.setIntervalFn(() => {
      void this.runTick();
    }, this.intervalMs);
  }

  /** Pauses the loop. Returns `true` when a state change occurred. */
  pause(): boolean {
    if (this.state !== "running") {
      return false;
    }
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.state = "paused";
    return true;
  }

  /** Resumes the loop after a pause. Returns `true` if the loop was resumed. */
  resume(): boolean {
    if (this.state !== "paused") {
      return false;
    }
    this.state = "running";
    this.timer = this.setIntervalFn(() => {
      void this.runTick();
    }, this.intervalMs);
    return true;
  }

  /** Stops the loop and waits for the current tick to complete. */
  async stop(): Promise<void> {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    if (this.state === "idle" && !this.processing) {
      return;
    }
    this.state = "idle";
    this.abortController.abort();
    await this.waitForIdle();
    this.abortController = new AbortController();
  }

  /** Resolves once the loop finished processing the current tick. */
  whenIdle(): Promise<void> {
    return this.waitForIdle();
  }

  private waitForIdle(): Promise<void> {
    if (!this.processing) {
      return Promise.resolve();
    }
    if (!this.idlePromise) {
      this.idlePromise = new Promise((resolve) => {
        this.idleResolver = resolve;
      });
    }
    return this.idlePromise;
  }

  private resolveIdle(): void {
    if (this.idleResolver) {
      const resolve = this.idleResolver;
      this.idleResolver = null;
      this.idlePromise = null;
      resolve();
    }
  }

  private async runTick(): Promise<void> {
    if (this.processing || this.state !== "running") {
      return;
    }
    this.processing = true;
    const tickIndex = this.tickCountInternal;
    const startedAt = this.now();
    const budget =
      this.budgetMs !== undefined
        ? new CooperativeBudget(
            this.budgetMs,
            this.now,
            this.scheduleYield,
            this.cancelYield,
            this.abortController.signal,
          )
        : undefined;

    const context: LoopTickContext = {
      startedAt,
      now: this.now,
      tickIndex,
      signal: this.abortController.signal,
      budget,
    };

    try {
      await this.tick(context);
      this.tickCountInternal += 1;
    } catch (error) {
      if (this.onError) {
        this.onError(error);
      } else {
        queueMicrotask(() => {
          throw error instanceof Error ? error : new Error(String(error));
        });
      }
    } finally {
      const reconcilersRun: LoopReconcilerRun[] = [];
      if (this.reconcilers.length > 0) {
        for (const reconciler of this.reconcilers) {
          const before = this.now();
          try {
            await reconciler.reconcile(context);
            reconcilersRun.push({
              id: this.describeReconciler(reconciler),
              status: "ok",
              durationMs: Math.max(0, this.now() - before),
            });
          } catch (error) {
            reconcilersRun.push({
              id: this.describeReconciler(reconciler),
              status: "error",
              durationMs: Math.max(0, this.now() - before),
              errorMessage:
                error instanceof Error
                  ? error.message
                  : typeof error === "string"
                    ? error
                    : undefined,
            });
            if (this.onError) {
              this.onError(error);
            } else {
              queueMicrotask(() => {
                throw error instanceof Error ? error : new Error(String(error));
              });
            }
          }
        }
      }
      if (this.afterTick) {
        this.afterTick({ context, reconcilers: reconcilersRun });
      }
      this.processing = false;
      this.resolveIdle();
    }
  }

  private describeReconciler(reconciler: LoopReconciler): string {
    if (typeof reconciler.id === "string" && reconciler.id.trim().length > 0) {
      return reconciler.id.trim();
    }
    const name = (reconciler as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name.length > 0 ? name : "reconciler";
  }
}
