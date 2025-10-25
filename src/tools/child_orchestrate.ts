import { randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import type { ChildSupervisorContract, SendResult } from "../children/supervisor.js";
import type { ChildCollectedOutputs, ChildRuntimeMessage, ChildShutdownResult } from "../childRuntime.js";
import type { Signal } from "../nodePrimitives.js";
import { StructuredLogger } from "../logger.js";
import { omitUndefinedEntries } from "../utils/object.js";
import {
  BudgetExceededError,
  type BudgetCharge,
  type BudgetSnapshot,
  type BudgetUsage,
  type BudgetUsageRecord,
  estimateTokenUsage,
  measureBudgetBytes,
} from "../infra/budget.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import {
  IdempotencyRegistry,
  buildIdempotencyCacheKey,
} from "../infra/idempotency.js";
import type {
  ToolImplementation,
  ToolManifest,
  ToolManifestDraft,
  ToolRegistry,
} from "../mcp/registry.js";
import {
  ChildOrchestrateInputSchema,
  ChildOrchestrateOutputSchema,
  type ChildOrchestrateInput,
  type ChildOrchestrateSuccessDetails,
} from "../rpc/schemas.js";
import { buildToolErrorResult, buildToolSuccessResult } from "./shared.js";

/** Canonical façade identifier exposed in the manifest catalogue. */
export const CHILD_ORCHESTRATE_TOOL_NAME = "child_orchestrate" as const;

/**
 * Manifest advertised to clients. Default budgets assume a short-lived child
 * exchange where we forward a couple of prompts and collect their responses.
 */
export const ChildOrchestrateManifestDraft: ToolManifestDraft = {
  name: CHILD_ORCHESTRATE_TOOL_NAME,
  title: "Orchestrer un enfant Codex",
  description:
    "Démarre un enfant Codex, lui envoie des messages séquentiels, collecte ses sorties puis l'arrête proprement.",
  kind: "dynamic",
  category: "child",
  tags: ["facade", "ops"],
  hidden: false,
  budgets: {
    time_ms: 15_000,
    tool_calls: 1,
    bytes_out: 32_768,
  },
};

/** Serialises a structured façade result for the textual MCP channel. */
function asJsonPayload(result: unknown): string {
  return JSON.stringify({ tool: CHILD_ORCHESTRATE_TOOL_NAME, result }, null, 2);
}

/** Dependencies required by {@link createChildOrchestrateHandler}. */
export interface ChildOrchestrateToolContext {
  /** Supervisor coordinating child runtimes and exposing lifecycle helpers. */
  readonly supervisor: ChildSupervisorContract;
  /** Structured logger fulfilling the observability requirements. */
  readonly logger: StructuredLogger;
  /** Optional idempotency registry replaying cached orchestration results. */
  readonly idempotency?: IdempotencyRegistry;
}

/** JSON-friendly snapshot of a runtime message. */
interface NormalisedRuntimeMessage {
  readonly stream: "stdout" | "stderr";
  readonly raw: string;
  readonly parsed: unknown | null;
  readonly sequence: number;
  readonly received_at: number;
}

/** JSON-friendly snapshot of a sent payload acknowledgement. */
interface NormalisedSendResult {
  readonly message_id: string;
  readonly sent_at: number;
}

/** Summary of collected outputs returned to the caller. */
interface NormalisedCollection {
  readonly manifest_path: string;
  readonly log_path: string;
  readonly message_count: number;
  readonly artifact_count: number;
  readonly messages?: NormalisedRuntimeMessage[];
  readonly artifacts?: Array<{
    readonly path: string;
    readonly size: number;
    readonly mime_type: string;
    readonly sha256: string;
  }>;
}

/** Optional observation result surfaced to the caller. */
interface NormalisedObservation {
  readonly message: NormalisedRuntimeMessage | null;
  readonly error?: string;
}

/** JSON-friendly serialisation of a {@link BudgetUsage} object. */
type SerialisedBudgetUsage = Record<keyof BudgetUsage, number>;

/** JSON-friendly representation of a {@link BudgetSnapshot}. */
interface SerialisedBudgetSnapshot {
  readonly limits: Readonly<BudgetSnapshot["limits"]>;
  readonly consumed: SerialisedBudgetUsage;
  readonly remaining: Record<keyof BudgetUsage, number | null>;
  readonly exhausted: readonly BudgetSnapshot["exhausted"][number][];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastUsage: (BudgetUsageRecord & { charge: SerialisedBudgetUsage }) | null;
}

/** Snapshot embedded in headers to expose timeout budgets to children. */
interface RuntimeTimeoutSnapshot {
  readonly request_timeout_ms: number | null;
  readonly ready_timeout_ms: number | null;
}

/**
 * Converts a potentially infinite numeric value into a JSON-friendly number.
 * `Infinity` is mapped to `null` so downstream consumers can distinguish
 * between bounded and unbounded dimensions without relying on special values.
 */
function toJsonNumber(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Serialises a {@link BudgetUsage} into a plain JSON object. */
function serialiseBudgetUsage(usage: BudgetUsage): SerialisedBudgetUsage {
  return {
    timeMs: usage.timeMs,
    tokens: usage.tokens,
    toolCalls: usage.toolCalls,
    bytesIn: usage.bytesIn,
    bytesOut: usage.bytesOut,
  };
}

/** Serialises a {@link BudgetSnapshot} while normalising `Infinity` values. */
function serialiseBudgetSnapshot(snapshot: BudgetSnapshot): SerialisedBudgetSnapshot {
  const remaining: Record<keyof BudgetUsage, number | null> = {
    timeMs: toJsonNumber(snapshot.remaining.timeMs),
    tokens: toJsonNumber(snapshot.remaining.tokens),
    toolCalls: toJsonNumber(snapshot.remaining.toolCalls),
    bytesIn: toJsonNumber(snapshot.remaining.bytesIn),
    bytesOut: toJsonNumber(snapshot.remaining.bytesOut),
  };

  return {
    limits: { ...snapshot.limits },
    consumed: serialiseBudgetUsage(snapshot.consumed),
    remaining,
    exhausted: [...snapshot.exhausted],
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    lastUsage: snapshot.lastUsage
      ? {
          charge: serialiseBudgetUsage(snapshot.lastUsage.charge),
          // Preserve the metadata object only when the tracker actually recorded
          // contextual hints so the serialised snapshot remains free of
          // `metadata: undefined` placeholders under strict optional semantics.
          ...(snapshot.lastUsage.metadata ? { metadata: snapshot.lastUsage.metadata } : {}),
        }
      : null,
  };
}

/**
 * Normalises arbitrary header bags into a lower-case map of strings. Unknown
 * values are coerced via `String()` so they remain serialisable, while empty
 * entries are ignored to keep manifests concise.
 */
function normaliseRequestHeaders(
  headers: Record<string, unknown> | undefined | null,
): Record<string, string> {
  if (!headers || typeof headers !== "object") {
    return {};
  }
  const normalised: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key) {
      continue;
    }
    const lowered = key.toLowerCase();
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        normalised[lowered] = trimmed;
      }
      continue;
    }
    if (Array.isArray(value)) {
      const joined = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : String(entry ?? "")))
        .filter((entry) => entry.length > 0)
        .join(", ");
      if (joined) {
        normalised[lowered] = joined;
      }
      continue;
    }
    if (value !== undefined && value !== null) {
      const serialised = String(value).trim();
      if (serialised) {
        normalised[lowered] = serialised;
      }
    }
  }
  return normalised;
}

/**
 * Builds the header snapshot persisted alongside the child manifest. Request
 * headers coming from HTTP transports are merged with synthetic JSON payloads
 * that describe timeout and budget envelopes so spawned children can reason
 * about the constraints applied to their lifecycle.
 */
function buildRuntimeHeadersSnapshot(
  base: Record<string, string>,
  timeouts: RuntimeTimeoutSnapshot,
  budgets: { transport?: BudgetSnapshot | null; tool?: BudgetSnapshot | null },
): Record<string, string> | null {
  const headers: Record<string, string> = { ...base };

  if (timeouts.request_timeout_ms !== null || timeouts.ready_timeout_ms !== null) {
    headers["x-runtime-timeouts"] = JSON.stringify(timeouts);
  }

  const budgetPayload: Record<string, unknown> = {};
  if (budgets.transport) {
    budgetPayload.transport = serialiseBudgetSnapshot(budgets.transport);
  }
  if (budgets.tool) {
    budgetPayload.tool = serialiseBudgetSnapshot(budgets.tool);
  }
  if (Object.keys(budgetPayload).length > 0) {
    headers["x-runtime-budgets"] = JSON.stringify(budgetPayload);
  }

  return Object.keys(headers).length > 0 ? headers : null;
}

/**
 * Aggregates the metadata persisted alongside the child manifest. Request
 * headers originating from transports are merged with synthetic JSON payloads
 * describing timeout and budget envelopes so spawned children can reason about
 * the orchestration context without having to query the server again.
 */
function buildSpawnMetadata(
  parsed: ChildOrchestrateInput,
  rpcContext: ReturnType<typeof getJsonRpcContext>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = parsed.metadata ? structuredClone(parsed.metadata) : {};

  const existingRuntimeHeaders =
    metadata.runtime_headers && typeof metadata.runtime_headers === "object" && metadata.runtime_headers !== null
      ? normaliseRequestHeaders(metadata.runtime_headers as Record<string, unknown>)
      : {};

  const contextHeaders = normaliseRequestHeaders(rpcContext?.headers);
  const requestInfo = (extra as { requestInfo?: { headers?: Record<string, unknown> } }).requestInfo;
  const requestHeaders = normaliseRequestHeaders(requestInfo?.headers);

  const mergedHeaders: Record<string, string> = { ...existingRuntimeHeaders, ...contextHeaders, ...requestHeaders };

  const timeouts: RuntimeTimeoutSnapshot = {
    request_timeout_ms:
      typeof rpcContext?.timeoutMs === "number" && Number.isFinite(rpcContext.timeoutMs)
        ? Math.max(0, Math.trunc(rpcContext.timeoutMs))
        : null,
    ready_timeout_ms:
      typeof parsed.ready_timeout_ms === "number" && Number.isFinite(parsed.ready_timeout_ms)
        ? Math.max(0, Math.trunc(parsed.ready_timeout_ms))
        : null,
  };

  const runtimeBudgets = {
    transport: rpcContext?.requestBudget ? rpcContext.requestBudget.snapshot() : null,
    tool: rpcContext?.budget ? rpcContext.budget.snapshot() : null,
  };

  const runtimeHeaders = buildRuntimeHeadersSnapshot(mergedHeaders, timeouts, runtimeBudgets);
  if (runtimeHeaders) {
    metadata.runtime_headers = runtimeHeaders;
  } else if (Object.prototype.hasOwnProperty.call(metadata, "runtime_headers")) {
    delete metadata.runtime_headers;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Snapshot cached for idempotent replays. Mirrors the façade success details to
 * keep `IdempotencyRegistry` entries compact yet expressive.
 */
interface ChildOrchestrateSnapshot {
  readonly idempotency_key: string;
  readonly child_id: string;
  readonly ready_message: NormalisedRuntimeMessage | null;
  readonly send_results: NormalisedSendResult[];
  readonly observation: NormalisedObservation | null;
  readonly collected: NormalisedCollection | null;
  readonly shutdown: {
    readonly code: number | null;
    readonly signal: string | null;
    readonly forced: boolean;
    readonly duration_ms: number;
  } | null;
}

function normaliseMessage(message: ChildRuntimeMessage | null): NormalisedRuntimeMessage | null {
  if (!message) {
    return null;
  }
  return {
    stream: message.stream,
    raw: message.raw,
    parsed: message.parsed ?? null,
    sequence: message.sequence,
    received_at: message.receivedAt,
  };
}

function normaliseSend(result: SendResult): NormalisedSendResult {
  return { message_id: result.messageId, sent_at: result.sentAt };
}

function normaliseCollection(
  outputs: ChildCollectedOutputs | null,
  options: { includeMessages: boolean; includeArtifacts: boolean } = { includeMessages: true, includeArtifacts: true },
): NormalisedCollection | null {
  if (!outputs) {
    return null;
  }
  const messages = options.includeMessages
    ? outputs.messages.map((message) => normaliseMessage(message)!)
    : undefined;
  const artifacts = options.includeArtifacts
    ? outputs.artifacts.map((artifact) => ({
        path: artifact.path,
        size: artifact.size,
        mime_type: artifact.mimeType,
        sha256: artifact.sha256,
      }))
    : undefined;
  return {
    manifest_path: outputs.manifestPath,
    log_path: outputs.logPath,
    message_count: outputs.messages.length,
    artifact_count: outputs.artifacts.length,
    ...(messages ? { messages } : {}),
    ...(artifacts ? { artifacts } : {}),
  };
}

function normaliseShutdown(result: ChildShutdownResult | null): ChildOrchestrateSnapshot["shutdown"] {
  if (!result) {
    return null;
  }
  const signal = (() => {
    if (result.signal === null || result.signal === undefined) {
      return null;
    }
    if (typeof result.signal === "number") {
      return result.signal.toString(10);
    }
    return result.signal;
  })();
  return {
    code: result.code,
    signal,
    forced: result.forced,
    duration_ms: result.durationMs,
  };
}

function buildBudgetExceededResponse(idempotencyKey: string, error: BudgetExceededError) {
  return ChildOrchestrateOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant l'orchestration de l'enfant",
    details: {
      idempotency_key: idempotencyKey,
      reason: "budget_exhausted" as const,
      dimension: error.dimension,
      attempted: error.attempted,
      remaining: error.remaining,
      limit: error.limit,
    },
  });
}

function buildOperationFailedResponse(idempotencyKey: string, message: string) {
  return ChildOrchestrateOutputSchema.parse({
    ok: false,
    summary: "orchestration enfant échouée",
    details: {
      idempotency_key: idempotencyKey,
      reason: "operation_failed" as const,
      message,
    },
  });
}

function estimateInputTokens(input: ChildOrchestrateInput): number {
  let tokens = 0;
  tokens += estimateTokenUsage(input.command ?? "");
  tokens += estimateTokenUsage(input.args ?? []);
  tokens += estimateTokenUsage(input.metadata ?? {});
  tokens += estimateTokenUsage(input.initial_payload ?? null);
  tokens += estimateTokenUsage(input.followup_payloads);
  return tokens;
}

function resolveIdempotencyKey(parsed: ChildOrchestrateInput, rpcContextIdempotencyKey: unknown): string {
  const fromPayload = typeof parsed.idempotency_key === "string" ? parsed.idempotency_key.trim() : "";
  if (fromPayload.length > 0) {
    return fromPayload;
  }
  if (typeof rpcContextIdempotencyKey === "string" && rpcContextIdempotencyKey.trim().length > 0) {
    return rpcContextIdempotencyKey.trim();
  }
  return randomUUID();
}

/**
 * Builds the supervisor spawn options while omitting any optional fields that
 * were not explicitly requested by the caller. Sanitising the payload upfront
 * keeps upcoming `exactOptionalPropertyTypes` enforcement from observing
 * placeholder `undefined` values on the supervisor boundary.
 */
function buildSpawnOptions(
  parsed: ChildOrchestrateInput,
  metadata: Record<string, unknown> | undefined,
) {
  const sandbox = parsed.sandbox !== undefined
    ? omitUndefinedEntries({
        profile: parsed.sandbox.profile,
        allowEnv: parsed.sandbox.allow_env,
        env: parsed.sandbox.env,
        inheritDefaultEnv: parsed.sandbox.inherit_default_env,
      })
    : undefined;

  const spawnRetry = parsed.spawn_retry
    ? omitUndefinedEntries({
        attempts: parsed.spawn_retry.attempts,
        initialDelayMs: parsed.spawn_retry.initial_delay_ms,
        backoffFactor: parsed.spawn_retry.backoff_factor,
        maxDelayMs: parsed.spawn_retry.max_delay_ms,
      })
    : undefined;

  const normalisedSpawnRetry = spawnRetry && Object.keys(spawnRetry).length > 0 ? spawnRetry : undefined;

  return omitUndefinedEntries({
    childId: parsed.child_id,
    command: parsed.command,
    args: parsed.args,
    env: parsed.env,
    metadata,
    manifestExtras: parsed.manifest_extras,
    limits: parsed.limits,
    role: parsed.role,
    toolsAllow: parsed.tools_allow,
    waitForReady: parsed.wait_for_ready === true ? undefined : parsed.wait_for_ready,
    readyType: parsed.ready_type === "ready" ? undefined : parsed.ready_type,
    readyTimeoutMs: parsed.ready_timeout_ms,
    sandbox,
    spawnRetry: normalisedSpawnRetry,
  });
}

function buildObservationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "unknown observation failure");
}

/**
 * Builds the optional timeout record forwarded to supervisor shutdown helpers.
 *
 * Returning `undefined` when the caller omits a concrete value prevents
 * `{ timeoutMs: undefined }` placeholders from leaking into the supervisor API
 * once `exactOptionalPropertyTypes` enforces strict optional semantics.
 */
function buildSupervisorTimeoutOptions(timeoutMs: number | null | undefined): { timeoutMs: number } | undefined {
  if (typeof timeoutMs !== "number") {
    return undefined;
  }
  return { timeoutMs };
}

/**
 * Builds the cancel options passed to the supervisor by omitting empty signal /
 * timeout combinations. The helper keeps the downstream contract sparse so no
 * optional field surfaces unless the caller provided a real value.
 */
function buildSupervisorCancelOptions(
  options: { signal?: Signal; timeoutMs?: number | null },
): { signal?: Signal; timeoutMs?: number } | undefined {
  const result: { signal?: Signal; timeoutMs?: number } = {};
  if (options.signal !== undefined) {
    result.signal = options.signal;
  }
  if (typeof options.timeoutMs === "number") {
    result.timeoutMs = options.timeoutMs;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Factory producing the MCP handler for the `child_orchestrate` façade.
 */
export function createChildOrchestrateHandler(
  context: ChildOrchestrateToolContext,
): ToolImplementation {
  return async (
    input: unknown,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<CallToolResult> => {
    const parsed = ChildOrchestrateInputSchema.parse(input);
    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();

    const idempotencyKey = resolveIdempotencyKey(parsed, rpcContext?.idempotencyKey);
    const budgetTokens = estimateInputTokens(parsed);
    const budgetBytes = measureBudgetBytes({
      command: parsed.command,
      args: parsed.args,
      env: parsed.env,
      metadata: parsed.metadata,
      initial_payload: parsed.initial_payload,
      followup_payloads: parsed.followup_payloads,
    });

    let charge: BudgetCharge | null = null;
    if (rpcContext?.budget) {
      try {
        charge = rpcContext.budget.consume(
          { toolCalls: 1, tokens: budgetTokens, bytesIn: budgetBytes },
          { actor: "facade", operation: CHILD_ORCHESTRATE_TOOL_NAME, detail: "child_orchestrate" },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          const degraded = buildBudgetExceededResponse(idempotencyKey, error);
          context.logger.warn("child_orchestrate_budget_exhausted", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            dimension: error.dimension,
            attempted: error.attempted,
            remaining: error.remaining,
            limit: error.limit,
          });
          return buildToolErrorResult(asJsonPayload(degraded), degraded);
        }
        throw error;
      }
    }

    const spawnMetadata = buildSpawnMetadata(parsed, rpcContext, extra);

    const executeOrchestration = async (): Promise<ChildOrchestrateSnapshot> => {
      const spawnOptions = buildSpawnOptions(parsed, spawnMetadata);
      const sendResults: NormalisedSendResult[] = [];
      let collected: NormalisedCollection | null = null;
      let observation: NormalisedObservation | null = null;
      let shutdown: ChildOrchestrateSnapshot["shutdown"] = null;
      let childId: string | null = null;
      let shutdownPerformed = false;

      context.logger.info("child_orchestrate_spawn_requested", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        command: spawnOptions.command ?? null,
        args: spawnOptions.args?.length ?? 0,
        wait_for_ready: spawnOptions.waitForReady ?? true,
      });

      const created = await context.supervisor.createChild(spawnOptions);
      childId = created.childId;

      context.logger.info("child_orchestrate_spawned", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        child_id: childId,
        pid: created.runtime.getStatus().pid,
        ready_type: spawnOptions.readyType ?? "ready",
      });

      const payloads = [
        ...(parsed.initial_payload === undefined ? [] : [parsed.initial_payload]),
        ...parsed.followup_payloads,
      ];

      for (const [index, payload] of payloads.entries()) {
        const sent = await context.supervisor.send(childId, payload);
        sendResults.push(normaliseSend(sent));
        context.logger.info("child_orchestrate_payload_sent", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          child_id: childId,
          sequence: index,
          message_id: sent.messageId,
        });
      }

      if (parsed.wait_for_message) {
        try {
          const waited = await context.supervisor.waitForMessage(
            childId,
            (message) => {
              if (!parsed.wait_for_message?.stream) {
                return true;
              }
              return message.stream === parsed.wait_for_message.stream;
            },
            parsed.wait_for_message.timeout_ms,
          );
          observation = { message: normaliseMessage(waited) };
        } catch (error) {
          const reason = buildObservationError(error);
          observation = { message: null, error: reason };
          context.logger.warn("child_orchestrate_observe_failed", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            child_id: childId,
            reason,
          });
        }
      }

      if (!parsed.collect || parsed.collect.include_messages || parsed.collect.include_artifacts) {
        try {
          const raw = await context.supervisor.collect(childId);
          const includeMessages = parsed.collect?.include_messages !== false;
          const includeArtifacts = parsed.collect?.include_artifacts !== false;
          collected = normaliseCollection(raw, {
            includeMessages,
            includeArtifacts,
          });
        } catch (error) {
          context.logger.warn("child_orchestrate_collect_failed", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            child_id: childId,
            reason: error instanceof Error ? error.message : String(error ?? "collect_failed"),
          });
        }
      }

      const performConfiguredShutdown = async () => {
        if (!childId || shutdownPerformed) {
          return;
        }
        try {
          const mode = parsed.shutdown?.mode ?? "cancel";
          const timeoutMs = parsed.shutdown?.timeout_ms;
          if (mode === "kill") {
            const killed = await context.supervisor.kill(
              childId,
              buildSupervisorTimeoutOptions(timeoutMs),
            );
            shutdown = normaliseShutdown(killed);
          } else {
            const resolvedSignal = parsed.shutdown?.signal as Signal | undefined;
            // Build the supervisor cancellation envelope by materialising only
            // the concrete signal/timeout values. This prevents `{ timeoutMs:
            // undefined }` placeholders from leaking into the runtime API once
            // `exactOptionalPropertyTypes` is fully enforced.
            const cancelOptions: { signal?: Signal; timeoutMs?: number | null } = {};
            if (resolvedSignal !== undefined) {
              cancelOptions.signal = resolvedSignal;
            }
            if (typeof timeoutMs === "number") {
              cancelOptions.timeoutMs = timeoutMs;
            } else if (timeoutMs === null) {
              cancelOptions.timeoutMs = null;
            }
            const cancelled = await context.supervisor.cancel(
              childId,
              buildSupervisorCancelOptions(cancelOptions),
            );
            shutdown = normaliseShutdown(cancelled);
          }
          shutdownPerformed = true;
        } catch (error) {
          shutdown = null;
          context.logger.error("child_orchestrate_shutdown_failed", {
            request_id: rpcContext?.requestId ?? extra.requestId ?? null,
            trace_id: traceContext?.traceId ?? null,
            child_id: childId,
            reason: error instanceof Error ? error.message : String(error ?? "shutdown_failed"),
          });
          throw error;
        }
      };

      try {
        await performConfiguredShutdown();
      } finally {
        if (childId && !shutdownPerformed) {
          try {
            const forced = await context.supervisor.kill(
              childId,
              buildSupervisorTimeoutOptions(parsed.shutdown?.timeout_ms ?? null),
            );
            shutdown = normaliseShutdown(forced);
          } catch (killError) {
            context.logger.error("child_orchestrate_forced_shutdown_failed", {
              request_id: rpcContext?.requestId ?? extra.requestId ?? null,
              trace_id: traceContext?.traceId ?? null,
              child_id: childId,
              reason: killError instanceof Error ? killError.message : String(killError ?? "forced_shutdown_failed"),
            });
          }
        }
      }

      return {
        idempotency_key: idempotencyKey,
        child_id: childId!,
        ready_message: normaliseMessage(created.readyMessage),
        send_results: sendResults,
        observation,
        collected,
        shutdown,
      };
    };

    let snapshot: ChildOrchestrateSnapshot;
    let idempotent = false;

    try {
      if (context.idempotency && parsed.idempotency_key) {
        const { idempotency_key: _omit, ...fingerprint } = parsed;
        const cacheKey = buildIdempotencyCacheKey(
          CHILD_ORCHESTRATE_TOOL_NAME,
          parsed.idempotency_key,
          fingerprint,
        );
        const hit = await context.idempotency.remember(cacheKey, executeOrchestration);
        snapshot = hit.value as ChildOrchestrateSnapshot;
        idempotent = hit.idempotent;
      } else {
        snapshot = await executeOrchestration();
      }
    } catch (error) {
      if (rpcContext?.budget && charge) {
        rpcContext.budget.refund(charge);
      }
      const degraded = buildOperationFailedResponse(
        idempotencyKey,
        error instanceof Error ? error.message : String(error),
      );
      context.logger.error("child_orchestrate_failed", {
        request_id: rpcContext?.requestId ?? extra.requestId ?? null,
        trace_id: traceContext?.traceId ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
      return buildToolErrorResult(asJsonPayload(degraded), degraded);
    }

    const successDetails: ChildOrchestrateSuccessDetails = {
      idempotency_key: snapshot.idempotency_key,
      child_id: snapshot.child_id,
      ready_message: snapshot.ready_message,
      send_results: snapshot.send_results,
      observation: snapshot.observation,
      collected: snapshot.collected,
      shutdown: snapshot.shutdown,
      idempotent,
    };

    const structured = ChildOrchestrateOutputSchema.parse({
      ok: true,
      summary:
        successDetails.observation && successDetails.observation.error
          ? "enfant orchestré avec avertissement"
          : "enfant orchestré avec succès",
      details: successDetails,
    });

    context.logger.info("child_orchestrate_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      child_id: successDetails.child_id,
      idempotent: successDetails.idempotent,
      sends: successDetails.send_results.length,
      had_warning: Boolean(successDetails.observation?.error),
    });

    if (rpcContext?.budget && charge) {
      rpcContext.budget.snapshot();
    }

    return buildToolSuccessResult(asJsonPayload(structured), structured);
  };
}

/** Registers the façade with the tool registry. */
export async function registerChildOrchestrateTool(
  registry: ToolRegistry,
  context: ChildOrchestrateToolContext,
): Promise<ToolManifest> {
  return await registry.register(ChildOrchestrateManifestDraft, createChildOrchestrateHandler(context), {
    inputSchema: ChildOrchestrateInputSchema.shape,
    outputSchema: ChildOrchestrateOutputSchema.shape,
    annotations: { intent: "child_orchestrate" },
  });
}
