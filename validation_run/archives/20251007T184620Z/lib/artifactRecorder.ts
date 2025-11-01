import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';

/**
 * Enumerates the log levels used by the validation harness. The levels mirror
 * conventional application logging semantics so that the resulting artefacts
 * remain easy to scan manually or to ingest in external tooling.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Represents the absolute paths of the artefacts generated while recording a
 * single MCP tool invocation. Keeping the paths explicit makes it easier for
 * callers to cross-link the evidence in the final report.
 */
export interface ToolCallArtefacts {
  /** Absolute path of the JSON payload written under `inputs/`. */
  readonly inputPath: string;
  /** Absolute path of the JSON response written under `outputs/`. */
  readonly outputPath: string;
}

/**
 * Options accepted by {@link ArtifactRecorder.recordToolInput}. The trace
 * identifier is optional: when omitted, the recorder relies on the
 * {@link RunContext.createTraceId} generator to produce a deterministic value.
 */
export interface RecordToolInputOptions {
  /** Name of the MCP tool being exercised. */
  readonly toolName: string;
  /** Payload that will be forwarded to the MCP tool. */
  readonly payload: unknown;
  /** Optional trace identifier to reuse across retries. */
  readonly traceId?: string;
}

/**
 * Options accepted by {@link ArtifactRecorder.recordToolOutput}. The method
 * expects a trace identifier that matches the earlier call to
 * {@link ArtifactRecorder.recordToolInput} to guarantee a stable mapping.
 */
export interface RecordToolOutputOptions {
  /** Name of the MCP tool that produced the response. */
  readonly toolName: string;
  /** Payload returned by the MCP tool. */
  readonly payload: unknown;
  /** Trace identifier shared with the corresponding input payload. */
  readonly traceId: string;
}

/**
 * Options accepted by {@link ArtifactRecorder.appendEvent}. Each event is
 * appended as an individual JSON line in a file associated to the trace.
 */
export interface AppendEventOptions {
  /** Trace identifier of the call the event belongs to. */
  readonly traceId: string;
  /** Event payload captured from the MCP server. */
  readonly event: unknown;
}

/**
 * Options accepted by {@link ArtifactRecorder.appendLogEntry}. The optional
 * trace identifier lets the log entry be correlated with a specific call when
 * relevant. Free-form contextual data can be attached through the `details`
 * property.
 */
export interface AppendLogOptions {
  /** Severity level associated with the log line. */
  readonly level: LogLevel;
  /** Human readable message that summarises the log entry. */
  readonly message: string;
  /** Optional trace identifier to correlate the log with a tool call. */
  readonly traceId?: string;
  /** Optional structured payload providing additional context. */
  readonly details?: Record<string, unknown> | undefined;
}

/**
 * Provides deterministic helpers for writing MCP validation artefacts to disk.
 * The recorder produces predictable file names so that the report can reference
 * them without ambiguity. It also takes care of serialising the data with a
 * human-friendly indentation to facilitate manual inspections.
 */
export class ArtifactRecorder {
  private readonly context: RunContext;
  private readonly now: () => Date;
  private invocationCounter = 0;
  private readonly prefixByTrace = new Map<string, string>();

  constructor(context: RunContext, options: { readonly clock?: () => Date } = {}) {
    this.context = context;
    this.now = options.clock ?? (() => new Date());
  }

  /**
   * Records the payload that will be sent to an MCP tool. The method returns
   * both the trace identifier used for the call and the path of the generated
   * JSON artefact under `inputs/`.
   */
  async recordToolInput(options: RecordToolInputOptions): Promise<{ traceId: string; inputPath: string }> {
    const traceId = options.traceId ?? this.context.createTraceId();
    const filePrefix = this.computeFilePrefix(options.toolName, traceId);
    this.prefixByTrace.set(traceId, filePrefix);
    const inputPath = path.join(this.context.directories.inputs, `${filePrefix}-input.json`);

    await this.writeJsonFile(inputPath, {
      traceId,
      toolName: options.toolName,
      recordedAt: this.now().toISOString(),
      payload: options.payload,
    });

    return { traceId, inputPath };
  }

  /**
   * Records the payload returned by an MCP tool. The JSON file stored under
   * `outputs/` mirrors the structure used for inputs so that diffs remain easy
   * to visualise.
   */
  async recordToolOutput(options: RecordToolOutputOptions): Promise<ToolCallArtefacts> {
    const filePrefix = this.prefixByTrace.get(options.traceId) ?? this.computeFilePrefix(options.toolName, options.traceId);
    this.prefixByTrace.set(options.traceId, filePrefix);
    const outputPath = path.join(this.context.directories.outputs, `${filePrefix}-output.json`);

    await this.writeJsonFile(outputPath, {
      traceId: options.traceId,
      toolName: options.toolName,
      recordedAt: this.now().toISOString(),
      payload: options.payload,
    });

    return {
      inputPath: path.join(this.context.directories.inputs, `${filePrefix}-input.json`),
      outputPath,
    };
  }

  /**
   * Appends an event payload to the JSON Lines file associated with the trace
   * identifier. The resulting artefact can be streamed in real time, making it
   * suitable for tailing while long running operations are in progress.
   */
  async appendEvent(options: AppendEventOptions): Promise<string> {
    const eventPath = path.join(this.context.directories.events, `${options.traceId}.jsonl`);

    await this.appendJsonLine(eventPath, {
      traceId: options.traceId,
      observedAt: this.now().toISOString(),
      event: options.event,
    });

    return eventPath;
  }

  /**
   * Appends a structured log entry to the run-wide log file. The method uses a
   * JSON Lines representation to keep the artefact both machine and human
   * friendly.
   */
  async appendLogEntry(options: AppendLogOptions): Promise<string> {
    const logPath = path.join(this.context.directories.logs, 'run.log');

    await this.appendJsonLine(logPath, {
      timestamp: this.now().toISOString(),
      level: options.level,
      message: options.message,
      traceId: options.traceId,
      details: options.details,
    });

    return logPath;
  }

  /** Generates a deterministic file prefix combining timestamp, counter and tool name. */
  private computeFilePrefix(toolName: string, traceId: string): string {
    this.invocationCounter += 1;
    const timestamp = this.now().toISOString().replace(/[:.]/g, '-');
    const sanitizedTool = this.sanitizeSegment(toolName);
    const suffix = traceId.replace(/[^a-zA-Z0-9_-]/g, '-');

    return `${timestamp}-${this.invocationCounter.toString().padStart(4, '0')}-${sanitizedTool}-${suffix}`;
  }

  /** Serialises the provided value as pretty-printed JSON into the target file. */
  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    const json = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(filePath, json, 'utf8');
  }

  /** Appends a JSON line representation of the value to the target file. */
  private async appendJsonLine(filePath: string, value: unknown): Promise<void> {
    const jsonLine = `${JSON.stringify(value)}\n`;
    await appendFile(filePath, jsonLine, 'utf8');
  }

  /** Sanitises a file path segment by replacing disallowed characters. */
  private sanitizeSegment(segment: string): string {
    return segment
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-');
  }
}

