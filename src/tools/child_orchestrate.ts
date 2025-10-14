import { randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import type { ChildSupervisor, SendResult } from "../childSupervisor.js";
import type { ChildCollectedOutputs, ChildRuntimeMessage, ChildShutdownResult } from "../childRuntime.js";
import type { Signal } from "../nodePrimitives.js";
import { StructuredLogger } from "../logger.js";
import {
  BudgetExceededError,
  type BudgetCharge,
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
} from "../rpc/childOrchestrateSchemas.js";

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

/** Dependencies required by {@link createChildOrchestrateHandler}. */
export interface ChildOrchestrateToolContext {
  /** Supervisor coordinating child runtimes and exposing lifecycle helpers. */
  readonly supervisor: ChildSupervisor;
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

function buildSpawnOptions(parsed: ChildOrchestrateInput) {
  return {
    childId: parsed.child_id,
    command: parsed.command,
    args: parsed.args,
    env: parsed.env,
    metadata: parsed.metadata,
    manifestExtras: parsed.manifest_extras,
    limits: parsed.limits ?? null,
    role: parsed.role ?? null,
    toolsAllow: parsed.tools_allow ?? null,
    waitForReady: parsed.wait_for_ready,
    readyType: parsed.ready_type,
    readyTimeoutMs: parsed.ready_timeout_ms,
    sandbox: parsed.sandbox
      ? {
          profile: parsed.sandbox.profile,
          allowEnv: parsed.sandbox.allow_env ?? undefined,
          env: parsed.sandbox.env ?? undefined,
          inheritDefaultEnv: parsed.sandbox.inherit_default_env ?? undefined,
        }
      : null,
    spawnRetry: parsed.spawn_retry
      ? {
          attempts: parsed.spawn_retry.attempts,
          initialDelayMs: parsed.spawn_retry.initial_delay_ms,
          backoffFactor: parsed.spawn_retry.backoff_factor,
          maxDelayMs: parsed.spawn_retry.max_delay_ms,
        }
      : undefined,
  };
}

function buildObservationError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "unknown observation failure");
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
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ tool: CHILD_ORCHESTRATE_TOOL_NAME, result: degraded }, null, 2) }],
            structuredContent: degraded,
          };
        }
        throw error;
      }
    }

    const executeOrchestration = async (): Promise<ChildOrchestrateSnapshot> => {
      const spawnOptions = buildSpawnOptions(parsed);
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
            const killed = await context.supervisor.kill(childId, { timeoutMs });
            shutdown = normaliseShutdown(killed);
          } else {
            const resolvedSignal = parsed.shutdown?.signal as Signal | undefined;
            const cancelled = await context.supervisor.cancel(childId, {
              signal: resolvedSignal,
              timeoutMs,
            });
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
            const forced = await context.supervisor.kill(childId, { timeoutMs: parsed.shutdown?.timeout_ms });
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
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ tool: CHILD_ORCHESTRATE_TOOL_NAME, result: degraded }, null, 2) }],
        structuredContent: degraded,
      };
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

    const textPayload = JSON.stringify({ tool: CHILD_ORCHESTRATE_TOOL_NAME, result: structured }, null, 2);

    return {
      // Explicitly signal a successful invocation to align with CallToolResult
      // semantics and keep tests/assertions deterministic.
      isError: false,
      content: [{ type: "text", text: textPayload }],
      structuredContent: structured,
    };
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
