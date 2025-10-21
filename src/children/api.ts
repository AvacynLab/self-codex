import { Buffer } from "node:buffer";
import type { ProcessEnv, Signal } from "../nodePrimitives.js";

import {
  ChildCollectedOutputs,
  ChildMessageStreamResult,
  ChildRuntimeLimits,
  ChildRuntimeMessage,
  ChildRuntimeStatus,
  ChildShutdownResult,
} from "../childRuntime.js";
import type {
  ChildSupervisorContract,
  CreateChildOptions,
  SendResult,
} from "./supervisor.js";
import { ChildRecordSnapshot } from "../state/childrenIndex.js";
import { StructuredLogger } from "../logger.js";
import { SandboxExecutionResult, getSandboxRegistry } from "../sim/sandbox.js";
import type { ChildSandboxRequest, ChildSandboxProfileName } from "./sandbox.js";
import type { PromptTemplate } from "../prompts.js";
import { LoopAlert, LoopDetector } from "../guard/loopDetector.js";
import type { LoopInteractionSample } from "../guard/loopDetector.js";
import type { OrchestratorSupervisorContract } from "../agents/supervisor.js";
import { omitUndefinedEntries } from "../utils/object.js";
import {
  ContractNetAwardDecision,
  ContractNetCoordinator,
  RegisterAgentOptions,
} from "../coord/contractNet.js";
import { IdempotencyRegistry, buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import {
  BudgetCharge,
  BudgetConsumption,
  BudgetExceededError,
  BudgetLimits,
  BudgetUsageMetadata,
  estimateTokenUsage,
  measureBudgetBytes,
} from "../infra/budget.js";
import { BulkOperationError, buildBulkFailureDetail } from "../tools/bulkError.js";
import { resolveOperationId } from "../tools/operationIds.js";
import { readBool, readOptionalInt, readOptionalString, readString } from "../config/env.js";

// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

/** Budget manager injected by the orchestrator so child tools can enforce limits. */
export interface ChildBudgetManager {
  registerChildBudget(childId: string, limits: BudgetLimits | null | undefined): void;
  consumeChildBudget(
    childId: string,
    consumption: BudgetConsumption,
    metadata: BudgetUsageMetadata,
  ): BudgetCharge | null;
  refundChildBudget(childId: string, charge: BudgetCharge | null | undefined): void;
  releaseChildBudget(childId: string): void;
}

/** Shared runtime dependencies used by the child-facing helpers. */
export interface ChildToolContext {
  supervisor: ChildSupervisorContract;
  logger: StructuredLogger;
  loopDetector?: LoopDetector;
  contractNet?: ContractNetCoordinator;
  supervisorAgent?: OrchestratorSupervisorContract;
  idempotency?: IdempotencyRegistry;
  budget?: ChildBudgetManager;
}

/** Timeout overrides accepted when spawning or attaching children. */
export interface ChildTimeoutOverrides {
  ready_ms?: number;
  idle_ms?: number;
  heartbeat_ms?: number;
}

/** Budget hints exposed by callers for downstream coordination logic. */
export interface ChildBudgetHints {
  messages?: number;
  tool_calls?: number;
  tokens?: number;
  wallclock_ms?: number;
  bytes_in?: number;
  bytes_out?: number;
}

/** Sandbox configuration accepted from tool payloads. */
export interface ChildSandboxOptionsInput {
  profile?: ChildSandboxProfileName | string | null;
  allow_env?: readonly string[] | null;
  env?: Record<string, string> | undefined;
  inherit_default_env?: boolean;
}

/** Input structure parsed from the `child_create` tool schema. */
export interface ChildCreateRequest {
  op_id?: string;
  child_id?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  prompt?: PromptTemplate;
  tools_allow?: string[];
  timeouts?: ChildTimeoutOverrides;
  budget?: ChildBudgetHints;
  metadata?: Record<string, unknown>;
  manifest_extras?: Record<string, unknown>;
  wait_for_ready?: boolean;
  ready_type?: string;
  ready_timeout_ms?: number;
  initial_payload?: unknown;
  idempotency_key?: string;
}

/** Input structure parsed from the `child_spawn_codex` tool schema. */
export interface ChildSpawnCodexRequest {
  op_id?: string;
  role?: string;
  prompt: PromptTemplate;
  model_hint?: string;
  limits?: ChildRuntimeLimits | null;
  metadata?: Record<string, unknown>;
  manifest_extras?: Record<string, unknown>;
  ready_timeout_ms?: number;
  idempotency_key?: string;
  sandbox?: ChildSandboxOptionsInput;
}

/** Input payload for the batch create helper. */
export interface ChildBatchCreateRequest {
  entries: ChildSpawnCodexRequest[];
}

/** Input parsed from the `child_attach` tool schema. */
export interface ChildAttachRequest {
  child_id: string;
  manifest_extras?: Record<string, unknown>;
}

/** Input parsed from the `child_set_role` tool schema. */
export interface ChildSetRoleRequest {
  child_id: string;
  role: string;
  manifest_extras?: Record<string, unknown>;
}

/** Input parsed from the `child_set_limits` tool schema. */
export interface ChildSetLimitsRequest {
  child_id: string;
  limits?: ChildRuntimeLimits | null;
  manifest_extras?: Record<string, unknown>;
}

/** Sandbox execution configuration accepted by `child_send`. */
export interface ChildSendSandboxConfig {
  enabled?: boolean;
  action?: string;
  payload?: unknown;
  timeout_ms?: number;
  allow_failure?: boolean;
  require_handler?: boolean;
  metadata?: Record<string, unknown>;
}

/** Contract-Net configuration accepted by `child_send`. */
export interface ChildSendContractNetConfig {
  call_id: string;
  requested_agent_id?: string;
  auto_complete?: boolean;
}

/** Input parsed from the `child_send` tool schema. */
export interface ChildSendRequest {
  child_id: string;
  payload: unknown;
  expect?: "stream" | "final";
  timeout_ms?: number;
  sandbox?: ChildSendSandboxConfig;
  contract_net?: ChildSendContractNetConfig;
}

/** Input parsed from the `child_status` tool schema. */
export interface ChildStatusRequest {
  child_id: string;
}

/** Input parsed from the `child_collect` tool schema. */
export interface ChildCollectRequest {
  child_id: string;
}

/** Input parsed from the `child_stream` tool schema. */
export interface ChildStreamRequest {
  child_id: string;
  after_sequence?: number;
  limit?: number;
  streams?: ("stdout" | "stderr")[];
}

/** Input parsed from the `child_cancel` tool schema. */
export interface ChildCancelRequest {
  child_id: string;
  signal?: string;
  timeout_ms?: number;
}

/** Input parsed from the `child_kill` tool schema. */
export interface ChildKillRequest {
  child_id: string;
  timeout_ms?: number;
}

/** Input parsed from the `child_gc` tool schema. */
export interface ChildGcRequest {
  child_id: string;
}

/** Shape returned by {@link handleChildCreate}. */
export interface ChildCreateResult extends Record<string, unknown> {
  op_id: string;
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
  manifest_path: string;
  log_path: string;
  workdir: string;
  started_at: number;
  ready_message: unknown | null;
  sent_initial_payload: boolean;
  idempotent: boolean;
  idempotency_key: string | null;
}

type ChildCreateSnapshot = Omit<ChildCreateResult, "idempotent" | "idempotency_key">;

/** Shape returned by {@link handleChildSpawnCodex}. */
export interface ChildSpawnCodexResult extends Record<string, unknown> {
  op_id: string;
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
  manifest_path: string;
  log_path: string;
  workdir: string;
  started_at: number;
  ready_message: unknown | null;
  role: string | null;
  limits: ChildRuntimeLimits | null;
  endpoint: { url: string; headers: Record<string, string> } | null;
  idempotency_key: string | null;
  idempotent: boolean;
}

type ChildSpawnCodexSnapshot = Omit<ChildSpawnCodexResult, "idempotent">;

/** Shape returned by {@link handleChildBatchCreate}. */
export interface ChildBatchCreateResult extends Record<string, unknown> {
  children: ChildSpawnCodexResult[];
  created: number;
  idempotent_entries: number;
}

/** Shape returned by {@link handleChildAttach}. */
export interface ChildAttachResult extends Record<string, unknown> {
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
  attached_at: number | null;
}

/** Shape returned by {@link handleChildSetRole}. */
export interface ChildSetRoleResult extends Record<string, unknown> {
  child_id: string;
  role: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
}

/** Shape returned by {@link handleChildSetLimits}. */
export interface ChildSetLimitsResult extends Record<string, unknown> {
  child_id: string;
  limits: ChildRuntimeLimits | null;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
}

/** Shape returned by {@link handleChildSend}. */
export interface ChildSendResult extends Record<string, unknown> {
  child_id: string;
  message: SendResult;
  awaited_message: ChildRuntimeMessage | null;
  sandbox_result: SandboxExecutionResult | null;
  loop_alert: LoopAlert | null;
  contract_net: ContractNetDispatchSummary | null;
}

/** Shape returned by {@link handleChildStatus}. */
export interface ChildStatusResult extends Record<string, unknown> {
  child_id: string;
  runtime_status: ChildRuntimeStatus;
  index_snapshot: ChildRecordSnapshot;
}

/** Shape returned by {@link handleChildCollect}. */
export interface ChildCollectResult extends Record<string, unknown> {
  child_id: string;
  outputs: ChildCollectedOutputs;
}

/** Shape returned by {@link handleChildStream}. */
export interface ChildStreamResult extends Record<string, unknown> {
  child_id: string;
  slice: ChildMessageStreamResult;
}

/** Shape returned by {@link handleChildCancel}. */
export interface ChildCancelResult extends Record<string, unknown> {
  child_id: string;
  shutdown: ChildShutdownResult;
}

/** Shape returned by {@link handleChildKill}. */
export interface ChildKillResult extends Record<string, unknown> {
  child_id: string;
  shutdown: ChildShutdownResult;
}

/** Shape returned by {@link handleChildGc}. */
export interface ChildGcResult extends Record<string, unknown> {
  child_id: string;
  removed: boolean;
}

interface ContractNetDispatchSummary extends Record<string, unknown> {
  call_id: string;
  agent_id: string;
  cost: number;
  effective_cost: number;
}

/**
 * Serialises a Contract-Net award decision so the caller receives the public
 * identifiers and costs without exposing the internal decision object.
 */
function buildContractNetSummary(decision: ContractNetAwardDecision): ContractNetDispatchSummary {
  return {
    call_id: decision.callId,
    agent_id: decision.agentId,
    cost: decision.cost,
    effective_cost: Number(decision.effectiveCost.toFixed(6)),
  };
}

const pendingLoopSignatures = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers shared across the child connectors
// ---------------------------------------------------------------------------

function registerChildBudgetIfAny(
  context: ChildToolContext,
  childId: string,
  budget: ChildBudgetHints | undefined,
): void {
  if (!context.budget) {
    return;
  }
  const limits = extractBudgetLimits(budget);
  if (!limits) {
    return;
  }
  context.budget.registerChildBudget(childId, limits);
}

function extractBudgetLimits(budget: ChildBudgetHints | undefined): BudgetLimits | null {
  if (!budget) {
    return null;
  }
  const limits: BudgetLimits = {};
  if (typeof budget.wallclock_ms === "number" && Number.isFinite(budget.wallclock_ms)) {
    limits.timeMs = budget.wallclock_ms;
  }
  if (typeof budget.tokens === "number" && Number.isFinite(budget.tokens)) {
    limits.tokens = budget.tokens;
  }
  const toolCalls =
    typeof budget.tool_calls === "number" && Number.isFinite(budget.tool_calls)
      ? budget.tool_calls
      : typeof budget.messages === "number" && Number.isFinite(budget.messages)
        ? budget.messages
        : null;
  if (toolCalls !== null) {
    limits.toolCalls = toolCalls;
  }
  if (typeof budget.bytes_in === "number" && Number.isFinite(budget.bytes_in)) {
    limits.bytesIn = budget.bytes_in;
  }
  if (typeof budget.bytes_out === "number" && Number.isFinite(budget.bytes_out)) {
    limits.bytesOut = budget.bytes_out;
  }
  return Object.keys(limits).length > 0 ? limits : null;
}

type CreateJsonRpcErrorFn = typeof import("../rpc/middleware.js").createJsonRpcError;
let cachedCreateJsonRpcError: CreateJsonRpcErrorFn | undefined;

async function getCreateJsonRpcError(): Promise<CreateJsonRpcErrorFn> {
  if (!cachedCreateJsonRpcError) {
    ({ createJsonRpcError: cachedCreateJsonRpcError } = await import("../rpc/middleware.js"));
  }
  return cachedCreateJsonRpcError;
}

async function consumeChildBudgetOrThrow(
  manager: ChildBudgetManager | undefined,
  childId: string,
  consumption: BudgetConsumption,
  metadata: BudgetUsageMetadata,
): Promise<BudgetCharge | null> {
  if (!manager) {
    return null;
  }
  try {
    return manager.consumeChildBudget(childId, consumption, metadata);
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      const createJsonRpcError = await getCreateJsonRpcError();
      throw createJsonRpcError("BUDGET_EXCEEDED", "Child budget exhausted", {
        hint: `child budget exceeded on ${error.dimension}`,
        status: 429,
        meta: {
          child_id: childId,
          dimension: error.dimension,
          remaining: error.remaining,
          attempted: error.attempted,
          limit: error.limit,
        },
      });
    }
    throw error;
  }
}

function refundChildBudget(
  manager: ChildBudgetManager | undefined,
  childId: string,
  charge: BudgetCharge | null | undefined,
): void {
  if (!manager || !charge) {
    return;
  }
  manager.refundChildBudget(childId, charge);
}

function buildManifestExtras(input: ChildCreateRequest): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {
    ...(input.manifest_extras ?? {}),
  };

  if (input.prompt) {
    extras.prompt = structuredClone(input.prompt);
  }
  if (input.timeouts) {
    extras.timeouts = structuredClone(input.timeouts);
  }
  if (input.budget) {
    extras.budget = structuredClone(input.budget);
  }

  return Object.keys(extras).length > 0 ? extras : undefined;
}

function buildSpawnCodexManifestExtras(input: ChildSpawnCodexRequest): Record<string, unknown> {
  const extras: Record<string, unknown> = {
    prompt: structuredClone(input.prompt),
  };

  if (input.manifest_extras) {
    Object.assign(extras, structuredClone(input.manifest_extras));
  }
  if (input.model_hint) {
    extras.model_hint = input.model_hint;
  }
  if (input.idempotency_key) {
    extras.idempotency_key = input.idempotency_key;
  }
  if (input.role) {
    extras.role = input.role;
  }
  return extras;
}

function isHttpLoopbackEnabled(): boolean {
  return readBool("MCP_HTTP_STATELESS", false);
}

function buildHttpChildEndpoint(
  context: ChildToolContext,
  childId: string,
  limits: ChildRuntimeLimits | null,
): { url: string; headers: Record<string, string> } {
  const inherited = (() => {
    const routeContext = getJsonRpcContext();
    if (!routeContext?.childId) {
      return null;
    }
    return context.supervisor.getHttpEndpoint(routeContext.childId) ?? null;
  })();

  if (inherited) {
    const headers = { ...inherited.headers };
    headers["x-child-id"] = childId;

    if (limits && Object.keys(limits).length > 0) {
      headers["x-child-limits"] = Buffer.from(JSON.stringify(limits), "utf8").toString("base64");
    } else {
      delete headers["x-child-limits"];
    }

    if (!headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    if (!headers.accept) {
      headers.accept = "application/json";
    }

    return { url: inherited.url, headers };
  }

  const host = readString("MCP_HTTP_HOST", "127.0.0.1");
  const port = readOptionalInt("MCP_HTTP_PORT", { min: 1, max: 65_535 }) ?? 8765;
  let path = readString("MCP_HTTP_PATH", "/mcp");
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  const url = `http://${host}:${port}${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    "x-child-id": childId,
  };

  const token = readOptionalString("MCP_HTTP_TOKEN", { allowEmpty: false });
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  if (limits && Object.keys(limits).length > 0) {
    headers["x-child-limits"] = Buffer.from(JSON.stringify(limits), "utf8").toString("base64");
  }

  return { url, headers };
}

function toSandboxEnvKey(candidate: string | undefined): string | null {
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? trimmed : null;
}

function normaliseChildSandboxRequestInput(
  input: ChildSandboxOptionsInput | undefined,
): ChildSandboxRequest | null {
  if (!input) {
    return null;
  }
  const allowEnv = new Set<string>();
  if (Array.isArray(input.allow_env)) {
    for (const key of input.allow_env) {
      const normalised = toSandboxEnvKey(key);
      if (normalised) {
        allowEnv.add(normalised);
      }
    }
  }

  let env: ProcessEnv | null = null;
  if (input.env) {
    env = {} as ProcessEnv;
    for (const [key, value] of Object.entries(input.env)) {
      const normalisedKey = toSandboxEnvKey(key);
      if (!normalisedKey) {
        continue;
      }
      env[normalisedKey] = String(value);
      allowEnv.add(normalisedKey);
    }
    if (Object.keys(env).length === 0) {
      env = null;
    }
  }

  const allowEnvList = Array.from(allowEnv);

  return {
    profile: (input.profile as ChildSandboxProfileName | undefined) ?? null,
    allowEnv: allowEnvList.length > 0 ? allowEnvList : null,
    env,
    inheritDefaultEnv:
      typeof input.inherit_default_env === "boolean" ? input.inherit_default_env : null,
  };
}

function summariseChildBatchEntry(entry: ChildSpawnCodexRequest): Record<string, unknown> {
  const prompt = (entry as { prompt?: Record<string, unknown> }).prompt;
  const promptKeys = prompt && typeof prompt === "object" ? Object.keys(prompt) : [];
  return {
    role: typeof entry.role === "string" ? entry.role : null,
    idempotency_key: typeof entry.idempotency_key === "string" ? entry.idempotency_key : null,
    prompt_keys: promptKeys,
  };
}

function deriveContractNetProfile(input: ChildCreateRequest): RegisterAgentOptions {
  const profile: RegisterAgentOptions = {};
  profile.baseCost = deriveContractNetBaseCost(input);
  const reliability = deriveContractNetReliability(input.metadata);
  if (typeof reliability === "number") {
    profile.reliability = reliability;
  }
  const tags = deriveContractNetTags(input);
  if (tags.length > 0) {
    profile.tags = tags;
  }
  const metadata: Record<string, unknown> = {};
  if (input.metadata) {
    metadata.metadata = structuredClone(input.metadata);
  }
  if (input.budget) {
    metadata.budget = structuredClone(input.budget);
  }
  if (input.timeouts) {
    metadata.timeouts = structuredClone(input.timeouts);
  }
  if (input.tools_allow) {
    metadata.allowed_tools = structuredClone(input.tools_allow);
  }
  if (Object.keys(metadata).length > 0) {
    profile.metadata = metadata;
  }
  return profile;
}

function deriveContractNetBaseCost(input: ChildCreateRequest): number {
  const budget = input.budget ?? {};
  if (typeof budget.tool_calls === "number" && Number.isFinite(budget.tool_calls)) {
    return Math.max(1, budget.tool_calls * 25);
  }
  if (typeof budget.wallclock_ms === "number" && Number.isFinite(budget.wallclock_ms)) {
    return Math.max(1, Math.round(budget.wallclock_ms / 100));
  }
  if (typeof budget.tokens === "number" && Number.isFinite(budget.tokens)) {
    return Math.max(1, Math.round(budget.tokens / 50));
  }
  if (typeof budget.messages === "number" && Number.isFinite(budget.messages)) {
    return Math.max(1, budget.messages * 25);
  }
  return 100;
}

function deriveContractNetReliability(metadata: unknown): number | undefined {
  const record = toRecord(metadata);
  if (!record) {
    return undefined;
  }
  const contractNet = toRecord(record.contract_net);
  if (!contractNet) {
    return undefined;
  }
  const value = contractNet.reliability;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function deriveContractNetTags(input: ChildCreateRequest): string[] {
  const tags = new Set<string>();
  for (const tool of input.tools_allow ?? []) {
    tags.add(`tool:${tool}`);
  }
  const metadata = toRecord(input.metadata);
  if (metadata) {
    for (const tag of extractStringArray(metadata.tags)) {
      tags.add(tag);
    }
  }
  return Array.from(tags);
}

function mergeLoopAlerts(
  existing: LoopAlert | null,
  candidate: LoopAlert | null,
  context: ChildToolContext,
): LoopAlert | null {
  const alert = chooseMostSevereAlert(existing, candidate);
  if (alert && (!existing || alert !== existing)) {
    context.logger.warn("loop_detector_alert", {
      child_ids: alert.childIds,
      participants: alert.participants,
      recommendation: alert.recommendation,
      reason: alert.reason,
      occurrences: alert.occurrences,
    });
  }
  return alert;
}

function chooseMostSevereAlert(first: LoopAlert | null, second: LoopAlert | null): LoopAlert | null {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  if (first.recommendation === "kill" && second.recommendation !== "kill") {
    return first;
  }
  if (second.recommendation === "kill" && first.recommendation !== "kill") {
    return second;
  }
  return second.lastTimestamp >= first.lastTimestamp ? second : first;
}

function clearLoopSignature(childId: string): void {
  pendingLoopSignatures.delete(childId);
}

const MAX_LOG_EXCERPT_LENGTH = 1_024;

function serialiseForLog(value: unknown): string {
  try {
    const serialised = JSON.stringify(value);
    if (!serialised) {
      return "";
    }
    if (serialised.length <= MAX_LOG_EXCERPT_LENGTH) {
      return serialised;
    }
    return `${serialised.slice(0, MAX_LOG_EXCERPT_LENGTH)}…`;
  } catch (error) {
    return `[unserialisable:${error instanceof Error ? error.message : String(error)}]`;
  }
}

function childMessageExcerpt(message: ChildRuntimeMessage | null): string | null {
  if (!message) {
    return null;
  }
  if (message.parsed !== null && message.parsed !== undefined) {
    return serialiseForLog(message.parsed);
  }
  return message.raw.length <= MAX_LOG_EXCERPT_LENGTH
    ? message.raw
    : `${message.raw.slice(0, MAX_LOG_EXCERPT_LENGTH)}…`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function extractRequestedTool(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const direct = record.tool;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (typeof record.type === "string") {
    const typeValue = record.type.toLowerCase();
    if ((typeValue === "tool" || typeValue === "call_tool") && typeof record.name === "string" && record.name.trim()) {
      return record.name.trim();
    }
  }
  const alt = record.tool_name ?? record.toolName;
  if (typeof alt === "string" && alt.trim()) {
    return alt.trim();
  }
  return null;
}

function isHighRiskTask(metadata?: Record<string, unknown>): boolean {
  if (!metadata) {
    return false;
  }
  const direct = [metadata.risk, metadata.risk_level, metadata.severity, metadata.safety];
  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate.trim().toLowerCase() === "high") {
      return true;
    }
  }
  const booleanFlag = metadata.high_risk;
  if (booleanFlag === true || (typeof booleanFlag === "string" && booleanFlag.toLowerCase() === "true")) {
    return true;
  }
  const tags = metadata.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === "string" && tag.toLowerCase().includes("high-risk")) {
        return true;
      }
    }
  }
  return false;
}

const FINAL_MESSAGE_TYPES = new Set([
  "response",
  "result",
  "final",
  "completion",
  "done",
]);

function matchesStreamMessage(message: ChildRuntimeMessage): boolean {
  if (message.stream !== "stdout") {
    return false;
  }
  const type = extractMessageType(message);
  if (!type) {
    return true;
  }
  if (type === "ready" || FINAL_MESSAGE_TYPES.has(type)) {
    return false;
  }
  return true;
}

function matchesFinalMessage(message: ChildRuntimeMessage): boolean {
  if (message.stream !== "stdout") {
    return false;
  }
  const type = extractMessageType(message);
  if (!type) {
    return false;
  }
  return FINAL_MESSAGE_TYPES.has(type) || type === "error";
}

function extractMessageType(message: ChildRuntimeMessage): string | null {
  if (!message.parsed || typeof message.parsed !== "object") {
    return null;
  }
  const candidate = (message.parsed as { type?: unknown }).type;
  return typeof candidate === "string" ? candidate : null;
}

function cloneChildMessage(message: ChildRuntimeMessage): ChildRuntimeMessage {
  const parsedClone =
    message.parsed === null || message.parsed === undefined
      ? message.parsed
      : JSON.parse(JSON.stringify(message.parsed));
  return { ...message, parsed: parsedClone };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const normalised = entry.trim();
      if (normalised.length > 0) {
        result.push(normalised);
      }
    }
  }
  return result;
}

function extractTaskIdentifier(metadata?: Record<string, unknown>): string | null {
  if (!metadata) {
    return null;
  }
  const candidates = [metadata.task_id, metadata.taskId, metadata.job_id, metadata.jobId];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractTaskType(metadata?: Record<string, unknown>): string {
  if (metadata) {
    const candidates = [metadata.task_type, metadata.taskType, metadata.role, metadata.mode];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return "child_send";
}

/**
 * Normalises the loop detector sample so optional identifiers are omitted when unknown.
 * This keeps the structure compatible with `exactOptionalPropertyTypes` by setting
 * the `taskId` field only when the caller surfaced a concrete identifier in the metadata.
 */
function buildLoopInteractionSample(
  from: string,
  to: string,
  signature: string,
  childId: string,
  taskType: string,
  taskId: string | null,
): LoopInteractionSample {
  const sample: LoopInteractionSample = {
    from,
    to,
    signature,
    childId,
    taskType,
  };
  if (taskId) {
    sample.taskId = taskId;
  }
  return sample;
}

/**
 * Generates a compact summary of the payload so loop detection heuristics can
 * differentiate exchanges without leaking sensitive data.
 */
function summariseLoopPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "null";
  }
  if (typeof payload === "string") {
    return payload.slice(0, 48);
  }
  if (typeof payload === "number" || typeof payload === "boolean") {
    return String(payload);
  }
  if (Array.isArray(payload)) {
    return `array:${payload.length}`;
  }
  if (typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const typeLike = record.type ?? record.name ?? record.action ?? record.kind;
    if (typeof typeLike === "string" && typeLike.trim()) {
      return typeLike.trim().slice(0, 48);
    }
    return `object:${Object.keys(record)
      .sort()
      .slice(0, 3)
      .join(",")}`;
  }
  return "unknown";
}

/**
 * Computes and stores the latest loop signature so follow-up responses can be
 * correlated with the outbound payload.
 */
function rememberLoopSignature(
  childId: string,
  metadata: Record<string, unknown> | undefined,
  payload: unknown,
): string {
  const taskId = extractTaskIdentifier(metadata) ?? "default";
  const taskType = extractTaskType(metadata);
  const payloadSummary = summariseLoopPayload(payload);
  const signature = `child:${childId}|task:${taskType}|id:${taskId}|payload:${payloadSummary}`;
  pendingLoopSignatures.set(childId, signature);
  return signature;
}

// ---------------------------------------------------------------------------
// Child tool connectors
// ---------------------------------------------------------------------------

export async function handleChildCreate(
  context: ChildToolContext,
  input: ChildCreateRequest,
): Promise<ChildCreateResult> {
  const opId = resolveOperationId(input.op_id, "child_create_op");
  const execute = async (): Promise<ChildCreateSnapshot> => {
    const manifestExtras = buildManifestExtras(input);
    const options: CreateChildOptions = {
      ...(input.child_id !== undefined ? { childId: input.child_id } : {}),
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(manifestExtras !== undefined ? { manifestExtras } : {}),
      ...(input.tools_allow !== undefined ? { toolsAllow: input.tools_allow ?? null } : {}),
      ...(input.wait_for_ready !== undefined ? { waitForReady: input.wait_for_ready } : {}),
      ...(input.ready_type !== undefined ? { readyType: input.ready_type } : {}),
      ...(input.ready_timeout_ms !== undefined ? { readyTimeoutMs: input.ready_timeout_ms } : {}),
    };

    context.logger.info("child_create_requested", {
      op_id: opId,
      child_id: options.childId ?? null,
      command: options.command ?? null,
      args: options.args?.length ?? 0,
      idempotency_key: input.idempotency_key ?? null,
    });

    const created = await context.supervisor.createChild(options);
    const runtimeStatus = created.runtime.getStatus();
    const readyMessage = created.readyMessage ? created.readyMessage.parsed ?? created.readyMessage.raw : null;

    let sentInitialPayload = false;
    if (input.initial_payload !== undefined) {
      await context.supervisor.send(created.childId, input.initial_payload);
      sentInitialPayload = true;
    }

    context.logger.info("child_create_succeeded", {
      op_id: opId,
      child_id: created.childId,
      pid: runtimeStatus.pid,
      workdir: runtimeStatus.workdir,
      idempotency_key: input.idempotency_key ?? null,
    });

    if (context.contractNet) {
      const profile = deriveContractNetProfile(input);
      const snapshot = context.contractNet.registerAgent(created.childId, profile);
      context.logger.info("contract_net_agent_registered", {
        op_id: opId,
        agent_id: snapshot.agentId,
        base_cost: snapshot.baseCost,
        reliability: snapshot.reliability,
        tags: snapshot.tags,
      });
    }

    return {
      op_id: opId,
      child_id: created.childId,
      runtime_status: runtimeStatus,
      index_snapshot: created.index,
      manifest_path: created.runtime.manifestPath,
      log_path: created.runtime.logPath,
      workdir: runtimeStatus.workdir,
      started_at: runtimeStatus.startedAt,
      ready_message: readyMessage,
      sent_initial_payload: sentInitialPayload,
    };
  };

  const key = input.idempotency_key ?? null;
  if (context.idempotency && key) {
    const { op_id: _omitOpId, idempotency_key: _omitKey, ...fingerprint } = input;
    const cacheKey = buildIdempotencyCacheKey("child_create", key, fingerprint);
    const hit = await context.idempotency.remember<ChildCreateSnapshot>(cacheKey, execute);
    if (hit.idempotent) {
      const snapshot = hit.value as ChildCreateSnapshot;
      context.logger.info("child_create_replayed", {
        idempotency_key: key,
        child_id: snapshot.child_id,
        op_id: snapshot.op_id,
      });
    }
    const snapshot = hit.value as ChildCreateSnapshot;
    if (typeof snapshot.child_id === "string" && snapshot.child_id.length > 0) {
      registerChildBudgetIfAny(context, snapshot.child_id, input.budget);
    }
    return {
      ...snapshot,
      op_id: snapshot.op_id ?? opId,
      idempotent: hit.idempotent,
      idempotency_key: key,
    } as ChildCreateResult;
  }

  const result = await execute();
  if (typeof result.child_id === "string" && result.child_id.length > 0) {
    registerChildBudgetIfAny(context, result.child_id, input.budget);
  }
  return { ...result, op_id: opId, idempotent: false, idempotency_key: key } as ChildCreateResult;
}

export async function handleChildSpawnCodex(
  context: ChildToolContext,
  input: ChildSpawnCodexRequest,
): Promise<ChildSpawnCodexResult> {
  const opId = resolveOperationId(input.op_id, "child_spawn_op");
  const execute = async (): Promise<ChildSpawnCodexSnapshot> => {
    const manifestExtras = buildSpawnCodexManifestExtras(input);
    const metadata: Record<string, unknown> = structuredClone(input.metadata ?? {});
    const limitsCopy: ChildRuntimeLimits | null = input.limits ? structuredClone(input.limits) : null;
    const role = input.role ?? null;
    const idempotencyKey = input.idempotency_key ?? null;
    const sandboxRequest = normaliseChildSandboxRequestInput(input.sandbox);

    metadata.op_id = opId;
    if (role) {
      metadata.role = role;
    }
    if (input.model_hint) {
      metadata.model_hint = input.model_hint;
    }
    if (idempotencyKey) {
      metadata.idempotency_key = idempotencyKey;
    }
    if (limitsCopy) {
      metadata.limits = structuredClone(limitsCopy);
    }
    if (sandboxRequest?.profile) {
      metadata.sandbox_profile_requested = sandboxRequest.profile;
    }
    if (sandboxRequest?.allowEnv && sandboxRequest.allowEnv.length > 0) {
      metadata.sandbox_allow_env = [...sandboxRequest.allowEnv];
    }

    context.logger.info("child_spawn_codex_requested", {
      op_id: opId,
      role,
      limit_keys: limitsCopy ? Object.keys(limitsCopy).length : 0,
      idempotency_key: idempotencyKey,
      sandbox_profile: sandboxRequest?.profile ?? null,
      sandbox_allow_env: sandboxRequest?.allowEnv?.length ?? 0,
    });

    if (isHttpLoopbackEnabled()) {
      const childId = context.supervisor.createChildId();
      const endpoint = buildHttpChildEndpoint(context, childId, limitsCopy);
      const registration = await context.supervisor.registerHttpChild({
        childId,
        endpoint,
        metadata,
        limits: limitsCopy,
        role,
        manifestExtras,
      });
      const statusSnapshot = context.supervisor.status(childId);

      context.logger.info("child_spawn_codex_ready", {
        op_id: opId,
        child_id: childId,
        pid: null,
        workdir: registration.workdir,
        endpoint_url: endpoint.url,
        idempotency_key: idempotencyKey,
      });

      return {
        op_id: opId,
        child_id: childId,
        runtime_status: statusSnapshot.runtime,
        index_snapshot: statusSnapshot.index,
        manifest_path: registration.manifestPath,
        log_path: registration.logPath,
        workdir: registration.workdir,
        started_at: registration.startedAt,
        ready_message: null,
        role: statusSnapshot.index.role,
        limits: statusSnapshot.index.limits,
        endpoint,
        idempotency_key: idempotencyKey,
      } satisfies ChildSpawnCodexSnapshot;
    }

    const readyTimeoutMs =
      typeof input.ready_timeout_ms === "number" && Number.isFinite(input.ready_timeout_ms)
        ? Math.max(1, Math.trunc(input.ready_timeout_ms))
        : 8_000;

    const created = await context.supervisor.createChild({
      role,
      manifestExtras,
      metadata,
      limits: limitsCopy,
      waitForReady: true,
      readyTimeoutMs,
      sandbox: sandboxRequest,
    });

    const runtimeStatus = created.runtime.getStatus();
    const readyMessage = created.readyMessage ? created.readyMessage.parsed ?? created.readyMessage.raw : null;

    context.logger.info("child_spawn_codex_ready", {
      op_id: opId,
      child_id: created.childId,
      pid: runtimeStatus.pid,
      workdir: runtimeStatus.workdir,
      ready_timeout_ms: readyTimeoutMs,
      idempotency_key: idempotencyKey,
    });

    return {
      op_id: opId,
      child_id: created.childId,
      runtime_status: runtimeStatus,
      index_snapshot: created.index,
      manifest_path: created.runtime.manifestPath,
      log_path: created.runtime.logPath,
      workdir: runtimeStatus.workdir,
      started_at: runtimeStatus.startedAt,
      ready_message: readyMessage,
      role: created.index.role,
      limits: created.index.limits,
      endpoint: null,
      idempotency_key: idempotencyKey,
    };
  };

  const key = input.idempotency_key ?? null;
  if (context.idempotency && key) {
    const cacheKey = buildIdempotencyCacheKey("child_spawn_codex", key, input);
    const hit = await context.idempotency.remember<ChildSpawnCodexSnapshot>(cacheKey, execute);
    if (hit.idempotent) {
      const snapshot = hit.value as ChildSpawnCodexSnapshot;
      context.logger.info("child_spawn_codex_replayed", {
        idempotency_key: key,
        child_id: snapshot.child_id,
        op_id: snapshot.op_id,
      });
    }
    const snapshot = hit.value as ChildSpawnCodexSnapshot;
    return { ...snapshot, op_id: snapshot.op_id ?? opId, idempotent: hit.idempotent } as ChildSpawnCodexResult;
  }

  const result = await execute();
  return { ...result, op_id: opId, idempotent: false } as ChildSpawnCodexResult;
}

export async function handleChildBatchCreate(
  context: ChildToolContext,
  input: ChildBatchCreateRequest,
): Promise<ChildBatchCreateResult> {
  context.logger.info("child_batch_create_requested", { entries: input.entries.length });

  const execute = async (): Promise<ChildBatchCreateResult> => {
    const results: ChildSpawnCodexResult[] = [];
    const createdChildIds: string[] = [];
    let failingIndex: number | null = null;
    let failingSummary: Record<string, unknown> | null = null;

    try {
      for (let index = 0; index < input.entries.length; index += 1) {
        const entry = input.entries[index]!;
        try {
          const snapshot = await handleChildSpawnCodex(context, entry);
          results.push(snapshot);
          if (!snapshot.idempotent) {
            createdChildIds.push(snapshot.child_id);
          }
        } catch (error) {
          failingIndex = index;
          failingSummary = summariseChildBatchEntry(entry);
          throw error;
        }
      }
    } catch (error) {
      for (const childId of createdChildIds.reverse()) {
        try {
          context.logger.warn("child_batch_create_rollback", { child_id: childId });
          await context.supervisor.kill(childId, { timeoutMs: 200 });
          await context.supervisor.waitForExit(childId, 1_000);
        } catch (shutdownError) {
          context.logger.error("child_batch_create_rollback_failed", {
            child_id: childId,
            reason: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
          });
        } finally {
          try {
            context.supervisor.gc(childId);
          } catch {
            // child already reclaimed
          }
          clearLoopSignature(childId);
        }
      }

      const entrySummary = failingSummary;
      throw new BulkOperationError("child batch aborted", {
        failures: [
          buildBulkFailureDetail({
            index: failingIndex ?? 0,
            entry: entrySummary,
            error,
            stage: "spawn",
          }),
        ],
        rolled_back: true,
        metadata: {
          rollback_child_ids: [...createdChildIds].reverse(),
        },
      });
    }

    const idempotentCount = results.filter((entry) => entry.idempotent).length;
    context.logger.info("child_batch_create_succeeded", {
      entries: input.entries.length,
      created: results.length - idempotentCount,
      replayed: idempotentCount,
    });

    return {
      children: results,
      created: results.length - idempotentCount,
      idempotent_entries: idempotentCount,
    };
  };

  const aggregatedKey = (() => {
    const parts: string[] = [];
    for (let index = 0; index < input.entries.length; index += 1) {
      const entry = input.entries[index]!;
      if (!entry.idempotency_key) {
        return null;
      }
      parts.push(`${index}:${entry.idempotency_key}`);
    }
    return parts.length > 0 ? parts.join('|') : null;
  })();

  if (context.idempotency && aggregatedKey) {
    const fingerprint = input.entries.map((entry) => {
      const { op_id: _omitOpId, idempotency_key: _omitKey, ...rest } = entry;
      return rest;
    });
    const cacheKey = buildIdempotencyCacheKey("child_batch_create", aggregatedKey, fingerprint);
    const hit = await context.idempotency.remember<ChildBatchCreateResult>(cacheKey, execute);
    if (hit.idempotent) {
      const replayedChildren = hit.value.children.map((child) => ({
        ...child,
        idempotent: true,
      }));
      const replayedResult: ChildBatchCreateResult = {
        ...hit.value,
        children: replayedChildren,
        created: 0,
        idempotent_entries: replayedChildren.length,
      };
      context.logger.info("child_batch_create_replayed", {
        entries: input.entries.length,
        idempotent_entries: replayedResult.idempotent_entries,
      });
      return replayedResult;
    }
    return hit.value;
  }

  return execute();
}

export async function handleChildAttach(
  context: ChildToolContext,
  input: ChildAttachRequest,
): Promise<ChildAttachResult> {
  context.logger.info("child_attach_requested", { child_id: input.child_id });
  const result = await context.supervisor.attachChild(input.child_id, {
    manifestExtras: input.manifest_extras ?? {},
  });
  context.logger.info("child_attach_succeeded", {
    child_id: input.child_id,
    attached_at: result.index.attachedAt,
  });
  return {
    child_id: input.child_id,
    runtime_status: result.runtime,
    index_snapshot: result.index,
    attached_at: result.index.attachedAt,
  };
}

export async function handleChildSetRole(
  context: ChildToolContext,
  input: ChildSetRoleRequest,
): Promise<ChildSetRoleResult> {
  context.logger.info("child_set_role_requested", {
    child_id: input.child_id,
    role: input.role,
  });
  const result = await context.supervisor.setChildRole(input.child_id, input.role, {
    manifestExtras: input.manifest_extras ?? {},
  });
  context.logger.info("child_set_role_succeeded", {
    child_id: input.child_id,
    role: result.index.role,
  });
  return {
    child_id: input.child_id,
    role: result.index.role ?? input.role,
    runtime_status: result.runtime,
    index_snapshot: result.index,
  };
}

export async function handleChildSetLimits(
  context: ChildToolContext,
  input: ChildSetLimitsRequest,
): Promise<ChildSetLimitsResult> {
  const requested = input.limits ?? null;
  context.logger.info("child_set_limits_requested", {
    child_id: input.child_id,
    limit_keys: requested ? Object.keys(requested).length : 0,
  });
  const result = await context.supervisor.setChildLimits(input.child_id, requested, {
    manifestExtras: input.manifest_extras ?? {},
  });
  context.logger.info("child_set_limits_succeeded", {
    child_id: input.child_id,
    limit_keys: result.limits ? Object.keys(result.limits).length : 0,
  });
  return {
    child_id: input.child_id,
    limits: result.limits,
    runtime_status: result.runtime,
    index_snapshot: result.index,
  };
}

export async function handleChildSend(
  context: ChildToolContext,
  input: ChildSendRequest,
): Promise<ChildSendResult> {
  const contractNetConfig = input.contract_net ?? null;
  let contractNetDecision: ContractNetAwardDecision | null = null;
  let resolvedChildId = input.child_id;

  if (contractNetConfig) {
    if (!context.contractNet) {
      throw new Error("Contract-Net coordinator is not enabled");
    }
    const requested =
      contractNetConfig.requested_agent_id ?? (input.child_id !== "auto" ? input.child_id : undefined);
    const normalisedRequest = requested === "auto" ? undefined : requested;
    contractNetDecision = context.contractNet.award(contractNetConfig.call_id, normalisedRequest);
    resolvedChildId = contractNetDecision.agentId;
  }

  const childId = resolvedChildId;
  const budgetManager = context.budget;
  const payloadTokens = estimateTokenUsage(input.payload);
  const payloadBytes = measureBudgetBytes(input.payload);
  let requestCharge: BudgetCharge | null = null;
  requestCharge = await consumeChildBudgetOrThrow(
    budgetManager,
    childId,
    { toolCalls: 1, tokens: payloadTokens, bytesOut: payloadBytes },
    { actor: "orchestrator", operation: "child_send", stage: "request" },
  );

  context.logger.info("child_send", {
    child_id: childId,
    contract_net_call: contractNetConfig?.call_id ?? null,
  });

  context.logger.logCognitive({
    actor: "orchestrator",
    phase: "prompt",
    childId,
    content: serialiseForLog(input.payload),
    metadata: {
      expect: input.expect ?? null,
      sandbox: input.sandbox ?? null,
      contract_net_call: contractNetConfig?.call_id ?? null,
    },
  });

  const startedAt = Date.now();
  let awaitedMessage: ChildRuntimeMessage | null = null;

  const childSnapshot = context.supervisor.childrenIndex.getChild(childId);
  try {
    const metadataRecord = toRecord(childSnapshot?.metadata);
    const highRisk = isHighRiskTask(metadataRecord);
    const sandboxConfig = input.sandbox;
    const sandboxEnabled = highRisk ? sandboxConfig?.enabled !== false : sandboxConfig?.enabled === true;
    let sandboxResult: SandboxExecutionResult | null = null;
    const loopDetector = context.loopDetector ?? null;
    const loopTaskId = extractTaskIdentifier(metadataRecord);
    const loopTaskType = extractTaskType(metadataRecord);
    let loopAlert: LoopAlert | null = null;
    const allowedTools = context.supervisor.getAllowedTools(childId);
    const requestedTool = extractRequestedTool(input.payload);
    if (requestedTool && allowedTools.length > 0 && !allowedTools.includes(requestedTool)) {
      throw new Error(
        `Tool "${requestedTool}" is not allowed for child ${childId}. Allowed tools: ${allowedTools.join(", ")}`,
      );
    }

    if (sandboxEnabled) {
      const registry = getSandboxRegistry();
      const actionName = (sandboxConfig?.action ?? "dry-run").trim() || "dry-run";
      const requestPayload = sandboxConfig?.payload ?? input.payload;
      const baseMetadata = toRecord(sandboxConfig?.metadata) ?? {};
      const sandboxMetadata: Record<string, unknown> = {
        ...baseMetadata,
        child_id: childId,
        high_risk: highRisk,
      };
      if (!registry.has(actionName)) {
        if (sandboxConfig?.require_handler) {
          throw new Error(`Sandbox handler "${actionName}" is not registered`);
        }
        const now = Date.now();
        sandboxResult = {
          action: actionName,
          status: "skipped",
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          reason: "handler_missing",
          metadata: sandboxMetadata,
        };
        context.logger.warn("child_send_sandbox_missing_handler", {
          child_id: childId,
          action: actionName,
        });
      } else {
        const timeoutOverride = sandboxConfig?.timeout_ms;
        const sandboxRequest = {
          action: actionName,
          payload: requestPayload,
          metadata: sandboxMetadata,
          ...(timeoutOverride !== undefined ? { timeoutMs: timeoutOverride } : {}),
        };
        sandboxResult = await registry.execute(sandboxRequest);
        context.logger.info("child_send_sandbox", {
          child_id: childId,
          action: actionName,
          status: sandboxResult.status,
          duration_ms: sandboxResult.durationMs,
        });
        if (sandboxResult.status !== "ok" && sandboxConfig?.allow_failure !== true) {
          const reason = sandboxResult.reason ?? sandboxResult.error?.message ?? sandboxResult.status;
          throw new Error(`Sandbox action "${actionName}" failed before child_send: ${reason}`);
        }
      }
    }

    let baselineSequence = 0;
    if (input.expect) {
      const snapshot = context.supervisor.stream(childId, { limit: 1 });
      baselineSequence = snapshot.totalMessages;
    }

    const message = await context.supervisor.send(childId, input.payload);
    const loopSignature = loopDetector ? rememberLoopSignature(childId, metadataRecord, input.payload) : null;

    if (loopDetector && loopSignature) {
      const outboundSample = buildLoopInteractionSample(
        "orchestrator",
        `child:${childId}`,
        loopSignature,
        childId,
        loopTaskType,
        loopTaskId,
      );
      loopAlert = mergeLoopAlerts(
        loopAlert,
        loopDetector.recordInteraction(outboundSample),
        context,
      );
      if (loopAlert && context.supervisorAgent) {
        await context.supervisorAgent.recordLoopAlert(loopAlert);
      }
    }

    if (!input.expect) {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      context.logger.info("child_send_completed", {
        child_id: childId,
        duration_ms: elapsedMs,
        awaited_type: null,
        awaited_sequence: null,
        excerpt: null,
      });
      if (contractNetDecision && (contractNetConfig?.auto_complete ?? true)) {
        context.contractNet?.complete(contractNetDecision.callId);
      }
      const contractNetSummary = contractNetDecision ? buildContractNetSummary(contractNetDecision) : null;
      return {
        child_id: childId,
        message,
        awaited_message: null,
        sandbox_result: sandboxResult,
        loop_alert: loopAlert,
        contract_net: contractNetSummary,
      } satisfies ChildSendResult;
    }

    const timeoutMs = input.timeout_ms ?? (input.expect === "final" ? 8_000 : 2_000);
    const matcher = input.expect === "final" ? matchesFinalMessage : matchesStreamMessage;

    try {
      const awaited = await waitForExpectedMessage(context, childId, baselineSequence, matcher, timeoutMs);
      awaitedMessage = awaited;

      if (loopDetector && loopSignature) {
        const inboundSample = buildLoopInteractionSample(
          `child:${childId}`,
          "orchestrator",
          loopSignature,
          childId,
          loopTaskType,
          loopTaskId,
        );
        loopAlert = mergeLoopAlerts(loopAlert, loopDetector.recordInteraction(inboundSample), context);
        if (loopAlert && context.supervisorAgent) {
          await context.supervisorAgent.recordLoopAlert(loopAlert);
        }
        const duration = Math.max(1, awaited.receivedAt - message.sentAt);
        loopDetector.recordTaskObservation({
          taskType: loopTaskType,
          durationMs: duration,
          success: true,
        });
      }

      context.logger.logCognitive({
        actor: `child:${childId}`,
        phase: "resume",
        childId,
        content: childMessageExcerpt(awaited),
        metadata: {
          stream: awaited.stream,
          sequence: awaited.sequence,
        },
      });

      const elapsedMs = Math.max(0, Date.now() - startedAt);
      context.logger.info("child_send_completed", {
        child_id: childId,
        duration_ms: elapsedMs,
        awaited_type: extractMessageType(awaited),
        awaited_sequence: awaited.sequence,
        excerpt: childMessageExcerpt(awaited),
      });

      if (contractNetDecision && (contractNetConfig?.auto_complete ?? true)) {
        context.contractNet?.complete(contractNetDecision.callId);
      }

      const contractNetSummary = contractNetDecision ? buildContractNetSummary(contractNetDecision) : null;
      return {
        child_id: childId,
        message,
        awaited_message: cloneChildMessage(awaited),
        sandbox_result: sandboxResult,
        loop_alert: loopAlert,
        contract_net: contractNetSummary,
      } satisfies ChildSendResult;
    } catch (error) {
      if (loopDetector && loopSignature) {
        loopDetector.recordTaskObservation({
          taskType: loopTaskType,
          durationMs: Math.max(1, Date.now() - message.sentAt),
          success: false,
        });
      }
      const reason = errorMessage(error);
      context.logger.logCognitive({
        actor: `child:${childId}`,
        phase: "resume",
        childId,
        content: reason,
        metadata: {
          status: "error",
          expect: input.expect ?? null,
        },
      });
      throw new Error(`child_send awaited a ${input.expect} message but failed after ${timeoutMs}ms: ${reason}`);
    }
  } catch (error) {
    refundChildBudget(budgetManager, childId, requestCharge);
    throw error;
  } finally {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    if (elapsedMs > 0) {
      await consumeChildBudgetOrThrow(
        budgetManager,
        childId,
        { timeMs: elapsedMs },
        { actor: "orchestrator", operation: "child_send", stage: "duration" },
      );
    }
    if (awaitedMessage) {
      const responseValue = awaitedMessage.parsed ?? awaitedMessage.raw;
      const responseBytes = measureBudgetBytes(responseValue);
      const responseTokens = estimateTokenUsage(responseValue);
      await consumeChildBudgetOrThrow(
        budgetManager,
        childId,
        { bytesIn: responseBytes, tokens: responseTokens },
        { actor: "orchestrator", operation: "child_send", stage: "response" },
      );
    }
  }
}

async function waitForExpectedMessage(
  context: ChildToolContext,
  childId: string,
  baselineSequence: number,
  matcher: (message: ChildRuntimeMessage) => boolean,
  timeoutMs: number,
): Promise<ChildRuntimeMessage> {
  return context.supervisor.waitForMessage(
    childId,
    (message) => message.sequence >= baselineSequence && matcher(message),
    timeoutMs,
  );
}

export function handleChildStatus(
  context: ChildToolContext,
  input: ChildStatusRequest,
): ChildStatusResult {
  context.logger.info("child_status", { child_id: input.child_id });
  const snapshot = context.supervisor.status(input.child_id);
  return {
    child_id: input.child_id,
    runtime_status: snapshot.runtime,
    index_snapshot: snapshot.index,
  };
}

export async function handleChildCollect(
  context: ChildToolContext,
  input: ChildCollectRequest,
): Promise<ChildCollectResult> {
  context.logger.info("child_collect", { child_id: input.child_id });
  const outputs = await context.supervisor.collect(input.child_id);
  if (context.budget) {
    const messageMetrics = outputs.messages.reduce(
      (acc, message) => {
        const value = message.parsed ?? message.raw;
        acc.bytes += measureBudgetBytes(value);
        acc.tokens += estimateTokenUsage(value);
        return acc;
      },
      { bytes: 0, tokens: 0 },
    );
    const artifactBytes = outputs.artifacts.reduce(
      (total, artifact) => total + (typeof artifact.size === "number" ? artifact.size : 0),
      0,
    );
    const totalBytes = messageMetrics.bytes + artifactBytes;
    if (totalBytes > 0 || messageMetrics.tokens > 0) {
      await consumeChildBudgetOrThrow(
        context.budget,
        input.child_id,
        { bytesIn: totalBytes, tokens: messageMetrics.tokens },
        { actor: "orchestrator", operation: "child_collect", stage: "response" },
      );
    }
  }
  return { child_id: input.child_id, outputs };
}

export function handleChildStream(
  context: ChildToolContext,
  input: ChildStreamRequest,
): ChildStreamResult {
  context.logger.info("child_stream", {
    child_id: input.child_id,
    after_sequence: input.after_sequence ?? null,
    limit: input.limit ?? null,
    streams: input.streams ?? null,
  });

  const streamOptions = omitUndefinedEntries({
    afterSequence: input.after_sequence,
    limit: input.limit,
    streams: input.streams as ("stdout" | "stderr")[] | undefined,
  });
  const slice = context.supervisor.stream(input.child_id, streamOptions);

  return {
    child_id: input.child_id,
    slice,
  };
}

export async function handleChildCancel(
  context: ChildToolContext,
  input: ChildCancelRequest,
): Promise<ChildCancelResult> {
  context.logger.info("child_cancel", {
    child_id: input.child_id,
    signal: input.signal ?? "SIGINT",
    timeout_ms: input.timeout_ms ?? null,
  });

  const cancelOptions = omitUndefinedEntries({
    signal: input.signal as Signal | undefined,
    timeoutMs: input.timeout_ms,
  });
  const shutdown = await context.supervisor.cancel(input.child_id, cancelOptions);

  clearLoopSignature(input.child_id);

  return { child_id: input.child_id, shutdown };
}

export async function handleChildKill(
  context: ChildToolContext,
  input: ChildKillRequest,
): Promise<ChildKillResult> {
  context.logger.warn("child_kill", { child_id: input.child_id, timeout_ms: input.timeout_ms ?? null });
  const killOptions = omitUndefinedEntries({ timeoutMs: input.timeout_ms });
  const shutdown = await context.supervisor.kill(input.child_id, killOptions);
  clearLoopSignature(input.child_id);
  return { child_id: input.child_id, shutdown };
}

export function handleChildGc(
  context: ChildToolContext,
  input: ChildGcRequest,
): ChildGcResult {
  context.logger.info("child_gc", { child_id: input.child_id });
  context.supervisor.gc(input.child_id);
  clearLoopSignature(input.child_id);
  if (context.budget) {
    context.budget.releaseChildBudget(input.child_id);
  }
  return { child_id: input.child_id, removed: true };
}

