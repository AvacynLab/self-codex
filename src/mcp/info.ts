import { z, type ZodTypeAny } from "zod";

import {
  FEATURE_FLAG_DEFAULTS,
  RUNTIME_TIMING_DEFAULTS,
  type ChildSafetyOptions,
  type FeatureToggles,
  type RuntimeTimingOptions,
} from "../serverOptions.js";

/**
 * Descriptor describing the stdio transport status. Stdio is always available
 * in-process therefore the snapshot only needs to track the enable flag.
 */
export interface StdioTransportSnapshot {
  /** Whether the stdio transport is currently exposed to clients. */
  enabled: boolean;
}

/**
 * Descriptor mirroring the HTTP transport configuration exposed to MCP
 * clients. Only the publicly observable attributes are surfaced.
 */
export interface HttpTransportSnapshot {
  /** Whether the HTTP transport is enabled. */
  enabled: boolean;
  /** Listening host/interface when the HTTP transport is active. */
  host: string | null;
  /** Listening port when the HTTP transport is active. */
  port: number | null;
  /** Endpoint path used to expose the MCP handler. */
  path: string | null;
  /** Whether JSON streaming mode is enabled for SSE/streaming responses. */
  enableJson: boolean;
  /** Whether the HTTP transport operates in a stateless fashion. */
  stateless: boolean;
}

/** Public transport descriptor returned to MCP clients. */
export type McpTransportDescriptor =
  | { kind: "stdio"; enabled: boolean }
  | {
      kind: "http";
      enabled: boolean;
      host: string | null;
      port: number | null;
      path: string | null;
      modes: { json: boolean; stateless: boolean };
    };

/**
 * High level metadata surfaced to MCP clients when they introspect the server.
 */
export interface McpInfo {
  /** Public identifier of the orchestrator. */
  server: {
    /** Human readable name of the orchestrator. */
    name: string;
    /** Semantic version of the orchestrator implementation. */
    version: string;
  };
  /** Protocol level information expected by MCP clients. */
  mcp: {
    /** Supported MCP protocol version. */
    protocol: string;
    /** Transport exposure descriptors. */
    transports: McpTransportDescriptor[];
  };
  /** Enabled feature labels derived from runtime flags. */
  features: string[];
  /** Limits applied to payloads and request processing. */
  limits: {
    /** Maximum payload size (bytes) accepted for a single MCP request. */
    maxInputBytes: number;
    /** Default server side timeout (milliseconds) applied to long ops. */
    defaultTimeoutMs: number;
  };
  /** Raw feature flag map so clients can gate calls precisely. */
  flags: Record<string, boolean>;
}

/** Tool summary surfaced by `getMcpCapabilities`. */
export interface ToolCapabilitySummary {
  /** Fully qualified tool name registered on the MCP server. */
  name: string;
  /** Concise summary of the input schema accepted by the tool. */
  inputSchemaSummary: string;
}

/**
 * Capabilities structure returned by `getMcpCapabilities`. The payload is kept
 * intentionally small so that the handshake remains lightweight while still
 * conveying the necessary discovery hints.
 */
export interface McpCapabilities {
  /** List of enabled namespaces advertised by the orchestrator. */
  namespaces: string[];
  /** Declarative summary of available tools and their expected payloads. */
  tools: ToolCapabilitySummary[];
}

/**
 * Snapshot persisted in memory so that tools can respond without having to
 * query other modules synchronously. Only plain data is stored in order to keep
 * the structure serialisable and side-effect free.
 */
export interface McpRuntimeSnapshot {
  server: { name: string; version: string; protocol: string };
  transports: {
    stdio: StdioTransportSnapshot;
    http: HttpTransportSnapshot;
  };
  features: FeatureToggles;
  timings: RuntimeTimingOptions;
  safety: ChildSafetyOptions;
  limits: { maxInputBytes: number; defaultTimeoutMs: number; maxEventHistory: number };
}

/**
 * Partial structure used when updating the runtime snapshot. Nested objects are
 * merged shallowly so callers can update only the portion that changed.
 */
export interface McpRuntimeUpdate {
  server?: Partial<McpRuntimeSnapshot["server"]>;
  transports?: {
    stdio?: Partial<StdioTransportSnapshot>;
    http?: Partial<HttpTransportSnapshot>;
  };
  features?: FeatureToggles;
  timings?: RuntimeTimingOptions;
  safety?: ChildSafetyOptions;
  limits?: Partial<McpRuntimeSnapshot["limits"]>;
}

/**
 * Default values mirroring the conservative bootstrap configuration. The snapshot reuses the exported
 * defaults so that runtime wiring and the handshake surface stay aligned without duplicating literals.
 */
const DEFAULT_RUNTIME_SNAPSHOT: McpRuntimeSnapshot = {
  server: { name: "self-codex", version: "0.0.0", protocol: "1.0" },
  transports: {
    stdio: { enabled: true },
    http: {
      enabled: false,
      host: null,
      port: null,
      path: null,
      enableJson: true,
      stateless: false,
    },
  },
  features: { ...FEATURE_FLAG_DEFAULTS },
  timings: { ...RUNTIME_TIMING_DEFAULTS },
  safety: {
    maxChildren: 16,
    memoryLimitMb: 512,
    cpuPercent: 100,
  },
  limits: {
    maxInputBytes: 512 * 1024,
    defaultTimeoutMs: RUNTIME_TIMING_DEFAULTS.defaultTimeoutMs,
    maxEventHistory: 1_000,
  },
};

/** Internal mutable reference storing the current snapshot. */
let runtimeSnapshot: McpRuntimeSnapshot = cloneSnapshot(DEFAULT_RUNTIME_SNAPSHOT);

/**
 * Creates a deep copy of the provided snapshot to prevent external mutation.
 */
function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Returns the current MCP runtime snapshot. A defensive copy is returned so
 * callers cannot accidentally mutate the internal state.
 */
export function getMcpRuntimeSnapshot(): McpRuntimeSnapshot {
  return cloneSnapshot(runtimeSnapshot);
}

/**
 * Replaces the runtime snapshot with a new value. Primarily used by tests so
 * they can restore the previous state between assertions.
 */
export function setMcpRuntimeSnapshot(next: McpRuntimeSnapshot): void {
  runtimeSnapshot = cloneSnapshot(next);
}

/**
 * Applies a partial update to the runtime snapshot. Only the provided sections
 * are updated which keeps the function lightweight for frequent calls.
 */
export function updateMcpRuntimeSnapshot(update: McpRuntimeUpdate): void {
  const next = cloneSnapshot(runtimeSnapshot);

  if (update.server) {
    next.server = { ...next.server, ...update.server };
  }

  if (update.transports?.stdio) {
    next.transports.stdio = { ...next.transports.stdio, ...update.transports.stdio };
  }

  if (update.transports?.http) {
    next.transports.http = { ...next.transports.http, ...update.transports.http };
  }

  if (update.features) {
    next.features = { ...update.features };
  }

  if (update.timings) {
    next.timings = { ...update.timings };
  }

  if (update.safety) {
    next.safety = { ...update.safety };
  }

  if (update.limits) {
    next.limits = { ...next.limits, ...update.limits };
  }

  runtimeSnapshot = next;
}

/**
 * Computes the list of namespaces that should be advertised given the current
 * feature toggles. The mapping is intentionally explicit so that future
 * modules can extend the handshake in a single location.
 */
const CAPABILITY_NAMESPACE_DEFINITIONS: Array<{
  name: string;
  feature?: keyof FeatureToggles;
}> = [
  { name: "core.jobs" },
  { name: "graph.core" },
  { name: "plan.bt", feature: "enableBT" },
  { name: "plan.reactive", feature: "enableReactiveScheduler" },
  { name: "coord.blackboard", feature: "enableBlackboard" },
  { name: "coord.stigmergy", feature: "enableStigmergy" },
  { name: "coord.contract-net", feature: "enableCNP" },
  { name: "coord.consensus", feature: "enableConsensus" },
  { name: "agents.autoscaler", feature: "enableAutoscaler" },
  { name: "agents.supervisor", feature: "enableSupervisor" },
  { name: "memory.knowledge", feature: "enableKnowledge" },
  { name: "memory.rag", feature: "enableRag" },
  { name: "memory.causal", feature: "enableCausalMemory" },
  { name: "values.guard", feature: "enableValueGuard" },
  { name: "plan.thought-graph", feature: "enableThoughtGraph" },
  { name: "tools.router", feature: "enableToolRouter" },
];

const BASE_FEATURE_LABELS = ["core"] as const;

const FEATURE_LABELS: Record<keyof FeatureToggles, string> = {
  enableBT: "plan-bt",
  enableReactiveScheduler: "plan-reactive",
  enableBlackboard: "coord-blackboard",
  enableStigmergy: "coord-stigmergy",
  enableCNP: "coord-contract-net",
  enableConsensus: "coord-consensus",
  enableAutoscaler: "agents-autoscaler",
  enableSupervisor: "agents-supervisor",
  enableKnowledge: "memory-knowledge",
  enableCausalMemory: "memory-causal",
  enableValueGuard: "values-guard",
  enableMcpIntrospection: "mcp-introspection",
  enableResources: "resources",
  enableEventsBus: "events-bus",
  enableCancellation: "cancellation",
  enableTx: "transactions",
  enableBulk: "bulk-operations",
  enableIdempotency: "idempotency",
  enableLocks: "locks",
  enableDiffPatch: "diff-patch",
  enablePlanLifecycle: "plan-lifecycle",
  enableChildOpsFine: "child-ops-fine",
  enableValuesExplain: "values-explain",
  enableRag: "memory-rag",
  enableToolRouter: "tools-router",
  enableThoughtGraph: "plan-thought-graph",
  enableAssist: "assist",
};

export interface ToolIntrospectionEntry {
  name: string;
  inputSchema?: ZodTypeAny;
  enabled: boolean;
}

type ToolIntrospectionProvider = () => ToolIntrospectionEntry[];

let toolIntrospectionProvider: ToolIntrospectionProvider | null = null;

const TOOL_FEATURE_RULES: Array<{ pattern: RegExp; features: Array<keyof FeatureToggles> }> = [
  { pattern: /^mcp_/, features: ["enableMcpIntrospection"] },
  { pattern: /^resources_/, features: ["enableResources"] },
  { pattern: /^events_/, features: ["enableEventsBus"] },
  { pattern: /^logs_tail$/, features: ["enableEventsBus"] },
  { pattern: /^plan_(status|pause|resume|dry_run)$/, features: ["enablePlanLifecycle"] },
  { pattern: /^plan_run_reactive$/, features: ["enableReactiveScheduler"] },
  { pattern: /^plan_(compile_bt|run_bt)$/, features: ["enableBT"] },
  { pattern: /^(op_cancel|plan_cancel)$/, features: ["enableCancellation"] },
  { pattern: /^tx_/, features: ["enableTx"] },
  { pattern: /^graph_(diff|patch)$/, features: ["enableDiffPatch"] },
  { pattern: /^graph_(lock|unlock)$/, features: ["enableLocks"] },
  { pattern: /^(bb_batch_set|graph_batch_mutate|child_batch_create|stig_batch)$/, features: ["enableBulk"] },
  { pattern: /^child_(spawn_codex|attach|set_role|set_limits|status)$/, features: ["enableChildOpsFine"] },
  { pattern: /^kg_suggest_plan$/, features: ["enableAssist", "enableKnowledge"] },
  { pattern: /^kg_/, features: ["enableKnowledge"] },
  { pattern: /^rag_/, features: ["enableKnowledge", "enableRag"] },
  { pattern: /^intent_route$/, features: ["enableToolRouter"] },
  { pattern: /^causal_/, features: ["enableCausalMemory"] },
  { pattern: /^values_explain$/, features: ["enableValuesExplain", "enableValueGuard"] },
  { pattern: /^values_/, features: ["enableValueGuard"] },
  { pattern: /^stig_/, features: ["enableStigmergy"] },
  { pattern: /^bb_/, features: ["enableBlackboard"] },
  { pattern: /^cnp_/, features: ["enableCNP"] },
  { pattern: /^consensus_/, features: ["enableConsensus"] },
  { pattern: /^agent_autoscale_set$/, features: ["enableAutoscaler"] },
];

/** Register a provider used to introspect tools for capability summaries. */
export function bindToolIntrospectionProvider(provider: ToolIntrospectionProvider): void {
  toolIntrospectionProvider = provider;
}

/** Reset the tool provider, primarily used in tests. */
export function resetToolIntrospectionProvider(): void {
  toolIntrospectionProvider = null;
}

function collectToolEntries(): ToolIntrospectionEntry[] {
  return toolIntrospectionProvider ? toolIntrospectionProvider() : [];
}

function computeCapabilityNamespaces(features: FeatureToggles): string[] {
  return CAPABILITY_NAMESPACE_DEFINITIONS.filter((definition) => {
    if (!definition.feature) {
      return true;
    }
    return Boolean(features[definition.feature]);
  }).map((definition) => definition.name);
}

function buildFeatureList(features: FeatureToggles): string[] {
  const labels = Object.entries(FEATURE_LABELS)
    .filter(([key]) => Boolean(features[key as keyof FeatureToggles]))
    .map(([, label]) => label);
  return [...BASE_FEATURE_LABELS, ...labels].sort();
}

function buildTransportDescriptors(transports: McpRuntimeSnapshot["transports"]): McpTransportDescriptor[] {
  return [
    { kind: "stdio", enabled: transports.stdio.enabled },
    {
      kind: "http",
      enabled: transports.http.enabled,
      host: transports.http.host,
      port: transports.http.port,
      path: transports.http.path,
      modes: { json: transports.http.enableJson, stateless: transports.http.stateless },
    },
  ];
}

function toolVisibleWithFeatures(name: string, features: FeatureToggles): boolean {
  for (const rule of TOOL_FEATURE_RULES) {
    if (rule.pattern.test(name)) {
      return rule.features.every((flag) => Boolean(features[flag]));
    }
  }
  return true;
}

function describeSchema(schema?: ZodTypeAny): { summary: string; optional: boolean } {
  if (!schema) {
    return { summary: "void", optional: false };
  }

  let current: ZodTypeAny = schema;
  let optional = false;
  let nullable = false;

  // Unwrap optional/default/effects wrappers so the summary focuses on the
  // underlying primitive or structured type.
  for (;;) {
    const typeName = current._def.typeName;
    if (typeName === z.ZodFirstPartyTypeKind.ZodOptional || typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
      optional = true;
      current = (current._def as { innerType: ZodTypeAny }).innerType;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
      nullable = true;
      current = (current._def as { innerType: ZodTypeAny }).innerType;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
      current = (current._def as { schema: ZodTypeAny }).schema;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodBranded) {
      current = (current._def as { type: ZodTypeAny }).type;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodCatch) {
      current = (current._def as { innerType: ZodTypeAny }).innerType;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodPipeline) {
      current = (current._def as { out: ZodTypeAny }).out;
      continue;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodReadonly) {
      current = (current._def as { innerType: ZodTypeAny }).innerType;
      continue;
    }
    break;
  }

  const summary = nullable ? `${summariseCoreSchema(current)}|null` : summariseCoreSchema(current);
  return { summary, optional };
}

function summariseCoreSchema(schema: ZodTypeAny): string {
  const typeName = schema._def.typeName;
  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return "string";
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return "number";
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return "boolean";
    case z.ZodFirstPartyTypeKind.ZodBigInt:
      return "bigint";
    case z.ZodFirstPartyTypeKind.ZodDate:
      return "date";
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return `literal(${JSON.stringify((schema._def as { value: unknown }).value)})`;
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return `enum(${((schema._def as { values: string[] }).values ?? []).join("|")})`;
    case z.ZodFirstPartyTypeKind.ZodNativeEnum: {
      const rawValues = (schema._def as { values: Record<string, string> | string[] }).values;
      const values = Array.isArray(rawValues) ? rawValues : Object.values(rawValues);
      return `enum(${values.join("|")})`;
    }
    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const options = (schema._def as { options: ZodTypeAny[] }).options.map((option) => describeSchema(option).summary);
      return `union[${options.sort().join(" | ")}]`;
    }
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const map = (schema._def as { optionsMap: Map<string, ZodTypeAny> }).optionsMap;
      const options = Array.from(map.values()).map((option) => describeSchema(option).summary);
      return `union[${options.sort().join(" | ")}]`;
    }
    case z.ZodFirstPartyTypeKind.ZodIntersection: {
      const defs = schema._def as { left: ZodTypeAny; right: ZodTypeAny };
      return `intersection[${describeSchema(defs.left).summary} & ${describeSchema(defs.right).summary}]`;
    }
    case z.ZodFirstPartyTypeKind.ZodTuple: {
      const tupleDef = schema._def as { items: ZodTypeAny[]; rest?: ZodTypeAny };
      const items = tupleDef.items.map((item) => describeSchema(item).summary);
      const rest = tupleDef.rest ? `, ...${describeSchema(tupleDef.rest).summary}` : "";
      return `tuple[${items.join(", ")}${rest}]`;
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const element = (schema._def as { type: ZodTypeAny }).type;
      return `array<${describeSchema(element).summary}>`;
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<Record<string, ZodTypeAny>>).shape;
      const keys = Object.keys(shape).sort();
      const entries = keys.map((key) => {
        const descriptor = describeSchema(shape[key]);
        return `${key}${descriptor.optional ? "?" : ""}:${descriptor.summary}`;
      });
      return `object{${entries.join(", ")}}`;
    }
    case z.ZodFirstPartyTypeKind.ZodRecord: {
      const recordDef = schema._def as { keyType: ZodTypeAny; valueType: ZodTypeAny };
      return `record<${describeSchema(recordDef.keyType).summary}, ${describeSchema(recordDef.valueType).summary}>`;
    }
    case z.ZodFirstPartyTypeKind.ZodMap: {
      const mapDef = schema._def as { keyType: ZodTypeAny; valueType: ZodTypeAny };
      return `map<${describeSchema(mapDef.keyType).summary}, ${describeSchema(mapDef.valueType).summary}>`;
    }
    case z.ZodFirstPartyTypeKind.ZodSet: {
      const valueType = (schema._def as { valueType: ZodTypeAny }).valueType;
      return `set<${describeSchema(valueType).summary}>`;
    }
    case z.ZodFirstPartyTypeKind.ZodPromise: {
      const valueType = (schema._def as { type: ZodTypeAny }).type;
      return `promise<${describeSchema(valueType).summary}>`;
    }
    case z.ZodFirstPartyTypeKind.ZodLazy:
      return "lazy";
    case z.ZodFirstPartyTypeKind.ZodAny:
      return "any";
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      return "unknown";
    case z.ZodFirstPartyTypeKind.ZodVoid:
      return "void";
    case z.ZodFirstPartyTypeKind.ZodNever:
      return "never";
    case z.ZodFirstPartyTypeKind.ZodUndefined:
      return "undefined";
    case z.ZodFirstPartyTypeKind.ZodNull:
      return "null";
    case z.ZodFirstPartyTypeKind.ZodNaN:
      return "nan";
    default:
      return typeName.replace(/^Zod/, "").toLowerCase();
  }
}

function summariseInputSchema(schema?: ZodTypeAny): string {
  return describeSchema(schema).summary;
}

/**
 * Returns the current MCP information payload mirrored by the `mcp_info` tool.
 */
export function getMcpInfo(): McpInfo {
  const snapshot = getMcpRuntimeSnapshot();
  return {
    server: { name: snapshot.server.name, version: snapshot.server.version },
    mcp: {
      protocol: snapshot.server.protocol,
      transports: buildTransportDescriptors(snapshot.transports),
    },
    features: buildFeatureList(snapshot.features),
    limits: {
      maxInputBytes: snapshot.limits.maxInputBytes,
      defaultTimeoutMs: snapshot.timings.defaultTimeoutMs ?? snapshot.limits.defaultTimeoutMs,
    },
    flags: { ...snapshot.features },
  };
}

/**
 * Returns the capability listing derived from the runtime snapshot. The
 * function recomputes namespaces on the fly to ensure feature toggles are
 * honoured.
 */
export function getMcpCapabilities(): McpCapabilities {
  const snapshot = getMcpRuntimeSnapshot();
  const namespaces = computeCapabilityNamespaces(snapshot.features);
  const tools = collectToolEntries()
    .filter((entry) => entry.enabled)
    .filter((entry) => toolVisibleWithFeatures(entry.name, snapshot.features))
    .map((entry) => ({ name: entry.name, inputSchemaSummary: summariseInputSchema(entry.inputSchema) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { namespaces, tools };
}
