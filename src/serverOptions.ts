import { randomUUID } from "crypto";

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
 * Runtime configuration parsed from CLI arguments.
 */
export interface OrchestratorRuntimeOptions {
  /** Controls whether the legacy stdio transport must be enabled. */
  enableStdio: boolean;
  /** Configuration of the optional HTTP transport. */
  http: HttpRuntimeOptions;
  /** Maximum number of events retained in memory. */
  maxEventHistory: number;
  /** Optional path where JSON logs must be mirrored. */
  logFile?: string | null;
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
  maxEventHistory: number;
  logFile: string | null;
  parallelism: number;
  childIdleSec: number;
  childTimeoutSec: number;
  enableReflection: boolean;
  qualityGateEnabled: boolean;
  qualityThreshold: number;
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
  "--quality-threshold",
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
  maxEventHistory: 5000,
  logFile: null,
  parallelism: 2,
  childIdleSec: 120,
  childTimeoutSec: 900,
  enableReflection: true,
  qualityGateEnabled: true,
  qualityThreshold: 70,
};

/**
 * Parses CLI arguments in order to determine how the orchestrator must expose
 * its transports. The function accepts raw `process.argv.slice(2)` content and
 * returns a structured object that can directly be consumed by the runtime.
 */
export function parseOrchestratorRuntimeOptions(argv: string[]): OrchestratorRuntimeOptions {
  const state: ParseState = { ...DEFAULT_STATE };

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
      stateless: state.httpStateless
    },
    maxEventHistory: state.maxEventHistory,
    logFile: state.logFile,
    parallelism: state.parallelism,
    childIdleSec: state.childIdleSec,
    childTimeoutSec: state.childTimeoutSec,
    enableReflection: state.enableReflection,
    enableQualityGate: state.qualityGateEnabled,
    qualityThreshold: state.qualityThreshold,
  };
}

/**
 * Generates an identifier suitable for Streamable HTTP sessions. Exposed to
 * keep session generation logic centralised and testable.
 */
export function createHttpSessionId(): string {
  return randomUUID();
}
