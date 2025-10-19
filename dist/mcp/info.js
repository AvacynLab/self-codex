import { z } from "zod";
import { FEATURE_FLAG_DEFAULTS, RUNTIME_TIMING_DEFAULTS, } from "../serverOptions.js";
/**
 * Default values mirroring the conservative bootstrap configuration. The snapshot reuses the exported
 * defaults so that runtime wiring and the handshake surface stay aligned without duplicating literals.
 */
const DEFAULT_RUNTIME_SNAPSHOT = {
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
const CAPABILITY_NAMESPACE_DEFINITIONS = [
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
const BASE_FEATURE_LABELS = ["core"];
const FEATURE_LABELS = {
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
let toolIntrospectionProvider = null;
const TOOL_FEATURE_RULES = [
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
export function bindToolIntrospectionProvider(provider) {
    toolIntrospectionProvider = provider;
}
/** Reset the tool provider, primarily used in tests. */
export function resetToolIntrospectionProvider() {
    toolIntrospectionProvider = null;
}
function collectToolEntries() {
    return toolIntrospectionProvider ? toolIntrospectionProvider() : [];
}
function computeCapabilityNamespaces(features) {
    return CAPABILITY_NAMESPACE_DEFINITIONS.filter((definition) => {
        if (!definition.feature) {
            return true;
        }
        return Boolean(features[definition.feature]);
    }).map((definition) => definition.name);
}
function buildFeatureList(features) {
    const labels = Object.entries(FEATURE_LABELS)
        .filter(([key]) => Boolean(features[key]))
        .map(([, label]) => label);
    return [...BASE_FEATURE_LABELS, ...labels].sort();
}
function buildTransportDescriptors(transports) {
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
function toolVisibleWithFeatures(name, features) {
    for (const rule of TOOL_FEATURE_RULES) {
        if (rule.pattern.test(name)) {
            return rule.features.every((flag) => Boolean(features[flag]));
        }
    }
    return true;
}
function describeSchema(schema) {
    if (!schema) {
        return { summary: "void", optional: false };
    }
    let current = schema;
    let optional = false;
    let nullable = false;
    // Unwrap optional/default/effects wrappers so the summary focuses on the
    // underlying primitive or structured type.
    for (;;) {
        const typeName = current._def.typeName;
        if (typeName === z.ZodFirstPartyTypeKind.ZodOptional || typeName === z.ZodFirstPartyTypeKind.ZodDefault) {
            optional = true;
            current = current._def.innerType;
            continue;
        }
        if (typeName === z.ZodFirstPartyTypeKind.ZodNullable) {
            nullable = true;
            current = current._def.innerType;
            continue;
        }
        if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
            current = current._def.schema;
            continue;
        }
        if (typeName === z.ZodFirstPartyTypeKind.ZodBranded) {
            current = current._def.type;
            continue;
        }
        if (typeName === z.ZodFirstPartyTypeKind.ZodCatch) {
            current = current._def.innerType;
            continue;
        }
        if (typeName === z.ZodFirstPartyTypeKind.ZodPipeline) {
            current = current._def.out;
            continue;
        }
        if (typeName === z.ZodFirstPartyTypeKind.ZodReadonly) {
            current = current._def.innerType;
            continue;
        }
        break;
    }
    const summary = nullable ? `${summariseCoreSchema(current)}|null` : summariseCoreSchema(current);
    return { summary, optional };
}
function summariseCoreSchema(schema) {
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
            return `literal(${JSON.stringify(schema._def.value)})`;
        case z.ZodFirstPartyTypeKind.ZodEnum:
            return `enum(${(schema._def.values ?? []).join("|")})`;
        case z.ZodFirstPartyTypeKind.ZodNativeEnum: {
            const rawValues = schema._def.values;
            const values = Array.isArray(rawValues) ? rawValues : Object.values(rawValues);
            return `enum(${values.join("|")})`;
        }
        case z.ZodFirstPartyTypeKind.ZodUnion: {
            const options = schema._def.options.map((option) => describeSchema(option).summary);
            return `union[${options.sort().join(" | ")}]`;
        }
        case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
            const map = schema._def.optionsMap;
            const options = Array.from(map.values()).map((option) => describeSchema(option).summary);
            return `union[${options.sort().join(" | ")}]`;
        }
        case z.ZodFirstPartyTypeKind.ZodIntersection: {
            const defs = schema._def;
            return `intersection[${describeSchema(defs.left).summary} & ${describeSchema(defs.right).summary}]`;
        }
        case z.ZodFirstPartyTypeKind.ZodTuple: {
            const tupleDef = schema._def;
            const items = tupleDef.items.map((item) => describeSchema(item).summary);
            const rest = tupleDef.rest ? `, ...${describeSchema(tupleDef.rest).summary}` : "";
            return `tuple[${items.join(", ")}${rest}]`;
        }
        case z.ZodFirstPartyTypeKind.ZodArray: {
            const element = schema._def.type;
            return `array<${describeSchema(element).summary}>`;
        }
        case z.ZodFirstPartyTypeKind.ZodObject: {
            const shape = schema.shape;
            const keys = Object.keys(shape).sort();
            const entries = keys.map((key) => {
                const descriptor = describeSchema(shape[key]);
                return `${key}${descriptor.optional ? "?" : ""}:${descriptor.summary}`;
            });
            return `object{${entries.join(", ")}}`;
        }
        case z.ZodFirstPartyTypeKind.ZodRecord: {
            const recordDef = schema._def;
            return `record<${describeSchema(recordDef.keyType).summary}, ${describeSchema(recordDef.valueType).summary}>`;
        }
        case z.ZodFirstPartyTypeKind.ZodMap: {
            const mapDef = schema._def;
            return `map<${describeSchema(mapDef.keyType).summary}, ${describeSchema(mapDef.valueType).summary}>`;
        }
        case z.ZodFirstPartyTypeKind.ZodSet: {
            const valueType = schema._def.valueType;
            return `set<${describeSchema(valueType).summary}>`;
        }
        case z.ZodFirstPartyTypeKind.ZodPromise: {
            const valueType = schema._def.type;
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
function summariseInputSchema(schema) {
    return describeSchema(schema).summary;
}
/**
 * Returns the current MCP information payload mirrored by the `mcp_info` tool.
 */
export function getMcpInfo() {
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
export function getMcpCapabilities() {
    const snapshot = getMcpRuntimeSnapshot();
    const namespaces = computeCapabilityNamespaces(snapshot.features);
    const tools = collectToolEntries()
        .filter((entry) => entry.enabled)
        .filter((entry) => toolVisibleWithFeatures(entry.name, snapshot.features))
        .map((entry) => ({ name: entry.name, inputSchemaSummary: summariseInputSchema(entry.inputSchema) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return { namespaces, tools };
}
//# sourceMappingURL=info.js.map