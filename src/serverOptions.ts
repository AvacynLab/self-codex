import { randomUUID } from "node:crypto";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/**
 * Options describing the HTTP exposure of the orchestrator. When `enabled` is
 * false the remaining attributes are ignored.
 */
export interface HttpRuntimeOptions {
  /** Should the HTTP transport be started. */
  enabled: boolean;
  /** Listening port for the HTTP server. */
  port: number;
  /** Listening host/interface for the HTTP server. */
  host: string;
  /** Endpoint path (absolute) that will process MCP HTTP calls. */
  path: string;
  /** Whether JSON responses are enabled for the streamable transport. */
  enableJson: boolean;
  /** Use a stateless mode (no session identifiers). */
  stateless: boolean;
}

/**
 * Runtime configuration exposed to operators for the monitoring dashboard. The
 * dashboard piggybacks the in-memory state of the orchestrator therefore it is
 * toggled via the CLI and shares the lifecycle of the main process.
 */
export interface DashboardRuntimeOptions {
  /** Enable the standalone dashboard HTTP server. */
  enabled: boolean;
  /** Host/interface used to bind the dashboard server. */
  host: string;
  /** Listening port for the dashboard server. */
  port: number;
  /** Interval (milliseconds) used to refresh SSE clients automatically. */
  streamIntervalMs: number;
}

/**
 * Runtime configuration parsed from CLI arguments.
 */
export interface FeatureToggles {
  /** Enable Behaviour Tree compilation and execution tools. */
  enableBT: boolean;
  /** Enable the reactive scheduler driving Behaviour Trees. */
  enableReactiveScheduler: boolean;
  /** Enable the shared blackboard coordination store. */
  enableBlackboard: boolean;
  /** Enable the stigmergic field and related coordination hooks. */
  enableStigmergy: boolean;
  /** Enable the Contract-Net protocol helpers. */
  enableCNP: boolean;
  /** Enable vote-based consensus helpers. */
  enableConsensus: boolean;
  /** Enable the autoscaler responsible for spawning children. */
  enableAutoscaler: boolean;
  /** Enable the orchestrator supervisor in charge of incident mitigation. */
  enableSupervisor: boolean;
  /** Enable the knowledge graph tooling (future module). */
  enableKnowledge: boolean;
  /** Enable the causal memory tooling (future module). */
  enableCausalMemory: boolean;
  /** Enable value guard checks filtering unsafe plans. */
  enableValueGuard: boolean;
  /** Expose MCP handshake metadata and negotiated namespaces. */
  enableMcpIntrospection: boolean;
  /** Allow listing and reading stable `sc://` resources. */
  enableResources: boolean;
  /** Publish correlated runtime events over the unified bus. */
  enableEventsBus: boolean;
  /** Honour cancellation tokens across long-running operations. */
  enableCancellation: boolean;
  /** Surface graph transactions over the MCP API. */
  enableTx: boolean;
  /** Accept atomic bulk operations across orchestration primitives. */
  enableBulk: boolean;
  /** Record and replay idempotent operations when keys match. */
  enableIdempotency: boolean;
  /** Guard concurrent graph mutation through cooperative locks. */
  enableLocks: boolean;
  /** Expose diff/patch helpers for graph evolution. */
  enableDiffPatch: boolean;
  /** Provide lifecycle plan inspection, pause and resume. */
  enablePlanLifecycle: boolean;
  /** Offer granular child runtime controls (spawn/attach/limits). */
  enableChildOpsFine: boolean;
  /** Run value graph explanations alongside dry-runs. */
  enableValuesExplain: boolean;
  /** Enable the Retrieval-Augmented Generation toolchain (ingest/query). */
  enableRag: boolean;
  /** Enable the contextual tool router and its `intent_route` façade. */
  enableToolRouter: boolean;
  /** Enable ThoughtGraph projection for multi-branch planning. */
  enableThoughtGraph: boolean;
  /** Suggest alternative fragments leveraging the knowledge graph. */
  enableAssist: boolean;
}

/**
 * Immutable defaults applied to every feature flag. Exported so tests and
 * introspection helpers can share a single source of truth when reporting the
 * orchestrator capabilities.
 */
export const FEATURE_FLAG_DEFAULTS: Readonly<FeatureToggles> = Object.freeze(
  {
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
  } satisfies FeatureToggles,
);

/** Tunable delays exposed so operators can adjust runtime pacing. */
export interface RuntimeTimingOptions {
  /** Target tick pacing for Behaviour Tree execution (milliseconds). */
  btTickMs: number;
  /** Default half-life applied when evaporating the stigmergic field. */
  stigHalfLifeMs: number;
  /** Number of scheduler ticks tolerated without progress before stalling. */
  supervisorStallTicks: number;
  /** Default timeout applied to operations lacking an explicit budget. */
  defaultTimeoutMs: number;
  /** Cooldown applied between autoscaler resize actions. */
  autoscaleCooldownMs: number;
  /** Interval (milliseconds) between orchestrator heartbeat emissions. */
  heartbeatIntervalMs: number;
}

/**
 * Immutable defaults for timing related configuration. Shared with tests to
 * guarantee that adjustments preserve the documented baseline pacing.
 */
export const RUNTIME_TIMING_DEFAULTS: Readonly<RuntimeTimingOptions> =
  Object.freeze({
    btTickMs: 50,
    stigHalfLifeMs: 30_000,
    supervisorStallTicks: 6,
    defaultTimeoutMs: 60_000,
    autoscaleCooldownMs: 10_000,
    heartbeatIntervalMs: 2_000,
  } satisfies RuntimeTimingOptions);

export interface OrchestratorRuntimeOptions {
  /** Controls whether the legacy stdio transport must be enabled. */
  enableStdio: boolean;
  /** Configuration of the optional HTTP transport. */
  http: HttpRuntimeOptions;
  /** Maximum number of events retained in memory. */
  maxEventHistory: number;
  /** Optional path where JSON logs must be mirrored. */
  logFile?: string | null;
  /** Dashboard HTTP exposure (optional). */
  dashboard: DashboardRuntimeOptions;
  /**
   * Maximum number of child runtimes that the orchestrator will execute in
   * parallel when fan-out plans are scheduled. This parameter is surfaced via
   * CLI flags so operators can adapt concurrency to the host resources.
   */
  parallelism: number;
  /**
   * Idle duration (in seconds) after which an inactive child should be
   * considered for recycling by monitoring tools.
   */
  childIdleSec: number;
  /**
   * Maximum wall clock duration (in seconds) granted to a child runtime before
   * it is forcefully terminated.
   */
  childTimeoutSec: number;
  /** Enable the self-reflection pass after each deliverable. */
  enableReflection: boolean;
  /** Enable the quality gate guarding final deliverables. */
  enableQualityGate: boolean;
  /** Threshold (0-100) below which a deliverable is flagged for revision. */
  qualityThreshold: number;
  /** Feature toggles controlling optional orchestrator modules. */
  features: FeatureToggles;
  /** Runtime pacing configuration for optional modules. */
  timings: RuntimeTimingOptions;
  /** Operational safety guardrails applied to child runtimes. */
  safety: ChildSafetyOptions;
}

/** Operational limits applied to child runtimes spawned by the orchestrator. */
export interface ChildSafetyOptions {
  /** Maximum number of concurrent child processes. */
  maxChildren: number;
  /** Memory ceiling (in megabytes) injected into child manifests. */
  memoryLimitMb: number;
  /** CPU usage ceiling (percentage) injected into child manifests. */
  cpuPercent: number;
}

/**
 * Shape used internally while parsing user provided flags.
 */
interface ParseState {
  enableStdio: boolean;
  httpEnabled: boolean;
  httpPort: number;
  httpHost: string;
  httpPath: string;
  httpEnableJson: boolean;
  httpStateless: boolean;
  dashboardEnabled: boolean;
  dashboardPort: number;
  dashboardHost: string;
  dashboardIntervalMs: number;
  maxEventHistory: number;
  logFile: string | null;
  parallelism: number;
  childIdleSec: number;
  childTimeoutSec: number;
  enableReflection: boolean;
  qualityGateEnabled: boolean;
  qualityThreshold: number;
  featureToggles: FeatureToggles;
  timings: RuntimeTimingOptions;
  safety: ChildSafetyOptions;
}

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
function parsePositiveInteger(value: string, flag: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new Error(`La valeur ${value} pour ${flag} doit être un entier positif.`);
  }
  return num;
}

function parseQualityThreshold(value: string, flag: string): number {
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
function parseDashboardInterval(value: string, flag: string): number {
  const parsed = parsePositiveInteger(value, flag);
  return Math.max(250, parsed);
}

/**
 * Parses the heartbeat interval and enforces a conservative lower bound so the
 * orchestrator continues emitting periodic events without overwhelming
 * observers.
 */
function parseHeartbeatInterval(value: string, flag: string): number {
  const parsed = parsePositiveInteger(value, flag);
  return Math.max(250, parsed);
}

/**
 * Normalises an HTTP path ensuring it is absolute and non-empty.
 */
function normalizeHttpPath(raw: string): string {
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
const DEFAULT_STATE: ParseState = {
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
export function parseOrchestratorRuntimeOptions(argv: string[]): OrchestratorRuntimeOptions {
  const state: ParseState = {
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

/**
 * Generates an identifier suitable for Streamable HTTP sessions. Exposed to
 * keep session generation logic centralised and testable.
 */
export function createHttpSessionId(): string {
  return randomUUID();
}
