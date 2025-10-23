import { StructuredLogger } from "../logger.js";

/**
 * Metadata describing the deprecation plan for a tool. The structure mirrors the
 * manifest field stored in the {@link ToolRegistry} so helpers can reuse the
 * same shape regardless of where the metadata originates from.
 */
export interface ToolDeprecationMetadata {
  readonly since: string;
  readonly replace_with?: string;
}

/** Snapshot describing the computed enforcement state for a deprecated tool. */
export interface ToolDeprecationEvaluation {
  /**
   * Raw metadata, if a deprecation has been registered for the tool. The
   * structure is cloned to avoid accidental mutations.
   */
  readonly metadata?: ToolDeprecationMetadata;
  /** Age in whole days since the deprecation notice was published. */
  readonly ageDays: number | null;
  /** When `true`, the tool should be hidden from discovery surfaces. */
  readonly forceHidden: boolean;
  /** When `true`, the tool must be rejected (J+60 enforcement). */
  readonly forceRemoval: boolean;
}

/** ISO-8601 timestamp used for the initial façade rollout. */
const FACADE_ROLLOUT_DATE = "2025-10-01T00:00:00Z";

/**
 * Declarative catalogue mapping primitive tool names to their façade
 * replacement. The list deliberately focuses on the legacy tool families that
 * now have a first-class façade. Prefix based entries allow us to cover the
 * large child/plan surfaces without enumerating every variant.
 */
const EXACT_DEPRECATIONS: Record<string, ToolDeprecationMetadata> = {
  graph_mutate: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_apply_change_set" },
  graph_batch_mutate: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_apply_change_set" },
  graph_patch: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_apply_change_set" },
  graph_diff: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_apply_change_set" },
  graph_lock: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_apply_change_set" },
  graph_unlock: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_apply_change_set" },
  graph_state_save: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_snapshot_time_travel" },
  graph_state_load: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_snapshot_time_travel" },
  graph_state_autosave: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_snapshot_time_travel" },
  graph_config_retention: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_snapshot_time_travel" },
  graph_prune: { since: FACADE_ROLLOUT_DATE, replace_with: "graph_snapshot_time_travel" },
  memory_vector_search: { since: FACADE_ROLLOUT_DATE, replace_with: "memory_search" },
};

interface PrefixRule {
  readonly prefix: string;
  readonly metadata: ToolDeprecationMetadata;
  readonly exclude?: ReadonlySet<string>;
}

const PREFIX_DEPRECATIONS: PrefixRule[] = [
  {
    prefix: "plan_",
    metadata: { since: FACADE_ROLLOUT_DATE, replace_with: "plan_compile_execute" },
    exclude: new Set(["plan_compile_execute"]),
  },
  {
    prefix: "child_",
    metadata: { since: FACADE_ROLLOUT_DATE, replace_with: "child_orchestrate" },
    exclude: new Set(["child_orchestrate"]),
  },
];

/**
 * Resolves the registered deprecation metadata for a tool name. The helper
 * first checks exact matches before applying prefix based rules.
 */
export function getRegisteredToolDeprecation(name: string): ToolDeprecationMetadata | undefined {
  const exact = EXACT_DEPRECATIONS[name];
  if (exact) {
    return { ...exact };
  }
  for (const rule of PREFIX_DEPRECATIONS) {
    if (!name.startsWith(rule.prefix)) {
      continue;
    }
    if (rule.exclude?.has(name)) {
      continue;
    }
    return { ...rule.metadata };
  }
  return undefined;
}

/** Parses the `since` field and returns the age in whole days. */
function resolveAgeInDays(metadata: ToolDeprecationMetadata | undefined, now: Date): number | null {
  if (!metadata) {
    return null;
  }
  const parsed = Number.isFinite(Date.parse(metadata.since)) ? new Date(metadata.since) : null;
  if (!parsed) {
    return null;
  }
  const diffMs = now.getTime() - parsed.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 0;
  }
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Computes the enforcement state for a deprecated tool. The evaluation
 * normalises missing metadata by consulting the registered catalogue so callers
 * can simply forward the manifest field when available.
 */
export function evaluateToolDeprecation(
  name: string,
  metadata: ToolDeprecationMetadata | undefined,
  now: Date = new Date(),
): ToolDeprecationEvaluation {
  const resolved = metadata ?? getRegisteredToolDeprecation(name);
  const ageDays = resolveAgeInDays(resolved, now);
  const forceHidden = typeof ageDays === "number" && ageDays !== null && ageDays >= 30;
  const forceRemoval = typeof ageDays === "number" && ageDays !== null && ageDays >= 60;
  // NOTE: The metadata field is attached conditionally so the returned
  // structure remains compliant with `exactOptionalPropertyTypes` once the
  // TypeScript flag is enforced globally.
  return {
    ...(resolved ? { metadata: { ...resolved } } : {}),
    ageDays,
    forceHidden,
    forceRemoval,
  };
}

/**
 * Emits a structured warning when a deprecated tool is invoked. Keeping the
 * logging helper centralised avoids duplicating the log formatting logic across
 * transports.
 */
export function logToolDeprecation(
  logger: StructuredLogger,
  level: "warn" | "error", // explicit union to keep TypeScript strict
  event: string,
  payload: {
    name: string;
    metadata: ToolDeprecationMetadata;
    ageDays: number | null;
  },
): void {
  const { name, metadata, ageDays } = payload;
  logger[level](event, {
    tool: name,
    since: metadata.since,
    replace_with: metadata.replace_with ?? null,
    age_days: ageDays,
  });
}
