import process from "node:process";

/**
 * Describes the timeout budget applied to a JSON-RPC invocation. The dispatcher
 * clamps the budget within the provided bounds to avoid absurd configuration
 * while still allowing slower tools to complete.
 */
export interface RpcTimeoutBudget {
  /** Target timeout applied to the request in milliseconds. */
  readonly timeoutMs: number;
  /** Lower bound used when clamping dynamic overrides. */
  readonly minMs: number;
  /** Upper bound used when clamping dynamic overrides. */
  readonly maxMs: number;
}

/** Error raised when a JSON-RPC handler exceeds its allocated timeout. */
export class JsonRpcTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`JSON-RPC handler exceeded timeout after ${timeoutMs}ms`);
    this.name = "JsonRpcTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Default timeout budget applied to methods without dedicated heuristics. */
const DEFAULT_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 60_000,
  minMs: 1_000,
  maxMs: 300_000,
};

/**
 * Fast metadata endpoints (introspection, capability discovery) are expected to
 * return in a few seconds. They also serve as readiness probes for the smoke
 * validation script, hence the tighter upper bound.
 */
const INTROSPECTION_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 5_000,
  minMs: 500,
  maxMs: 10_000,
};

/** Observability endpoints serve small responses but may page through data. */
const OBSERVABILITY_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 15_000,
  minMs: 2_000,
  maxMs: 45_000,
};

/** Graph operations can require costly validations; allow a generous budget. */
const GRAPH_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 60_000,
  minMs: 10_000,
  maxMs: 180_000,
};

/** Graph batch operations are heavier and may stream work; extend the cap. */
const GRAPH_BATCH_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 90_000,
  minMs: 20_000,
  maxMs: 240_000,
};

/** Planning pipelines orchestrate multiple children; give them ample time. */
const PLAN_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 180_000,
  minMs: 60_000,
  maxMs: 480_000,
};

/** Child lifecycle management should complete quickly but allow buffers. */
const CHILD_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 30_000,
  minMs: 5_000,
  maxMs: 60_000,
};

/** Blackboard/coordination helpers primarily touch in-memory stores. */
const COORD_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 20_000,
  minMs: 5_000,
  maxMs: 45_000,
};

/** Value, causal and knowledge stores may perform disk IO or analytics. */
const KNOWLEDGE_TIMEOUT: RpcTimeoutBudget = {
  timeoutMs: 45_000,
  minMs: 10_000,
  maxMs: 120_000,
};

/**
 * Runtime overrides keyed by method or tool name. Tests rely on these knobs to
 * simulate tight budgets while production may hook an environment toggle later.
 */
const overrideTimeouts = new Map<string, RpcTimeoutBudget>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalise(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function buildOverrideKey(kind: "method" | "tool", name: string): string {
  return `${kind}:${name}`;
}

const EXACT_METHOD_TIMEOUTS: Record<string, RpcTimeoutBudget> = {
  mcp_info: INTROSPECTION_TIMEOUT,
  mcp_capabilities: INTROSPECTION_TIMEOUT,
  health_check: INTROSPECTION_TIMEOUT,
  "resources/list": OBSERVABILITY_TIMEOUT,
  "resources/read": OBSERVABILITY_TIMEOUT,
  "resources/watch": OBSERVABILITY_TIMEOUT,
  "events/list": OBSERVABILITY_TIMEOUT,
  "events/subscribe": OBSERVABILITY_TIMEOUT,
  "logs/tail": OBSERVABILITY_TIMEOUT,
};

const TOOL_PREFIX_TIMEOUTS: Array<{ prefix: string; budget: RpcTimeoutBudget }> = [
  { prefix: "graph_batch", budget: GRAPH_BATCH_TIMEOUT },
  { prefix: "graph_paths", budget: GRAPH_BATCH_TIMEOUT },
  { prefix: "graph_", budget: GRAPH_TIMEOUT },
  { prefix: "tx_", budget: GRAPH_TIMEOUT },
  { prefix: "plan_", budget: PLAN_TIMEOUT },
  { prefix: "child_", budget: CHILD_TIMEOUT },
  { prefix: "bb_", budget: COORD_TIMEOUT },
  { prefix: "stig_", budget: COORD_TIMEOUT },
  { prefix: "cnp_", budget: COORD_TIMEOUT },
  { prefix: "consensus_", budget: COORD_TIMEOUT },
  { prefix: "values_", budget: KNOWLEDGE_TIMEOUT },
  { prefix: "kg_", budget: KNOWLEDGE_TIMEOUT },
  { prefix: "causal_", budget: KNOWLEDGE_TIMEOUT },
];

const EXACT_TOOL_TIMEOUTS: Record<string, RpcTimeoutBudget> = {
  child_stream: CHILD_TIMEOUT,
  child_collect: CHILD_TIMEOUT,
  child_kill: CHILD_TIMEOUT,
  child_spawn_codex: CHILD_TIMEOUT,
  graph_batch_mutate: GRAPH_BATCH_TIMEOUT,
  graph_rewrite_apply: GRAPH_BATCH_TIMEOUT,
  plan_run_bt: PLAN_TIMEOUT,
  plan_run_reactive: PLAN_TIMEOUT,
  plan_compile_bt: PLAN_TIMEOUT,
  plan_reduce: PLAN_TIMEOUT,
};

/**
 * Computes the timeout budget associated with the provided method or tool name.
 * The dispatcher relies on this helper before invoking `routeJsonRpcRequest`.
 */
export function resolveRpcTimeoutBudget(method: string, toolName?: string | null): RpcTimeoutBudget {
  const normalisedMethod = normalise(method);
  const normalisedTool = normalise(toolName);

  if (normalisedTool) {
    const override = overrideTimeouts.get(buildOverrideKey("tool", normalisedTool));
    if (override) {
      return override;
    }
    const exact = EXACT_TOOL_TIMEOUTS[normalisedTool];
    if (exact) {
      return exact;
    }
    for (const { prefix, budget } of TOOL_PREFIX_TIMEOUTS) {
      if (normalisedTool.startsWith(prefix)) {
        return budget;
      }
    }
  }

  if (normalisedMethod) {
    const override = overrideTimeouts.get(buildOverrideKey("method", normalisedMethod));
    if (override) {
      return override;
    }
    const exact = EXACT_METHOD_TIMEOUTS[normalisedMethod];
    if (exact) {
      return exact;
    }
    if (normalisedMethod.startsWith("resources/")) {
      return OBSERVABILITY_TIMEOUT;
    }
    if (normalisedMethod.startsWith("events/")) {
      return OBSERVABILITY_TIMEOUT;
    }
    if (normalisedMethod.startsWith("logs/")) {
      return OBSERVABILITY_TIMEOUT;
    }
  }

  return DEFAULT_TIMEOUT;
}

/**
 * Normalises and clamps the timeout budget before it is applied to a request.
 * The helper accepts an optional override which may come from runtime flags.
 */
export function normaliseTimeoutBudget(
  budget: RpcTimeoutBudget,
  overrideMs?: number | null,
): RpcTimeoutBudget {
  const timeout = overrideMs ?? budget.timeoutMs;
  if (!Number.isFinite(timeout)) {
    return budget;
  }
  const clamped = clamp(timeout, budget.minMs, budget.maxMs);
  return { timeoutMs: clamped, minMs: budget.minMs, maxMs: budget.maxMs };
}

/** Registers an override for the provided method or tool name. */
export function setRpcTimeoutOverride(
  kind: "method" | "tool",
  name: string,
  budget: RpcTimeoutBudget | null,
): void {
  const key = buildOverrideKey(kind, normalise(name) ?? name.trim().toLowerCase());
  if (!key || !name.trim()) {
    return;
  }
  if (budget === null) {
    overrideTimeouts.delete(key);
    return;
  }
  overrideTimeouts.set(key, budget);
}

/** Clears every timeout override, primarily used by tests to restore state. */
export function resetRpcTimeoutOverrides(): void {
  overrideTimeouts.clear();
}

/**
 * Exposes the default timeout budget for diagnostics and tests. The values are
 * immutable at runtime but the helper allows smoke tests to assert the cap.
 */
export function getDefaultRpcTimeoutBudget(): RpcTimeoutBudget {
  return { ...DEFAULT_TIMEOUT };
}

/**
 * Reads an environment driven override that clamps the default timeout budget.
 * This is currently only used to facilitate local experimentation.
 */
export function loadDefaultTimeoutOverride(): number | null {
  const raw = process.env.MCP_RPC_DEFAULT_TIMEOUT_MS;
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}
