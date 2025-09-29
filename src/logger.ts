import { appendFile } from "node:fs/promises";

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
          await appendFile(this.logFile!, line, "utf8");
        } catch (err) {
          const errorEntry: LogEntry = {
            timestamp: new Date().toISOString(),
            level: "error",
            message: "log_file_write_failed",
            payload: err instanceof Error ? { message: err.message } : { error: String(err) }
          };
          process.stderr.write(`${JSON.stringify(errorEntry)}\n`);
        }
      })
      .catch(() => {
        // Errors already reported; reset queue to avoid unhandled rejections.
        this.writeQueue = Promise.resolve();
      });
  }
}
