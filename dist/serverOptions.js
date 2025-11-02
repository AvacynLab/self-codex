import { randomUUID } from "node:crypto";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
import { readOptionalEnum, readOptionalInt } from "./config/env.js";
const DEFAULT_SEARCH_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Immutable defaults applied to every feature flag. Exported so tests and
 * introspection helpers can share a single source of truth when reporting the
 * orchestrator capabilities.
 */
export const FEATURE_FLAG_DEFAULTS = Object.freeze({
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
    enableRag: false,
    enableToolRouter: false,
    enableThoughtGraph: false,
    enableAssist: false,
});
/**
 * Immutable defaults for timing related configuration. Shared with tests to
 * guarantee that adjustments preserve the documented baseline pacing.
 */
export const RUNTIME_TIMING_DEFAULTS = Object.freeze({
    btTickMs: 50,
    stigHalfLifeMs: 30_000,
    supervisorStallTicks: 6,
    defaultTimeoutMs: 60_000,
    autoscaleCooldownMs: 10_000,
    heartbeatIntervalMs: 2_000,
});
const FLAG_WITH_VALUE = new Set([
    "--http-port",
    "--http-host",
    "--http-path",
    "--max-event-history",
    "--log-file",
    "--parallelism",
    "--child-idle-sec",
    "--child-timeout-sec",
    "--max-children",
    "--child-memory-mb",
    "--child-cpu-percent",
    "--quality-threshold",
    "--bt-tick-ms",
    "--stig-half-life-ms",
    "--supervisor-stall-ticks",
    "--default-timeout-ms",
    "--autoscale-cooldown-ms",
    "--heartbeat-interval-ms",
    "--dashboard-port",
    "--dashboard-host",
    "--dashboard-interval-ms",
]);
/**
 * Ensures a provided numeric string can be converted to a positive integer.
 */
function parsePositiveInteger(value, flag) {
    const num = Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
        throw new Error(`La valeur ${value} pour ${flag} doit être un entier positif.`);
    }
    return num;
}
function parseQualityThreshold(value, flag) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0 || num > 100) {
        throw new Error(`La valeur ${value} pour ${flag} doit être comprise entre 0 et 100.`);
    }
    return Math.round(num);
}
/**
 * Parses the dashboard streaming interval. We accept positive integers and
 * enforce a sane minimum to avoid overwhelming clients.
 */
function parseDashboardInterval(value, flag) {
    const parsed = parsePositiveInteger(value, flag);
    return Math.max(250, parsed);
}
/**
 * Parses the heartbeat interval and enforces a conservative lower bound so the
 * orchestrator continues emitting periodic events without overwhelming
 * observers.
 */
function parseHeartbeatInterval(value, flag) {
    const parsed = parsePositiveInteger(value, flag);
    return Math.max(250, parsed);
}
/**
 * Normalises an HTTP path ensuring it is absolute and non-empty.
 */
function normalizeHttpPath(raw) {
    const cleaned = raw.trim();
    if (!cleaned.length) {
        throw new Error("Le chemin HTTP ne peut pas être vide.");
    }
    if (!cleaned.startsWith("/")) {
        return `/${cleaned}`;
    }
    return cleaned;
}
/**
 * Default runtime configuration used before CLI flags are processed.
 */
const DEFAULT_STATE = {
    enableStdio: true,
    httpEnabled: false,
    httpPort: 4000,
    httpHost: "0.0.0.0",
    httpPath: "/mcp",
    httpEnableJson: false,
    httpStateless: false,
    dashboardEnabled: false,
    dashboardPort: 4100,
    dashboardHost: "127.0.0.1",
    dashboardIntervalMs: 2_000,
    maxEventHistory: 5000,
    logFile: null,
    parallelism: 2,
    childIdleSec: 120,
    childTimeoutSec: 900,
    enableReflection: true,
    qualityGateEnabled: true,
    qualityThreshold: 70,
    featureToggles: { ...FEATURE_FLAG_DEFAULTS },
    timings: { ...RUNTIME_TIMING_DEFAULTS },
    safety: {
        maxChildren: 16,
        memoryLimitMb: 512,
        cpuPercent: 100,
    },
};
/**
 * Parses CLI arguments in order to determine how the orchestrator must expose
 * its transports. The function accepts raw `process.argv.slice(2)` content and
 * returns a structured object that can directly be consumed by the runtime.
 */
export function parseOrchestratorRuntimeOptions(argv) {
    const state = {
        ...DEFAULT_STATE,
        featureToggles: { ...DEFAULT_STATE.featureToggles },
        timings: { ...DEFAULT_STATE.timings },
        safety: { ...DEFAULT_STATE.safety },
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (!arg.startsWith("--")) {
            continue;
        }
        const [flag, inlineValue] = arg.split("=", 2);
        const expectsValue = FLAG_WITH_VALUE.has(flag);
        let value = inlineValue;
        if (expectsValue && (value === undefined || value === "")) {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith("--")) {
                throw new Error(`Le flag ${flag} requiert une valeur.`);
            }
            value = next;
            index += 1;
        }
        switch (flag) {
            case "--no-stdio":
                state.enableStdio = false;
                break;
            case "--http-port":
                state.httpPort = parsePositiveInteger(value ?? "", flag);
                state.httpEnabled = true;
                break;
            case "--http-host":
                state.httpHost = (value ?? "").trim();
                if (!state.httpHost.length) {
                    throw new Error("L'hôte HTTP ne peut pas être vide.");
                }
                state.httpEnabled = true;
                break;
            case "--http-path":
                state.httpPath = normalizeHttpPath(value ?? "");
                state.httpEnabled = true;
                break;
            case "--http-json":
                state.httpEnableJson = true;
                state.httpEnabled = true;
                break;
            case "--http-stateless":
                state.httpStateless = true;
                state.httpEnabled = true;
                break;
            case "--http":
                state.httpEnabled = true;
                break;
            case "--dashboard":
                state.dashboardEnabled = true;
                break;
            case "--dashboard-port":
                state.dashboardPort = parsePositiveInteger(value ?? "", flag);
                state.dashboardEnabled = true;
                break;
            case "--dashboard-host": {
                const rawHost = (value ?? "").trim();
                if (!rawHost.length) {
                    throw new Error("L'hôte du dashboard ne peut pas être vide.");
                }
                state.dashboardHost = rawHost;
                state.dashboardEnabled = true;
                break;
            }
            case "--dashboard-interval-ms":
                state.dashboardIntervalMs = parseDashboardInterval(value ?? "", flag);
                state.dashboardEnabled = true;
                break;
            case "--max-event-history":
                state.maxEventHistory = parsePositiveInteger(value ?? "", flag);
                break;
            case "--log-file": {
                const raw = (value ?? "").trim();
                if (!raw.length) {
                    throw new Error("Le chemin du fichier de log ne peut pas être vide.");
                }
                state.logFile = raw;
                break;
            }
            case "--parallelism":
                state.parallelism = parsePositiveInteger(value ?? "", flag);
                break;
            case "--child-idle-sec":
                state.childIdleSec = parsePositiveInteger(value ?? "", flag);
                break;
            case "--child-timeout-sec":
                state.childTimeoutSec = parsePositiveInteger(value ?? "", flag);
                break;
            case "--max-children":
                state.safety.maxChildren = parsePositiveInteger(value ?? "", flag);
                break;
            case "--child-memory-mb":
                state.safety.memoryLimitMb = parsePositiveInteger(value ?? "", flag);
                break;
            case "--child-cpu-percent": {
                const parsedCpu = parsePositiveInteger(value ?? "", flag);
                state.safety.cpuPercent = Math.min(100, Math.max(1, parsedCpu));
                break;
            }
            case "--no-reflection":
                state.enableReflection = false;
                break;
            case "--reflection":
                state.enableReflection = true;
                break;
            case "--no-quality-gate":
                state.qualityGateEnabled = false;
                break;
            case "--quality-gate":
                state.qualityGateEnabled = true;
                break;
            case "--quality-threshold":
                state.qualityThreshold = parseQualityThreshold(value ?? "", flag);
                state.qualityGateEnabled = true;
                break;
            case "--enable-bt":
                state.featureToggles.enableBT = true;
                break;
            case "--disable-bt":
                state.featureToggles.enableBT = false;
                break;
            case "--enable-reactive-scheduler":
                state.featureToggles.enableReactiveScheduler = true;
                break;
            case "--disable-reactive-scheduler":
                state.featureToggles.enableReactiveScheduler = false;
                break;
            case "--enable-blackboard":
                state.featureToggles.enableBlackboard = true;
                break;
            case "--disable-blackboard":
                state.featureToggles.enableBlackboard = false;
                break;
            case "--enable-stigmergy":
                state.featureToggles.enableStigmergy = true;
                break;
            case "--disable-stigmergy":
                state.featureToggles.enableStigmergy = false;
                break;
            case "--enable-cnp":
                state.featureToggles.enableCNP = true;
                break;
            case "--disable-cnp":
                state.featureToggles.enableCNP = false;
                break;
            case "--enable-consensus":
                state.featureToggles.enableConsensus = true;
                break;
            case "--disable-consensus":
                state.featureToggles.enableConsensus = false;
                break;
            case "--enable-autoscaler":
                state.featureToggles.enableAutoscaler = true;
                break;
            case "--disable-autoscaler":
                state.featureToggles.enableAutoscaler = false;
                break;
            case "--enable-supervisor":
                state.featureToggles.enableSupervisor = true;
                break;
            case "--disable-supervisor":
                state.featureToggles.enableSupervisor = false;
                break;
            case "--enable-knowledge":
                state.featureToggles.enableKnowledge = true;
                break;
            case "--disable-knowledge":
                state.featureToggles.enableKnowledge = false;
                break;
            case "--enable-causal-memory":
                state.featureToggles.enableCausalMemory = true;
                break;
            case "--disable-causal-memory":
                state.featureToggles.enableCausalMemory = false;
                break;
            case "--enable-value-guard":
                state.featureToggles.enableValueGuard = true;
                break;
            case "--disable-value-guard":
                state.featureToggles.enableValueGuard = false;
                break;
            case "--enable-mcp-introspection":
                state.featureToggles.enableMcpIntrospection = true;
                break;
            case "--disable-mcp-introspection":
                state.featureToggles.enableMcpIntrospection = false;
                break;
            case "--enable-resources":
                state.featureToggles.enableResources = true;
                break;
            case "--disable-resources":
                state.featureToggles.enableResources = false;
                break;
            case "--enable-events-bus":
                state.featureToggles.enableEventsBus = true;
                break;
            case "--disable-events-bus":
                state.featureToggles.enableEventsBus = false;
                break;
            case "--enable-cancellation":
                state.featureToggles.enableCancellation = true;
                break;
            case "--disable-cancellation":
                state.featureToggles.enableCancellation = false;
                break;
            case "--enable-tx":
                state.featureToggles.enableTx = true;
                break;
            case "--disable-tx":
                state.featureToggles.enableTx = false;
                break;
            case "--enable-bulk":
                state.featureToggles.enableBulk = true;
                break;
            case "--disable-bulk":
                state.featureToggles.enableBulk = false;
                break;
            case "--enable-idempotency":
                state.featureToggles.enableIdempotency = true;
                break;
            case "--disable-idempotency":
                state.featureToggles.enableIdempotency = false;
                break;
            case "--enable-locks":
                state.featureToggles.enableLocks = true;
                break;
            case "--disable-locks":
                state.featureToggles.enableLocks = false;
                break;
            case "--enable-diff-patch":
                state.featureToggles.enableDiffPatch = true;
                break;
            case "--disable-diff-patch":
                state.featureToggles.enableDiffPatch = false;
                break;
            case "--enable-plan-lifecycle":
                state.featureToggles.enablePlanLifecycle = true;
                break;
            case "--disable-plan-lifecycle":
                state.featureToggles.enablePlanLifecycle = false;
                break;
            case "--enable-child-ops-fine":
                state.featureToggles.enableChildOpsFine = true;
                break;
            case "--disable-child-ops-fine":
                state.featureToggles.enableChildOpsFine = false;
                break;
            case "--enable-values-explain":
                state.featureToggles.enableValuesExplain = true;
                break;
            case "--disable-values-explain":
                state.featureToggles.enableValuesExplain = false;
                break;
            case "--enable-rag":
                state.featureToggles.enableRag = true;
                break;
            case "--disable-rag":
                state.featureToggles.enableRag = false;
                break;
            case "--enable-tool-router":
                state.featureToggles.enableToolRouter = true;
                break;
            case "--disable-tool-router":
                state.featureToggles.enableToolRouter = false;
                break;
            case "--enable-thought-graph":
                state.featureToggles.enableThoughtGraph = true;
                break;
            case "--disable-thought-graph":
                state.featureToggles.enableThoughtGraph = false;
                break;
            case "--enable-assist":
                state.featureToggles.enableAssist = true;
                break;
            case "--disable-assist":
                state.featureToggles.enableAssist = false;
                break;
            case "--bt-tick-ms":
                state.timings.btTickMs = parsePositiveInteger(value ?? "", flag);
                break;
            case "--stig-half-life-ms":
                state.timings.stigHalfLifeMs = parsePositiveInteger(value ?? "", flag);
                break;
            case "--supervisor-stall-ticks":
                state.timings.supervisorStallTicks = parsePositiveInteger(value ?? "", flag);
                break;
            case "--default-timeout-ms":
                state.timings.defaultTimeoutMs = parsePositiveInteger(value ?? "", flag);
                break;
            case "--autoscale-cooldown-ms":
                state.timings.autoscaleCooldownMs = parsePositiveInteger(value ?? "", flag);
                break;
            case "--heartbeat-interval-ms":
                state.timings.heartbeatIntervalMs = parseHeartbeatInterval(value ?? "", flag);
                break;
            default:
                // Ignore unknown flags so the orchestrator remains permissive for
                // future arguments handled elsewhere.
                break;
        }
    }
    return {
        enableStdio: state.enableStdio,
        http: {
            enabled: state.httpEnabled,
            port: state.httpPort,
            host: state.httpHost,
            path: state.httpPath,
            enableJson: state.httpEnableJson,
            stateless: state.httpStateless,
        },
        dashboard: {
            enabled: state.dashboardEnabled,
            port: state.dashboardPort,
            host: state.dashboardHost,
            streamIntervalMs: state.dashboardIntervalMs,
        },
        maxEventHistory: state.maxEventHistory,
        logFile: state.logFile,
        parallelism: state.parallelism,
        childIdleSec: state.childIdleSec,
        childTimeoutSec: state.childTimeoutSec,
        enableReflection: state.enableReflection,
        enableQualityGate: state.qualityGateEnabled,
        qualityThreshold: state.qualityThreshold,
        features: { ...state.featureToggles },
        timings: { ...state.timings },
        safety: { ...state.safety },
    };
}
/** Reads the persistence configuration for the search job store from env vars. */
export function loadSearchJobStoreOptions() {
    const mode = readOptionalEnum("MCP_SEARCH_STATUS_PERSIST", ["memory", "file"]) ?? "file";
    const ttlOverride = readOptionalInt("MCP_SEARCH_JOB_TTL_MS", { min: 60_000 });
    const journalFsync = readOptionalEnum("MCP_SEARCH_JOURNAL_FSYNC", ["always", "interval", "never"]) ?? "interval";
    return {
        mode,
        jobTtlMs: ttlOverride ?? DEFAULT_SEARCH_JOB_TTL_MS,
        journalFsync,
    };
}
/**
 * Generates an identifier suitable for Streamable HTTP sessions. Exposed to
 * keep session generation logic centralised and testable.
 */
export function createHttpSessionId() {
    return randomUUID();
}
//# sourceMappingURL=serverOptions.js.map