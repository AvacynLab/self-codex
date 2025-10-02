import { z } from "zod";

import {
  type BTStatus,
  type BehaviorNode,
  type BehaviorTickResult,
  type TickRuntime,
} from "./types.js";

/** Utility constant representing a successful tick result. */
const SUCCESS_RESULT: BehaviorTickResult = { status: "success" };

/** Utility constant representing a failed tick result. */
const FAILURE_RESULT: BehaviorTickResult = { status: "failure" };

/** Delay helper used by {@link RetryNode} when no runtime wait function is provided. */
async function defaultDelay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Determine whether the provided status represents a terminal outcome. */
function isTerminal(status: BTStatus): boolean {
  return status === "success" || status === "failure";
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
      const result = await child.tick(runtime);
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
      const result = await child.tick(runtime);
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

/** Behaviour Tree parallel composite node. */
export class ParallelNode implements BehaviorNode {
  private readonly childStates: Map<string, BTStatus> = new Map();

  constructor(
    public readonly id: string,
    private readonly policy: "all" | "any",
    private readonly children: BehaviorNode[],
  ) {}

  /**
   * Execute all children concurrently. The policy controls the aggregation of
   * child statuses:
   * - `all`: success when every child succeeds, failure as soon as one fails
   * - `any`: success once one child succeeds, failure when all fail
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    const results = await Promise.all(
      this.children.map(async (child) => {
        const previous = this.childStates.get(child.id);
        if (previous && isTerminal(previous)) {
          return { status: previous } satisfies BehaviorTickResult;
        }
        const result = await child.tick(runtime);
        if (isTerminal(result.status)) {
          this.childStates.set(child.id, result.status);
        }
        return result;
      }),
    );

    const statuses = results.map((result) => result.status);
    const successes = statuses.filter((status) => status === "success").length;
    const failures = statuses.filter((status) => status === "failure").length;
    const running = statuses.filter((status) => status === "running").length;

    if (this.policy === "all") {
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
  ) {}

  /**
   * Retry the child node when it fails, waiting for the configured backoff
   * between attempts.
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    const result = await this.child.tick(runtime);
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
    const delayFn = runtime.wait ?? defaultDelay;
    if (this.backoffMs > 0) {
      await delayFn(this.backoffMs);
    }
    return { status: "running" };
  }

  /** Reset the attempts counter and the child node. */
  reset(): void {
    this.attempts = 0;
    this.child.reset();
  }
}

/** Behaviour Tree timeout decorator node. */
const TIMEOUT_SENTINEL = Symbol("timeout");

export class TimeoutNode implements BehaviorNode {
  constructor(
    public readonly id: string,
    private readonly timeoutMs: number,
    private readonly child: BehaviorNode,
  ) {}

  /**
   * Wrap the child execution inside a timeout. When the timer elapses first the
   * decorator fails and resets the child.
   */
  async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
    const wait = runtime.wait ?? defaultDelay;
    const timeoutPromise = wait(this.timeoutMs).then(() => TIMEOUT_SENTINEL);
    const childPromise = this.child.tick(runtime);
    const winner = await Promise.race([timeoutPromise, childPromise]);
    if (winner === TIMEOUT_SENTINEL) {
      this.child.reset();
      this.reset();
      return FAILURE_RESULT;
    }
    const result = winner as BehaviorTickResult;
    if (result.status !== "running") {
      this.reset();
    }
    return result;
  }

  /** Reset simply proxies to the child to clear its state. */
  reset(): void {
    this.child.reset();
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
    const actual = runtime.variables[this.conditionKey];
    const matches = this.expected === undefined ? Boolean(actual) : actual === this.expected;
    if (!matches) {
      this.child.reset();
      return FAILURE_RESULT;
    }
    const result = await this.child.tick(runtime);
    if (result.status !== "running") {
      this.reset();
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
    const rawInput = this.inputKey ? runtime.variables[this.inputKey] : undefined;
    const parsedInput = this.schema ? this.schema.parse(rawInput ?? {}) : rawInput ?? {};
    const output = await runtime.invokeTool(this.toolName, parsedInput);
    return { status: "success", output };
  }

  /** Task leaves are stateless, nothing to reset. */
  reset(): void {
    // no-op
  }
}
