import { BudgetTracker, type BudgetLimits } from "./budget.js";
import type { ToolBudgets, ToolManifest } from "../mcp/registry.js";
import { normaliseTimeoutBudget, type RpcTimeoutBudget } from "../rpc/timeouts.js";

/**
 * Lightweight descriptor mirroring the subset of {@link ToolRegistry} required to
 * look up manifests. The indirection keeps {@link assembleJsonRpcRuntime}
 * decoupled from the concrete registry implementation which greatly simplifies
 * unit testing.
 */
export interface ToolBudgetCatalog {
  /** Retrieves the manifest associated with the provided tool name. */
  get(name: string): ToolManifest | undefined;
}

/**
 * Context propagated across JSON-RPC handlers. The structure intentionally stays
 * minimal so transports can attach metadata such as request identifiers,
 * per-request budgets, or idempotency keys without leaking transport specific
 * state to business logic.
 */
export interface JsonRpcRouteContext {
  /** Optional HTTP-like headers to expose to downstream handlers. */
  headers?: Record<string, string>;
  /** Identifier reused when the upstream caller provided one. */
  requestId?: string | number | null;
  /** Logical transport tag (e.g. "http", "fs") for diagnostics. */
  transport?: string;
  /** Logical child identifier propagated by self-provider orchestration. */
  childId?: string;
  /** Optional limits advertised by the child session. */
  childLimits?: { cpuMs?: number; memMb?: number; wallMs?: number };
  /** Idempotency key supplied by HTTP callers. */
  idempotencyKey?: string;
  /** Number of bytes contained in the JSON-RPC request payload. */
  payloadSizeBytes?: number;
  /** Timeout budget (milliseconds) applied to the JSON-RPC handler. */
  timeoutMs?: number;
  /** Budget tracker attached to the current request lifecycle. */
  budget?: BudgetTracker;
  /** Request-level tracker used by the transport to enforce ingress/egress quotas. */
  requestBudget?: BudgetTracker;
}

/**
 * Dependencies required to assemble the per-request runtime context. The server
 * root provides concrete implementations, while tests can inject light-weight
 * doubles to validate the behaviour in isolation.
 */
export interface RuntimeAssemblyDependencies {
  /** Registry exposing the manifests (and therefore budgets) for every tool. */
  readonly toolRegistry: ToolBudgetCatalog;
  /** Limits applied to the transport-level request budget. */
  readonly requestLimits: BudgetLimits;
  /** Resolver returning the timeout budget associated with a method/tool pair. */
  readonly resolveTimeoutBudget: (method: string, toolName: string | null) => RpcTimeoutBudget;
  /** Optional override used to clamp the timeout budget. */
  readonly defaultTimeoutOverride?: number | null;
}

/**
 * Parameters describing the JSON-RPC invocation currently being processed.
 * Only the method name, targeted tool and optional parent context are required
 * to build the derived runtime artefacts.
 */
export interface RuntimeAssemblyInput {
  /** Canonical JSON-RPC method name (after normalisation). */
  readonly method: string;
  /** Logical tool name targeted by the invocation, if any. */
  readonly toolName: string | null;
  /** Optional context propagated by the transport or parent invocation. */
  readonly context?: JsonRpcRouteContext;
}

/** Result returned after assembling the per-request runtime artefacts. */
export interface RuntimeAssemblyResult {
  /** Fresh runtime context enriched with budget trackers and timeout metadata. */
  readonly context: JsonRpcRouteContext;
  /** Transport-level budget tracker enforcing ingress/egress/tool-call quotas. */
  readonly requestBudget: BudgetTracker;
  /** Optional tool-specific budget tracker derived from the manifest. */
  readonly toolBudget: BudgetTracker | null;
  /** Timeout budget applied to the JSON-RPC invocation. */
  readonly timeoutBudget: RpcTimeoutBudget;
}

/**
 * Converts manifest-defined tool budgets into the structure understood by the
 * {@link BudgetTracker}. Undefined or negative limits are ignored so optional
 * manifest fields are treated as unbounded dimensions.
 */
function normaliseToolBudgetLimits(budgets: ToolBudgets | undefined): BudgetLimits | undefined {
  if (!budgets) {
    return undefined;
  }

  const limits: BudgetLimits = {};
  let applied = false;

  if (typeof budgets.time_ms === "number" && Number.isFinite(budgets.time_ms) && budgets.time_ms >= 0) {
    limits.timeMs = Math.trunc(budgets.time_ms);
    applied = true;
  }
  if (typeof budgets.tool_calls === "number" && Number.isFinite(budgets.tool_calls) && budgets.tool_calls >= 0) {
    limits.toolCalls = Math.trunc(budgets.tool_calls);
    applied = true;
  }
  if (typeof budgets.bytes_out === "number" && Number.isFinite(budgets.bytes_out) && budgets.bytes_out >= 0) {
    limits.bytesOut = Math.trunc(budgets.bytes_out);
    applied = true;
  }

  return applied ? limits : undefined;
}

/**
 * Builds a budget tracker for the requested tool when its manifest advertises
 * explicit limits. When no manifest is found or all limits are omitted the
 * helper returns `null`, signalling to the caller that only the transport-level
 * budget should be enforced.
 */
function createToolBudgetTracker(toolName: string | null, registry: ToolBudgetCatalog): BudgetTracker | null {
  if (!toolName) {
    return null;
  }
  const manifest = registry.get(toolName);
  if (!manifest) {
    return null;
  }
  const limits = normaliseToolBudgetLimits(manifest.budgets);
  return limits ? new BudgetTracker(limits) : null;
}

/**
 * Assembles the per-request runtime artefacts required by JSON-RPC handlers.
 * The function clones the inbound context, attaches a fresh transport-level
 * budget tracker, creates a tool-specific tracker when relevant, and derives
 * the timeout budget enforced during execution.
 */
export function assembleJsonRpcRuntime(
  deps: RuntimeAssemblyDependencies,
  input: RuntimeAssemblyInput,
): RuntimeAssemblyResult {
  const baseContext = input.context ? { ...input.context } : {};

  // Always reset the tool budget to avoid leaking parent trackers when nested
  // invocations reuse the AsyncLocalStorage context.
  baseContext.budget = undefined;

  const requestBudget = new BudgetTracker(deps.requestLimits);
  baseContext.requestBudget = requestBudget;

  const toolBudget = createToolBudgetTracker(input.toolName, deps.toolRegistry);
  if (toolBudget) {
    baseContext.budget = toolBudget;
  }

  const timeoutBudget = normaliseTimeoutBudget(
    deps.resolveTimeoutBudget(input.method.trim(), input.toolName),
    deps.defaultTimeoutOverride ?? null,
  );
  baseContext.timeoutMs = timeoutBudget.timeoutMs;

  return {
    context: baseContext,
    requestBudget,
    toolBudget,
    timeoutBudget,
  };
}

