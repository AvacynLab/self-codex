import { format } from "node:util";

import { StructuredLogger } from "../logger.js";

/**
 * Structured representation of a console-style log entry emitted by validation
 * stage CLIs. Collecting these entries allows tests to assert on the formatted
 * content without scraping stdout.
 */
export interface CliLogEntry {
  /** Identifier describing the validation stage emitting the entry. */
  readonly stage: string;
  /** Severity level matching the underlying {@link StructuredLogger} call. */
  readonly level: "info" | "warn" | "error";
  /** Human-readable text generated from the original console arguments. */
  readonly text: string;
  /** Raw arguments forwarded by the CLI before formatting. */
  readonly raw: readonly unknown[];
}

/**
 * Shape describing the structured logging utilities returned by
 * {@link createCliStructuredLogger}. Scripts receive the `console` facade to
 * preserve the existing `logger.log(...)` API while emitting structured events
 * through the shared {@link StructuredLogger} implementation.
 */
export interface CliStructuredLogger {
  /** Shared structured logger emitting JSON entries for machine consumption. */
  readonly logger: StructuredLogger;
  /** Console-like facade expected by validation CLI helpers. */
  readonly console: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** Captured entries mirroring the emitted structured events for tests. */
  readonly entries: readonly CliLogEntry[];
}

/** Message identifier attached to console bridge events. */
const CONSOLE_EVENT_MESSAGE = "validation_cli_console";

/**
 * Factory creating a structured logger wrapper for validation scripts. The
 * helper mirrors console-style calls to {@link StructuredLogger} while
 * preserving a log of formatted entries for assertions in unit tests.
 *
 * @param stage Identifier describing the validation stage (used in payloads).
 * @param options Optional override to reuse an existing {@link StructuredLogger}.
 */
export function createCliStructuredLogger(
  stage: string,
  options: { logger?: StructuredLogger } = {},
): CliStructuredLogger {
  const logger = options.logger ?? new StructuredLogger();
  const capturedEntries: CliLogEntry[] = [];

  /**
   * Emits a structured entry at the requested severity while keeping a textual
   * representation for humans. The approach ensures command-line ergonomics do
   * not regress while migrating away from `console.log`.
   */
  function emit(level: "info" | "warn" | "error", args: unknown[]): void {
    const text = format(...args);
    const entry: CliLogEntry = { stage, level, text, raw: [...args] };
    capturedEntries.push(entry);
    const payload = { stage, text };
    if (level === "error") {
      logger.error(CONSOLE_EVENT_MESSAGE, payload);
    } else if (level === "warn") {
      logger.warn(CONSOLE_EVENT_MESSAGE, payload);
    } else {
      logger.info(CONSOLE_EVENT_MESSAGE, payload);
    }
  }

  return {
    logger,
    console: {
      log: (...args: unknown[]) => emit("info", args),
      warn: (...args: unknown[]) => emit("warn", args),
      error: (...args: unknown[]) => emit("error", args),
    },
    entries: capturedEntries,
  };
}
