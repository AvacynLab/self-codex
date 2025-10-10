"use strict";

/**
 * Lightweight MCP harness that connects the orchestrator to an in-memory
 * transport.  The helper records deterministic artefacts for every tool call and
 * restores runtime feature toggles once the session finishes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadServerModule } from "./server-loader.mjs";
import { ArtifactRecorder } from "./artifact-recorder.mjs";

let serverModulePromise = null;

async function getServerExports() {
  if (!serverModulePromise) {
    serverModulePromise = loadServerModule();
  }
  const module = await serverModulePromise;
  const {
    server,
    configureRuntimeFeatures,
    getRuntimeFeatures,
  } = module;
  if (!server || !configureRuntimeFeatures || !getRuntimeFeatures) {
    throw new Error(
      "The server module does not expose the expected runtime helpers",
    );
  }
  return { server, configureRuntimeFeatures, getRuntimeFeatures };
}

/**
 * Error raised when the MCP client fails to obtain a successful response.
 */
export class McpToolCallError extends Error {
  /**
   * @param {string} message human readable error message.
   * @param {{traceId:string, toolName:string, durationMs:number, artefacts:{inputPath:string, outputPath:string}, cause:unknown}} details
   */
  constructor(message, details) {
    super(message);
    this.name = "McpToolCallError";
    this.traceId = details.traceId;
    this.toolName = details.toolName;
    this.durationMs = details.durationMs;
    this.artefacts = details.artefacts;
    this.cause = details.cause;
  }
}

/**
 * Wraps an in-memory MCP client so validation scripts can exercise tools
 * without leaving the current process.
 */
export class McpSession {
  /**
   * @param {{
   *   context: { runId:string, rootDir:string, directories:{inputs:string, outputs:string, events:string, logs:string, artifacts:string, report:string}, createTraceId:() => string },
   *   recorder: ArtifactRecorder,
   *   clientName?: string,
   *   clientVersion?: string,
   *   featureOverrides?: Record<string, unknown>,
   * }} options
   */
  constructor(options) {
    this.context = options.context;
    this.recorder = options.recorder;
    this.clientName = options.clientName ?? "validation-harness";
    this.clientVersion = options.clientVersion ?? "0.0.0-campaign";
    this.featureOverrides = options.featureOverrides ?? {};
    this.client = null;
    this.baselineFeatures = null;
    this.server = null;
    this.configureRuntimeFeatures = null;
    this.getRuntimeFeatures = null;
  }

  /** Opens the in-memory transport and applies feature overrides. */
  async open() {
    if (this.client) {
      return;
    }

    const { server, configureRuntimeFeatures, getRuntimeFeatures } = await getServerExports();
    this.server = server;
    this.configureRuntimeFeatures = configureRuntimeFeatures;
    this.getRuntimeFeatures = getRuntimeFeatures;

    this.baselineFeatures = this.getRuntimeFeatures();
    const nextFeatures = { ...this.baselineFeatures, ...this.featureOverrides };
    this.configureRuntimeFeatures(nextFeatures);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await this.server.close().catch(() => {});
    await this.server.connect(serverTransport);

    this.client = new Client({ name: this.clientName, version: this.clientVersion });
    await this.client.connect(clientTransport);
  }

  /** Closes the transport and restores the original feature toggles. */
  async close() {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    if (this.server) {
      await this.server.close().catch(() => {});
      this.server = null;
    }
    if (this.baselineFeatures && this.configureRuntimeFeatures) {
      this.configureRuntimeFeatures(this.baselineFeatures);
    }
    this.baselineFeatures = null;
    this.configureRuntimeFeatures = null;
    this.getRuntimeFeatures = null;
  }

  #assertClient() {
    if (!this.client) {
      throw new Error("MCP session is not connected");
    }
    return this.client;
  }

  /**
   * Executes a single MCP tool call while recording artefacts and structured
   * logs.  Failures still produce an output snapshot so the caller can inspect
   * the captured payloads.
   *
   * @param {string} toolName
   * @param {unknown} payload
   * @param {{ phaseId?: string }=} options optional execution hints (phase association).
   * @returns {Promise<{traceId:string, toolName:string, response:any, durationMs:number, artefacts:{inputPath:string, outputPath:string}}>}
   */
  async callTool(toolName, payload, options = {}) {
    const phaseId = options?.phaseId ?? null;
    const client = this.#assertClient();
    const startedAt = process.hrtime.bigint();
    const { traceId, inputPath } = await this.recorder.recordToolInput({ toolName, payload, phaseId });

    try {
      const response = await client.callTool({ name: toolName, arguments: payload });
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const artefacts = await this.recorder.recordToolOutput({
        toolName,
        traceId,
        payload: response,
        phaseId,
        metadata: { duration_ms: durationMs },
      });
      await this.recorder.appendLogEntry({
        level: response.isError ? "warn" : "info",
        message: "tool_call_completed",
        traceId,
        phaseId,
        details: {
          tool: toolName,
          duration_ms: durationMs,
          input_path: inputPath,
          output_path: artefacts.outputPath,
          is_error: response.isError ?? false,
        },
      });

      return { traceId, toolName, response, durationMs, artefacts };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const failurePayload = {
        error: error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { message: String(error) },
      };
      const artefacts = await this.recorder.recordToolOutput({
        toolName,
        traceId,
        payload: failurePayload,
        phaseId,
        metadata: { duration_ms: durationMs, failure: true },
      });
      await this.recorder.appendLogEntry({
        level: "error",
        message: "tool_call_failed",
        traceId,
        phaseId,
        details: {
          tool: toolName,
          duration_ms: durationMs,
          input_path: inputPath,
          output_path: artefacts.outputPath,
          error: failurePayload.error,
        },
      });
      throw new McpToolCallError(`MCP tool call failed: ${toolName}`, {
        traceId,
        toolName,
        durationMs,
        artefacts,
        cause: error,
      });
    }
  }

  /**
   * Executes the `tools/list` RPC while recording deterministic artefacts.
   *
   * The operation is treated as a pseudo-tool named `rpc:tools_list` so the
   * validation campaign can reuse the existing tracing infrastructure and
   * surface the request/response pair in the findings report.
   *
   * @param {{ cursor?: string | null, limit?: number | null }=} params request arguments forwarded to the MCP client.
   * @param {{ phaseId?: string }=} options optional execution hints (phase association).
   * @returns {Promise<{traceId:string, toolName:string, response:any, durationMs:number, artefacts:{inputPath:string, outputPath:string}}>} outcome payload mirroring `callTool`.
   */
  async listTools(params = {}, options = {}) {
    const phaseId = options?.phaseId ?? null;
    const client = this.#assertClient();
    const toolName = "rpc:tools_list";
    const startedAt = process.hrtime.bigint();
    const { traceId, inputPath } = await this.recorder.recordToolInput({
      toolName,
      payload: params,
      phaseId,
    });

    try {
      const response = await client.listTools(params);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const artefacts = await this.recorder.recordToolOutput({
        toolName,
        traceId,
        payload: response,
        phaseId,
        metadata: { duration_ms: durationMs, rpc: true },
      });
      await this.recorder.appendLogEntry({
        level: "info",
        message: "rpc_call_completed",
        traceId,
        phaseId,
        details: {
          method: "tools/list",
          duration_ms: durationMs,
          input_path: inputPath,
          output_path: artefacts.outputPath,
        },
      });

      return { traceId, toolName, response, durationMs, artefacts };
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const failurePayload = {
        error: error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { message: String(error) },
      };
      const artefacts = await this.recorder.recordToolOutput({
        toolName,
        traceId,
        payload: failurePayload,
        phaseId,
        metadata: { duration_ms: durationMs, failure: true, rpc: true },
      });
      await this.recorder.appendLogEntry({
        level: "error",
        message: "rpc_call_failed",
        traceId,
        phaseId,
        details: {
          method: "tools/list",
          duration_ms: durationMs,
          input_path: inputPath,
          output_path: artefacts.outputPath,
          error: failurePayload.error,
        },
      });

      throw new McpToolCallError("MCP RPC call failed: tools/list", {
        traceId,
        toolName,
        durationMs,
        artefacts,
        cause: error,
      });
    }
  }
}
