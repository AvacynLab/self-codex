import { z } from "zod";

/**
 * Status returned by every Behaviour Tree node after a tick.
 */
export type BTStatus = "success" | "failure" | "running";

/**
 * Result returned by a Behaviour Tree node once its {@link BehaviorNode.tick}
 * method completes.
 */
export interface BehaviorTickResult {
  /** Final status produced by the node. */
  status: BTStatus;
  /** Optional value propagated to parents for diagnostics or reducers. */
  output?: unknown;
}

/**
 * Function responsible for invoking a concrete orchestrator tool.
 */
export type ToolInvoker = (toolName: string, input: unknown) => Promise<unknown>;

/**
 * Runtime services injected while ticking a Behaviour Tree. The methods are
 * intentionally simple so tests can provide deterministic fake implementations.
 */
export interface TickRuntime {
  /** Execute a concrete tool and resolve with its output. */
  invokeTool: ToolInvoker;
  /** Retrieve the monotonic clock expressed in milliseconds. */
  now(): number;
  /** Await for the provided duration while allowing fake timers in tests. */
  wait(ms: number): Promise<void>;
  /** Shared map of variables exposed to guards and task leaves. */
  variables: Record<string, unknown>;
  /**
   * Optional recommender returning the timeout budget for a named category. The
   * decorator passes {@link TimeoutDefinition.complexity_score} when available
   * and expects the runtime to fall back to the provided {@link fallbackMs}.
   */
  recommendTimeout?(category: string, complexityScore?: number, fallbackMs?: number): number | undefined;
  /**
   * Optional analytics hook invoked once a timeout branch completes. Runtimes
   * may leverage it to feed telemetry (loop detector, dashboards, …).
   */
  recordTimeoutOutcome?(category: string, outcome: { durationMs: number; success: boolean; budgetMs: number }): void;
}

/**
 * Base contract implemented by every Behaviour Tree node.
 */
export interface BehaviorNode {
  /** Unique identifier used for tracing/debugging. */
  readonly id: string;
  /** Execute one tick and resolve with the resulting status/output. */
  tick(runtime: TickRuntime): Promise<BehaviorTickResult>;
  /** Reset any internal state so the node can be executed from scratch. */
  reset(): void;
}

/**
 * Definition of a tree serialisable as JSON. The interpreter converts this
 * representation into concrete {@link BehaviorNode} instances.
 */
export type BehaviorNodeDefinition =
  | SequenceDefinition
  | SelectorDefinition
  | ParallelDefinition
  | RetryDefinition
  | TimeoutDefinition
  | GuardDefinition
  | TaskDefinition;

/** Definition of a sequence composite node. */
export interface SequenceDefinition {
  type: "sequence";
  id?: string;
  children: BehaviorNodeDefinition[];
}

/** Definition of a selector composite node. */
export interface SelectorDefinition {
  type: "selector";
  id?: string;
  children: BehaviorNodeDefinition[];
}

/** Definition of a parallel composite node. */
export interface ParallelDefinition {
  type: "parallel";
  id?: string;
  policy: "all" | "any";
  children: BehaviorNodeDefinition[];
}

/** Definition of a retry decorator node. */
export interface RetryDefinition {
  type: "retry";
  id?: string;
  max_attempts: number;
  backoff_ms?: number;
  child: BehaviorNodeDefinition;
}

/** Definition of a timeout decorator node. */
export interface TimeoutDefinition {
  type: "timeout";
  id?: string;
  /** Optional static timeout applied when no category override is resolved. */
  timeout_ms?: number;
  /**
   * Optional logical category resolved against runtime timeout profiles. When
   * provided the interpreter will ask the orchestrator for a recommended
   * timeout and fall back to {@link timeout_ms} if the profile is unavailable.
   */
  timeout_category?: string;
  /**
   * Optional complexity hint forwarded to the timeout recommender. Values are
   * clamped by the runtime to keep recommendations bounded.
   */
  complexity_score?: number;
  child: BehaviorNodeDefinition;
}

/** Definition of a guard decorator node. */
export interface GuardDefinition {
  type: "guard";
  id?: string;
  /** Identifier resolved against {@link TickRuntime.variables}. */
  condition_key: string;
  expected?: unknown;
  child: BehaviorNodeDefinition;
}

/** Definition of a task leaf node. */
export interface TaskDefinition {
  type: "task";
  id?: string;
  node_id: string;
  tool: string;
  /** Optional key used to resolve the input from {@link TickRuntime.variables}. */
  input_key?: string;
}

/** Behaviour Tree persisted on disk or exchanged via the API. */
export interface CompiledBehaviorTree {
  id: string;
  root: BehaviorNodeDefinition;
}

/** Schema validating a serialised Behaviour Tree definition. */
export const BehaviorNodeDefinitionSchema: z.ZodType<BehaviorNodeDefinition> = z.lazy(() =>
  z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("sequence"),
        id: z.string().min(1).optional(),
        children: z.array(BehaviorNodeDefinitionSchema).min(1),
      }),
    z.object({
      type: z.literal("selector"),
      id: z.string().min(1).optional(),
      children: z.array(BehaviorNodeDefinitionSchema).min(1),
    }),
    z.object({
      type: z.literal("parallel"),
      id: z.string().min(1).optional(),
      policy: z.enum(["all", "any"]),
      children: z.array(BehaviorNodeDefinitionSchema).min(1),
    }),
    z.object({
      type: z.literal("retry"),
      id: z.string().min(1).optional(),
      max_attempts: z.number().int().min(1),
      backoff_ms: z.number().int().min(0).optional(),
      child: BehaviorNodeDefinitionSchema,
    }),
    z.object({
      type: z.literal("timeout"),
      id: z.string().min(1).optional(),
      timeout_ms: z.number().int().min(1).optional(),
      timeout_category: z.string().min(1).optional(),
      complexity_score: z.number().positive().max(100).optional(),
      child: BehaviorNodeDefinitionSchema,
    }),
    z.object({
      type: z.literal("guard"),
      id: z.string().min(1).optional(),
      condition_key: z.string().min(1),
      expected: z.unknown().optional(),
      child: BehaviorNodeDefinitionSchema,
    }),
    z.object({
      type: z.literal("task"),
      id: z.string().min(1).optional(),
      node_id: z.string().min(1),
      tool: z.string().min(1),
      input_key: z.string().min(1).optional(),
    }),
  ])
    .superRefine((value, ctx) => {
      if (value.type === "timeout" && value.timeout_ms === undefined && value.timeout_category === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "timeout nodes require timeout_ms or timeout_category",
          path: ["timeout_ms"],
        });
      }
      if (value.type === "timeout" && value.complexity_score !== undefined && !Number.isFinite(value.complexity_score)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "complexity_score must be finite",
          path: ["complexity_score"],
        });
      }
    }),
);

/** Schema validating an entire compiled Behaviour Tree payload. */
export const CompiledBehaviorTreeSchema = z.object({
  id: z.string().min(1),
  root: BehaviorNodeDefinitionSchema,
});

export type BehaviorNodeDefinitionInput = z.input<typeof BehaviorNodeDefinitionSchema>;
export type CompiledBehaviorTreeInput = z.input<typeof CompiledBehaviorTreeSchema>;
