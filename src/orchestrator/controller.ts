import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type { JsonRpcRouteContext } from "../infra/runtime.js";
import type { ToolRegistry } from "../mcp/registry.js";
import type { StructuredLogger } from "../logger.js";
import type { LogJournal } from "../monitor/log.js";
import type { EventBus } from "../events/bus.js";
import type {
  JsonRpcEventMessage,
  JsonRpcEventPayload,
  JsonRpcEventPayloadByMessage,
  JsonRpcEventSharedFields,
  JsonRpcEventStatus,
} from "../events/types.js";
import { appendWalEntry } from "../state/wal.js";
import { buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { runWithJsonRpcContext } from "../infra/jsonRpcContext.js";
import { assembleJsonRpcRuntime } from "../infra/runtime.js";
import { runtimeTimers, type IntervalHandle } from "../runtime/timers.js";
import {
  getMutableJsonRpcRequestHandlerRegistry,
  type InternalJsonRpcHandler,
} from "../mcp/jsonRpcInternals.js";
import {
  runWithRpcTrace,
  annotateTraceContext,
  registerInboundBytes,
  getActiveTraceContext,
  registerRpcError,
  registerRpcSuccess,
  deriveMetricMethodLabel,
} from "../infra/tracing.js";
import {
  createJsonRpcError,
  JsonRpcError,
  normaliseJsonRpcRequest,
  toJsonRpc,
} from "../rpc/middleware.js";
import { JsonRpcTimeoutError, resolveRpcTimeoutBudget } from "../rpc/timeouts.js";
import {
  BudgetExceededError,
  estimateTokenUsage,
  measureBudgetBytes,
  type BudgetLimits,
} from "../infra/budget.js";
import { getMcpInfo } from "../mcp/info.js";
import { evaluateToolDeprecation, logToolDeprecation } from "../mcp/deprecations.js";

export interface JsonRpcRequest {
  /** JSON-RPC protocol version, only "2.0" is supported. */
  jsonrpc: "2.0";
  /** Identifier propagated by clients so responses can be correlated. */
  id: string | number | null;
  /** Fully qualified method name (tool id or native MCP request). */
  method: string;
  /** Optional structured parameters forwarded to the handler. */
  params?: unknown;
}

export interface JsonRpcResponse {
  /** JSON-RPC protocol version echoed back to the caller. */
  jsonrpc: "2.0";
  /** Identifier copied from the request (can be null for notifications). */
  id: string | number | null;
  /** Structured result produced by the handler when the call succeeds. */
  result?: unknown;
  /** Error payload when the handler throws or rejects. */
  error?: { code: number; message: string; data?: unknown };
}

/** Immutable dependencies required to initialise the orchestrator controller. */
export interface OrchestratorControllerDependencies {
  /** Underlying MCP server exposing registered JSON-RPC handlers. */
  readonly server: McpServer;
  /** Tool registry used to resolve registrations during routing. */
  readonly toolRegistry: ToolRegistry;
  /** Structured logger capturing diagnostics and warnings. */
  readonly logger: StructuredLogger;
  /** Event bus broadcasting JSON-RPC observability envelopes. */
  readonly eventBus: EventBus;
  /** Log journal mirroring events into persistent append-only streams. */
  readonly logJournal: LogJournal;
  /** Request budget limits applied to incoming invocations. */
  readonly requestBudgetLimits: BudgetLimits;
  /** Default timeout override resolved from environment or CLI options. */
  readonly defaultTimeoutOverride: number | null;
}

/** Functions exposed by the orchestrator controller. */
export interface OrchestratorController {
  /** Routes a JSON-RPC method to the underlying MCP handler. */
  routeJsonRpcRequest(
    method: string,
    params?: unknown,
    context?: JsonRpcRouteContext,
  ): Promise<unknown>;
  /** Records WAL entries for idempotent JSON-RPC invocations. */
  maybeRecordIdempotentWalEntry(
    request: JsonRpcRequest,
    context: JsonRpcRouteContext | undefined,
    overrides?: { method?: string; toolName?: string | null },
  ): Promise<void>;
  /** Validates and executes a JSON-RPC request, returning the serialised response. */
  handleJsonRpc(request: JsonRpcRequest, context?: JsonRpcRouteContext): Promise<JsonRpcResponse>;
}

function normaliseJsonRpcInvocation(method: string, params: unknown): { method: string; params?: unknown } {
  const trimmed = method.trim();
  if (trimmed.includes("/")) {
    return { method: trimmed, params };
  }

  const toolArgs =
    params && typeof params === "object" && params !== null ? { ...(params as Record<string, unknown>) } : {};
  return {
    method: "tools/call",
    params: { name: trimmed, arguments: toolArgs },
  };
}

function injectIdempotencyKey(method: string, params: unknown, key: string): unknown {
  if (!key || typeof key !== "string") {
    return params;
  }

  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }

  if (method === "tools/call") {
    const payload = params as { arguments?: unknown };
    if (!payload.arguments || typeof payload.arguments !== "object" || Array.isArray(payload.arguments)) {
      return params;
    }

    const args = payload.arguments as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(args, "idempotency_key")) {
      return params;
    }

    return {
      ...payload,
      arguments: { ...args, idempotency_key: key },
    };
  }

  const record = params as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "idempotency_key")) {
    return params;
  }

  return { ...record, idempotency_key: key };
}

function isMcpInfoInvocation(request: JsonRpcRequest): boolean {
  const method = request?.method?.trim();
  if (method === "mcp_info") {
    return true;
  }

  if (method === "tools/call") {
    const params = request?.params;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const name = (params as { name?: unknown }).name;
      if (typeof name === "string" && name.trim() === "mcp_info") {
        return true;
      }
    }
  }

  return false;
}

function shouldHydrateMcpInfo(
  request: JsonRpcRequest,
  context: JsonRpcRouteContext | undefined,
  result: unknown,
): boolean {
  if (!context || context.transport !== "http" || !isMcpInfoInvocation(request)) {
    return false;
  }

  if (!result || typeof result !== "object") {
    return true;
  }

  const payload = result as { server?: { name?: unknown } };
  return typeof payload.server?.name !== "string";
}

type JsonRpcCorrelationSnapshot = {
  runId?: string | null;
  opId?: string | null;
  childId?: string | null;
  jobId?: string | null;
};

function normaliseCorrelationValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeCorrelationSnapshots(
  base: JsonRpcCorrelationSnapshot,
  next: JsonRpcCorrelationSnapshot,
): JsonRpcCorrelationSnapshot {
  const merged: JsonRpcCorrelationSnapshot = { ...base };
  for (const key of ["runId", "opId", "childId", "jobId"] as const) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      merged[key] = next[key];
    }
  }
  return merged;
}

function collectCorrelationFromContext(context?: JsonRpcRouteContext): JsonRpcCorrelationSnapshot {
  const snapshot: JsonRpcCorrelationSnapshot = {};
  if (context && Object.prototype.hasOwnProperty.call(context, "childId")) {
    snapshot.childId = context.childId ?? null;
  }
  if (context && Object.prototype.hasOwnProperty.call(context, "runId")) {
    snapshot.runId = (context as { runId?: string | null }).runId ?? null;
  }
  if (context && Object.prototype.hasOwnProperty.call(context, "jobId")) {
    snapshot.jobId = (context as { jobId?: string | null }).jobId ?? null;
  }
  if (context && Object.prototype.hasOwnProperty.call(context, "opId")) {
    snapshot.opId = (context as { opId?: string | null }).opId ?? null;
  }
  return snapshot;
}

function collectCorrelationFromPayload(payload: unknown): JsonRpcCorrelationSnapshot {
  if (Array.isArray(payload)) {
    return payload.reduce<JsonRpcCorrelationSnapshot>(
      (acc, entry) => mergeCorrelationSnapshots(acc, collectCorrelationFromPayload(entry)),
      {},
    );
  }
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const record = payload as Record<string, unknown>;
  let snapshot: JsonRpcCorrelationSnapshot = {};

  const assign = (fields: readonly string[], key: keyof JsonRpcCorrelationSnapshot) => {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) {
        continue;
      }
      snapshot = { ...snapshot, [key]: normaliseCorrelationValue(record[field]) };
      break;
    }
  };

  assign(["run_id"], "runId");
  assign(["op_id", "operation_id"], "opId");
  assign(["child_id"], "childId");
  assign(["job_id"], "jobId");

  for (const nestedKey of ["result", "data", "payload"]) {
    if (Object.prototype.hasOwnProperty.call(record, nestedKey)) {
      snapshot = mergeCorrelationSnapshots(snapshot, collectCorrelationFromPayload(record[nestedKey]));
    }
  }

  if (Object.prototype.hasOwnProperty.call(record, "structuredContent")) {
    const structured = record.structuredContent;
    if (structured !== undefined) {
      snapshot = mergeCorrelationSnapshots(snapshot, collectCorrelationFromPayload(structured));
    }
  }

  return snapshot;
}

/**
 * Traverses arbitrary error/result payloads to capture embedded correlation hints (run_id, child_id, etc.).
 */
function collectCorrelationFromUnknown(value: unknown): JsonRpcCorrelationSnapshot {
  if (Array.isArray(value)) {
    return value.reduce<JsonRpcCorrelationSnapshot>(
      (acc, entry) => mergeCorrelationSnapshots(acc, collectCorrelationFromUnknown(entry)),
      {},
    );
  }
  if (value instanceof Error) {
    const errorRecord = value as Error & { data?: unknown; cause?: unknown };
    let snapshot = collectCorrelationFromPayload(errorRecord);
    if (errorRecord.data !== undefined) {
      snapshot = mergeCorrelationSnapshots(snapshot, collectCorrelationFromUnknown(errorRecord.data));
    }
    if (errorRecord.cause !== undefined) {
      snapshot = mergeCorrelationSnapshots(snapshot, collectCorrelationFromUnknown(errorRecord.cause));
    }
    return snapshot;
  }
  if (!value || typeof value !== "object") {
    return {};
  }
  return collectCorrelationFromPayload(value);
}

function extractInvocationArguments(method: string, params: unknown): unknown {
  const trimmed = method.trim();
  if (trimmed === "tools/call" && params && typeof params === "object" && !Array.isArray(params)) {
    const record = params as { arguments?: unknown };
    if (record.arguments && typeof record.arguments === "object") {
      return record.arguments;
    }
  }
  return params;
}

function resolveJsonRpcToolName(method: string, params: unknown): string | null {
  const trimmed = method.trim();
  if (trimmed && trimmed !== "tools/call") {
    return trimmed;
  }
  if (trimmed === "tools/call" && params && typeof params === "object" && !Array.isArray(params)) {
    const record = params as { name?: unknown };
    if (typeof record.name === "string") {
      const name = record.name.trim();
      return name.length > 0 ? name : null;
    }
  }
  return null;
}

type JsonRpcObservabilityStage = "request" | "response" | "error";

interface JsonRpcObservabilityInput {
  stage: JsonRpcObservabilityStage;
  method: string;
  toolName?: string | null;
  requestId: string | number | null;
  transport?: string;
  idempotencyKey?: string | null;
  correlation: JsonRpcCorrelationSnapshot;
  status?: "pending" | "ok" | "error";
  elapsedMs?: number | null;
  errorMessage?: string | null;
  errorCode?: number | null;
  timeoutMs?: number | null;
}

interface JsonRpcErrorSnapshot {
  readonly message: string | null;
  readonly code: string | null;
}

function parseToolErrorPayload(raw: unknown): JsonRpcErrorSnapshot {
  if (!raw || typeof raw !== "object") {
    return { message: null, code: null };
  }
  let message: string | null = null;
  let code: string | null = null;

  if (typeof (raw as { message?: unknown }).message === "string") {
    message = (raw as { message: string }).message;
  }
  if (typeof (raw as { error?: unknown }).error === "string") {
    code = (raw as { error: string }).error;
  }
  if (message && code) {
    return { message, code };
  }

  const details = raw as { content?: unknown };
  if (Array.isArray(details.content)) {
    for (const entry of details.content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const text = (entry as { text?: unknown }).text;
      if (typeof text !== "string" || text.trim().length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          if (!message && typeof (parsed as { message?: unknown }).message === "string") {
            message = (parsed as { message: string }).message;
          }
          if (!code && typeof (parsed as { error?: unknown }).error === "string") {
            code = (parsed as { error: string }).error;
          }
        }
      } catch {
        // Ignore malformed JSON payloads and fall back to the raw message when available.
      }
      if (message && code) {
        break;
      }
    }
  }

  return { message, code };
}

function detectJsonRpcErrorResult(result: unknown): JsonRpcErrorSnapshot | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as Record<string, unknown>;
  const hasErrorFlag = record.isError === true;
  const hasExplicitFailure = record.ok === false;
  if (!hasErrorFlag && !hasExplicitFailure) {
    return null;
  }
  return parseToolErrorPayload(record);
}

interface IdempotentWalConfig {
  readonly topic: string;
  readonly event: string;
}

const IDEMPOTENT_MUTATION_WAL_MAP = new Map<string, IdempotentWalConfig>([
  ["graph_mutate", { topic: "graph", event: "graph_mutate" }],
  ["graph_batch_mutate", { topic: "graph", event: "graph_batch_mutate" }],
  ["graph_patch", { topic: "graph", event: "graph_patch" }],
  ["graph_rewrite_apply", { topic: "graph", event: "graph_rewrite_apply" }],
  ["tx_begin", { topic: "tx", event: "tx_begin" }],
  ["tx_apply", { topic: "tx", event: "tx_apply" }],
  ["tx_commit", { topic: "tx", event: "tx_commit" }],
  ["tx_rollback", { topic: "tx", event: "tx_rollback" }],
  ["child_create", { topic: "child", event: "child_create" }],
  ["child_batch_create", { topic: "child", event: "child_batch_create" }],
  ["child_spawn_codex", { topic: "child", event: "child_spawn_codex" }],
  ["child_set_role", { topic: "child", event: "child_set_role" }],
  ["child_set_limits", { topic: "child", event: "child_set_limits" }],
  ["child_send", { topic: "child", event: "child_send" }],
  ["child_cancel", { topic: "child", event: "child_cancel" }],
  ["child_kill", { topic: "child", event: "child_kill" }],
]);

function normaliseWalMethodName(name: string | null | undefined): string | null {
  if (typeof name !== "string") {
    return null;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.toLowerCase();
}

function resolveIdempotentWalConfig(method: string, toolName: string | null): IdempotentWalConfig | null {
  const byTool = normaliseWalMethodName(toolName);
  if (byTool) {
    const config = IDEMPOTENT_MUTATION_WAL_MAP.get(byTool);
    if (config) {
      return config;
    }
  }

  const byMethod = normaliseWalMethodName(method);
  if (!byMethod) {
    return null;
  }
  return IDEMPOTENT_MUTATION_WAL_MAP.get(byMethod) ?? null;
}

function serialiseWalPayload(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { non_serialisable: true, reason };
  }
}

export function createOrchestratorController(
  deps: OrchestratorControllerDependencies,
): OrchestratorController {
  const { server, toolRegistry, logger, eventBus, logJournal, requestBudgetLimits, defaultTimeoutOverride } = deps;

  const recordJsonRpcObservability = (input: JsonRpcObservabilityInput): void => {
    const trace = getActiveTraceContext();
    const duration = typeof trace?.durationMs === "number" && Number.isFinite(trace.durationMs)
      ? Math.max(0, trace.durationMs)
      : null;
    const bytesIn = typeof trace?.bytesIn === "number" && Number.isFinite(trace.bytesIn)
      ? Math.max(0, trace.bytesIn)
      : null;
    const bytesOut = typeof trace?.bytesOut === "number" && Number.isFinite(trace.bytesOut)
      ? Math.max(0, trace.bytesOut)
      : null;
    const metricMethod = deriveMetricMethodLabel(input.method, input.toolName ?? null);

    annotateTraceContext({ method: metricMethod });
    const jsonRpcMessage = `jsonrpc_${input.stage}` as JsonRpcEventMessage;

    // Clamp optional numeric telemetry (elapsed, duration, bytes, timeout) to non-negative integers while
    // preserving `null` for absent measurements so downstream serialisation reste déterministe.
    const normaliseOptionalMetric = (value: number | null | undefined): number | null => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
      }
      if (value < 0) {
        return 0;
      }
      return Math.round(value);
    };

    // Ensure the emitted payload status matches the JSON-RPC stage; unexpected values are coerced to the
    // documented lifecycle token so dashboards keep a stable contract.
    const resolveStatus = <M extends JsonRpcEventMessage>(
      message: M,
      status: JsonRpcObservabilityInput["status"],
    ): JsonRpcEventPayloadByMessage<M>["status"] => {
      const fallback: JsonRpcEventStatus =
        message === "jsonrpc_request" ? "pending" : message === "jsonrpc_response" ? "ok" : "error";
      const candidate = status ?? fallback;
      return (candidate === fallback ? candidate : fallback) as JsonRpcEventPayloadByMessage<M>["status"];
    };

    const sharedFields: JsonRpcEventSharedFields = {
      method: input.method,
      metric_method: metricMethod,
      tool: input.toolName ?? null,
      request_id: input.requestId ?? null,
      transport: input.transport ?? null,
      elapsed_ms: normaliseOptionalMetric(input.elapsedMs ?? null),
      trace_id: trace?.traceId ?? null,
      span_id: trace?.spanId ?? null,
      duration_ms: normaliseOptionalMetric(duration),
      bytes_in: normaliseOptionalMetric(bytesIn),
      bytes_out: normaliseOptionalMetric(bytesOut),
      run_id: input.correlation.runId ?? null,
      op_id: input.correlation.opId ?? null,
      child_id: input.correlation.childId ?? null,
      job_id: input.correlation.jobId ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      timeout_ms: normaliseOptionalMetric(input.timeoutMs ?? null),
    } satisfies JsonRpcEventSharedFields;

    let payload: JsonRpcEventPayload;
    switch (jsonRpcMessage) {
      case "jsonrpc_request": {
        const requestPayload = {
          msg: "jsonrpc_request",
          status: resolveStatus("jsonrpc_request", input.status),
          error_message: null,
          error_code: null,
          ...sharedFields,
        } satisfies JsonRpcEventPayloadByMessage<"jsonrpc_request">;
        payload = requestPayload;
        break;
      }
      case "jsonrpc_response": {
        const responsePayload = {
          msg: "jsonrpc_response",
          status: resolveStatus("jsonrpc_response", input.status),
          error_message: null,
          error_code: null,
          ...sharedFields,
        } satisfies JsonRpcEventPayloadByMessage<"jsonrpc_response">;
        payload = responsePayload;
        break;
      }
      case "jsonrpc_error":
      default: {
        const errorPayload = {
          msg: "jsonrpc_error",
          status: resolveStatus("jsonrpc_error", input.status),
          error_message: input.errorMessage ?? null,
          error_code: input.errorCode ?? null,
          ...sharedFields,
        } satisfies JsonRpcEventPayloadByMessage<"jsonrpc_error">;
        payload = errorPayload;
        break;
      }
    }

    if (input.stage === "error") {
      registerRpcError(input.errorCode ?? null);
    } else if (input.stage === "response") {
      registerRpcSuccess();
    }

    try {
      eventBus.publish<typeof payload.msg>({
        cat: "scheduler",
        level: input.stage === "error" ? "error" : "info",
        runId: input.correlation.runId ?? null,
        opId: input.correlation.opId ?? null,
        childId: input.correlation.childId ?? null,
        jobId: input.correlation.jobId ?? null,
        component: "jsonrpc",
        stage: jsonRpcMessage,
        elapsedMs: payload.elapsed_ms ?? undefined,
        kind: `JSONRPC_${input.stage.toUpperCase()}`,
        msg: payload.msg,
        data: payload,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          message: "jsonrpc_event_publish_failed",
          detail,
        })}\n`,
      );
    }

    const latestEnvelope = eventBus.list({ limit: 1 }).at(-1);
    const seq = latestEnvelope?.seq;
    const ts = latestEnvelope?.ts;
    try {
      const level = input.stage === "error" ? "error" : "info";
      const baseEntry = {
        level,
        message: payload.msg,
        data: payload,
        jobId: input.correlation.jobId ?? null,
        runId: input.correlation.runId ?? null,
        opId: input.correlation.opId ?? null,
        childId: input.correlation.childId ?? null,
        component: "jsonrpc",
        stage: payload.msg,
        elapsedMs: payload.elapsed_ms ?? null,
        ts,
        seq,
      } as const;

      logJournal.record({ stream: "server", bucketId: "jsonrpc", ...baseEntry });
      if (input.correlation.runId) {
        logJournal.record({ stream: "run", bucketId: input.correlation.runId, ...baseEntry });
      }
      if (input.correlation.childId) {
        logJournal.record({ stream: "child", bucketId: input.correlation.childId, ...baseEntry });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          message: "jsonrpc_log_record_failed",
          detail,
        })}\n`,
      );
    }
  };

  const recordIdempotentWalInvocation = async (
    config: IdempotentWalConfig,
    request: JsonRpcRequest,
    context: JsonRpcRouteContext | undefined,
    toolName: string | null,
  ): Promise<void> => {
    const idempotencyKey = context?.idempotencyKey;
    if (!idempotencyKey) {
      return;
    }

    const rawMethod = typeof request.method === "string" ? request.method : String(request.method ?? "");
    const cacheKey = buildIdempotencyCacheKey(rawMethod, idempotencyKey, request.params);

    try {
      await appendWalEntry(config.topic, config.event, {
        cache_key: cacheKey,
        method: rawMethod,
        tool: toolName ?? null,
        idempotency_key: idempotencyKey,
        request_id: request.id ?? null,
        http_request_id: context?.requestId ?? null,
        transport: context?.transport ?? null,
        child_id: context?.childId ?? null,
        params: serialiseWalPayload(request.params ?? null),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("wal_append_failed", {
        topic: config.topic,
        event: config.event,
        method: rawMethod,
        idempotency_key: idempotencyKey,
        message,
      });
    }
  };

  const maybeRecordIdempotentWalEntry = async (
    request: JsonRpcRequest,
    context: JsonRpcRouteContext | undefined,
    overrides: { method?: string; toolName?: string | null } = {},
  ): Promise<void> => {
    const explicitMethod = overrides.method;
    const method =
      typeof explicitMethod === "string" && explicitMethod.trim().length > 0
        ? explicitMethod
        : typeof request.method === "string"
          ? request.method
          : "";
    const toolName =
      overrides.toolName !== undefined
        ? overrides.toolName
        : resolveJsonRpcToolName(method, request.params);
    const config = resolveIdempotentWalConfig(method, toolName ?? null);
    if (!config) {
      return;
    }
    await recordIdempotentWalInvocation(config, request, context, toolName ?? null);
  };

  const routeJsonRpcRequest = async (
    method: string,
    params?: unknown,
    context: JsonRpcRouteContext = {},
  ): Promise<unknown> => {
    const originalMethod = method.trim();
    let handlers: Map<string, InternalJsonRpcHandler>;
    try {
      handlers = getMutableJsonRpcRequestHandlerRegistry(server);
    } catch (error) {
      throw new Error("JSON-RPC handlers not initialised", {
        cause: error instanceof Error ? error : undefined,
      });
    }

    let invocation = normaliseJsonRpcInvocation(method, params);
    const handler = handlers.get(invocation.method);
    if (!handler) {
      throw new Error(`Unknown method: ${invocation.method}`);
    }

    const requestId = context.requestId ?? randomUUID();
    const timeoutBudget =
      typeof context.timeoutMs === "number" && Number.isFinite(context.timeoutMs)
        ? Math.max(0, Math.trunc(context.timeoutMs))
        : null;
    const abort = new AbortController();

    const headersSnapshot = { ...(context.headers ?? {}) };
    if (context.transport) {
      headersSnapshot["x-mcp-transport"] = context.transport;
    }
    if (context.childId) {
      headersSnapshot["x-child-id"] = context.childId;
    }
    if (context.childLimits) {
      headersSnapshot["x-child-limits"] = Buffer.from(JSON.stringify(context.childLimits), "utf8").toString("base64");
    }
    if (context.idempotencyKey) {
      headersSnapshot["idempotency-key"] = context.idempotencyKey;
    }
    if (context.transport === "http" && context.requestId) {
      headersSnapshot["x-http-request-id"] = String(context.requestId);
    }

    invocation = normaliseJsonRpcInvocation(invocation.method, invocation.params);
    if (context.idempotencyKey) {
      invocation.params = injectIdempotencyKey(invocation.method, invocation.params, context.idempotencyKey);
    }

    const executeInvocation = () =>
      runWithJsonRpcContext(context, async () => {
        const rawResult = await handler(
          { jsonrpc: "2.0", id: requestId, method: invocation.method, params: invocation.params },
          {
            signal: abort.signal,
            requestId,
            requestInfo: Object.keys(headersSnapshot).length > 0 ? { headers: headersSnapshot } : undefined,
            sendNotification: async () => {
              // Notifications are not routed through the in-process adapter. The promise simply
              // resolves to keep behaviour consistent with the legacy implementation.
              return;
            },
            sendRequest: async () => {
              throw new Error("Nested requests are not supported via routeJsonRpcRequest");
            },
          },
        );
        if (!originalMethod.includes("/") && invocation.method === "tools/call") {
          return normaliseToolCallResult(rawResult);
        }
        return rawResult;
      });

    if (!timeoutBudget || timeoutBudget <= 0) {
      try {
        return await executeInvocation();
      } finally {
        abort.abort();
      }
    }

    let timeoutHandle: IntervalHandle | null = null;
    let timedOut = false;
    const invocationPromise = executeInvocation();
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = runtimeTimers.setTimeout(() => {
        timedOut = true;
        abort.abort();
        reject(new JsonRpcTimeoutError(timeoutBudget));
      }, timeoutBudget);
    });

    try {
      return await Promise.race([invocationPromise, timeoutPromise]);
    } catch (error) {
      if (timedOut) {
        invocationPromise.catch(() => undefined);
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        runtimeTimers.clearTimeout(timeoutHandle);
      }
      abort.abort();
    }
  };

  const handleJsonRpc = async (
    req: JsonRpcRequest,
    context?: JsonRpcRouteContext,
  ): Promise<JsonRpcResponse> => {
    const rawId = req?.id ?? null;
    const baseContext: JsonRpcRouteContext = context ? { ...context } : {};
    const requestIdHint = baseContext.requestId ?? rawId;
    let sanitizedRequest: JsonRpcRequest;
    let method = typeof req?.method === "string" ? req.method.trim() || "unknown" : "unknown";
    let toolName: string | null = null;

    try {
      const normalised = normaliseJsonRpcRequest(req, { requestId: requestIdHint });
      sanitizedRequest = normalised.request;
      method = normalised.method.trim() || (normalised.method ? normalised.method : "unknown");
      toolName = normalised.toolName ?? resolveJsonRpcToolName(normalised.request.method, normalised.request.params);
    } catch (error) {
      if (error instanceof JsonRpcError) {
        recordJsonRpcObservability({
          stage: "error",
          method,
          toolName: resolveJsonRpcToolName(typeof req?.method === "string" ? req.method : "", req?.params),
          requestId: rawId,
          transport: baseContext?.transport,
          idempotencyKey: baseContext?.idempotencyKey ?? null,
          correlation: collectCorrelationFromContext(baseContext),
          status: "error",
          errorMessage: error.data?.hint ?? error.message,
          errorCode: error.code,
        });
        return toJsonRpc(rawId, error);
      }
      throw error;
    }

    const { context: runtimeContext, requestBudget, timeoutBudget } = assembleJsonRpcRuntime(
      {
        toolRegistry,
        requestLimits: requestBudgetLimits,
        resolveTimeoutBudget: (name, tool) => resolveRpcTimeoutBudget(name, tool ?? null),
        defaultTimeoutOverride,
      },
      { method, toolName, context: baseContext },
    );

    const id = sanitizedRequest.id ?? null;
    const request = sanitizedRequest;
    const rawMethod = typeof request.method === "string" ? request.method : "";
    const invocationArgs = extractInvocationArguments(rawMethod, request.params);
    let correlation = mergeCorrelationSnapshots(
      collectCorrelationFromContext(runtimeContext),
      collectCorrelationFromPayload(invocationArgs),
    );
    const deprecation = toolName ? evaluateToolDeprecation(toolName, undefined, new Date()) : null;
    if (deprecation?.metadata && toolName) {
      const logPayload = { name: toolName, metadata: deprecation.metadata, ageDays: deprecation.ageDays };
      if (deprecation.forceRemoval) {
        logToolDeprecation(logger, "warn", "tool_deprecated_blocked", logPayload);
        const replacementHint = deprecation.metadata.replace_with
          ? `utilise '${deprecation.metadata.replace_with}' à la place`
          : "mets à jour ton intégration";
        const removalError = createJsonRpcError("VALIDATION_ERROR", "Tool retired", {
          requestId: id,
          hint: `l'outil '${toolName}' est retiré (${deprecation.metadata.since}); ${replacementHint}.`,
          status: 410,
          meta: { tool: toolName, since: deprecation.metadata.since },
        });
        recordJsonRpcObservability({
          stage: "error",
          method,
          toolName,
          requestId: id,
          transport: runtimeContext?.transport,
          idempotencyKey: runtimeContext?.idempotencyKey ?? null,
          correlation,
          status: "error",
          timeoutMs: null,
          errorMessage: removalError.data?.hint ?? removalError.message,
          errorCode: removalError.code,
        });
        return toJsonRpc(id, removalError);
      }
      logToolDeprecation(logger, "warn", "tool_deprecated_invoked", logPayload);
    }
    const transport = runtimeContext?.transport ?? null;
    const childId = runtimeContext?.childId ?? null;
    const payloadBytes = runtimeContext?.payloadSizeBytes ?? 0;
    const timeoutMs = timeoutBudget.timeoutMs;
    const processRequest = async (): Promise<JsonRpcResponse> => {
      try {
        requestBudget.consume(
          {
            toolCalls: 1,
            tokens: estimateTokenUsage(invocationArgs),
            bytesIn: payloadBytes,
          },
          { actor: "transport", operation: method, stage: "ingress" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          const budgetError = createJsonRpcError("BUDGET_EXCEEDED", "Request budget exhausted", {
            requestId: id,
            hint: `request budget exceeded on ${error.dimension}`,
            meta: {
              dimension: error.dimension,
              remaining: error.remaining,
              attempted: error.attempted,
              limit: error.limit,
            },
            status: 429,
          });
          recordJsonRpcObservability({
            stage: "error",
            method,
            toolName,
            requestId: id,
            transport: runtimeContext?.transport,
            idempotencyKey: runtimeContext?.idempotencyKey ?? null,
            correlation,
            status: "error",
            timeoutMs,
            errorMessage: budgetError.data?.hint ?? budgetError.message,
            errorCode: budgetError.code,
          });
          return toJsonRpc(id, budgetError);
        }
        throw error;
      }

      recordJsonRpcObservability({
        stage: "request",
        method,
        toolName,
        requestId: id,
        transport: runtimeContext?.transport,
        idempotencyKey: runtimeContext?.idempotencyKey ?? null,
        correlation,
        status: "pending",
        timeoutMs,
      });

      await maybeRecordIdempotentWalEntry(request, runtimeContext, { method, toolName });

      const startedAt = Date.now();
      try {
        let result = await runWithJsonRpcContext(runtimeContext, async () =>
          routeJsonRpcRequest(request.method, request.params, { ...runtimeContext, requestId: id, timeoutMs }),
        );
        correlation = mergeCorrelationSnapshots(correlation, collectCorrelationFromPayload(result));

        if (shouldHydrateMcpInfo(request, runtimeContext, result)) {
          result = getMcpInfo();
          correlation = mergeCorrelationSnapshots(correlation, collectCorrelationFromPayload(result));
        }

        const elapsedMs = Date.now() - startedAt;
        const errorSnapshot = detectJsonRpcErrorResult(result);

        if (errorSnapshot) {
          const normalisedErrorCode =
            typeof errorSnapshot.code === "number" ? errorSnapshot.code : null;
          recordJsonRpcObservability({
            stage: "error",
            method,
            toolName,
            requestId: id,
            transport: runtimeContext?.transport,
            idempotencyKey: runtimeContext?.idempotencyKey ?? null,
            correlation,
            status: "error",
            elapsedMs,
            errorMessage: errorSnapshot.message,
            errorCode: normalisedErrorCode,
            timeoutMs,
          });
        } else {
          recordJsonRpcObservability({
            stage: "response",
            method,
            toolName,
            requestId: id,
            transport: runtimeContext?.transport,
            idempotencyKey: runtimeContext?.idempotencyKey ?? null,
            correlation,
            status: "ok",
            elapsedMs,
            timeoutMs,
          });
        }

        try {
          requestBudget.consume(
            {
              timeMs: elapsedMs,
              bytesOut: measureBudgetBytes(result),
              tokens: estimateTokenUsage(result),
            },
            { actor: "transport", operation: method, stage: "egress" },
          );
        } catch (budgetError) {
          if (budgetError instanceof BudgetExceededError) {
            const jsonRpcError = createJsonRpcError("BUDGET_EXCEEDED", "Request budget exhausted", {
              requestId: id,
              hint: `response budget exceeded on ${budgetError.dimension}`,
              meta: {
                dimension: budgetError.dimension,
                remaining: budgetError.remaining,
                attempted: budgetError.attempted,
                limit: budgetError.limit,
              },
              status: 429,
            });
            recordJsonRpcObservability({
              stage: "error",
              method,
              toolName,
              requestId: id,
              transport: runtimeContext?.transport,
              idempotencyKey: runtimeContext?.idempotencyKey ?? null,
              correlation,
              status: "error",
              elapsedMs,
              errorMessage: jsonRpcError.data?.hint ?? jsonRpcError.message,
              errorCode: jsonRpcError.code,
              timeoutMs,
            });
            return toJsonRpc(id, jsonRpcError);
          }
          throw budgetError;
        }

        return { jsonrpc: "2.0", id, result };
      } catch (error) {
        const elapsedMs = Date.now() - startedAt;
        let message = error instanceof Error ? error.message : String(error);
        let errorCode = -32000;
        let errorData: Record<string, unknown> | undefined;
        if (error instanceof JsonRpcTimeoutError) {
          message = `JSON-RPC handler exceeded timeout after ${error.timeoutMs}ms`;
          errorCode = -32001;
          errorData = { timeout_ms: error.timeoutMs };
        }
        correlation = mergeCorrelationSnapshots(correlation, collectCorrelationFromUnknown(error));

        recordJsonRpcObservability({
          stage: "error",
          method,
          toolName,
          requestId: id,
          transport: runtimeContext?.transport,
          idempotencyKey: runtimeContext?.idempotencyKey ?? null,
          correlation,
          status: "error",
          elapsedMs,
          errorMessage: message,
          errorCode,
          timeoutMs,
        });

        const errorPayload = { code: errorCode, message, data: errorData };
        try {
          requestBudget.consume(
            {
              timeMs: elapsedMs,
              bytesOut: measureBudgetBytes(errorPayload),
              tokens: estimateTokenUsage(errorPayload),
            },
            { actor: "transport", operation: method, stage: "egress_error" },
          );
        } catch (budgetError) {
          if (budgetError instanceof BudgetExceededError) {
            const jsonRpcError = createJsonRpcError("BUDGET_EXCEEDED", "Request budget exhausted", {
              requestId: id,
              hint: `response budget exceeded on ${budgetError.dimension}`,
              meta: {
                dimension: budgetError.dimension,
                remaining: budgetError.remaining,
                attempted: budgetError.attempted,
                limit: budgetError.limit,
              },
              status: 429,
            });
            recordJsonRpcObservability({
              stage: "error",
              method,
              toolName,
              requestId: id,
              transport: runtimeContext?.transport,
              idempotencyKey: runtimeContext?.idempotencyKey ?? null,
              correlation,
              status: "error",
              elapsedMs,
              errorMessage: jsonRpcError.data?.hint ?? jsonRpcError.message,
              errorCode: jsonRpcError.code,
              timeoutMs,
            });
            return toJsonRpc(id, jsonRpcError);
          }
          throw budgetError;
        }

        return { jsonrpc: "2.0", id, error: errorPayload };
      }
    };

    const activeTrace = getActiveTraceContext();
    if (activeTrace) {
      registerInboundBytes(payloadBytes);
      annotateTraceContext({ method, requestId: id, childId, transport });
      return processRequest();
    }

    return runWithRpcTrace(
      { method, requestId: id, childId, transport, bytesIn: 0 },
      async () => {
        registerInboundBytes(payloadBytes);
        annotateTraceContext({ method, requestId: id, childId, transport });
        return processRequest();
      },
    );
  };

  return { routeJsonRpcRequest, maybeRecordIdempotentWalEntry, handleJsonRpc };
}

/**
 * Attempts to extract a structured payload from a tool response while keeping the legacy
 * `structuredContent` compatibility. Tests (and the FS bridge) depend on this helper to
 * surface friendly objects rather than raw MCP envelopes.
 */
function normaliseToolCallResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const payload = result as {
    structuredContent?: unknown;
    content?: Array<{ text?: string } | null | undefined>;
  };

  if (Object.prototype.hasOwnProperty.call(payload, "structuredContent")) {
    return payload.structuredContent;
  }

  if (Array.isArray(payload.content)) {
    for (const entry of payload.content) {
      if (entry && typeof entry === "object" && typeof entry.text === "string") {
        try {
          const parsed = JSON.parse(entry.text);
          if (parsed && typeof parsed === "object") {
            const record = parsed as Record<string, unknown>;
            if (record.result !== undefined) {
              return record.result;
            }
            if (record.info !== undefined) {
              return record.info;
            }
            return parsed;
          }
        } catch {
          // Ignore malformed JSON blobs and surface the original response instead.
        }
        break;
      }
    }
  }

  return result;
}
