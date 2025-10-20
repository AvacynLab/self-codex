import { StructuredLogger, type LogLevel } from "../../src/logger.js";

/**
 * Lightweight logger tailored for tests that need to observe structured
 * entries without polluting stdout. The class subclasses the production
 * {@link StructuredLogger} so it exposes the exact same surface area while
 * capturing the relevant calls in memory for assertions.
 */
export class RecordingLogger extends StructuredLogger {
  /** Entries emitted via `debug`/`info`/`warn`/`error` during the test. */
  public readonly entries: Array<{ level: LogLevel; message: string; payload?: unknown }> = [];

  constructor() {
    // The parent logger accepts `logFile: null`, preventing any attempt to
    // touch the filesystem. Automatic redaction is also disabled so the tests
    // can inspect the payloads exactly as they were emitted.
    super({ logFile: null, redactionEnabled: false });
  }

  private record(level: LogLevel, message: string, payload?: unknown): void {
    this.entries.push({ level, message, payload });
  }

  override debug(message: string, payload?: unknown): void {
    this.record("debug", message, payload);
  }

  override info(message: string, payload?: unknown): void {
    this.record("info", message, payload);
  }

  override warn(message: string, payload?: unknown): void {
    this.record("warn", message, payload);
  }

  override error(message: string, payload?: unknown): void {
    this.record("error", message, payload);
  }
}
