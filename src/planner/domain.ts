import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { omitUndefinedEntries } from "../utils/object.js";

/**
 * Error raised when a plan specification cannot be parsed or validated. The
 * error contains a stable {@link code} so transport layers can surface
 * consistent diagnostics to clients without leaking internal details.
 */
export class PlanSpecificationError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, code = "E-PLAN-SPEC", details?: unknown) {
    super(message);
    this.name = "PlanSpecificationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Contract describing a condition that must be satisfied before or after a
 * planner task executes. Conditions are intentionally descriptive: the runtime
 * can evaluate them using domain-specific logic or surface them to operators
 * for manual validation.
 */
export interface PlannerCondition {
  /** Optional identifier allowing other tasks to reference the condition. */
  id?: string;
  /** Human readable description of the requirement or outcome. */
  description: string;
  /** Optional machine-readable expression (CEL, JSONLogic, …). */
  expression?: string;
  /** Logical kind categorising how the condition should be evaluated. */
  kind: "pre" | "post" | "invariant";
}

/**
 * Resource requirement attached to a planner task. Requirements help schedulers
 * and operators estimate load or enforce guard-rails when executing the plan.
 */
export interface PlannerResourceRequest {
  /** Semantic name of the resource (cpu, memory, budget…). */
  name: string;
  /** Optional quantity requested by the task (non-negative). */
  quantity?: number;
  /** Optional unit string (ms, tokens, dollars…). */
  unit?: string;
}

/**
 * Declarative task describing a step within a planner document. Each task
 * points to a tool that will be invoked once dependencies and pre-conditions
 * are satisfied.
 */
export interface PlannerTask {
  /** Stable identifier used for dependency edges and scheduling. */
  id: string;
  /** Optional short name used in dashboards. */
  name?: string;
  /** Free-form description for operators and audits. */
  description?: string;
  /** Tool executed when the task runs. */
  tool: string;
  /** Optional JSON-serialisable payload forwarded to the tool. */
  input?: unknown;
  /** List of task identifiers that must complete before this step runs. */
  depends_on: string[];
  /** Conditions that must hold before the tool executes. */
  preconditions: PlannerCondition[];
  /** Conditions the tool guarantees after completion. */
  postconditions: PlannerCondition[];
  /** Resource requirements enforced during execution. */
  resources: PlannerResourceRequest[];
  /**
   * Optional optimistic duration estimate used for scheduling heuristics.
   * Expressed in milliseconds and clamped to positive integers.
   */
  estimated_duration_ms?: number;
  /** Optional timeout budget applied when the plan executes. */
  timeout_ms?: number;
  /** Arbitrary metadata carried alongside the task. */
  metadata?: Record<string, unknown>;
}

/** High-level metadata describing the author or purpose of the plan. */
export interface PlannerPlanMetadata extends Record<string, unknown> {
  owner?: string;
  labels?: string[];
}

/** Top-level document consumed by the planner compiler. */
export interface PlannerPlan {
  /** Stable identifier referenced by downstream tooling. */
  id: string;
  /** Optional version string (semver, git SHA…). */
  version?: string;
  /** Human readable title summarising the plan. */
  title?: string;
  /** Detailed description of the intent. */
  description?: string;
  /** Ordered list of declarative tasks. */
  tasks: PlannerTask[];
  /** Arbitrary metadata preserved end-to-end. */
  metadata?: PlannerPlanMetadata;
}

/**
 * Zod schema validating a planner condition. Enforces trimmed strings and caps
 * description length to keep telemetry payloads lightweight.
 */
const PlannerConditionSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().min(1).max(500),
    expression: z.string().trim().min(1).max(2000).optional(),
    kind: z.enum(["pre", "post", "invariant"]).default("pre"),
  })
  .strict();

/** Schema validating resource requirements. */
const PlannerResourceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    quantity: z.number().nonnegative().finite().optional(),
    unit: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

/** Schema validating individual planner tasks. */
const PlannerTaskSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    tool: z.string().trim().min(1).max(200),
    input: z.unknown().optional(),
    depends_on: z.array(z.string().trim().min(1).max(200)).default([]),
    preconditions: z.array(PlannerConditionSchema).default([]),
    postconditions: z.array(PlannerConditionSchema).default([]),
    resources: z.array(PlannerResourceRequestSchema).default([]),
    estimated_duration_ms: z.number().int().min(1).max(86_400_000).optional(),
    timeout_ms: z.number().int().min(1).max(86_400_000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

/** Schema validating the top-level planner document. */
const PlannerPlanSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(120).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(4000).optional(),
    tasks: z.array(PlannerTaskSchema).min(1),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * TypeScript helpers inferred from the schemas. These remain module-private so
 * callers interact with the Zod definitions directly while internal helpers
 * keep full static typing.
 */
type PlannerConditionInput = z.infer<typeof PlannerConditionSchema>;
type PlannerResourceRequestInput = z.infer<typeof PlannerResourceRequestSchema>;
type PlannerTaskInput = z.infer<typeof PlannerTaskSchema>;
type PlannerPlanInput = z.infer<typeof PlannerPlanSchema>;

/** Parse unknown input (JSON or YAML) into a validated {@link PlannerPlan}. */
export function parsePlannerPlan(spec: unknown): PlannerPlan {
  let payload: unknown;
  if (typeof spec === "string") {
    const trimmed = spec.trim();
    if (trimmed.length === 0) {
      throw new PlanSpecificationError("plan specification is empty", "E-PLAN-EMPTY");
    }
    payload = parseStringSpec(trimmed);
  } else if (spec && typeof spec === "object") {
    payload = spec;
  } else {
    throw new PlanSpecificationError("plan specification must be an object or string", "E-PLAN-TYPE");
  }

  const parsed = PlannerPlanSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PlanSpecificationError("plan specification is invalid", "E-PLAN-INVALID", parsed.error.flatten());
  }

  const plan = parsed.data;

  const uniqueIds = new Set<string>();
  for (const task of plan.tasks) {
    if (uniqueIds.has(task.id)) {
      throw new PlanSpecificationError(`duplicate task id ${task.id}`, "E-PLAN-DUPLICATE", { taskId: task.id });
    }
    uniqueIds.add(task.id);
  }

  return sanitisePlannerPlan(plan);
}

/** Attempt to parse a textual specification as JSON first, then YAML. */
function parseStringSpec(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    try {
      return parseYaml(source);
    } catch (error) {
      throw new PlanSpecificationError("unable to parse plan specification", "E-PLAN-PARSE", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Re-exported schemas so RPC layers can reference them without duplication. */
export const PlannerSchemas = {
  plan: PlannerPlanSchema,
  task: PlannerTaskSchema,
  condition: PlannerConditionSchema,
  resource: PlannerResourceRequestSchema,
};

/**
 * Removes optional `undefined` markers from a planner condition so the returned
 * payload honours `exactOptionalPropertyTypes` while preserving the intent of
 * the specification. Conditions are cloned to avoid mutating the parsed schema
 * output and to make downstream consumers resilient to accidental mutation.
 */
function sanitisePlannerCondition(condition: PlannerConditionInput): PlannerCondition {
  const optionalFields = omitUndefinedEntries({
    id: condition.id,
    expression: condition.expression,
  });

  return {
    description: condition.description,
    kind: condition.kind,
    ...optionalFields,
  };
}

/**
 * Normalises planner resource requests by trimming `undefined` optional
 * properties. The resulting object only exposes quantity/unit when explicitly
 * provided in the source document, ensuring telemetry payloads stay sparse.
 */
function sanitisePlannerResourceRequest(
  resource: PlannerResourceRequestInput,
): PlannerResourceRequest {
  const optionalFields = omitUndefinedEntries({
    quantity: resource.quantity,
    unit: resource.unit,
  });

  return {
    name: resource.name,
    ...optionalFields,
  };
}

/**
 * Builds a clean planner task object without serialising placeholders for
 * optional metadata. Arrays are recreated to avoid leaking shared references
 * from the schema output.
 */
function sanitisePlannerTask(task: PlannerTaskInput): PlannerTask {
  const optionalFields = omitUndefinedEntries({
    name: task.name,
    description: task.description,
    input: task.input,
    estimated_duration_ms: task.estimated_duration_ms,
    timeout_ms: task.timeout_ms,
    metadata: task.metadata,
  });

  return {
    id: task.id,
    tool: task.tool,
    depends_on: [...task.depends_on],
    preconditions: task.preconditions.map(sanitisePlannerCondition),
    postconditions: task.postconditions.map(sanitisePlannerCondition),
    resources: task.resources.map(sanitisePlannerResourceRequest),
    ...optionalFields,
  };
}

/**
 * Produces a fully sanitised planner document that omits optional fields when
 * they were not supplied in the specification. This keeps downstream consumers
 * compliant with strict optional typing without modifying the raw schema
 * output in-place.
 */
function sanitisePlannerPlan(plan: PlannerPlanInput): PlannerPlan {
  const optionalFields = omitUndefinedEntries({
    version: plan.version,
    title: plan.title,
    description: plan.description,
    metadata: plan.metadata,
  });

  return {
    id: plan.id,
    tasks: plan.tasks.map(sanitisePlannerTask),
    ...optionalFields,
  };
}
