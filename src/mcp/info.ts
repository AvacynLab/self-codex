import type {
  ChildSafetyOptions,
  FeatureToggles,
  RuntimeTimingOptions,
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
    /** Version of the MCP protocol supported by this server. */
    mcpVersion: string;
  };
  /** Snapshot of exposed transports (stdio / HTTP). */
  transports: {
    stdio: StdioTransportSnapshot;
    http: HttpTransportSnapshot;
  };
  /** Active feature toggles controlling optional modules. */
  features: FeatureToggles;
  /** Runtime pacing information for optional modules. */
  timings: RuntimeTimingOptions;
  /** Operational safety guardrails applied to child runtimes. */
  safety: ChildSafetyOptions;
  /** Limits applied to payloads and server side buffers. */
  limits: {
    /** Maximum payload size (bytes) accepted for a single MCP request. */
    maxInputBytes: number;
    /** Default server side timeout (milliseconds) applied to long ops. */
    defaultTimeoutMs: number;
    /** Maximum number of events retained in memory for streaming. */
    maxEventHistory: number;
  };
}

/**
 * Structure describing a namespace entry exposed to MCP clients. Namespaces
 * are tied to feature toggles so that clients can negotiate optional modules.
 */
export interface McpCapabilityNamespace {
  /** Fully qualified namespace identifier. */
  name: string;
  /** Human readable description of the namespace scope. */
  description: string;
}

/**
 * JSON serialisable description of the available schemas. The goal is not to
 * mirror Zod internals but to expose concise metadata for discovery.
 */
export interface McpSchemaSummary {
  /** Namespace owning the tool/schema. */
  namespace: string;
  /** Short summary helping clients understand the payload semantics. */
  summary: string;
}

/**
 * Capabilities structure returned by `getMcpCapabilities`. The payload is kept
 * intentionally small so that the handshake remains lightweight while still
 * conveying the necessary discovery hints.
 */
export interface McpCapabilities {
  /** List of enabled namespaces with human readable descriptions. */
  namespaces: McpCapabilityNamespace[];
  /** Mapping of namespace identifiers to schema metadata summaries. */
  schemas: Record<string, McpSchemaSummary>;
  /** Limits mirrored from the runtime snapshot (useful for pagination). */
  limits: {
    maxEventHistory: number;
  };
}

/**
 * Snapshot persisted in memory so that tools can respond without having to
 * query other modules synchronously. Only plain data is stored in order to keep
 * the structure serialisable and side-effect free.
 */
export interface McpRuntimeSnapshot {
  server: McpInfo["server"];
  transports: McpInfo["transports"];
  features: FeatureToggles;
  timings: RuntimeTimingOptions;
  safety: ChildSafetyOptions;
  limits: McpInfo["limits"];
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

/** Default values mirroring the conservative bootstrap configuration. */
const DEFAULT_RUNTIME_SNAPSHOT: McpRuntimeSnapshot = {
  server: { name: "self-codex", version: "0.0.0", mcpVersion: "1.0" },
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
  features: {
    enableBT: false,
    enableReactiveScheduler: false,
    enableBlackboard: false,
    enableStigmergy: false,
    enableCNP: false,
    enableConsensus: false,
    enableAutoscaler: false,
    enableSupervisor: false,
    enableKnowledge: false,
    enableCausalMemory: false,
    enableValueGuard: false,
    enableMcpIntrospection: false,
    enableResources: false,
    enableEventsBus: false,
    enableCancellation: false,
    enableTx: false,
    enableBulk: false,
    enableIdempotency: false,
    enableLocks: false,
    enableDiffPatch: false,
    enablePlanLifecycle: false,
    enableChildOpsFine: false,
    enableValuesExplain: false,
    enableAssist: false,
  },
  timings: {
    btTickMs: 50,
    stigHalfLifeMs: 30_000,
    supervisorStallTicks: 6,
    defaultTimeoutMs: 60_000,
    autoscaleCooldownMs: 10_000,
  },
  safety: {
    maxChildren: 16,
    memoryLimitMb: 512,
    cpuPercent: 100,
  },
  limits: {
    maxInputBytes: 512 * 1024,
    defaultTimeoutMs: 60_000,
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
function computeCapabilityNamespaces(features: FeatureToggles): McpCapabilityNamespace[] {
  const definitions: Array<{
    name: string;
    description: string;
    feature?: keyof FeatureToggles;
  }> = [
    { name: "core.jobs", description: "Gestion des jobs orchestrateur" },
    { name: "graph.core", description: "Inspection et mutations de graphes" },
    { name: "plan.bt", description: "Compilation et exécution Behaviour Tree", feature: "enableBT" },
    { name: "plan.reactive", description: "Boucle scheduler réactif", feature: "enableReactiveScheduler" },
    { name: "coord.blackboard", description: "Coordination via blackboard", feature: "enableBlackboard" },
    { name: "coord.stigmergy", description: "Champ stigmergique", feature: "enableStigmergy" },
    { name: "coord.contract-net", description: "Protocole Contract-Net", feature: "enableCNP" },
    { name: "coord.consensus", description: "Vote par consensus", feature: "enableConsensus" },
    { name: "agents.autoscaler", description: "Autoscaler d'enfants", feature: "enableAutoscaler" },
    { name: "agents.supervisor", description: "Superviseur orchestrateur", feature: "enableSupervisor" },
    { name: "memory.knowledge", description: "Graphe de connaissance", feature: "enableKnowledge" },
    { name: "memory.causal", description: "Mémoire causale", feature: "enableCausalMemory" },
    { name: "values.guard", description: "Filtre par valeurs", feature: "enableValueGuard" },
  ];

  return definitions
    .filter((definition) => {
      if (!definition.feature) {
        return true;
      }
      return Boolean(features[definition.feature]);
    })
    .map(({ name, description }) => ({ name, description }));
}

/**
 * Builds a JSON friendly summary for each namespace so clients can display the
 * available areas without having to understand the full schema definitions.
 */
function buildSchemaSummaries(namespaces: McpCapabilityNamespace[]): Record<string, McpSchemaSummary> {
  const summaries: Record<string, McpSchemaSummary> = {};
  for (const entry of namespaces) {
    summaries[entry.name] = {
      namespace: entry.name,
      summary: entry.description,
    };
  }
  return summaries;
}

/**
 * Returns the current MCP information payload mirrored by the `mcp_info` tool.
 */
export function getMcpInfo(): McpInfo {
  return cloneSnapshot(runtimeSnapshot);
}

/**
 * Returns the capability listing derived from the runtime snapshot. The
 * function recomputes namespaces on the fly to ensure feature toggles are
 * honoured.
 */
export function getMcpCapabilities(): McpCapabilities {
  const namespaces = computeCapabilityNamespaces(runtimeSnapshot.features);
  return {
    namespaces,
    schemas: buildSchemaSummaries(namespaces),
    limits: { maxEventHistory: runtimeSnapshot.limits.maxEventHistory },
  };
}
