import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Default placeholder inserted when a secret token is redacted. */
const REDACTION_TOKEN = "[REDACTED]";

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
}

/** Phases covered by the cognitive logging helpers. */
export type CognitiveLogPhase = "prompt" | "resume" | "score";

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

  constructor(options: LoggerOptions = {}) {
    this.logFile = options.logFile ?? undefined;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
    this.maxFileCount = Math.max(1, options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT);
    this.redactSecrets = options.redactSecrets ? [...options.redactSecrets] : [];
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
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(payload !== undefined ? { payload } : {})
    };
    const line = `${JSON.stringify(entry)}\n`;
    process.stdout.write(line);
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
      const err = error as NodeJS.ErrnoException;
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
        const err = error as NodeJS.ErrnoException;
        if (err?.code !== "ENOENT") {
          throw error;
        }
      }
    }

    try {
      await rename(this.logFile, `${this.logFile}.1`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}
