import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  server,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from '../../../../src/server.js';
import type { FeatureToggles } from '../../../../src/serverOptions.js';
import type { RunContext } from './runContext.js';
import { ArtifactRecorder, type ToolCallArtefacts } from './artifactRecorder.js';

/**
 * Describes the options accepted when establishing an MCP validation session.
 * The harness operates in-process and therefore only requires a run context,
 * an artefact recorder and, optionally, feature overrides to activate gated
 * tools during the discovery stages.
 */
export interface McpSessionOptions {
  /** Validation run context providing directories and trace generator. */
  readonly context: RunContext;
  /** Recorder used to persist structured artefacts produced by the harness. */
  readonly recorder: ArtifactRecorder;
  /** Optional semantic name surfaced during the MCP handshake. */
  readonly clientName?: string;
  /** Optional semantic version surfaced during the MCP handshake. */
  readonly clientVersion?: string;
  /** Optional feature overrides toggled for the lifetime of the session. */
  readonly featureOverrides?: Partial<FeatureToggles>;
}

/**
 * Snapshot describing a single tool invocation. The structure exposes the raw
 * MCP response together with metadata that simplifies downstream reporting and
 * troubleshooting of failed calls.
 */
export interface ToolCallRecord {
  /** Trace identifier correlating artefacts, logs and events. */
  readonly traceId: string;
  /** Fully qualified tool name exercised by the harness. */
  readonly toolName: string;
  /** JSON artefact paths generated for the call input/output payloads. */
  readonly artefacts: ToolCallArtefacts;
  /** Raw MCP response returned by the server. */
  readonly response: Awaited<ReturnType<Client['callTool']>>;
  /** Wall-clock duration (milliseconds) spent waiting for the response. */
  readonly durationMs: number;
}

/**
 * Error raised when the MCP client fails to obtain a response. The exception
 * surfaces the captured artefact paths so operators can inspect the payloads
 * even when the server rejects the request at the transport level.
 */
export class McpToolCallError extends Error {
  /** Trace identifier correlated with the failing request. */
  public readonly traceId: string;
  /** Name of the tool that triggered the failure. */
  public readonly toolName: string;
  /** Duration elapsed before the failure was observed. */
  public readonly durationMs: number;
  /** Artefacts persisted for the failed call (input + output snapshot). */
  public readonly artefacts: ToolCallArtefacts;
  /** Original error raised by the MCP SDK or server implementation. */
  public readonly cause: unknown;

  constructor(message: string, details: {
    readonly traceId: string;
    readonly toolName: string;
    readonly durationMs: number;
    readonly artefacts: ToolCallArtefacts;
    readonly cause: unknown;
  }) {
    super(message);
    this.name = 'McpToolCallError';
    this.traceId = details.traceId;
    this.toolName = details.toolName;
    this.durationMs = details.durationMs;
    this.artefacts = details.artefacts;
    this.cause = details.cause;
  }
}

/**
 * Lightweight harness that spins up an in-memory MCP client connected to the
 * orchestrator. The session automatically toggles the required runtime features
 * and restores the initial configuration once all calls complete.
 */
export class McpSession {
  private readonly context: RunContext;
  private readonly recorder: ArtifactRecorder;
  private readonly clientInfo: { name: string; version: string };
  private readonly featureOverrides: Partial<FeatureToggles>;

  private client: Client | null = null;
  private baselineFeatures: FeatureToggles | null = null;

  constructor(options: McpSessionOptions) {
    this.context = options.context;
    this.recorder = options.recorder;
    this.clientInfo = {
      name: options.clientName ?? 'validation-harness',
      version: options.clientVersion ?? '0.0.0-audit',
    };
    this.featureOverrides = options.featureOverrides ?? {};
  }

  /** Returns the underlying MCP client. Throws when the session is not open. */
  private getClient(): Client {
    if (!this.client) {
      throw new Error('MCP session is not connected');
    }
    return this.client;
  }

  /**
   * Opens the MCP session by connecting the orchestrator to an in-memory
   * transport. Feature overrides are applied lazily so tests can customise the
   * environment without mutating global state before the connection occurs.
   */
  async open(): Promise<void> {
    if (this.client) {
      return;
    }

    this.baselineFeatures = getRuntimeFeatures();
    const nextFeatures = { ...this.baselineFeatures, ...this.featureOverrides };
    configureRuntimeFeatures(nextFeatures);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.close().catch(() => {});
    await server.connect(serverTransport);

    this.client = new Client({
      name: this.clientInfo.name,
      version: this.clientInfo.version,
    });
    await this.client.connect(clientTransport);
  }

  /**
   * Closes the MCP session and restores the runtime feature toggles captured at
   * startup. The helper is idempotent so repeated invocations remain safe.
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    await server.close().catch(() => {});
    if (this.baselineFeatures) {
      configureRuntimeFeatures(this.baselineFeatures);
      this.baselineFeatures = null;
    }
  }

  /**
   * Executes a single MCP tool call while recording deterministic artefacts and
   * structured logs. The helper always writes an output snapshot, even when the
   * SDK throws, so operators can inspect the captured error payloads.
   */
  async callTool(toolName: string, payload: unknown): Promise<ToolCallRecord> {
    const client = this.getClient();
    const startedAt = process.hrtime.bigint();
    const { traceId, inputPath } = await this.recorder.recordToolInput({
      toolName,
      payload,
    });

    try {
      const response = await client.callTool({ name: toolName, arguments: payload });
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const artefacts = await this.recorder.recordToolOutput({
        toolName,
        traceId,
        payload: response,
      });
      await this.recorder.appendLogEntry({
        level: response.isError ? 'warn' : 'info',
        message: 'tool_call_completed',
        traceId,
        details: {
          tool: toolName,
          duration_ms: durationMs,
          input_path: inputPath,
          output_path: artefacts.outputPath,
          is_error: response.isError ?? false,
        },
      });

      return {
        traceId,
        toolName,
        artefacts,
        response,
        durationMs,
      };
    } catch (error: unknown) {
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
      });
      await this.recorder.appendLogEntry({
        level: 'error',
        message: 'tool_call_failed',
        traceId,
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
}

