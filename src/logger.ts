import { Buffer } from "node:buffer";
import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ErrnoException } from "./nodePrimitives.js";
import { getJsonRpcContext } from "./infra/jsonRpcContext.js";
import { getActiveTraceContext, type TraceContextSnapshot } from "./infra/tracing.js";
import type { JsonRpcRouteContext } from "./infra/runtime.js";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/** Default placeholder inserted when a secret token is redacted. */
const REDACTION_TOKEN = "[REDACTED]";

/** Accepted directives enabling custom secret redaction. */
const REDACTION_ENABLE_TOKENS = new Set(["on", "true", "yes", "1", "enable", "enabled"]);

/** Directives explicitly disabling secret redaction despite configured tokens. */
const REDACTION_DISABLE_TOKENS = new Set(["off", "false", "no", "0", "disable", "disabled"]);

interface CorrelationFields {
  request_id?: string | number | null;
  trace_id?: string | null;
  child_id?: string | null;
  method?: string;
  duration_ms?: number;
  bytes_in?: number;
  bytes_out?: number;
  transport?: string | null;
}

/** Keys whose values are redacted when `MCP_LOG_REDACT=on`. */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "cookie",
  "set-cookie",
]);

/**
 * Parses the `MCP_LOG_REDACT` environment variable so operators can both
 * toggle redaction and provide a list of sensitive substrings that must be
 * scrubbed from persisted artefacts. The helper accepts comma-separated
 * directives such as `"on,sk-"` or `"off"` and defaults to enabling
 * redaction when custom patterns are provided without an explicit toggle.
 */
export function parseRedactionDirectives(raw: string | undefined): {
  enabled: boolean;
  tokens: Array<string>;
} {
  if (!raw) {
    return { enabled: false, tokens: [] };
  }

  const directives = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (directives.length === 0) {
    return { enabled: false, tokens: [] };
  }

  let enabled: boolean | undefined;
  const tokens: Array<string> = [];

  for (const directive of directives) {
    const normalised = directive.toLowerCase();
    if (REDACTION_DISABLE_TOKENS.has(normalised)) {
      enabled = false;
      continue;
    }
    if (REDACTION_ENABLE_TOKENS.has(normalised)) {
      enabled = true;
      continue;
    }
    tokens.push(directive);
  }

  if (enabled === undefined) {
    enabled = tokens.length > 0;
  }

  // Deduplicate tokens while preserving insertion order. Operators occasionally
  // repeat the same pattern (for example when composing shell snippets) and we
  // do not want to spend time applying the same replacement multiple times.
  const uniqueTokens = Array.from(new Set(tokens));

  return { enabled, tokens: uniqueTokens };
}

/**
 * Default maximum size (in bytes) of the primary log file before a rotation is
 * triggered. The value intentionally stays modest to keep artefacts light when
 * the orchestrator is embedded in constrained environments.
 */
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MiB

/** Default number of historical log files retained during rotation. */
const DEFAULT_MAX_FILE_COUNT = 5;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  payload?: unknown;
  request_id?: string | number | null;
  trace_id?: string | null;
  child_id?: string | null;
  method?: string | null;
  duration_ms?: number | null;
  bytes_in?: number | null;
  bytes_out?: number | null;
}

export interface LoggerOptions {
  readonly logFile?: string | null;
  /** Maximum size in bytes before the active log file is rotated. */
  readonly maxFileSizeBytes?: number;
  /** Number of historical log files to retain (including the active one). */
  readonly maxFileCount?: number;
  /**
   * Collection of tokens or regular expressions that must be redacted from log
   * entries. The feature is used primarily by {@link logCognitive} to ensure
   * sensitive prompts stay confidential in persisted artefacts.
   */
  readonly redactSecrets?: Array<string | RegExp>;
  /**
   * Explicit toggle for structured payload redaction. When omitted, the logger
   * falls back to {@link parseRedactionDirectives} to keep behaviour consistent
   * with the `MCP_LOG_REDACT` environment variable.
   */
  readonly redactionEnabled?: boolean;
  /** Optional listener invoked every time an entry is emitted. */
  readonly onEntry?: (entry: LogEntry) => void;
}

/** Phases covered by the cognitive logging helpers. */
export type CognitiveLogPhase = "prompt" | "resume" | "score" | "learn";

/**
 * Shape describing a cognitive log event, i.e. a high-level reasoning artefact
 * produced while orchestrating children. Events stay intentionally concise so
 * they can be safely mirrored to JSONL files without leaking excessive data.
 */
export interface CognitiveLogEvent {
  /** Identifier of the child runtime involved in the exchange, if any. */
  childId?: string;
  /** Actor producing the artefact (orchestrator, child, critic, ...). */
  actor: string;
  /** Phase of the reasoning cycle covered by the event. */
  phase: CognitiveLogPhase;
  /** Optional textual content (prompt excerpt, response snippet, ...). */
  content?: string | null;
  /** Optional numeric score associated with the event. */
  score?: number | null;
  /** Additional structured metadata used for audits. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Structured logger that emits JSON lines on stdout and optionally mirrors them
 * to a file. File writes are queued sequentially to guarantee ordering.
 */
export class StructuredLogger {
  private readonly logFile?: string;
  private readonly maxFileSizeBytes?: number;
  private readonly maxFileCount: number;
  private readonly redactSecrets: Array<string | RegExp>;
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * Tracks whether the directory containing {@link logFile} has already been
   * created. This avoids performing an expensive `mkdir` call for every log
   * entry while still ensuring that relative destinations such as
   * `./tmp/orchestrator.log` work even when the `tmp/` folder is missing.
   */
  private logDirectoryReady = false;
  /** Optional listener invoked with the structured entry. */
  private readonly entryListener?: (entry: LogEntry) => void;
  /** Whether automatic header redaction is enabled via environment variable. */
  private readonly redactionEnabled: boolean;

  constructor(options: LoggerOptions = {}) {
    this.logFile = options.logFile ?? undefined;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    this.maxFileCount = Math.max(1, options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT);
    const directives = parseRedactionDirectives(process.env.MCP_LOG_REDACT);
    const combined = new Set<string | RegExp>(directives.tokens);
    if (options.redactSecrets) {
      for (const entry of options.redactSecrets) {
        combined.add(entry);
      }
    }
    this.redactSecrets = [...combined];
    this.entryListener = options.onEntry;
    this.redactionEnabled = options.redactionEnabled ?? directives.enabled;
  }

  info(message: string, payload?: unknown): void {
    this.log("info", message, payload);
  }

  warn(message: string, payload?: unknown): void {
    this.log("warn", message, payload);
  }

  error(message: string, payload?: unknown): void {
    this.log("error", message, payload);
  }

  debug(message: string, payload?: unknown): void {
    this.log("debug", message, payload);
  }

  /**
   * Records a cognitive log entry covering prompts, resumes or scores. Content
   * is sanitised to avoid leaking raw secrets while keeping artefacts useful
   * for audits. The entry is emitted at `info` level to align with other
   * high-level events recorded by the orchestrator.
   */
  logCognitive(event: CognitiveLogEvent): void {
    const payload = {
      actor: event.actor,
      child_id: event.childId ?? null,
      phase: event.phase,
      score: event.score ?? null,
      metadata: event.metadata ?? undefined,
      excerpt: event.content ? this.truncateAndRedact(String(event.content)) : undefined,
    };

    this.log("info", "cognitive_event", payload);
  }

  private async ensureLogDestination(): Promise<void> {
    if (!this.logFile || this.logDirectoryReady) {
      return;
    }

    const directory = dirname(this.logFile);
    try {
      await mkdir(directory, { recursive: true });
      this.logDirectoryReady = true;
    } catch (error) {
      const errorEntry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "error",
        message: "log_directory_create_failed",
        payload: {
          directory,
          error: error instanceof Error ? { message: error.message } : { message: String(error) },
        },
      };
      process.stderr.write(`${JSON.stringify(errorEntry)}\n`);
      throw error;
    }
  }

  private log(level: LogLevel, message: string, payload?: unknown): void {
    const trace = getActiveTraceContext();
    const rpcContext = getJsonRpcContext();
    const correlation = this.collectCorrelationFields(trace, rpcContext);
    const enrichedPayload =
      payload !== undefined ? this.enrichPayload(payload, trace, rpcContext) : undefined;
    const safePayload =
      enrichedPayload !== undefined ? this.redactStructuredValue(enrichedPayload) : undefined;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(correlation.request_id !== undefined ? { request_id: correlation.request_id } : {}),
      ...(correlation.trace_id !== undefined ? { trace_id: correlation.trace_id } : {}),
      ...(correlation.child_id !== undefined ? { child_id: correlation.child_id } : {}),
      ...(correlation.method !== undefined ? { method: correlation.method } : {}),
      ...(correlation.duration_ms !== undefined ? { duration_ms: correlation.duration_ms } : {}),
      ...(correlation.bytes_in !== undefined ? { bytes_in: correlation.bytes_in } : {}),
      ...(correlation.bytes_out !== undefined ? { bytes_out: correlation.bytes_out } : {}),
      ...(safePayload !== undefined ? { payload: safePayload } : {}),
    };
    const line = `${JSON.stringify(entry)}\n`;
    process.stdout.write(line);
    if (this.entryListener) {
      this.entryListener(structuredClone(entry));
    }
    if (!this.logFile) {
      return;
    }
    this.writeQueue = this.writeQueue
      .then(async () => {
        try {
          await this.ensureLogDestination();
          await this.rotateIfNeeded(Buffer.byteLength(line, "utf8"));
          await appendFile(this.logFile!, line, "utf8");
        } catch (err) {
          const errorEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: "error",
            message: "log_file_write_failed",
            payload: err instanceof Error ? { message: err.message } : { error: String(err) }
          };
          process.stderr.write(`${JSON.stringify(errorEntry)}\n`);
          // Allow future attempts to retry directory creation after a failure.
          this.logDirectoryReady = false;
        }
      })
      .catch(() => {
        // Errors already reported; reset queue to avoid unhandled rejections.
        this.writeQueue = Promise.resolve();
      });
  }

  /**
   * Waits for all pending log writes to be flushed. Tests rely on this helper
   * to deterministically assert the content of mirrored log files.
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  /**
   * Applies secret redaction and truncation to cognitive excerpts. The helper
   * keeps log entries lightweight while ensuring repeatable output in tests.
   */
  private truncateAndRedact(value: string): string {
    let sanitized = value;
    for (const pattern of this.redactSecrets) {
      if (typeof pattern === "string" && pattern.length > 0) {
        sanitized = sanitized.split(pattern).join(REDACTION_TOKEN);
      } else if (pattern instanceof RegExp) {
        sanitized = sanitized.replace(pattern, REDACTION_TOKEN);
      }
    }

    const limit = 1_024;
    if (sanitized.length <= limit) {
      return sanitized;
    }
    return `${sanitized.slice(0, limit)}…`;
  }

  /**
   * Rotates the active log file when appending the provided payload would
   * exceed the configured size limit. Rotation keeps at most
   * {@link maxFileCount} historical files alongside the active one.
   */
  private async rotateIfNeeded(pendingBytes: number): Promise<void> {
    if (!this.logFile || !this.maxFileSizeBytes) {
      return;
    }

    let currentSize = 0;
    try {
      const stats = await stat(this.logFile);
      currentSize = stats.size;
    } catch (error) {
      const err = error as ErrnoException;
      if (err?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    if (currentSize + pendingBytes <= this.maxFileSizeBytes) {
      return;
    }

    try {
      await this.performRotation();
    } catch (error) {
      const errEntry: LogEntry = {
        timestamp: new Date().toISOString(),
        level: "error",
        message: "log_file_rotation_failed",
        payload: error instanceof Error ? { message: error.message } : { error: String(error) },
      };
      process.stderr.write(`${JSON.stringify(errEntry)}\n`);
    }
  }

  /** Executes the rotation sequence while honouring {@link maxFileCount}. */
  private async performRotation(): Promise<void> {
    if (!this.logFile) {
      return;
    }

    const keep = Math.max(1, this.maxFileCount);
    if (keep === 1) {
      await rm(this.logFile, { force: true });
      return;
    }

    const oldest = `${this.logFile}.${keep - 1}`;
    await rm(oldest, { force: true });

    for (let index = keep - 2; index >= 1; index -= 1) {
      const source = `${this.logFile}.${index}`;
      const target = `${this.logFile}.${index + 1}`;
      try {
        await rename(source, target);
      } catch (error) {
        const err = error as ErrnoException;
        if (err?.code !== "ENOENT") {
          throw error;
        }
      }
    }

    try {
      await rename(this.logFile, `${this.logFile}.1`);
    } catch (error) {
      const err = error as ErrnoException;
      if (err?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  /**
   * Enriches structured payloads with the correlation details exposed by the
   * JSON-RPC and tracing contexts. The helper keeps user-provided metadata
   * intact while filling gaps such as `trace_id`, `request_id` or `bytes_out`.
   */
  private enrichPayload(
    payload: unknown,
    trace: TraceContextSnapshot | undefined,
    rpcContext: JsonRpcRouteContext | undefined,
  ): unknown {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return payload;
    }

    const enriched: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
    if (trace) {
      if (enriched.trace_id === undefined) {
        enriched.trace_id = trace.traceId;
      }
      if (enriched.span_id === undefined) {
        enriched.span_id = trace.spanId;
      }
      if (enriched.method === undefined && trace.method) {
        enriched.method = trace.method;
      }
      if (enriched.request_id === undefined && trace.requestId !== null) {
        enriched.request_id = trace.requestId;
      }
      if (enriched.child_id === undefined && trace.childId) {
        enriched.child_id = trace.childId;
      }
      const duration = this.normaliseMetric(trace.durationMs);
      if (enriched.duration_ms === undefined && duration !== null) {
        enriched.duration_ms = duration;
      }
      const bytesIn = this.normaliseMetric(trace.bytesIn);
      if (enriched.bytes_in === undefined && bytesIn !== null) {
        enriched.bytes_in = bytesIn;
      }
      const bytesOut = this.normaliseMetric(trace.bytesOut);
      if (enriched.bytes_out === undefined && bytesOut !== null) {
        enriched.bytes_out = bytesOut;
      }
    }

    if (rpcContext) {
      if (enriched.request_id === undefined && rpcContext.requestId !== undefined) {
        enriched.request_id = rpcContext.requestId ?? null;
      }
      if (enriched.child_id === undefined && rpcContext.childId !== undefined) {
        enriched.child_id = rpcContext.childId ?? null;
      }
      if (enriched.transport === undefined && rpcContext.transport !== undefined) {
        enriched.transport = rpcContext.transport ?? null;
      }
    }

    return enriched;
  }

  private collectCorrelationFields(
    trace: TraceContextSnapshot | undefined,
    rpcContext: JsonRpcRouteContext | undefined,
  ): CorrelationFields {
    const fields: CorrelationFields = {};
    if (trace) {
      fields.trace_id = trace.traceId;
      fields.request_id = trace.requestId ?? null;
      fields.child_id = trace.childId ?? null;
      if (trace.method) {
        fields.method = trace.method;
      }
      const duration = this.normaliseMetric(trace.durationMs);
      if (duration !== null) {
        fields.duration_ms = duration;
      }
      const bytesIn = this.normaliseMetric(trace.bytesIn);
      if (bytesIn !== null) {
        fields.bytes_in = bytesIn;
      }
      const bytesOut = this.normaliseMetric(trace.bytesOut);
      if (bytesOut !== null) {
        fields.bytes_out = bytesOut;
      }
    }

    if (rpcContext) {
      if (fields.request_id === undefined && rpcContext.requestId !== undefined) {
        fields.request_id = rpcContext.requestId ?? null;
      }
      if (fields.child_id === undefined && rpcContext.childId !== undefined) {
        fields.child_id = rpcContext.childId ?? null;
      }
      if (fields.transport === undefined && rpcContext.transport !== undefined) {
        fields.transport = rpcContext.transport ?? null;
      }
    }

    return fields;
  }

  private normaliseMetric(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return Math.round(Math.max(0, value));
  }

  private redactStructuredValue<T>(value: T): T {
    if (!this.redactionEnabled) {
      return value;
    }
    return this.deepRedact(value) as T;
  }

  private deepRedact(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.deepRedact(item));
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
          result[key] = REDACTION_TOKEN;
        } else {
          result[key] = this.deepRedact(entry);
        }
      }
      return result;
    }
    return value;
  }
}
