/** Default values mirroring the conservative bootstrap configuration. */
const DEFAULT_RUNTIME_SNAPSHOT = {
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
        heartbeatIntervalMs: 2_000,
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
let runtimeSnapshot = cloneSnapshot(DEFAULT_RUNTIME_SNAPSHOT);
/**
 * Creates a deep copy of the provided snapshot to prevent external mutation.
 */
function cloneSnapshot(value) {
    return JSON.parse(JSON.stringify(value));
}
/**
 * Returns the current MCP runtime snapshot. A defensive copy is returned so
 * callers cannot accidentally mutate the internal state.
 */
export function getMcpRuntimeSnapshot() {
    return cloneSnapshot(runtimeSnapshot);
}
/**
 * Replaces the runtime snapshot with a new value. Primarily used by tests so
 * they can restore the previous state between assertions.
 */
export function setMcpRuntimeSnapshot(next) {
    runtimeSnapshot = cloneSnapshot(next);
}
/**
 * Applies a partial update to the runtime snapshot. Only the provided sections
 * are updated which keeps the function lightweight for frequent calls.
 */
export function updateMcpRuntimeSnapshot(update) {
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
function computeCapabilityNamespaces(features) {
    const definitions = [
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
function buildSchemaSummaries(namespaces) {
    const summaries = {};
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
export function getMcpInfo() {
    return cloneSnapshot(runtimeSnapshot);
}
/**
 * Returns the capability listing derived from the runtime snapshot. The
 * function recomputes namespaces on the fly to ensure feature toggles are
 * honoured.
 */
export function getMcpCapabilities() {
    const namespaces = computeCapabilityNamespaces(runtimeSnapshot.features);
    return {
        namespaces,
        schemas: buildSchemaSummaries(namespaces),
        limits: { maxEventHistory: runtimeSnapshot.limits.maxEventHistory },
    };
}
