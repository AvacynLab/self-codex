import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  payload?: unknown;
}

export interface LoggerOptions {
  readonly logFile?: string | null;
}

/**
 * Structured logger that emits JSON lines on stdout and optionally mirrors them
 * to a file. File writes are queued sequentially to guarantee ordering.
 */
export class StructuredLogger {
  private readonly logFile?: string;
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
}
