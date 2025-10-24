/**
 * Encapsulates the plan fan-out child resolution logic so `planTools.ts` can focus
 * on orchestration. The helpers keep the branching strategies explicit while
 * remaining fully typed via imports from the parent module.
 */
import { omitUndefinedEntries } from "../../utils/object.js";
import { cloneDefinedRecord } from "../shared.js";
import type { ValueImpactInput, ValueFilterDecision } from "../../values/valueGraph.js";
import type { PlanFanoutInput } from "../planTools.js";

export interface ResolvedChildPlan {
  name: string;
  runtime: string;
  system?: string;
  goals?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  metadata?: Record<string, unknown>;
  manifestExtras?: Record<string, unknown>;
  promptVariables: Record<string, string | number | boolean>;
  ttlSeconds?: number;
  valueImpacts?: ValueImpactInput[];
  valueDecision?: ValueFilterDecision | null;
}

function cloneValueImpacts(source: ValueImpactInput[] | undefined): ValueImpactInput[] | undefined {
  return source ? source.map((impact) => ({ ...impact })) : undefined;
}

function fromChildSpecification(
  child: NonNullable<PlanFanoutInput["children"]>[number],
  defaultRuntime: string,
): ResolvedChildPlan {
  return {
    name: child.name,
    runtime: child.runtime ?? defaultRuntime,
    promptVariables: cloneDefinedRecord(child.prompt_variables) ?? {},
    ...omitUndefinedEntries({
      system: child.system,
      goals: child.goals,
      command: child.command,
      args: child.args,
      env: child.env,
      metadata: cloneDefinedRecord(child.metadata),
      manifestExtras: cloneDefinedRecord(child.manifest_extras),
      ttlSeconds: child.ttl_s,
      valueImpacts: cloneValueImpacts(child.value_impacts as ValueImpactInput[] | undefined),
    }),
  } satisfies ResolvedChildPlan;
}

function resolveFromList(
  children: NonNullable<PlanFanoutInput["children_spec"]> & { list: NonNullable<PlanFanoutInput["children"]> },
  defaultRuntime: string,
): ResolvedChildPlan[] {
  return children.list.map((child) => fromChildSpecification(child, defaultRuntime));
}

function resolveFromTemplate(
  spec: Exclude<NonNullable<PlanFanoutInput["children_spec"]>, { list: unknown }>,
  defaultRuntime: string,
): ResolvedChildPlan[] {
  const plans: ResolvedChildPlan[] = [];
  for (let index = 0; index < spec.count; index += 1) {
    plans.push({
      name: `${spec.name_prefix}-${index + 1}`,
      runtime: spec.runtime ?? defaultRuntime,
      promptVariables: {
        ...(cloneDefinedRecord(spec.prompt_variables) ?? {}),
        child_index: index + 1,
      },
      ...omitUndefinedEntries({
        system: spec.system,
        goals: spec.goals,
        metadata: cloneDefinedRecord(spec.metadata),
        manifestExtras: cloneDefinedRecord(spec.manifest_extras),
        valueImpacts: cloneValueImpacts(spec.value_impacts as ValueImpactInput[] | undefined),
      }),
    });
  }
  return plans;
}

function resolveFromChildrenArray(
  children: PlanFanoutInput["children"],
  defaultRuntime: string,
): ResolvedChildPlan[] {
  if (!children) {
    return [];
  }
  return children.map((child) => fromChildSpecification(child, defaultRuntime));
}

export function resolveChildrenPlans(
  input: PlanFanoutInput,
  defaultRuntime: string,
): ResolvedChildPlan[] {
  const spec = input.children_spec;
  if (spec) {
    if ("list" in spec && spec.list) {
      return resolveFromList(spec as typeof spec & { list: NonNullable<typeof input.children> }, defaultRuntime);
    }
    return resolveFromTemplate(spec as Exclude<typeof spec, { list: unknown }>, defaultRuntime);
  }

  const fromChildren = resolveFromChildrenArray(input.children, defaultRuntime);
  if (fromChildren.length > 0) {
    return fromChildren;
  }

  throw new Error("plan_fanout requires either children_spec or children to describe the clones");
}
