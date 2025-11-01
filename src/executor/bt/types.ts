/**
 * Behaviour Tree type system centralising runtime contracts and serialisation schemas.
 * The shared definitions keep the interpreter strongly typed across runtime and persistence.
 */
import { z } from "zod";

import { omitUndefinedDeep } from "../../utils/object.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
  return !(key in record) || typeof record[key] === "string";
}

function hasOptionalNumber(record: Record<string, unknown>, key: string, predicate?: (value: number) => boolean): boolean {
  if (!(key in record)) {
    return true;
  }
  const value = record[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    return false;
  }
  return predicate ? predicate(value) : true;
}

function isParallelPolicyValue(value: unknown): value is ParallelPolicy {
  if (value === "all" || value === "any") {
    return true;
  }
  if (isRecord(value) && value.mode === "quota" && typeof value.threshold === "number" && Number.isFinite(value.threshold)) {
    return true;
  }
  return false;
}

function isBehaviorNodeDefinition(value: unknown): value is BehaviorNodeDefinition {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "sequence":
    case "selector": {
      return (
        Array.isArray(value.children) &&
        value.children.every(isBehaviorNodeDefinition) &&
        hasOptionalString(value, "id")
      );
    }
    case "parallel": {
      return (
        Array.isArray(value.children) &&
        value.children.every(isBehaviorNodeDefinition) &&
        hasOptionalString(value, "id") &&
        isParallelPolicyValue(value.policy)
      );
    }
    case "retry": {
      return (
        typeof value.max_attempts === "number" &&
        Number.isInteger(value.max_attempts) &&
        value.max_attempts >= 1 &&
        isBehaviorNodeDefinition(value.child) &&
        hasOptionalString(value, "id") &&
        hasOptionalNumber(value, "backoff_ms", (candidate) => Number.isInteger(candidate) && candidate >= 0) &&
        hasOptionalNumber(value, "backoff_jitter_ms", (candidate) => Number.isInteger(candidate) && candidate >= 0)
      );
    }
    case "timeout": {
      return (
        isBehaviorNodeDefinition(value.child) &&
        hasOptionalString(value, "id") &&
        hasOptionalNumber(value, "timeout_ms", (candidate) => Number.isInteger(candidate) && candidate >= 1) &&
        hasOptionalString(value, "timeout_category") &&
        hasOptionalNumber(value, "complexity_score", (candidate) => Number.isFinite(candidate) && candidate > 0)
      );
    }
    case "guard": {
      return (
        typeof value.condition_key === "string" &&
        hasOptionalString(value, "id") &&
        isBehaviorNodeDefinition(value.child)
      );
    }
    case "cancellable": {
      return hasOptionalString(value, "id") && isBehaviorNodeDefinition(value.child);
    }
    case "task": {
      return (
        typeof value.node_id === "string" &&
        typeof value.tool === "string" &&
        hasOptionalString(value, "id") &&
        hasOptionalString(value, "input_key")
      );
    }
    default:
      return false;
  }
}

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
  /**
   * Optional value propagated to parents for diagnostics or reducers. Callers
   * must omit the property rather than storing `undefined` to remain compatible
   * with `exactOptionalPropertyTypes` once enforced globally.
   */
  output?: unknown;
}

/**
 * Function responsible for invoking a concrete orchestrator tool.
 */
export type ToolInvoker = (toolName: string, input: unknown) => Promise<unknown>;

/**
 * Nominal type describing the shape expected from Behaviour Tree task schemas.
 * Using `unknown` keeps validation strict without widening to `any` while still
 * allowing each task to expose its precise contract.
 */
export type BehaviorTaskSchema = z.ZodType<unknown>;

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
  /** Optional pseudo-random source leveraged by jittered backoffs. */
  random?(): number;
  /** Shared map of variables exposed to guards and task leaves. */
  variables: Record<string, unknown>;
  /** Optional cancellation signal propagated by the orchestrator. */
  cancellationSignal?: AbortSignal;
  /** Predicate exposing the cancellation state for cooperative checks. */
  isCancelled?(): boolean;
  /** Helper throwing when the associated operation has been cancelled. */
  throwIfCancelled?(): void;
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
  | CancellableDefinition
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

/**
 * Supported aggregation policies for {@link ParallelDefinition}. The legacy
 * string shorthands are kept for backward compatibility while the `quota`
 * variant exposes an explicit threshold so plans can succeed once a subset of
 * children complete successfully.
 */
export type ParallelPolicy =
  | "all"
  | "any"
  | { mode: "quota"; threshold: number };

/** Definition of a parallel composite node. */
export interface ParallelDefinition {
  type: "parallel";
  id?: string;
  policy: ParallelPolicy;
  children: BehaviorNodeDefinition[];
}

/** Definition of a retry decorator node. */
export interface RetryDefinition {
  type: "retry";
  id?: string;
  max_attempts: number;
  backoff_ms?: number;
  backoff_jitter_ms?: number;
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

/** Definition of a cancellable decorator node. */
export interface CancellableDefinition {
  type: "cancellable";
  id?: string;
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
export const BehaviorNodeDefinitionSchema: z.ZodType<BehaviorNodeDefinition> = z.lazy(() => {
  const schema = z
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
        policy: z.union([
          z.enum(["all", "any"]),
          z
            .object({
              mode: z.literal("quota"),
              threshold: z.number().int().min(1),
            })
            .strict(),
        ]),
        children: z.array(BehaviorNodeDefinitionSchema).min(1),
      }),
      z.object({
        type: z.literal("retry"),
        id: z.string().min(1).optional(),
        max_attempts: z.number().int().min(1),
        backoff_ms: z.number().int().min(0).optional(),
        backoff_jitter_ms: z.number().int().min(0).optional(),
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
        type: z.literal("cancellable"),
        id: z.string().min(1).optional(),
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
    })
    .transform((value): BehaviorNodeDefinition => {
      const sanitised = omitUndefinedDeep(value);
      if (!isBehaviorNodeDefinition(sanitised)) {
        throw new Error("invalid behavior node definition");
      }
      return sanitised;
    });

  return schema as z.ZodType<BehaviorNodeDefinition>;
});

/** Schema validating an entire compiled Behaviour Tree payload. */
export const CompiledBehaviorTreeSchema = z.object({
  id: z.string().min(1),
  root: BehaviorNodeDefinitionSchema,
});

