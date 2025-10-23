"use strict";

/**
 * Deterministic helpers that persist MCP validation artefacts.  The recorder
 * keeps file naming stable so the final report and manual audits can cross-link
 * inputs, outputs, events and log entries using trace identifiers.
 */
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Default MIME type recorded for validation artefacts surfaced via resources. */
const VALIDATION_MIME = "application/json";

/**
 * @typedef {{
 *   runId: string,
 *   rootDir: string,
 *   directories: {
 *     inputs: string,
 *     outputs: string,
 *     events: string,
 *     logs: string,
 *     artifacts: string,
 *     report: string,
 *   },
 *   createTraceId: () => string,
 * }} RunContext
 */

/**
 * Recorder generating deterministic file names for tool inputs/outputs, JSONL
 * event streams and structured logs.
 */
export class ArtifactRecorder {
  /**
   * @param {RunContext} context validation run context describing directories.
   * @param {{
   *   clock?: () => Date,
   *   resourceRegistry?: { registerValidationArtifact: (input: any) => string },
   *   logger?: { warn?: (...args: unknown[]) => void },
   * }=} options injectable wall clock and optional validation registry bridge.
   */
  constructor(context, options = {}) {
    this.context = context;
    this.clock = options.clock ?? (() => new Date());
    this.invocationCounter = 0;
    this.prefixByTrace = new Map();
    this.phaseEventCounters = new Map();
    this.phaseEventBuffers = new Map();
    this.logEntries = [];
    this.resourceRegistry = options.resourceRegistry ?? null;
    this.logger = options.logger ?? console;
    this.jsonlStatistics = new Map();
  }

  /** Records the payload that will be sent to an MCP tool. */
  async recordToolInput({ toolName, payload, traceId, phaseId }) {
    const resolvedTraceId = traceId ?? this.context.createTraceId();
    const descriptor = this.#createFileDescriptor(toolName, resolvedTraceId);
    this.prefixByTrace.set(resolvedTraceId, descriptor);
    const inputName = `${descriptor.prefix}-input.json`;
    const inputPath = join(this.context.directories.inputs, inputName);

    const recordedAt = this.clock();
    await this.#writeJsonFile(inputPath, {
      traceId: resolvedTraceId,
      toolName,
      recordedAt: recordedAt.toISOString(),
      payload,
    });

    this.#registerValidationArtifact({
      artifactType: "inputs",
      name: inputName,
      phaseId,
      data: {
        traceId: resolvedTraceId,
        toolName,
        payload,
      },
      metadata: {
        tool: toolName,
        trace_id: resolvedTraceId,
        call_index: descriptor.callIndex,
        role: "input",
      },
      recordedAt,
    });

    return { traceId: resolvedTraceId, inputPath };
  }

  /**
   * Records the payload returned by an MCP tool and mirrors the snapshot into
   * the resource registry so validation campaigns expose deterministic
   * evidence.
   */
  async recordToolOutput({ toolName, payload, traceId, phaseId, metadata }) {
    const descriptor = this.prefixByTrace.get(traceId) ?? this.#createFileDescriptor(toolName, traceId);
    this.prefixByTrace.set(traceId, descriptor);
    const outputName = `${descriptor.prefix}-output.json`;
    const outputPath = join(this.context.directories.outputs, outputName);

    const recordedAt = this.clock();
    await this.#writeJsonFile(outputPath, {
      traceId,
      toolName,
      recordedAt: recordedAt.toISOString(),
      payload,
    });

    this.#registerValidationArtifact({
      artifactType: "outputs",
      name: outputName,
      phaseId,
      data: {
        traceId,
        toolName,
        payload,
      },
      metadata: {
        tool: toolName,
        trace_id: traceId,
        call_index: descriptor.callIndex,
        role: "output",
        ...(metadata ?? {}),
      },
      recordedAt,
    });

    return {
      inputPath: join(this.context.directories.inputs, `${descriptor.prefix}-input.json`),
      outputPath,
    };
  }

  /** Appends an event payload to the trace-specific JSONL file. */
  async appendEvent({ traceId, event }) {
    const eventPath = join(this.context.directories.events, `${traceId}.jsonl`);
    await this.#appendJsonLine(eventPath, {
      traceId,
      observedAt: this.clock().toISOString(),
      event,
    });
    return eventPath;
  }

  /**
   * Appends an event emitted while running a campaign phase. The helper keeps a
   * strictly monotonic counter per phase so JSONL consumers can assert ordering
   * without inspecting the underlying MCP payload.
   */
  async appendPhaseEvent({ phaseId, traceId, event }) {
    const sanitizedPhase = this.#sanitize(phaseId ?? "phase");
    const phasePath = join(this.context.directories.events, `${sanitizedPhase}.jsonl`);
    const counter = (this.phaseEventCounters.get(sanitizedPhase) ?? 0) + 1;
    this.phaseEventCounters.set(sanitizedPhase, counter);

    await this.#appendJsonLine(phasePath, {
      phaseId: sanitizedPhase,
      sequence: counter,
      observedAt: this.clock().toISOString(),
      traceId: traceId ?? null,
      event,
    });

    const buffer = this.phaseEventBuffers.get(sanitizedPhase) ?? [];
    buffer.push({ sequence: counter, traceId: traceId ?? null, event: this.#clone(event) });
    this.phaseEventBuffers.set(sanitizedPhase, buffer);

    this.#registerValidationArtifact({
      artifactType: "events",
      name: `${sanitizedPhase}.jsonl`,
      phaseId: sanitizedPhase,
      data: { phaseId: sanitizedPhase, events: buffer },
      metadata: {
        phase: sanitizedPhase,
        event_count: buffer.length,
        latest_sequence: counter,
      },
    });

    return phasePath;
  }

  /**
   * Appends a structured log entry to the run log JSONL file while tracking the
   * in-memory representation so the registry can expose the campaign log as a
   * validation artefact.
   */
  async appendLogEntry({ level, message, traceId, details, phaseId }) {
    const logPath = join(this.context.directories.logs, "run.log");
    const timestamp = this.clock().toISOString();
    const entry = {
      timestamp,
      level,
      message,
      traceId: traceId ?? null,
      details: details ?? null,
      phase: phaseId ?? null,
    };
    await this.#appendJsonLine(logPath, entry);

    this.logEntries.push(this.#clone(entry));
    this.#registerValidationArtifact({
      artifactType: "logs",
      name: "run.log",
      phaseId,
      data: { entries: this.logEntries },
      metadata: {
        entry_count: this.logEntries.length,
        last_level: level,
        last_message: message,
      },
    });
    return logPath;
  }

  /**
   * Persists a standalone JSON document under one of the validation directories
   * (inputs, outputs, events, logs, artifacts, report). The helper mirrors the
   * document into the resource registry so the validation viewer can expose the
   * generated artefact alongside tool call evidence.
   *
   * @param {{
   *   directory: keyof RunContext["directories"],
   *   filename: string,
   *   payload: unknown,
   *   phaseId?: string | null,
   *   metadata?: Record<string, unknown>,
   *   resourceData?: Record<string, unknown>,
   * }} options
   * @returns {Promise<string>} absolute path to the written file.
   */
  async recordJsonDocument({ directory, filename, payload, phaseId, metadata }) {
    const targetDir = this.#resolveDirectory(directory);
    const targetName = filename;
    const targetPath = join(targetDir, targetName);
    await this.#writeJsonFile(targetPath, payload);

    this.#registerValidationArtifact({
      artifactType: directory,
      name: targetName,
      phaseId,
      data: payload,
      metadata: {
        role: "document",
        ...(metadata ?? {}),
      },
    });

    return targetPath;
  }

  /**
   * Appends a JSON serialisable payload to a JSONL artefact. The method keeps a
   * counter per `(directory, filename)` pair so the associated resource entry
   * can expose a stable `entry_count` field to downstream consumers.
   *
   * @param {{
   *   directory: keyof RunContext["directories"],
   *   filename: string,
   *   payload: unknown,
   *   phaseId?: string | null,
   *   metadata?: Record<string, unknown>,
   * }} options
   * @returns {Promise<string>} absolute path to the JSONL file.
   */
  async appendJsonlArtifact({ directory, filename, payload, phaseId, metadata, resourceData }) {
    const targetDir = this.#resolveDirectory(directory);
    const targetName = filename;
    const targetPath = join(targetDir, targetName);
    await this.#appendJsonLine(targetPath, payload);

    const counterKey = `${directory}:${targetName}`;
    const nextCount = (this.jsonlStatistics.get(counterKey) ?? 0) + 1;
    this.jsonlStatistics.set(counterKey, nextCount);

    const normalisedResourceData = resourceData
      ? this.#clone(resourceData)
      : {
          entry_count: nextCount,
          last_entry: this.#clone(payload),
        };

    if (typeof normalisedResourceData.entry_count !== "number") {
      normalisedResourceData.entry_count = nextCount;
    }

    this.#registerValidationArtifact({
      artifactType: directory,
      name: targetName,
      phaseId,
      data: normalisedResourceData,
      metadata: {
        role: "jsonl",
        entry_count: nextCount,
        ...(metadata ?? {}),
      },
    });

    return targetPath;
  }

  #createFileDescriptor(toolName, traceId) {
    this.invocationCounter += 1;
    const invocationIndex = this.invocationCounter;
    const timestamp = this.clock().toISOString().replace(/[:.]/g, "-");
    const sanitizedTool = this.#sanitize(toolName);
    const suffix = this.#sanitize(traceId);
    const prefix = `${timestamp}-${String(invocationIndex).padStart(4, "0")}-${sanitizedTool}-${suffix}`;
    return { prefix, callIndex: invocationIndex };
  }

  #sanitize(segment) {
    return String(segment ?? "").replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  async #writeJsonFile(filePath, value) {
    const json = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(filePath, json, "utf8");
  }

  async #appendJsonLine(filePath, value) {
    const jsonLine = `${JSON.stringify(value)}\n`;
    await appendFile(filePath, jsonLine, "utf8");
  }

  #resolveDirectory(directory) {
    const target = this.context.directories?.[directory];
    if (!target) {
      throw new Error(`Unknown validation directory: ${directory}`);
    }
    return target;
  }

  #registerValidationArtifact({ artifactType, name, phaseId, data, metadata, recordedAt }) {
    if (!this.resourceRegistry?.registerValidationArtifact) {
      return;
    }
    try {
      // NOTE: The registry entry mirrors the artefact persisted on disk.  When
      // optional metadata is omitted by the caller we must avoid forwarding an
      // explicit `undefined` placeholder because the upcoming
      // `exactOptionalPropertyTypes` flag rejects such assignments.  Spreading a
      // conditional object keeps the payload compact while still cloning the
      // metadata object when it is concretely provided.
      const metadataPayload =
        metadata !== undefined && metadata !== null ? { ...metadata } : undefined;

      this.resourceRegistry.registerValidationArtifact({
        sessionId: this.context.runId,
        runId: this.context.runId,
        phase: phaseId ? this.#sanitize(phaseId) : null,
        artifactType,
        name,
        recordedAt: recordedAt ? recordedAt.getTime() : this.clock().getTime(),
        mime: VALIDATION_MIME,
        data: this.#clone(data),
        ...(metadataPayload !== undefined ? { metadata: metadataPayload } : {}),
      });
    } catch (error) {
      this.logger?.warn?.("validation_artifact_registration_failed", {
        artifact_type: artifactType,
        name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * @internal Testing hook allowing the suite to exercise the registry payload
   * normalisation without touching the file-system. The helper simply proxies
   * the private {@link ArtifactRecorder#registerValidationArtifact} logic.
   */
  registerArtifactForTesting(options) {
    this.#registerValidationArtifact(options);
  }

  #clone(value) {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (typeof globalThis.structuredClone === "function") {
      try {
        return globalThis.structuredClone(value);
      } catch {
        // Fall back to JSON cloning below.
      }
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}
