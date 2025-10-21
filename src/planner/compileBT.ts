import { randomUUID } from "node:crypto";
import {
  type BehaviorNodeDefinition,
  type CompiledBehaviorTree,
} from "../executor/bt/types.js";
import { type PlannerPlan, type PlannerTask } from "./domain.js";
import { buildPlanSchedule, type PlanSchedule } from "./schedule.js";

/**
 * Metadata accompanying a compiled planner document. The structure includes the
 * behaviour tree, deterministic schedule, and helper maps consumed by runtimes
 * to seed Behaviour Tree variables or evaluate guards.
 */
export interface PlannerCompilationResult {
  plan: PlannerPlan;
  behaviorTree: CompiledBehaviorTree;
  schedule: PlanSchedule;
  /** Static inputs injected into the Behaviour Tree variable bag. */
  variableBindings: Record<string, unknown>;
  /** Mapping of guard keys to their declarative definition. */
  guardConditions: Record<string, PlannerTask["preconditions"][number]>;
  /** Mapping of task id to declared post-conditions. */
  postconditions: Record<string, PlannerTask["postconditions"]>;
}

/** Prefix applied to variable bindings generated for task inputs. */
export const INPUT_VARIABLE_PREFIX = "plan.inputs";
/** Prefix applied to guard variable lookups for pre-conditions. */
export const GUARD_VARIABLE_PREFIX = "plan.guards";

/**
 * Compile a planner document into a Behaviour Tree enriched with scheduling
 * metadata. The resulting artefact can be executed directly by the existing
 * Behaviour Tree interpreter while exposing sufficient context for monitoring
 * and lifecycle registries.
 */
export function compilePlannerPlan(plan: PlannerPlan): PlannerCompilationResult {
  const schedule = buildPlanSchedule(plan);
  const variableBindings: Record<string, unknown> = {};
  const guardConditions: Record<string, PlannerTask["preconditions"][number]> = {};
  const postconditions: Record<string, PlannerTask["postconditions"]> = {};

  const phaseNodes: BehaviorNodeDefinition[] = schedule.phases.map((phase) => {
    const phaseChildren = phase.tasks.map((task) =>
      buildTaskNode(plan, task.id, variableBindings, guardConditions, postconditions),
    );
    if (phaseChildren.length === 1) {
      return phaseChildren[0];
    }
    return {
      type: "parallel",
      id: `phase:${phase.index}:${plan.id}`,
      policy: "all",
      children: phaseChildren,
    } satisfies BehaviorNodeDefinition;
  });

  const root: BehaviorNodeDefinition =
    phaseNodes.length === 1
      ? phaseNodes[0]
      : {
          type: "sequence",
          id: `plan:${plan.id}:sequence`,
          children: phaseNodes,
        };

  const behaviorTree: CompiledBehaviorTree = {
    id: plan.id,
    root,
  };

  return {
    plan,
    behaviorTree,
    schedule,
    variableBindings,
    guardConditions,
    postconditions,
  };
}

function buildTaskNode(
  plan: PlannerPlan,
  taskId: string,
  variableBindings: Record<string, unknown>,
  guardConditions: Record<string, PlannerTask["preconditions"][number]>,
  postconditions: Record<string, PlannerTask["postconditions"]>,
): BehaviorNodeDefinition {
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`task ${taskId} disappeared during compilation`);
  }

  const inputBinding =
    task.input !== undefined ? `${INPUT_VARIABLE_PREFIX}.${task.id}` : undefined;

  let node: BehaviorNodeDefinition = {
    type: "task",
    id: `task:${task.id}`,
    node_id: task.id,
    tool: task.tool,
    // Propagate the behaviour-tree variable binding only when the planner task
    // declares an input payload. This avoids materialising `input_key:
    // undefined`, which would violate `exactOptionalPropertyTypes` once the
    // compiler flag is enabled.
    ...(inputBinding ? { input_key: inputBinding } : {}),
  } satisfies BehaviorNodeDefinition;

  if (task.timeout_ms) {
    node = {
      type: "timeout",
      id: `timeout:${task.id}`,
      timeout_ms: task.timeout_ms,
      child: node,
    } satisfies BehaviorNodeDefinition;
  }

  if (task.preconditions.length > 0) {
    for (let index = task.preconditions.length - 1; index >= 0; index -= 1) {
      const condition = task.preconditions[index];
      const guardKey = `${GUARD_VARIABLE_PREFIX}.${task.id}.${condition.id ?? index}`;
      guardConditions[guardKey] = structuredClone(condition);
      node = {
        type: "guard",
        id: `guard:${task.id}:${index}`,
        condition_key: guardKey,
        expected: true,
        child: node,
      } satisfies BehaviorNodeDefinition;
    }
  }

  if (task.input !== undefined) {
    variableBindings[`${INPUT_VARIABLE_PREFIX}.${task.id}`] = structuredClone(task.input);
  }

  if (task.postconditions.length > 0) {
    postconditions[task.id] = task.postconditions.map((condition) => structuredClone(condition));
  }

  return node;
}

/**
 * Generate a deterministic run identifier for the compiled plan. The helper is
 * exported to keep tests deterministic while mirroring the production strategy
 * (UUID v4).
 */
export function generatePlanRunId(planId: string): string {
  return `plan_run_${planId}_${randomUUID()}`;
}
