import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodTypeAny } from "zod";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath, basename as pathBasename } from "node:path";
import process from "node:process";
import { runtimeTimers, type IntervalHandle } from "./runtime/timers.js";
import { pathToFileURL } from "node:url";
import { GraphState, type ChildSnapshot, type JobSnapshot } from "./graphState.js";
import { GraphTransactionManager, GraphTransactionError, GraphVersionConflictError } from "./graph/tx.js";
import { GraphLockManager } from "./graph/locks.js";
import { LoggerOptions, StructuredLogger, type LogEntry } from "./logger.js";
import { EventStore, OrchestratorEvent, type EventKind, type EventLevel, type EventSource } from "./eventStore.js";
import {
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
  EventBus,
  EVENT_CATEGORIES,
  type EventCategory,
  type EventFilter,
  type EventLevel as BusEventLevel,
} from "./events/bus.js";
import {
  buildChildCorrelationHints,
  buildJobCorrelationHints,
  extractCorrelationHints,
  mergeCorrelationHints,
  type EventCorrelationHints,
} from "./events/correlation.js";
import { buildChildCognitiveEvents, type QualityAssessmentSnapshot } from "./events/cognitive.js";
import {
  bridgeBlackboardEvents,
  bridgeCancellationEvents,
  bridgeConsensusEvents,
  bridgeContractNetEvents,
  bridgeValueEvents,
  bridgeStigmergyEvents,
  createContractNetWatcherTelemetryListener,
} from "./events/bridges.js";
import { serialiseForSse } from "./events/sse.js";
import { startHttpServer, type HttpServerExtras, type HttpReadinessReport } from "./httpServer.js";
import { startDashboardServer } from "./monitor/dashboard.js";
import { LogJournal, type LogStream } from "./monitor/log.js";
import { BehaviorTreeStatusRegistry } from "./monitor/btStatusRegistry.js";
import { MessageRecord, Role } from "./types.js";
import {
  FeatureToggles,
  RuntimeTimingOptions,
  parseOrchestratorRuntimeOptions,
  ChildSafetyOptions,
} from "./serverOptions.js";
import { ChildSupervisor, type ChildLogEventSnapshot } from "./childSupervisor.js";
import { normaliseSandboxProfile } from "./children/sandbox.js";
import { ChildRecordSnapshot, UnknownChildError } from "./state/childrenIndex.js";
import { ChildCollectedOutputs, ChildRuntimeStatus } from "./childRuntime.js";
import { Autoscaler } from "./agents/autoscaler.js";
import { OrchestratorSupervisor, inferSupervisorIncidentCorrelation } from "./agents/supervisor.js";
import { MetaCritic, ReviewKind, ReviewResult } from "./agents/metaCritic.js";
import { reflect, ReflectionResult } from "./agents/selfReflect.js";
import { scoreCode, scorePlan, scoreText, ScoreCodeInput, ScorePlanInput, ScoreTextInput } from "./quality/scoring.js";
import { appendWalEntry } from "./state/wal.js";
import { ToolRegistry, ToolRegistrationError, type CompositeRegistrationRequest } from "./mcp/registry.js";
import { SharedMemoryStore } from "./memory/store.js";
import { PersistentKnowledgeGraph } from "./memory/kg.js";
import { VectorMemoryIndex } from "./memory/vector.js";
import { selectMemoryContext } from "./memory/attention.js";
import { LoopDetector } from "./guard/loopDetector.js";
import { BlackboardStore } from "./coord/blackboard.js";
import { ContractNetCoordinator } from "./coord/contractNet.js";
import { ContractNetWatcherTelemetryRecorder, watchContractNetPheromoneBounds } from "./coord/contractNetWatchers.js";
import { StigmergyField } from "./coord/stigmergy.js";
import type { KnowledgeTripleSnapshot } from "./knowledge/knowledgeGraph.js";
import { CausalMemory } from "./knowledge/causalMemory.js";
import { ValueGraph, type ValueGraphConfig } from "./values/valueGraph.js";
import type { ValueFilterDecision } from "./values/valueGraph.js";
import { ResourceRegistry, type ResourceWatchResult } from "./resources/registry.js";
import { renderResourceWatchSseMessages, serialiseResourceWatchResultForSse } from "./resources/sse.js";
import { IdempotencyRegistry, buildIdempotencyCacheKey } from "./infra/idempotency.js";
import { FileIdempotencyStore } from "./infra/idempotencyStore.file.js";
import { resolveIdempotencyDirectory } from "./infra/idempotencyStore.js";
import { runWithJsonRpcContext } from "./infra/jsonRpcContext.js";
import {
  runWithRpcTrace,
  annotateTraceContext,
  registerInboundBytes,
  getActiveTraceContext,
  registerRpcError,
  registerRpcSuccess,
} from "./infra/tracing.js";
import {
  BudgetTracker,
  BudgetLimits,
  BudgetConsumption,
  BudgetCharge,
  BudgetUsageMetadata,
  BudgetExceededError,
  estimateTokenUsage,
  measureBudgetBytes,
} from "./infra/budget.js";
import { PlanLifecycleRegistry, PlanRunNotFoundError } from "./executor/planLifecycle.js";
import type { PlanLifecycleSnapshot } from "./executor/planLifecycle.js";
import { ensureParentDirectory, resolveWorkspacePath, PathResolutionError } from "./paths.js";
import {
  normaliseJsonRpcRequest,
  JsonRpcError,
  createJsonRpcError,
  buildJsonRpcErrorResponse,
} from "./rpc/middleware.js";
import {
  JsonRpcTimeoutError,
  resolveRpcTimeoutBudget,
  normaliseTimeoutBudget,
  loadDefaultTimeoutOverride,
} from "./rpc/timeouts.js";
import {
  ToolComposeRegisterInputSchema,
  ToolComposeRegisterInputShape,
  ToolsListInputSchema,
  ToolsListInputShape,
} from "./rpc/schemas.js";
import {
  ChildCancelInputShape,
  ChildCancelInputSchema,
  ChildCollectInputShape,
  ChildCollectInputSchema,
  ChildCreateInputShape,
  ChildCreateInputSchema,
  ChildGcInputShape,
  ChildGcInputSchema,
  ChildKillInputShape,
  ChildKillInputSchema,
  ChildSendInputShape,
  ChildSendInputSchema,
  ChildStreamInputShape,
  ChildStreamInputSchema,
  ChildStatusInputShape,
  ChildStatusInputSchema,
  ChildBudgetManager,
  ChildToolContext,
  ChildSpawnCodexInputShape,
  ChildSpawnCodexInputSchema,
  ChildBatchCreateInputShape,
  ChildBatchCreateInputSchema,
  ChildAttachInputShape,
  ChildAttachInputSchema,
  ChildSetRoleInputShape,
  ChildSetRoleInputSchema,
  ChildSetLimitsInputShape,
  ChildSetLimitsInputSchema,
  handleChildCancel,
  handleChildCollect,
  handleChildCreate,
  handleChildSpawnCodex,
  handleChildBatchCreate,
  handleChildAttach,
  handleChildSetRole,
  handleChildSetLimits,
  handleChildGc,
  handleChildKill,
  handleChildSend,
  handleChildStream,
  handleChildStatus,
} from "./tools/childTools.js";
import {
  MemoryVectorSearchInputSchema,
  MemoryVectorSearchInputShape,
  handleMemoryVectorSearch,
} from "./tools/memoryTools.js";
import type { MemoryVectorToolContext } from "./tools/memoryTools.js";
import {
  PlanFanoutInputSchema,
  PlanFanoutInputShape,
  PlanJoinInputSchema,
  PlanJoinInputShape,
  PlanCompileBTInputSchema,
  PlanCompileBTInputShape,
  PlanCompileExecuteInputSchema,
  PlanCompileExecuteInputShape,
  PlanRunBTInputSchema,
  PlanRunBTInputShape,
  PlanRunReactiveInputSchema,
  PlanRunReactiveInputShape,
  PlanReduceInputSchema,
  PlanReduceInputShape,
  PlanDryRunInputSchema,
  PlanDryRunInputShape,
  PlanStatusInputSchema,
  PlanStatusInputShape,
  PlanPauseInputSchema,
  PlanPauseInputShape,
  PlanResumeInputSchema,
  PlanResumeInputShape,
  PlanToolContext,
  handlePlanFanout,
  handlePlanJoin,
  handlePlanCompileExecute,
  handlePlanCompileBT,
  handlePlanRunBT,
  handlePlanRunReactive,
  handlePlanReduce,
  handlePlanDryRun,
  handlePlanStatus,
  handlePlanPause,
  handlePlanResume,
  ValueGuardRejectionError,
  ValueGuardRequiredError,
} from "./tools/planTools.js";
import {
  BbGetInputSchema,
  BbGetInputShape,
  BbQueryInputSchema,
  BbQueryInputShape,
  BbSetInputSchema,
  BbSetInputShape,
  BbBatchSetInputSchema,
  BbBatchSetInputShape,
  BbWatchInputSchema,
  BbWatchInputShape,
  CnpAnnounceInputSchema,
  CnpAnnounceInputShape,
  CoordinationToolContext,
  handleBbGet,
  handleBbBatchSet,
  handleBbQuery,
  handleBbSet,
  handleBbWatch,
  StigDecayInputSchema,
  StigDecayInputShape,
  StigMarkInputSchema,
  StigMarkInputShape,
  StigBatchInputSchema,
  StigBatchInputShape,
  StigSnapshotInputSchema,
  StigSnapshotInputShape,
  handleStigDecay,
  handleStigMark,
  handleStigBatch,
  handleStigSnapshot,
  CnpRefreshBoundsInputSchema,
  CnpRefreshBoundsInputShape,
  handleCnpRefreshBounds,
  handleCnpAnnounce,
  CnpWatcherTelemetryInputSchema,
  CnpWatcherTelemetryInputShape,
  handleCnpWatcherTelemetry,
  ConsensusVoteInputSchema,
  ConsensusVoteInputShape,
  handleConsensusVote,
} from "./tools/coordTools.js";
import { requestCancellation, cancelRun, getCancellation } from "./executor/cancel.js";
import {
  AgentAutoscaleSetInputSchema,
  AgentAutoscaleSetInputShape,
  AgentToolContext,
  handleAgentAutoscaleSet,
} from "./tools/agentTools.js";
import {
  GraphGenerateInputSchema,
  GraphGenerateInputShape,
  GraphMutateInputSchema,
  GraphMutateInputShape,
  GraphDescriptorSchema,
  GraphPathsConstrainedInputSchema,
  GraphPathsConstrainedInputShape,
  GraphPathsKShortestInputSchema,
  GraphPathsKShortestInputShape,
  GraphCentralityBetweennessInputSchema,
  GraphCentralityBetweennessInputShape,
  GraphCriticalPathInputSchema,
  GraphCriticalPathInputShape,
  GraphOptimizeInputSchema,
  GraphOptimizeInputShape,
  GraphOptimizeMooInputSchema,
  GraphOptimizeMooInputShape,
  GraphCausalAnalyzeInputSchema,
  GraphCausalAnalyzeInputShape,
  GraphRewriteApplyInputSchema,
  GraphRewriteApplyInputShape,
  GraphHyperExportInputSchema,
  GraphHyperExportInputShape,
  GraphPartitionInputSchema,
  GraphPartitionInputShape,
  GraphSummarizeInputSchema,
  GraphSummarizeInputShape,
  GraphSimulateInputSchema,
  GraphSimulateInputShape,
  GraphValidateInputSchema,
  GraphValidateInputShape,
  handleGraphGenerate,
  handleGraphMutate,
  handleGraphRewriteApply,
  handleGraphHyperExport,
  handleGraphPathsConstrained,
  handleGraphPathsKShortest,
  handleGraphCentralityBetweenness,
  handleGraphCriticalPath,
  handleGraphOptimize,
  handleGraphOptimizeMoo,
  handleGraphCausalAnalyze,
  handleGraphPartition,
  handleGraphSummarize,
  handleGraphSimulate,
  handleGraphValidate,
  normaliseGraphPayload,
  serialiseNormalisedGraph,
} from "./tools/graphTools.js";
import {
  GraphBatchMutateInputSchema,
  GraphBatchMutateInputShape,
  GraphBatchToolContext,
  handleGraphBatchMutate,
  type GraphBatchMutateResult,
} from "./tools/graphBatchTools.js";
import {
  GraphLockInputShape,
  GraphLockInputSchema,
  GraphUnlockInputShape,
  GraphUnlockInputSchema,
  GraphLockToolContext,
  handleGraphLock,
  handleGraphUnlock,
} from "./tools/graphLockTools.js";
import {
  GraphDiffInputSchema,
  GraphDiffInputShape,
  GraphPatchInputSchema,
  GraphPatchInputShape,
  handleGraphDiff,
  handleGraphPatch,
  type GraphDiffToolContext,
} from "./tools/graphDiffTools.js";
import { resolveOperationId } from "./tools/operationIds.js";
import {
  TxBeginInputSchema,
  TxBeginInputShape,
  TxApplyInputSchema,
  TxApplyInputShape,
  TxCommitInputSchema,
  TxCommitInputShape,
  TxRollbackInputSchema,
  TxRollbackInputShape,
  handleTxBegin,
  handleTxApply,
  handleTxCommit,
  handleTxRollback,
  type TxToolContext,
} from "./tools/txTools.js";
import type { GraphDescriptorPayload, GraphRewriteApplyInput } from "./tools/graphTools.js";
import {
  KgExportInputSchema,
  KgExportInputShape,
  KgInsertInputSchema,
  KgInsertInputShape,
  KgQueryInputSchema,
  KgQueryInputShape,
  KgSuggestPlanInputSchema,
  KgSuggestPlanInputShape,
  KnowledgeToolContext,
  handleKgExport,
  handleKgInsert,
  handleKgQuery,
  handleKgSuggestPlan,
} from "./tools/knowledgeTools.js";
import {
  CausalExportInputSchema,
  CausalExportInputShape,
  CausalExplainInputSchema,
  CausalExplainInputShape,
  CausalToolContext,
  handleCausalExport,
  handleCausalExplain,
} from "./tools/causalTools.js";
import {
  ValuesExplainInputSchema,
  ValuesExplainInputShape,
  ValuesFilterInputSchema,
  ValuesFilterInputShape,
  ValuesScoreInputSchema,
  ValuesScoreInputShape,
  ValuesSetInputSchema,
  ValuesSetInputShape,
  ValueToolContext,
  handleValuesExplain,
  handleValuesFilter,
  handleValuesScore,
  handleValuesSet,
} from "./tools/valueTools.js";
import { renderMermaidFromGraph } from "./viz/mermaid.js";
import { renderDotFromGraph } from "./viz/dot.js";
import { renderGraphmlFromGraph } from "./viz/graphml.js";
import { snapshotToGraphDescriptor } from "./viz/snapshot.js";
import {
  childToolError,
  planToolError,
  graphToolError,
  transactionToolError,
  coordinationToolError,
  knowledgeToolError,
  causalToolError,
  valueToolError,
  resourceToolError,
} from "./server/toolErrors.js";
import {
  SUBGRAPH_REGISTRY_KEY,
  collectMissingSubgraphDescriptors,
  collectSubgraphReferences,
} from "./graph/subgraphRegistry.js";
import { extractSubgraphToFile } from "./graph/subgraphExtract.js";
import {
  getMcpCapabilities,
  getMcpInfo,
  bindToolIntrospectionProvider,
  updateMcpRuntimeSnapshot,
} from "./mcp/info.js";

/*
v1.3 - Orchestrateur MCP self-fork avec:
- Streaming par subscriptions/poll (wait_ms)
- Partiels de reponse (child_push_partial)
- Consultation live par enfant (child_info, child_transcript)
- Chat multi-tour orchestrateur <-> enfant (child_chat)
Toutes les reponses tools renvoient du texte JSON: { type: "text", text: JSON.stringify(...) }
*/

// ---------------------------
// Types de domaine
// ---------------------------

interface SpawnChildSpec {
  name: string;
  system?: string;
  goals?: string[];
  runtime?: string;
}

// ---------------------------
// Stores en memoire
// ---------------------------

const graphState = new GraphState();
/**
 * Transaction manager guarding graph mutations. Every server-side mutation is
 * funneled through this instance to guarantee optimistic concurrency checks and
 * deterministic version bumps.
 */
const graphTransactions = new GraphTransactionManager();
const graphLocks = new GraphLockManager();
/** Shared blackboard store powering coordination tools. */
const blackboard = new BlackboardStore();
/** Registry exposing normalised MCP resources (graphs, runs, logs, namespaces). */
const resources = new ResourceRegistry({ blackboard });
/** Shared stigmergic field coordinating pheromone-driven prioritisation. */
const stigmergy = new StigmergyField();
/** Shared contract-net coordinator balancing task assignments. */
const contractNet = new ContractNetCoordinator();
/** Telemetry recorder tracking automatic Contract-Net bounds refreshes. */
const contractNetWatcherTelemetry = new ContractNetWatcherTelemetryRecorder();

/** Parses the optional TTL override for the idempotency cache. */
function resolveIdempotencyTtlFromEnv(): number | undefined {
  const raw = process.env.IDEMPOTENCY_TTL_MS;
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

/** Resolves the maximum number of vector documents kept in memory. */
function resolveVectorIndexCapacity(): number {
  const raw = process.env.MCP_MEMORY_VECTOR_MAX_DOCS;
  if (!raw) {
    return 1024;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1024;
  }
  return parsed;
}

const IDEMPOTENCY_TTL_OVERRIDE = resolveIdempotencyTtlFromEnv();
/** Registry replaying cached results for idempotent operations. */
const idempotencyRegistry = new IdempotencyRegistry({
  defaultTtlMs: IDEMPOTENCY_TTL_OVERRIDE,
});
/** Root directory storing the layered memory artefacts (vector + knowledge). */
const MEMORY_ROOT = resolvePath(process.cwd(), "runs", "memory");
/** Persistent vector index capturing long form orchestrator artefacts. */
const vectorMemoryIndex = VectorMemoryIndex.createSync({
  directory: resolvePath(MEMORY_ROOT, "vector"),
  maxDocuments: resolveVectorIndexCapacity(),
});
/** Durable knowledge graph shared across orchestrator restarts. */
const knowledgeGraphPersistence = PersistentKnowledgeGraph.createSync({
  directory: resolvePath(MEMORY_ROOT, "kg"),
});
const knowledgeGraph = knowledgeGraphPersistence.graph;
/** Shared causal memory tracking runtime event relationships. */
const causalMemory = new CausalMemory();
/** Shared value graph guarding plan execution against policy violations. */
const valueGraph = new ValueGraph();
/** Registry storing the last guard decision for spawned children. */
const valueGuardRegistry = new Map<string, ValueFilterDecision>();
/** Registry exposing live Behaviour Tree node statuses to dashboards. */
const btStatusRegistry = new BehaviorTreeStatusRegistry();
/** Registry tracking plan lifecycle state for pause/resume tooling. */
const planLifecycle = new PlanLifecycleRegistry();
/** Directory storing JSONL artefacts for correlated log tails. */
const LOG_JOURNAL_ROOT = resolvePath(process.cwd(), "runs", "logs");
/** Shared journal preserving orchestrator, run and child logs for MCP tools. */
const logJournal = new LogJournal({
  rootDir: LOG_JOURNAL_ROOT,
  maxEntriesPerBucket: 1000,
  maxFileSizeBytes: 4 * 1024 * 1024,
  maxFileCount: 5,
});

/** Optional default timeout override driven via environment variables. */
const DEFAULT_RPC_TIMEOUT_OVERRIDE = loadDefaultTimeoutOverride();

/** Timestamp captured when the orchestrator module is initialised. */
const SERVER_STARTED_AT = Date.now();

/** Default feature toggles used before CLI/flags are parsed. */
const DEFAULT_FEATURE_TOGGLES: FeatureToggles = {
  enableBT: false,
  enableReactiveScheduler: false,
  enableBlackboard: false,
  enableStigmergy: false,
  enableCNP: false,
  enableConsensus: false,
  enableAutoscaler: false,
  enableSupervisor: false,
  enableKnowledge: false,
  enableCausalMemory: false,
  enableValueGuard: false,
  enableMcpIntrospection: false,
  enableResources: false,
  enableEventsBus: false,
  enableCancellation: false,
  enableTx: false,
  enableBulk: false,
  enableIdempotency: false,
  enableLocks: false,
  enableDiffPatch: false,
  enablePlanLifecycle: false,
  enableChildOpsFine: false,
  enableValuesExplain: false,
  enableAssist: false,
};

/** Default runtime timings exposed before configuration takes place. */
const DEFAULT_RUNTIME_TIMINGS: RuntimeTimingOptions = {
  btTickMs: 50,
  stigHalfLifeMs: 30_000,
  supervisorStallTicks: 6,
  defaultTimeoutMs: 60_000,
  autoscaleCooldownMs: 10_000,
  heartbeatIntervalMs: 2_000,
};

const MIN_HEARTBEAT_INTERVAL_MS = 250;

const DEFAULT_CHILD_SAFETY_LIMITS: ChildSafetyOptions = {
  maxChildren: 16,
  memoryLimitMb: 512,
  cpuPercent: 100,
};

let runtimeFeatures: FeatureToggles = { ...DEFAULT_FEATURE_TOGGLES };
let runtimeTimings: RuntimeTimingOptions = { ...DEFAULT_RUNTIME_TIMINGS };
let runtimeChildSafety: ChildSafetyOptions = { ...DEFAULT_CHILD_SAFETY_LIMITS };

updateMcpRuntimeSnapshot({
  features: runtimeFeatures,
  timings: runtimeTimings,
  safety: runtimeChildSafety,
});

/** Returns the active feature toggles applied to the orchestrator. */
export function getRuntimeFeatures(): FeatureToggles {
  return { ...runtimeFeatures };
}

/** Applies a new set of feature toggles at runtime. */
export function configureRuntimeFeatures(next: FeatureToggles): void {
  runtimeFeatures = { ...next };
  updateMcpRuntimeSnapshot({ features: runtimeFeatures });
}

/** Expose the unified event bus for observability tooling and tests. */
export function getEventBusInstance(): EventBus {
  return eventBus;
}

/** Returns the pacing configuration applied to optional modules. */
export function getRuntimeTimings(): RuntimeTimingOptions {
  return { ...runtimeTimings };
}

/** Applies a new pacing configuration for optional modules. */
export function configureRuntimeTimings(next: RuntimeTimingOptions): void {
  const heartbeatInterval = Math.max(
    MIN_HEARTBEAT_INTERVAL_MS,
    next.heartbeatIntervalMs ?? DEFAULT_RUNTIME_TIMINGS.heartbeatIntervalMs,
  );
  runtimeTimings = { ...next, heartbeatIntervalMs: heartbeatInterval };
  updateMcpRuntimeSnapshot({ timings: runtimeTimings });
  refreshHeartbeatTimer();
}

/** Returns the safety guardrails applied to child runtimes. */
export function getChildSafetyLimits(): ChildSafetyOptions {
  return { ...runtimeChildSafety };
}

/** Applies new safety guardrails and updates the child supervisor accordingly. */
export function configureChildSafetyLimits(next: ChildSafetyOptions): void {
  runtimeChildSafety = { ...next };
  childSupervisor.configureSafety({
    maxChildren: runtimeChildSafety.maxChildren,
    memoryLimitMb: runtimeChildSafety.memoryLimitMb,
    cpuPercent: runtimeChildSafety.cpuPercent,
  });
  updateMcpRuntimeSnapshot({ safety: runtimeChildSafety });
}

interface SubgraphSummary {
  references: string[];
  missing: string[];
}

function summariseSubgraphUsage(graph: GraphDescriptorPayload): SubgraphSummary {
  const references = Array.from(collectSubgraphReferences(graph));
  const missing = collectMissingSubgraphDescriptors(graph);
  return { references, missing };
}

function parseSizeEnv(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned.length) {
    return undefined;
  }
  const match = cleaned.match(/^(\d+)([kmg]?b?)?$/);
  if (!match) {
    return undefined;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base)) {
    return undefined;
  }
  const unit = match[2];
  switch (unit) {
    case "k":
    case "kb":
      return base * 1024;
    case "m":
    case "mb":
      return base * 1024 * 1024;
    case "g":
    case "gb":
      return base * 1024 * 1024 * 1024;
    default:
      return base;
  }
}

function parseCountEnv(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return undefined;
  }
  return Math.floor(num);
}

function parseRedactEnv(raw: string | undefined): Array<string> {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) {
    return defaultValue;
  }
  const normalised = raw.trim().toLowerCase();
  if (!normalised.length) {
    return defaultValue;
  }
  if (["0", "false", "no", "off"].includes(normalised)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(normalised)) {
    return true;
  }
  return defaultValue;
}

function parseQualityThresholdEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

const baseLoggerOptions: LoggerOptions = {
  logFile: process.env.MCP_LOG_FILE ?? undefined,
  maxFileSizeBytes: parseSizeEnv(process.env.MCP_LOG_ROTATE_SIZE),
  maxFileCount: parseCountEnv(process.env.MCP_LOG_ROTATE_KEEP),
  redactSecrets: parseRedactEnv(process.env.MCP_LOG_REDACT),
};

function recordServerLogEntry(entry: LogEntry): void {
  let timestamp = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestamp)) {
    timestamp = Date.now();
  }
  const payload = entry.payload ?? null;
  // Merge correlation hints emitted by upstream components so nested metadata keeps run/op/child context.
  const correlationHints = extractCorrelationHints(payload);
  // Each identifier honours explicit null overrides while falling back to legacy payload shapes when hints are absent.
  const runId =
    correlationHints.runId !== undefined ? correlationHints.runId : extractRunId(payload);
  const opId = correlationHints.opId !== undefined ? correlationHints.opId : extractOpId(payload);
  const graphId =
    correlationHints.graphId !== undefined ? correlationHints.graphId : extractGraphId(payload);
  const nodeId =
    correlationHints.nodeId !== undefined ? correlationHints.nodeId : extractNodeId(payload);
  const childId =
    correlationHints.childId !== undefined ? correlationHints.childId : extractChildId(payload);
  const jobId = correlationHints.jobId !== undefined ? correlationHints.jobId : extractJobId(payload);
  const component = normaliseTag(extractComponentTag(payload)) ?? "server";
  const stage = normaliseTag(extractStageTag(payload)) ?? entry.message;
  const elapsedMs = resolveEventElapsedMs(extractElapsedMilliseconds(payload));

  try {
    logJournal.record({
      stream: "server",
      bucketId: "orchestrator",
      ts: timestamp,
      level: entry.level,
      message: entry.message,
      data: payload ?? null,
      jobId,
      runId,
      opId,
      graphId,
      nodeId,
      childId,
      component,
      stage,
      elapsedMs,
    });
  } catch (error) {
    try {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: "error", message: "log_journal_record_failed", detail })}\n`,
      );
    } catch {
      // Ignore secondary failures: logging should never crash orchestrator hot paths.
    }
  }
}

/** @internal Expose logging helpers so tests can assert journal correlation without mocking the logger. */
export const __serverLogInternals = {
  recordServerLogEntry,
};

function instantiateLogger(options: LoggerOptions): StructuredLogger {
  return new StructuredLogger({ ...options, onEntry: recordServerLogEntry });
}

let activeLoggerOptions: LoggerOptions = { ...baseLoggerOptions };
let logger = instantiateLogger(activeLoggerOptions);
const eventStore = new EventStore({ maxHistory: 5000, logger });
const eventBus = new EventBus({ historyLimit: 5000 });

const contractNetWatcherTelemetryListener = createContractNetWatcherTelemetryListener({
  bus: eventBus,
  recorder: contractNetWatcherTelemetry,
});

const detachContractNetBoundsWatcher = watchContractNetPheromoneBounds({
  field: stigmergy,
  contractNet,
  logger,
  onTelemetry: contractNetWatcherTelemetryListener,
});
process.once("exit", () => detachContractNetBoundsWatcher());

// Bridge coordination primitives to the unified event bus so downstream MCP
// clients can observe blackboard and stigmergic activity without bespoke
// wiring. The returned disposers are intentionally ignored because the server
// keeps these observers for its entire lifetime.
void bridgeBlackboardEvents({ blackboard, bus: eventBus });
void bridgeStigmergyEvents({ field: stigmergy, bus: eventBus });
void bridgeCancellationEvents({ bus: eventBus });
void bridgeContractNetEvents({ coordinator: contractNet, bus: eventBus });
void bridgeConsensusEvents({ bus: eventBus });
void bridgeValueEvents({ graph: valueGraph, bus: eventBus });

if (activeLoggerOptions.logFile) {
  logger.info("logger_configured", {
    log_file: activeLoggerOptions.logFile,
    max_size_bytes: activeLoggerOptions.maxFileSizeBytes ?? null,
    max_file_count: activeLoggerOptions.maxFileCount ?? null,
    redacted_tokens: activeLoggerOptions.redactSecrets?.length ?? 0,
    source: "env",
  });
}
const memoryStore = new SharedMemoryStore();
const metaCritic = new MetaCritic();
let lastInactivityThresholdMs = 120_000;
const loopDetector = new LoopDetector();
const REFLECTION_PRIORITY_KINDS: ReadonlySet<ReviewKind> = new Set(["code", "plan", "text"]);

let reflectionEnabled = parseBooleanEnv(process.env.MCP_ENABLE_REFLECTION, true);
let qualityGateEnabled = parseBooleanEnv(process.env.MCP_QUALITY_GATE, true);
let qualityGateThreshold = parseQualityThresholdEnv(process.env.MCP_QUALITY_THRESHOLD, 70);

let DEFAULT_CHILD_RUNTIME = "codex";

function setDefaultChildRuntime(runtime: string) {
  DEFAULT_CHILD_RUNTIME = runtime.trim() || "codex";
}

const CHILDREN_ROOT = process.env.MCP_CHILDREN_ROOT
  ? resolvePath(process.cwd(), process.env.MCP_CHILDREN_ROOT)
  : resolvePath(process.cwd(), "children");

function parseDefaultChildArgs(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value));
    }
    logger.warn("child_default_args_invalid", { raw });
  } catch (error) {
    logger.warn("child_default_args_parse_error", {
      raw,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return [];
}

function parseBudgetLimitEnv(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

function parseChildEnvAllowList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const segments = raw
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const allow = new Set<string>();
  for (const segment of segments) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      allow.add(segment);
    }
  }
  return Array.from(allow);
}

function parseSandboxProfileEnv(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  return normaliseSandboxProfile(raw, "standard");
}

const REQUEST_BUDGET_LIMITS: BudgetLimits = {
  timeMs: parseBudgetLimitEnv(process.env.MCP_REQUEST_BUDGET_TIME_MS),
  tokens: parseBudgetLimitEnv(process.env.MCP_REQUEST_BUDGET_TOKENS),
  toolCalls: parseBudgetLimitEnv(process.env.MCP_REQUEST_BUDGET_TOOL_CALLS),
  bytesIn: parseBudgetLimitEnv(process.env.MCP_REQUEST_BUDGET_BYTES_IN),
  bytesOut: parseBudgetLimitEnv(process.env.MCP_REQUEST_BUDGET_BYTES_OUT),
};

const defaultChildCommand = process.env.MCP_CHILD_COMMAND ?? process.execPath;
const defaultChildArgs = parseDefaultChildArgs(process.env.MCP_CHILD_ARGS);
const sandboxDefaultProfile = parseSandboxProfileEnv(process.env.MCP_CHILD_SANDBOX_PROFILE ?? undefined);
const sandboxAllowEnv = parseChildEnvAllowList(process.env.MCP_CHILD_ENV_ALLOW ?? undefined);

const childSupervisor = new ChildSupervisor({
  childrenRoot: CHILDREN_ROOT,
  defaultCommand: defaultChildCommand,
  defaultArgs: defaultChildArgs,
  defaultEnv: process.env,
  safety: {
    maxChildren: runtimeChildSafety.maxChildren,
    memoryLimitMb: runtimeChildSafety.memoryLimitMb,
    cpuPercent: runtimeChildSafety.cpuPercent,
  },
  sandbox: {
    defaultProfile: sandboxDefaultProfile ?? undefined,
    allowEnv: sandboxAllowEnv,
  },
  eventBus,
  recordChildLogEntry: (childId, entry: ChildLogEventSnapshot) => {
    resources.recordChildLogEntry(childId, {
      ts: entry.ts,
      stream: entry.stream,
      message: entry.message,
      childId: entry.childId ?? childId,
      jobId: entry.jobId ?? null,
      runId: entry.runId ?? null,
      opId: entry.opId ?? null,
      graphId: entry.graphId ?? null,
      nodeId: entry.nodeId ?? null,
      raw: entry.raw ?? null,
      parsed: entry.parsed ?? null,
    });
    try {
      logJournal.record({
        stream: "child",
        bucketId: entry.childId ?? childId,
        ts: entry.ts,
        level: resolveChildLogLevel(entry.stream),
        message: entry.message,
        data: {
          raw: entry.raw ?? null,
          parsed: entry.parsed ?? null,
          stream: entry.stream,
        },
        jobId: entry.jobId ?? null,
        runId: entry.runId ?? null,
        opId: entry.opId ?? null,
        graphId: entry.graphId ?? null,
        nodeId: entry.nodeId ?? null,
        childId: entry.childId ?? childId,
        component: "child_io",
        stage: entry.stream,
        elapsedMs: null,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: "error", message: "child_log_journal_failed", detail })}\n`,
      );
    }
  },
});

const autoscaler = new Autoscaler({
  supervisor: childSupervisor,
  logger,
  emitEvent: (event) => {
    pushEvent({
      kind: "AUTOSCALER",
      level: event.level,
      childId: event.childId,
      payload: event.payload,
      correlation: event.correlation ?? undefined,
    });
  },
});

const orchestratorSupervisor = new OrchestratorSupervisor({
  childManager: childSupervisor,
  logger,
  actions: {
    emitAlert: async (incident) => {
      const level = incident.severity === "critical" ? "error" : "warn";
      const eventKind = level === "error" ? "ERROR" : "WARN";
      const correlation = inferSupervisorIncidentCorrelation(incident);
      if (level === "error") {
        logger.error("supervisor_incident", {
          type: incident.type,
          reason: incident.reason,
          context: incident.context,
        });
      } else {
        logger.warn("supervisor_incident", {
          type: incident.type,
          reason: incident.reason,
          context: incident.context,
        });
      }
      pushEvent({
        kind: eventKind,
        level,
        payload: { type: "supervisor_incident", incident },
        correlation,
      });
    },
    requestRewrite: async (incident) => {
      logger.warn("supervisor_request_rewrite", incident.context);
      pushEvent({
        kind: "INFO",
        level: "warn",
        payload: { type: "supervisor_request_rewrite", incident },
        correlation: inferSupervisorIncidentCorrelation(incident),
      });
    },
    requestRedispatch: async (incident) => {
      logger.warn("supervisor_request_redispatch", incident.context);
      pushEvent({
        kind: "INFO",
        level: "warn",
        payload: { type: "supervisor_request_redispatch", incident },
        correlation: inferSupervisorIncidentCorrelation(incident),
      });
    },
  },
});

const childBudgetTrackers = new Map<string, BudgetTracker>();

const childBudgetManager: ChildBudgetManager = {
  registerChildBudget(childId, limits) {
    if (!limits) {
      return;
    }
    const normalised: BudgetLimits = { ...limits };
    const existing = childBudgetTrackers.get(childId);
    if (existing) {
      return;
    }
    childBudgetTrackers.set(childId, new BudgetTracker(normalised));
  },
  consumeChildBudget(childId, consumption, metadata) {
    const tracker = childBudgetTrackers.get(childId);
    if (!tracker) {
      return null;
    }
    return tracker.consume(consumption, metadata);
  },
  refundChildBudget(childId, charge) {
    const tracker = childBudgetTrackers.get(childId);
    if (tracker && charge) {
      tracker.refund(charge);
    }
  },
  releaseChildBudget(childId) {
    childBudgetTrackers.delete(childId);
  },
};

function extractMetadataGoals(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) {
    return [];
  }

  const collected: string[] = [];
  const candidateKeys = ["goal", "goals", "objective", "objectives", "mission", "target"];
  for (const key of candidateKeys) {
    const value = metadata[key];
    if (typeof value === "string") {
      collected.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          collected.push(entry);
        }
      }
    }
  }

  return Array.from(
    new Set(
      collected
        .map((goal) => goal.toString().trim())
        .filter((goal) => goal.length > 0),
    ),
  );
}

function extractMetadataTags(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) {
    return [];
  }

  const tags = new Set<string>();
  const candidateKeys = ["tags", "labels", "topics", "areas", "keywords"];
  for (const key of candidateKeys) {
    const value = metadata[key];
    if (typeof value === "string") {
      tags.add(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          tags.add(entry);
        }
      }
    }
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" && /tag|topic|domain|area|category/i.test(key)) {
      tags.add(value);
    } else if (Array.isArray(value) && /tag|topic|domain|area|category/i.test(key)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          tags.add(entry);
        }
      }
    }
  }

  return Array.from(tags)
    .map((tag) => tag.toString().trim().toLowerCase())
    .filter((tag) => tag.length > 0);
}

function renderPromptForMemory(prompt: unknown): string {
  if (!prompt || typeof prompt !== "object") {
    return "";
  }

  const segments: string[] = [];
  const record = prompt as Record<string, unknown>;
  for (const key of ["system", "user", "assistant"]) {
    const value = record[key];
    if (typeof value === "string") {
      segments.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          segments.push(entry);
        }
      }
    }
  }

  return segments.join(" ").slice(0, 512);
}

type ChildCreatePrompt = z.infer<typeof ChildCreateInputSchema>["prompt"];

/**
 * Normalises arbitrary identifiers (job labels, slugs…) into a compact
 * lowercase string compatible with the graph node naming scheme. Non-alphanumeric
 * characters are replaced to avoid creating invalid node IDs.
 */
function sanitiseIdentifier(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") {
    return fallback;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    return fallback;
  }
  const collapsed = trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (collapsed.length === 0) {
    return fallback;
  }
  return collapsed.slice(0, 64);
}

/**
 * Looks up the first string value associated with one of the provided metadata
 * keys. The helper keeps the extraction logic readable when multiple aliases
 * may be supplied by callers.
 */
function pickMetadataString(
  metadata: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Derives a stable job identifier for ad-hoc children spawned outside of plan
 * executions. The identifier is prefixed to avoid clashing with planner
 * generated jobs while still reflecting operator-provided hints when available.
 */
function deriveManualJobId(childId: string, metadata: Record<string, unknown> | undefined): string {
  const explicit = pickMetadataString(metadata, ["job_id", "jobId", "job", "jobSlug", "jobName"]);
  const base = sanitiseIdentifier(explicit, childId);
  return `manual-${base}`;
}

/**
 * Extracts a human-friendly child name from metadata while falling back to the
 * technical identifier when no label is provided.
 */
function deriveManualChildName(childId: string, metadata: Record<string, unknown> | undefined): string {
  const candidate = pickMetadataString(metadata, ["name", "label", "title", "alias", "child_name"]);
  if (!candidate) {
    return childId;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : childId;
}

/**
 * Normalises a prompt segment (string or string array) into a single string.
 * Empty entries are ignored so transcripts remain concise.
 */
function normalisePromptSegment(segment: string | string[] | undefined): string | undefined {
  if (!segment) {
    return undefined;
  }
  if (typeof segment === "string") {
    const trimmed = segment.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const parts = segment
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n");
}

/**
 * Extracts the system prompt string, if any, so a synthetic transcript entry
 * can be recorded when we materialise ad-hoc children in the graph.
 */
function deriveSystemPrompt(prompt: ChildCreatePrompt | undefined): string | undefined {
  if (!prompt) {
    return undefined;
  }
  return normalisePromptSegment(prompt.system);
}

/**
 * Derives a runtime label used by the dashboard. Metadata wins over the
 * underlying executable name which itself falls back to the configured default.
 */
function deriveRuntimeLabel(
  metadata: Record<string, unknown> | undefined,
  runtimeStatus: ChildRuntimeStatus,
): string {
  const metadataRuntime = pickMetadataString(metadata, ["runtime", "model", "engine", "llm"]);
  if (metadataRuntime) {
    return metadataRuntime.trim();
  }
  const command = runtimeStatus.command ?? "";
  const commandBasename = command.length > 0 ? pathBasename(command) : "";
  if (commandBasename.length > 0) {
    return commandBasename;
  }
  return DEFAULT_CHILD_RUNTIME;
}

interface ManualChildGraphOptions {
  /** Unique identifier assigned to the child runtime. */
  childId: string;
  /** Snapshot returned by the supervisor index. */
  snapshot: ChildRecordSnapshot;
  /** Metadata persisted alongside the manifest (may include labels/goals). */
  metadata: Record<string, unknown> | undefined;
  /** Prompt blueprint submitted during creation, if any. */
  prompt: ChildCreatePrompt | undefined;
  /** Low-level runtime status (command, spawn time…). */
  runtimeStatus: ChildRuntimeStatus;
  /** Timestamp reported by `child_create` for the start of the child. */
  startedAt: number;
}

/**
 * Ensures ad-hoc child creations appear in the graph by synthesising a job and
 * child node when the planner did not pre-register them. This keeps the
 * dashboard consistent regardless of how the runtime was spawned.
 */
function ensureChildVisibleInGraph(options: ManualChildGraphOptions): void {
  const { childId, snapshot, metadata, prompt, runtimeStatus, startedAt } = options;
  const existing = graphState.getChild(childId);
  if (existing) {
    graphState.syncChildIndexSnapshot(snapshot);
    return;
  }

  const goals = extractMetadataGoals(metadata);
  const jobId = deriveManualJobId(childId, metadata);
  const createdAtCandidates = [snapshot.startedAt, startedAt, Date.now()].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  const createdAt = createdAtCandidates.length > 0 ? createdAtCandidates[0]! : Date.now();

  if (!graphState.getJob(jobId)) {
    graphState.createJob(jobId, { createdAt, goal: goals[0], state: "running" });
  } else if (goals[0]) {
    graphState.patchJob(jobId, { goal: goals[0] });
  }

  const runtimeLabel = deriveRuntimeLabel(metadata, runtimeStatus);
  const systemPrompt = deriveSystemPrompt(prompt);
  const spec: SpawnChildSpec = {
    name: deriveManualChildName(childId, metadata),
    runtime: runtimeLabel,
    goals: goals.length > 0 ? goals.slice(0, 5) : undefined,
    system: systemPrompt,
  };

  graphState.createChild(jobId, childId, spec, { createdAt, ttlAt: null });
  graphState.patchChild(childId, {
    state: snapshot.state,
    runtime: runtimeLabel,
    lastHeartbeatAt: snapshot.lastHeartbeatAt,
    startedAt: snapshot.startedAt,
    waitingFor: null,
    pendingId: null,
  });
  graphState.syncChildIndexSnapshot(snapshot);
}

function summariseChildOutputs(outputs: ChildCollectedOutputs): {
  text: string;
  tags: string[];
  kind: ReviewKind;
} {
  const parts: string[] = [];
  const tags = new Set<string>(["child"]);
  let kind: ReviewKind = "text";

  const codeExtensions = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cs", "json", "mjs"]);
  for (const artifact of outputs.artifacts) {
    const ext = artifact.path.split(".").pop()?.toLowerCase();
    if (ext) {
      tags.add(ext);
      if (codeExtensions.has(ext)) {
        kind = "code";
      }
    }
  }

  for (const message of outputs.messages) {
    tags.add(message.stream);
    const parsed = message.parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.content === "string") {
        parts.push(record.content);
        continue;
      }
      if (typeof record.text === "string") {
        parts.push(record.text);
        continue;
      }
      parts.push(JSON.stringify(record));
    } else if (typeof parsed === "string") {
      parts.push(parsed);
    } else if (typeof message.raw === "string") {
      parts.push(message.raw);
    }
  }

  if (kind !== "code") {
    const joined = parts.join(" ").toLowerCase();
    if (/\betape\b|\bétape\b|\bplan\b|\bphase\b/.test(joined)) {
      kind = "plan";
    }
  }

  let text = parts.join("\n").slice(0, 2_000).trim();
  if (!text) {
    text = outputs.artifacts
      .map((artifact) => `${artifact.path} (${artifact.size ?? 0} bytes)`)
      .join("; ");
  }
  if (!text) {
    text = "(aucune sortie)";
  }

  return { text, tags: Array.from(tags), kind };
}

function countMatches(pattern: RegExp, text: string): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function deriveCodeQualitySignals(summaryText: string): ScoreCodeInput {
  const tokens = summaryText.split(/\s+/).filter((token) => token.length > 0);
  const testsSignals = countMatches(/\b(test|describe|it|expect)\b/gi, summaryText);
  const lintSignals =
    countMatches(/\b(?:lint|eslint|tsc|warning|erreur|error|exception)\b/gi, summaryText) +
    countMatches(/\b(fail|échec)\b/gi, summaryText);
  const complexityEstimate = tokens.length === 0 ? 5 : Math.ceil(tokens.length / 40);

  return {
    testsPassed: Math.min(testsSignals, 6),
    lintErrors: Math.min(lintSignals, 10),
    complexity: Math.min(complexityEstimate, 100),
  };
}

function deriveTextQualitySignals(summaryText: string, reviewScore: number): ScoreTextInput {
  const condensed = summaryText.replace(/\s+/g, " ").trim();
  const sentences = condensed.split(/[.!?]+/).map((part) => part.trim()).filter((part) => part.length > 0);
  const words = condensed.length > 0 ? condensed.split(/\s+/) : [];
  const averageSentenceLength = sentences.length > 0 ? words.length / sentences.length : words.length;
  const readability = Math.min(100, Math.max(20, 120 - averageSentenceLength * 3));
  const bulletMatches = countMatches(/\n\s*(?:[-*•]|\d+\.)/g, summaryText);
  const sectionMatches = countMatches(/\n\s*[A-Za-zÀ-ÿ0-9]+\s*:/g, summaryText);
  const structure = Math.min(1, bulletMatches / 5 + sectionMatches / 6 + (sentences.length > 3 ? 0.2 : 0));

  return {
    factsOK: Math.min(1, Math.max(0, reviewScore)),
    readability,
    structure: Math.min(1, Math.max(0, structure)),
  };
}

function derivePlanQualitySignals(summaryText: string, reviewScore: number): ScorePlanInput {
  const lines = summaryText.split(/\n+/).map((line) => line.trim());
  const nonEmpty = lines.filter((line) => line.length > 0);
  const stepLines = nonEmpty.filter((line) => /^(?:\d+\.|[-*•])/.test(line));
  const lower = summaryText.toLowerCase();
  const coherence = Math.min(1, stepLines.length / Math.max(nonEmpty.length, 1));
  const coverage = Math.min(1, stepLines.length / 6 + (summaryText.length > 400 ? 0.25 : 0));
  let risk = reviewScore < 0.5 ? 0.8 : reviewScore < 0.7 ? 0.55 : 0.35;
  if (!/fallback|plan\s*b|mitigation|contingence|secours/.test(lower)) {
    risk += 0.2;
  }
  risk += Math.min(countMatches(/\brisque|bloquant|retard|incident\b/gi, summaryText) * 0.1, 0.3);

  return {
    coherence: Math.min(1, Math.max(0, coherence)),
    coverage: Math.min(1, Math.max(0, coverage)),
    risk: Math.min(1, Math.max(0, risk)),
  };
}

interface QualityAssessmentComputation {
  score: number;
  rubric: Record<string, number>;
  metrics: Record<string, number>;
}

function computeQualityAssessment(
  kind: ReviewKind,
  summaryText: string,
  review: ReviewResult,
): QualityAssessmentComputation | null {
  switch (kind) {
    case "code": {
      const signals = deriveCodeQualitySignals(summaryText);
      const result = scoreCode(signals);
      return { score: result.score, rubric: result.rubric, metrics: signals };
    }
    case "text": {
      const signals = deriveTextQualitySignals(summaryText, review.overall);
      const result = scoreText(signals);
      return { score: result.score, rubric: result.rubric, metrics: signals };
    }
    case "plan": {
      const signals = derivePlanQualitySignals(summaryText, review.overall);
      const result = scorePlan(signals);
      return { score: result.score, rubric: result.rubric, metrics: signals };
    }
    default:
      return null;
  }
}

function getChildToolContext(): ChildToolContext {
  return {
    supervisor: childSupervisor,
    logger,
    loopDetector,
    contractNet,
    supervisorAgent: orchestratorSupervisor,
    idempotency: runtimeFeatures.enableIdempotency ? idempotencyRegistry : undefined,
    budget: childBudgetManager,
  };
}

function getPlanToolContext(): PlanToolContext {
  return {
    supervisor: childSupervisor,
    graphState,
    logger,
    childrenRoot: CHILDREN_ROOT,
    defaultChildRuntime: DEFAULT_CHILD_RUNTIME,
    emitEvent: (event) => {
      pushEvent({
        kind: event.kind,
        level: event.level,
        jobId: event.jobId,
        childId: event.childId,
        payload: event.payload,
        correlation: event.correlation ?? undefined,
      });
    },
    stigmergy,
    blackboard: runtimeFeatures.enableBlackboard ? blackboard : undefined,
    supervisorAgent: orchestratorSupervisor,
    causalMemory: runtimeFeatures.enableCausalMemory ? causalMemory : undefined,
    valueGuard: runtimeFeatures.enableValueGuard
      ? { graph: valueGraph, registry: valueGuardRegistry }
      : undefined,
    loopDetector,
    autoscaler: runtimeFeatures.enableAutoscaler ? autoscaler : undefined,
    btStatusRegistry,
    planLifecycle,
    planLifecycleFeatureEnabled: runtimeFeatures.enablePlanLifecycle,
    idempotency: runtimeFeatures.enableIdempotency ? idempotencyRegistry : undefined,
  };
}

function getTxToolContext(): TxToolContext {
  return {
    transactions: graphTransactions,
    resources,
    locks: graphLocks,
    idempotency: runtimeFeatures.enableIdempotency ? idempotencyRegistry : undefined,
  };
}

function getGraphBatchToolContext(): GraphBatchToolContext {
  return {
    transactions: graphTransactions,
    resources,
    locks: graphLocks,
    idempotency: runtimeFeatures.enableIdempotency ? idempotencyRegistry : undefined,
  };
}

function getGraphDiffToolContext(): GraphDiffToolContext {
  return { transactions: graphTransactions, resources, locks: graphLocks };
}

function getGraphLockToolContext(): GraphLockToolContext {
  return { locks: graphLocks };
}

type GraphDiffSelectorInput = z.infer<typeof GraphDiffInputSchema>["from"];

function describeSelectorForLog(selector: GraphDiffSelectorInput): string {
  if ("graph" in selector) {
    return "descriptor";
  }
  if ("version" in selector) {
    return `version:${selector.version}`;
  }
  return "latest";
}

function getCoordinationToolContext(): CoordinationToolContext {
  return {
    blackboard,
    stigmergy,
    contractNet,
    logger,
    idempotency: runtimeFeatures.enableIdempotency ? idempotencyRegistry : undefined,
    contractNetWatcherTelemetry,
  };
}

function getAgentToolContext(): AgentToolContext {
  return { autoscaler, logger };
}

function getKnowledgeToolContext(): KnowledgeToolContext {
  return { knowledgeGraph, logger };
}

function getMemoryVectorToolContext(): MemoryVectorToolContext {
  return { vectorIndex: vectorMemoryIndex, logger };
}

interface ChildCollectMemoryPayload {
  childId: string;
  summaryText: string;
  tags: string[];
  reviewScore: number;
  artifactCount: number;
  reflection: ReflectionResult | null;
}

async function maybeIndexChildCollectMemory(payload: ChildCollectMemoryPayload): Promise<void> {
  const trimmed = payload.summaryText.trim();
  if (trimmed.length < 160) {
    return;
  }

  let documentId: string | null = null;
  try {
    const document = await vectorMemoryIndex.upsert({
      text: trimmed,
      tags: Array.from(new Set([...payload.tags, `child:${payload.childId}`])),
      metadata: {
        child_id: payload.childId,
        review_score: payload.reviewScore,
        artifact_count: payload.artifactCount,
        reflection: payload.reflection
          ? {
              insights: payload.reflection.insights.slice(0, 3),
              next_steps: payload.reflection.nextSteps.slice(0, 3),
            }
          : null,
        source: "child_collect",
      },
    });
    documentId = document.id;
  } catch (error) {
    logger.warn("memory_vector_index_failed", {
      child_id: payload.childId,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const features = getRuntimeFeatures();
  if (!features.enableKnowledge || !documentId) {
    return;
  }

  try {
    await knowledgeGraphPersistence.upsert({
      subject: `memory:${documentId}`,
      predicate: "describes_child",
      object: `child:${payload.childId}`,
      source: "child_collect",
      confidence: normaliseConfidence(payload.reviewScore / 100),
    });
  } catch (error) {
    logger.warn("memory_kg_index_failed", {
      child_id: payload.childId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function normaliseConfidence(value: number | null | undefined): number {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return 0.5;
  }
  return Math.max(0.05, Math.min(1, value));
}

function getCausalToolContext(): CausalToolContext {
  return { causalMemory, logger };
}

/** Capture the knowledge graph state so integration tests can restore it. */
function snapshotKnowledgeGraph(): KnowledgeTripleSnapshot[] {
  return knowledgeGraph.exportAll();
}

/** Replace the knowledge graph entries with the provided snapshots. */
function restoreKnowledgeGraph(snapshots: KnowledgeTripleSnapshot[]): void {
  knowledgeGraph.restore(snapshots);
  knowledgeGraphPersistence
    .persist()
    .catch((error) =>
      logger.warn("knowledge_persist_failed", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
}

function getValueToolContext(): ValueToolContext {
  return { valueGraph, logger };
}

/** Capture the value guard configuration to keep end-to-end tests isolated. */
function snapshotValueGraphConfiguration(): ValueGraphConfig | null {
  return valueGraph.exportConfiguration();
}

/** Restore the value guard configuration captured before a scenario. */
function restoreValueGraphConfiguration(config: ValueGraphConfig | null): void {
  valueGraph.restoreConfiguration(config);
}

class CancellationFeatureDisabledError extends Error {
  public readonly code = "E-CANCEL-DISABLED";
  public readonly hint = "enable_cancellation";

  constructor() {
    super("cancellation feature disabled");
    this.name = "CancellationFeatureDisabledError";
  }
}

function ensureKnowledgeEnabled(toolName: string) {
  if (!runtimeFeatures.enableKnowledge) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "KNOWLEDGE_DISABLED", tool: toolName, message: "knowledge module disabled" }),
        },
      ],
    };
  }
  return null;
}

function ensureAssistEnabled(toolName: string) {
  if (!runtimeFeatures.enableAssist) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "ASSIST_DISABLED", tool: toolName, message: "assist module disabled" }),
        },
      ],
    };
  }
  return ensureKnowledgeEnabled(toolName);
}

function ensureCausalMemoryEnabled(toolName: string) {
  if (!runtimeFeatures.enableCausalMemory) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "CAUSAL_MEMORY_DISABLED", tool: toolName, message: "causal memory module disabled" }),
        },
      ],
    };
  }
  return null;
}

function ensureValueGuardEnabled(toolName: string) {
  if (!runtimeFeatures.enableValueGuard) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "VALUE_GUARD_DISABLED", tool: toolName, message: "value guard disabled" }),
        },
      ],
    };
  }
  return null;
}

function ensureEventsBusEnabled(toolName: string) {
  if (!runtimeFeatures.enableEventsBus) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "EVENTS_BUS_DISABLED", tool: toolName, message: "events bus disabled" }),
        },
      ],
    };
  }
  return null;
}

function ensureLocksEnabled(toolName: string) {
  if (!runtimeFeatures.enableLocks) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "LOCKS_DISABLED", tool: toolName, message: "graph locks disabled" }),
        },
      ],
    };
  }
  return null;
}

function ensureBulkEnabled(toolName: string) {
  if (!runtimeFeatures.enableBulk) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "BULK_DISABLED", tool: toolName, message: "bulk tools disabled" }),
        },
      ],
    };
  }
  return null;
}

/**
 * Guards fine-grained child management tools so they can only be exercised when
 * the corresponding feature flag is enabled. This prevents partially configured
 * deployments from invoking orchestration helpers that rely on richer child
 * indexing guarantees.
 */
function ensureChildOpsFineEnabled(toolName: string) {
  if (!runtimeFeatures.enableChildOpsFine) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "CHILD_OPS_FINE_DISABLED", tool: toolName, message: "child fine operations disabled" }),
        },
      ],
    };
  }
  return null;
}

function ensureTransactionsEnabled(toolName: string) {
  if (!runtimeFeatures.enableTx) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "TRANSACTIONS_DISABLED", tool: toolName, message: "transactions module disabled" }),
        },
      ],
    };
  }
  return null;
}

/**
 * Guards MCP discovery tools so they cannot be invoked unless the dedicated flag is enabled.
 * This keeps the handshake surface minimised while still logging the attempt for operators.
 */
function ensureMcpIntrospectionEnabled(toolName: string) {
  if (!runtimeFeatures.enableMcpIntrospection) {
    logger.warn(`${toolName}_disabled`, { tool: toolName });
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: j({ error: "MCP_INTROSPECTION_DISABLED", tool: toolName, message: "mcp introspection disabled" }),
        },
      ],
    };
  }
  return null;
}

// ---------------------------
// Utils
// ---------------------------

const now = () => Date.now();
const j = (o: unknown) => JSON.stringify(o, null, 2);

/**
 * Serialises a {@link PathResolutionError} into the legacy MCP text payload expected by the
 * historical graph maintenance tools.
 */
function formatWorkspacePathError(error: PathResolutionError) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: j({
          error: error.code,
          message: error.message,
          hint: error.hint,
          details: error.details,
        }),
      },
    ],
  };
}

function extractStringProperty(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  const raw = candidate[key];
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractRunId(payload: unknown): string | null {
  return extractStringProperty(payload, "run_id");
}

function extractOpId(payload: unknown): string | null {
  return extractStringProperty(payload, "op_id") ?? extractStringProperty(payload, "operation_id");
}

function extractGraphId(payload: unknown): string | null {
  return extractStringProperty(payload, "graph_id") ?? null;
}

function extractNodeId(payload: unknown): string | null {
  return extractStringProperty(payload, "node_id") ?? null;
}

function extractChildId(payload: unknown): string | null {
  return extractStringProperty(payload, "child_id") ?? null;
}

function extractJobId(payload: unknown): string | null {
  return extractStringProperty(payload, "job_id") ?? null;
}

function extractStringCandidate(payload: unknown, keys: readonly string[]): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const value = record[key];
    if (value === null) {
      return null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      return null;
    }
  }
  return null;
}

function extractComponentTag(payload: unknown): string | null {
  return (
    extractStringCandidate(payload, ["component", "component_id", "componentId", "origin", "source_component"]) ?? null
  );
}

function extractStageTag(payload: unknown): string | null {
  return extractStringCandidate(payload, ["stage", "phase", "status", "state"]);
}

function extractElapsedMilliseconds(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const keys = ["elapsed_ms", "elapsedMs", "duration_ms", "durationMs", "latency_ms", "latencyMs"];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }
    const value = record[key];
    if (value === null) {
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.round(parsed));
      }
    }
  }
  return null;
}

function normaliseTag(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveEventComponent(category: EventCategory, ...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const normalised = normaliseTag(candidate ?? null);
    if (normalised) {
      return normalised;
    }
  }
  return category;
}

function resolveEventStage(kind: string, message: string, ...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const normalised = normaliseTag(candidate ?? null);
    if (normalised) {
      return normalised;
    }
  }
  const fallback = normaliseTag(kind.toLowerCase()) ?? normaliseTag(message) ?? "event";
  return fallback;
}

function resolveEventElapsedMs(...candidates: Array<number | null | undefined>): number | null {
  for (const candidate of candidates) {
    if (candidate === null) {
      return null;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, Math.round(candidate));
    }
  }
  return null;
}

function deriveEventMessage(kind: string, payload: unknown): string {
  const msg = extractStringProperty(payload, "msg");
  if (msg) {
    return msg;
  }
  return kind.toLowerCase();
}

const EVENT_KIND_TO_CATEGORY: Record<EventKind, EventCategory> = {
  PLAN: "graph",
  START: "graph",
  PROMPT: "child",
  PENDING: "child",
  REPLY_PART: "child",
  REPLY: "child",
  STATUS: "graph",
  AGGREGATE: "graph",
  KILL: "scheduler",
  HEARTBEAT: "scheduler",
  INFO: "graph",
  WARN: "graph",
  ERROR: "graph",
  BT_RUN: "bt",
  SCHEDULER: "scheduler",
  AUTOSCALER: "scheduler",
  COGNITIVE: "child",
};

function deriveEventCategory(kind: EventKind): EventCategory {
  return EVENT_KIND_TO_CATEGORY[kind] ?? "graph";
}

const EVENT_CATEGORY_SET = new Set<EventCategory>(EVENT_CATEGORIES);

function parseEventCategories(values: readonly string[] | undefined): EventCategory[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const collected: EventCategory[] = [];
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || !EVENT_CATEGORY_SET.has(trimmed as EventCategory)) {
      continue;
    }
    const category = trimmed as EventCategory;
    if (!collected.includes(category)) {
      collected.push(category);
    }
  }
  return collected.length > 0 ? collected : undefined;
}

function resolveChildLogLevel(stream: "stdout" | "stderr" | "meta"): string {
  switch (stream) {
    case "stderr":
      return "error";
    case "meta":
      return "debug";
    default:
      return "info";
  }
}

const OpCancelInputSchema = z
  .object({
    op_id: z.string().min(1),
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();
const OpCancelInputShape = OpCancelInputSchema.shape;

const PlanCancelInputSchema = z
  .object({
    run_id: z.string().min(1),
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();
const PlanCancelInputShape = PlanCancelInputSchema.shape;

/**
 * Schema guarding MCP introspection tools. They do not accept parameters to
 * keep the handshake deterministic therefore the schema is a strict empty
 * object.
 */
const McpIntrospectionInputSchema = z.object({}).strict();
const McpIntrospectionInputShape = McpIntrospectionInputSchema.shape;

/**
 * Payload accepted by the lightweight `health_check` RPC. The optional flag
 * allows callers to request extended probe details without making the handler
 * heavyweight for the common case where a simple availability verdict is
 * enough.
 */
const HealthCheckInputSchema = z
  .object({
    include_details: z.boolean().optional(),
  })
  .strict();
const HealthCheckInputShape = HealthCheckInputSchema.shape;

/** Status values surfaced by each health check probe. */
type HealthCheckStatus = "ok" | "error";

/**
 * Snapshot describing an individual subsystem probe. The handler reports the
 * execution latency so operators can spot slow dependencies even when they are
 * technically up.
 */
interface HealthCheckProbeResult {
  name: string;
  status: HealthCheckStatus;
  /** Execution latency (milliseconds) recorded for the probe. */
  elapsed_ms: number;
  /** Optional structured details exposed when callers opt-in. */
  detail?: Record<string, unknown> | null;
  /** Optional error message when the probe fails. */
  error?: string | null;
}

/**
 * Structured payload returned by the `health_check` RPC. Keeping the contract
 * explicit in TypeScript avoids regressions when new probes are introduced.
 */
interface HealthCheckPayload extends Record<string, unknown> {
  status: HealthCheckStatus;
  /** ISO-8601 timestamp describing when the health snapshot was produced. */
  observed_at: string;
  /** Server uptime (milliseconds) computed from the module initialisation. */
  uptime_ms: number;
  server: { name: string; version: string; protocol: string };
  probes: HealthCheckProbeResult[];
}

/**
 * Executes a probe while capturing latency and optional diagnostics. The helper
 * normalises thrown values into human friendly messages so the JSON-RPC
 * contract remains stable even when dependencies fail in unexpected ways.
 */
function runHealthCheckProbe(
  name: string,
  includeDetails: boolean,
  task: () => Record<string, unknown> | null | void,
): HealthCheckProbeResult {
  const startedAt = Date.now();
  try {
    const detail = task();
    const elapsed = Math.max(0, Date.now() - startedAt);
    const result: HealthCheckProbeResult = {
      name,
      status: "ok",
      elapsed_ms: elapsed,
    };
    if (includeDetails && detail !== undefined) {
      result.detail = detail ?? null;
    }
    return result;
  } catch (error) {
    const elapsed = Math.max(0, Date.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    const result: HealthCheckProbeResult = {
      name,
      status: "error",
      elapsed_ms: elapsed,
      error: message,
    };
    if (includeDetails) {
      result.detail = { message };
    }
    return result;
  }
}

/**
 * Input schema guarding the `resources_list` tool. Accepts optional prefix and
 * limit parameters so clients can page deterministically through the registry.
 */
const ResourceListInputSchema = z
  .object({
    prefix: z.string().trim().min(1).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
const ResourceListInputShape = ResourceListInputSchema.shape;

/** Input schema guarding the `resources_read` tool. */
const ResourceReadInputSchema = z.object({ uri: z.string().min(1) }).strict();
const ResourceReadInputShape = ResourceReadInputSchema.shape;

/** Input schema guarding the `resources_watch` tool. */
const ResourceWatchRunFilterSchema = z
  .object({
    levels: z.array(z.enum(["debug", "info", "warn", "error"])).max(4).optional(),
    kinds: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    job_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    op_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    graph_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    node_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    child_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    run_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    since_ts: z.number().int().min(0).optional(),
    until_ts: z.number().int().min(0).optional(),
  })
  .partial()
  .strict();

const ResourceWatchChildFilterSchema = z
  .object({
    streams: z.array(z.enum(["stdout", "stderr", "meta"])).max(3).optional(),
    job_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    run_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    op_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    graph_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    node_ids: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    since_ts: z.number().int().min(0).optional(),
    until_ts: z.number().int().min(0).optional(),
  })
  .partial()
  .strict();

const ResourceWatchBlackboardFilterSchema = z
  .object({
    keys: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    kinds: z.array(z.enum(["set", "delete", "expire"])).max(3).optional(),
    tags: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    since_ts: z.number().int().min(0).optional(),
    until_ts: z.number().int().min(0).optional(),
  })
  .partial()
  .strict();

const ResourceWatchInputSchema = z
  .object({
    uri: z.string().min(1),
    from_seq: z.number().int().min(0).optional(),
    limit: z.number().int().positive().max(500).optional(),
    format: z.enum(["json", "sse"]).optional(),
    keys: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    run: ResourceWatchRunFilterSchema.optional(),
    child: ResourceWatchChildFilterSchema.optional(),
    blackboard: ResourceWatchBlackboardFilterSchema.optional(),
  })
  .strict();
const ResourceWatchInputShape = ResourceWatchInputSchema.shape;

const EventSubscribeInputSchema = z
  .object({
    cats: z.array(z.string().trim().min(1)).max(10).optional(),
    levels: z.array(z.enum(["debug", "info", "warn", "error"])).max(4).optional(),
    run_id: z.string().trim().min(1).optional(),
    job_id: z.string().trim().min(1).optional(),
    child_id: z.string().trim().min(1).optional(),
    op_id: z.string().trim().min(1).optional(),
    graph_id: z.string().trim().min(1).optional(),
    node_id: z.string().trim().min(1).optional(),
    from_seq: z.number().int().min(0).optional(),
    limit: z.number().int().positive().max(500).optional(),
    format: z.enum(["jsonlines", "sse"]).optional(),
  })
  .strict();
const EventSubscribeInputShape = EventSubscribeInputSchema.shape;

/** Set of severity levels supported by the structured logger. */
const LOG_TAIL_LEVELS = new Set(["debug", "info", "warn", "error"]);

/**
 * Filters accepted by the `logs_tail` tool so callers can restrict correlated
 * entries to a subset of identifiers without downloading the full stream.
 */
const LogsTailFilterSchema = z
  .object({
    run_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    job_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    op_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    graph_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    node_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    child_ids: z.array(z.string().trim().min(1)).max(10).optional(),
    message_contains: z.array(z.string().trim().min(1)).max(5).optional(),
    since_ts: z.number().int().min(0).optional(),
    until_ts: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((filters, ctx) => {
    const hasAtLeastOne =
      (filters.run_ids?.length ?? 0) > 0 ||
      (filters.job_ids?.length ?? 0) > 0 ||
      (filters.op_ids?.length ?? 0) > 0 ||
      (filters.graph_ids?.length ?? 0) > 0 ||
      (filters.node_ids?.length ?? 0) > 0 ||
      (filters.child_ids?.length ?? 0) > 0 ||
      (filters.message_contains?.length ?? 0) > 0 ||
      filters.since_ts !== undefined ||
      filters.until_ts !== undefined;
    if (!hasAtLeastOne) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "empty_filters",
      });
    }
    if (
      filters.since_ts !== undefined &&
      filters.until_ts !== undefined &&
      filters.since_ts > filters.until_ts
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid_window",
        path: ["until_ts"],
      });
    }
  });

const LogsTailInputSchema = z
  .object({
    stream: z.enum(["server", "run", "child"]).default("server"),
    id: z.string().trim().min(1).optional(),
    from_seq: z.number().int().min(0).optional(),
    limit: z.number().int().positive().max(500).optional(),
    levels: z
      .array(z.string().trim().min(1))
      .max(4)
      .optional()
      .superRefine((levels, ctx) => {
        if (!levels) {
          return;
        }
        levels.forEach((level, index) => {
          const normalised = level.toLowerCase();
          if (!LOG_TAIL_LEVELS.has(normalised)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "invalid_level",
              path: [index],
            });
          }
        });
      }),
    filters: LogsTailFilterSchema.optional(),
  })
  .strict();
const LogsTailInputShape = LogsTailInputSchema.shape;

/**
 * Input schema guarding the `graph_subgraph_extract` tool. The strict contract
 * rejects stray properties so export destinations remain predictable.
 */
const GraphSubgraphExtractInputSchema = z
  .object({
    graph: GraphDescriptorSchema,
    node_id: z.string().min(1),
    run_id: z.string().min(1),
    directory: z.string().min(1).optional(),
    op_id: z.string().trim().min(1).optional(),
  })
  .strict();

const GraphSubgraphExtractInputShape = GraphSubgraphExtractInputSchema.shape;

type GraphSubgraphExtractInput = z.infer<typeof GraphSubgraphExtractInputSchema>;

interface PushEventInput {
  kind: EventKind;
  level?: EventLevel;
  source?: EventSource;
  jobId?: string | null;
  childId?: string | null;
  payload?: unknown;
  correlation?: EventCorrelationHints | null;
  component?: string | null;
  stage?: string | null;
  elapsedMs?: number | null;
}

function pushEvent(event: PushEventInput): OrchestratorEvent {
  const emitted = eventStore.emit({
    // Forward the semantic kind so downstream consumers can latch onto
    // PROMPT/PENDING/... identifiers without re-deriving them from payloads.
    kind: event.kind,
    level: event.level,
    source: event.source,
    jobId: event.jobId ?? undefined,
    childId: event.childId ?? undefined,
    payload: event.payload
  });
  graphState.recordEvent({
    seq: emitted.seq,
    ts: emitted.ts,
    kind: emitted.kind,
    level: emitted.level,
    jobId: emitted.jobId,
    childId: emitted.childId
  });

  const hints: EventCorrelationHints = {};
  mergeCorrelationHints(hints, event.correlation ?? undefined);
  if (event.jobId !== undefined) {
    mergeCorrelationHints(hints, { jobId: event.jobId ?? null });
  }
  if (event.childId !== undefined) {
    mergeCorrelationHints(hints, { childId: event.childId ?? null });
  }

  const payloadHints: EventCorrelationHints = {};
  const payloadRunId = extractRunId(event.payload);
  if (typeof payloadRunId === "string") {
    payloadHints.runId = payloadRunId;
  }
  const payloadOpId = extractOpId(event.payload);
  if (typeof payloadOpId === "string") {
    payloadHints.opId = payloadOpId;
  }
  const payloadGraphId = extractGraphId(event.payload);
  if (typeof payloadGraphId === "string") {
    payloadHints.graphId = payloadGraphId;
  }
  const payloadNodeId = extractNodeId(event.payload);
  if (typeof payloadNodeId === "string") {
    payloadHints.nodeId = payloadNodeId;
  }
  mergeCorrelationHints(hints, payloadHints);

  const runId = hints.runId ?? null;
  const opId = hints.opId ?? null;
  const graphId = hints.graphId ?? null;
  const nodeId = hints.nodeId ?? null;
  const jobId = hints.jobId ?? null;
  const childId = hints.childId ?? null;
  const message = deriveEventMessage(event.kind, event.payload);
  const category = deriveEventCategory(event.kind);
  const component = resolveEventComponent(category, event.component, extractComponentTag(event.payload));
  const stage = resolveEventStage(event.kind, message, event.stage, extractStageTag(event.payload));
  const elapsedMs = resolveEventElapsedMs(event.elapsedMs, extractElapsedMilliseconds(event.payload));

  eventBus.publish({
    cat: category,
    level: (event.level ?? emitted.level) as BusEventLevel,
    jobId,
    runId,
    opId,
    graphId,
    nodeId,
    childId,
    component,
    stage,
    elapsedMs,
    kind: event.kind,
    msg: message,
    data: event.payload,
  });
  if (runId) {
    resources.recordRunEvent(runId, {
      seq: emitted.seq,
      ts: emitted.ts,
      kind: emitted.kind,
      level: emitted.level,
      jobId,
      runId,
      opId,
      graphId,
      nodeId,
      childId,
      component,
      stage,
      elapsedMs,
      payload: emitted.payload,
    });
    try {
      logJournal.record({
        stream: "run",
        bucketId: runId,
        seq: emitted.seq,
        ts: emitted.ts,
        level: event.level ?? emitted.level,
        message,
        data: event.payload ?? null,
        jobId,
        runId,
        opId,
        graphId,
        nodeId,
        childId,
        component,
        stage,
        elapsedMs,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level: "error", message: "run_log_journal_failed", detail })}\n`,
      );
    }
  }
  return emitted;
}

function buildLiveEvents(input: { job_id?: string; child_id?: string; limit?: number; order?: "asc" | "desc"; min_seq?: number }) {
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 500) : 100;
  const afterSeq = typeof input.min_seq === "number" ? input.min_seq - 1 : undefined;
  const snapshot = eventBus.list({
    jobId: input.job_id,
    childId: input.child_id,
    afterSeq,
    limit,
  });
  const ordered = [...snapshot].sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq));
  return ordered.slice(0, limit).map((evt) => {
    const childId = evt.childId ?? null;
    const deepLink = childId ? `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(childId)}` : null;
    const commandUri = childId
      ? `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: childId }))}`
      : null;
    const eventKind = evt.kind && evt.kind.trim().length > 0 ? evt.kind : evt.cat.toUpperCase();
    return {
      seq: evt.seq,
      ts: evt.ts,
      // Surface the semantic kind (PROMPT/PENDING/...) when available so the
      // live event feed mirrors `events_subscribe` and the legacy `EventStore`
      // API. Falling back to the upper-cased message preserves deterministic
      // identifiers for bridged events that have not been migrated yet.
      kind: eventKind,
      level: evt.level,
      jobId: evt.jobId ?? null,
      childId,
      runId: evt.runId ?? null,
      opId: evt.opId ?? null,
      component: evt.component ?? null,
      stage: evt.stage ?? null,
      elapsed_ms: evt.elapsedMs ?? null,
      msg: evt.msg,
      payload: evt.data,
      vscode_deeplink: deepLink,
      vscode_command: commandUri,
    };
  });
}

// Heartbeat
let HEARTBEAT_TIMER: IntervalHandle | null = null;

function resolveHeartbeatIntervalMs(): number {
  const raw = runtimeTimings.heartbeatIntervalMs ?? DEFAULT_RUNTIME_TIMINGS.heartbeatIntervalMs;
  return Math.max(MIN_HEARTBEAT_INTERVAL_MS, raw);
}

function refreshHeartbeatTimer(): void {
  if (!HEARTBEAT_TIMER) {
    return;
  }
  stopHeartbeat();
  startHeartbeat();
}

/**
 * Publish a heartbeat event for every job currently marked as running. The helper keeps the
 * correlation logic reusable so deterministic tests can trigger heartbeats without waiting for
 * the scheduler interval to elapse.
 */
function emitHeartbeatTick(): void {
  for (const job of graphState.listJobsByState("running")) {
    const correlation = resolveJobEventCorrelation(job.id, { job });
    pushEvent({
      kind: "HEARTBEAT",
      jobId: correlation.jobId ?? job.id,
      payload: { msg: "alive" },
      correlation,
    });
  }
}

/**
 * Start the periodic heartbeat publisher when the orchestrator schedules background jobs. The
 * interval delegates to {@link emitHeartbeatTick} so the logic remains testable.
 */
function startHeartbeat() {
  if (HEARTBEAT_TIMER) return;
  const interval = resolveHeartbeatIntervalMs();
  HEARTBEAT_TIMER = runtimeTimers.setInterval(() => {
    emitHeartbeatTick();
  }, interval);
  HEARTBEAT_TIMER.unref?.();
}

/** Stop the heartbeat interval to avoid leaking timers when shutting down tests or transports. */
function stopHeartbeat(): void {
  if (!HEARTBEAT_TIMER) {
    return;
  }
  runtimeTimers.clearInterval(HEARTBEAT_TIMER);
  HEARTBEAT_TIMER = null;
}

// ---------------------------
// Orchestrateur (jobs/enfants)
// ---------------------------


function createJob(goal?: string): string {
  const jobId = `job_${randomUUID()}`;
  graphState.createJob(jobId, { goal, createdAt: now(), state: "running" });
  return jobId;
}

function createChild(jobId: string, spec: SpawnChildSpec, ttl_s?: number): string {
  const childId = `child_${randomUUID()}`;
  const createdAt = now();
  const ttlAt = ttl_s ? createdAt + ttl_s * 1000 : null;
  const normalizedSpec: SpawnChildSpec = { ...spec, runtime: spec.runtime ?? DEFAULT_CHILD_RUNTIME };
  graphState.createChild(jobId, childId, normalizedSpec, { createdAt, ttlAt });
  return childId;
}

function findJobIdByChild(childId: string): string | undefined {
  return graphState.findJobIdByChild(childId);
}

/**
 * Synthesises correlation hints for child-centric events by combining the
 * orchestrator state (graph snapshot + supervisor metadata) with optional
 * additional sources.
 */
function resolveChildEventCorrelation(
  childId: string,
  options: { child?: ChildSnapshot | null; extraSources?: Array<unknown | null | undefined> } = {},
): EventCorrelationHints {
  const childSnapshot = options.child ?? graphState.getChild(childId) ?? null;
  const jobCandidate = childSnapshot?.jobId ?? findJobIdByChild(childId) ?? null;
  const metadata = childSupervisor.childrenIndex.getChild(childId)?.metadata;
  const sources: Array<unknown | null | undefined> = [];
  if (metadata) {
    sources.push(metadata);
  }
  if (options.extraSources) {
    sources.push(...options.extraSources);
  }
  return buildChildCorrelationHints({
    childId,
    jobId: jobCandidate,
    sources,
  });
}

/**
 * Synthesises correlation hints for job-centric events by combining the
 * orchestrator state with supervisor metadata. The helper inspects the job
 * snapshot, associated children and any additional sources so job-scoped
 * events can inherit `runId`/`opId` hints derived from their participants.
 */
function resolveJobEventCorrelation(
  jobId: string,
  options: { job?: JobSnapshot | null; extraSources?: Array<unknown | null | undefined> } = {},
): EventCorrelationHints {
  const jobSnapshot = options.job ?? graphState.getJob(jobId) ?? null;
  const sources: Array<unknown | null | undefined> = [];

  if (jobSnapshot) {
    sources.push({
      job_id: jobSnapshot.id,
      state: jobSnapshot.state,
      child_ids: jobSnapshot.childIds,
    });

    for (const childId of jobSnapshot.childIds) {
      const child = graphState.getChild(childId);
      if (child) {
        sources.push(child);
      }
      const indexSnapshot = childSupervisor.childrenIndex.getChild(childId);
      if (indexSnapshot) {
        sources.push(indexSnapshot.metadata);
      }
    }
  }

  if (options.extraSources) {
    sources.push(...options.extraSources);
  }

  return buildJobCorrelationHints({ jobId, sources });
}

function pruneExpired() {
  const t = now();
  for (const child of graphState.listChildSnapshots()) {
    if (child.ttlAt && t > child.ttlAt && child.state !== "killed") {
      graphState.clearPendingForChild(child.id);
      graphState.patchChild(child.id, { state: "killed", waitingFor: null, pendingId: null, ttlAt: null });
      const correlation = resolveChildEventCorrelation(child.id, { child });
      const jobId = correlation.jobId ?? undefined;
      pushEvent({
        kind: "KILL",
        jobId,
        childId: correlation.childId ?? child.id,
        level: "warn",
        payload: { reason: "ttl" },
        correlation,
      });
    }
  }
  const expiredEntries = blackboard.evictExpired();
  if (expiredEntries.length > 0) {
    const keys = expiredEntries.map((event) => event.key);
    logger.info("bb_expire", {
      count: expiredEntries.length,
      keys: keys.slice(0, 5),
      truncated: keys.length > 5 ? keys.length - 5 : 0,
    });
  }
  if (runtimeFeatures.enableIdempotency) {
    idempotencyRegistry.pruneExpired(t);
  }
}

// ---------------------------
// Aggregation
// ---------------------------

function aggregateConcat(jobId: string, opts?: { includeSystem?: boolean; includeGoals?: boolean }) {
  const job = graphState.getJob(jobId);
  if (!job) {
    throw new Error(`Unknown job '${jobId}'`);
  }
  const transcripts = job.childIds.map((cid) => {
    const child = graphState.getChild(cid);
    const slice = graphState.getTranscript(cid, { limit: 1000 });
    const items = slice.items.filter((m) => {
      if (m.role === "system" && opts?.includeSystem === false) return false;
      if (m.role === "user" && child?.name && m.content.startsWith("Objectifs:") && opts?.includeGoals === false) return false;
      return true;
    });
    return {
      child_id: cid,
      name: child?.name ?? cid,
      transcript: items.map((m) => ({
        idx: m.idx,
        role: m.role as Role,
        content: m.content,
        ts: m.ts,
        actor: m.actor
      }))
    };
  });
  const summary = transcripts
    .map((t) => `# ${t.name}\n` + t.transcript.map((m) => `- [${m.role}] ${m.content}`).join("\n"))
    .join("\n\n");



  return { summary, transcripts, artifacts: [] as any[] };
}

function aggregateCompact(jobId: string, opts?: { includeSystem?: boolean; includeGoals?: boolean }) {
  const base = aggregateConcat(jobId, opts);
  const compactLines: string[] = [];
  for (const t of base.transcripts) {
    compactLines.push(`# ${t.name}`);
    const merged: { role: string; content: string }[] = [];
    for (const m of t.transcript) {
      if (m.role === "assistant") {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === "assistant") {
          prev.content = `${prev.content} ${m.content}`.replace(/\s+/g, " ").trim();
        } else {
          merged.push({ role: m.role, content: m.content });
        }
      } else {
        merged.push({ role: m.role, content: m.content });
      }
    }
    for (const m of merged) compactLines.push(`- [${m.role}] ${m.content}`);
    compactLines.push("");
  }
  const summary = compactLines.join("\n").trim();
  return { summary, transcripts: base.transcripts, artifacts: [] as any[] };
}

function aggregateJsonl(jobId: string) {
  const job = graphState.getJob(jobId);
  if (!job) throw new Error(`Unknown job '${jobId}'`);
  const lines: string[] = [];
  for (const cid of job.childIds) {
    const child = graphState.getChild(cid);
    const slice = graphState.getTranscript(cid, { limit: 5000 });
    for (const m of slice.items) {
      lines.push(JSON.stringify({ child_id: cid, child_name: child?.name ?? cid, idx: m.idx, role: m.role, content: m.content, ts: m.ts, actor: m.actor ?? null }));
    }
  }
  const summary = `jsonl_count=${lines.length}`;
  return { summary, transcripts: [], artifacts: lines };
}

function aggregate(jobId: string, strategy?: "concat" | "json_merge" | "vote" | "markdown_compact" | "jsonl", opts?: { includeSystem?: boolean; includeGoals?: boolean }) {
  switch (strategy) {
    case "markdown_compact":
      return aggregateCompact(jobId, opts);
    case "jsonl":
      return aggregateJsonl(jobId);
    case "json_merge":
    case "vote":
      return aggregateConcat(jobId, opts);
    case "concat":
    default:
      return aggregateConcat(jobId, opts);
  }
}

// ---------------------------
// Zod shapes et types
// ---------------------------

const ChildSpecShape = {
  name: z.string(),
  system: z.string().optional(),
  goals: z.array(z.string()).optional(),
  runtime: z.string().optional()
} as const;

const StartShape = {
  job_id: z.string(),
  children: z.array(z.object(ChildSpecShape)).optional()
} as const;
const StartSchema = z.object(StartShape);
type StartInput = z.infer<typeof StartSchema>;

const ChildPromptShape = {
  child_id: z.string(),
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
} as const;
const ChildPromptSchema = z.object(ChildPromptShape);
type ChildPromptInput = z.infer<typeof ChildPromptSchema>;
/**
 * Structured payload emitted by `child_prompt` so operators can reconcile
 * transcript growth without replaying the entire conversation history.
 */
type ChildPromptStructuredPayload = {
  /** Identifier assigned to the pending reply waiting on the child. */
  pending_id: string;
  /** Identifier of the child that received the appended messages. */
  child_id: string;
  /** Number of messages appended to the transcript during the call. */
  appended: number;
};
/**
 * Canonical shape returned by `child_prompt`, exposing the JSON friendly
 * payload alongside the textual representation required by MCP clients.
 */
type ChildPromptToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ChildPromptStructuredPayload;
};

const ChildPushReplyShape = { pending_id: z.string(), content: z.string() } as const;
const ChildPushReplySchema = z.object(ChildPushReplyShape);
type ChildPushReplyInput = z.infer<typeof ChildPushReplySchema>;

const ChildPushPartialShape = { pending_id: z.string(), delta: z.string(), done: z.boolean().optional() } as const;
const ChildPushPartialSchema = z.object(ChildPushPartialShape);
type ChildPushPartialInput = z.infer<typeof ChildPushPartialSchema>;

const StatusShape = { job_id: z.string().optional() } as const;
const StatusSchema = z.object(StatusShape);
type StatusInput = z.infer<typeof StatusSchema>;

const AggregateShape = {
  job_id: z.string(),
  // Accept any string to allow client wrappers with custom strategies; server falls back gracefully.
  strategy: z.string().optional(),
  include_system: z.boolean().optional(),
  include_goals: z.boolean().optional()
} as const;
const AggregateSchema = z.object(AggregateShape);
type AggregateInput = z.infer<typeof AggregateSchema>;

const KillShape = { child_id: z.string().optional(), job_id: z.string().optional() } as const;
const KillSchema = z.object(KillShape);
type KillInput = z.infer<typeof KillSchema>;

const ChildInfoShape = { child_id: z.string() } as const;
const ChildInfoSchema = z.object(ChildInfoShape);
type ChildInfoInput = z.infer<typeof ChildInfoSchema>;

const ChildTranscriptShape = {
  child_id: z.string(),
  since_index: z.number().int().min(0).optional(),
  since_ts: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  reverse: z.boolean().optional()
} as const;
const ChildTranscriptSchema = z.object(ChildTranscriptShape);
type ChildTranscriptInput = z.infer<typeof ChildTranscriptSchema>;

const ChildChatShape = {
  child_id: z.string(),
  content: z.string(),
  role: z.enum(["user", "system"]).optional()
} as const;
const ChildChatSchema = z.object(ChildChatShape);
type ChildChatInput = z.infer<typeof ChildChatSchema>;
/**
 * Structured payload surfaced by the `child_chat` tool so HTTP clients can
 * reason about pending replies without parsing the textual JSON blob.
 */
type ChildChatStructuredPayload = {
  /** Identifier assigned to the pending reply waiting on the child. */
  pending_id: string;
  /** Identifier of the child that received the prompt. */
  child_id: string;
  /** Role associated with the forwarded content (user/system today). */
  role: "user" | "system";
  /** Raw textual content forwarded to the child. */
  content: string;
};
/**
 * Canonical shape returned by `child_chat`, exposing both textual and
 * structured content to keep JSON-RPC responses backward compatible.
 */
type ChildChatToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ChildChatStructuredPayload;
};

const ChildRenameShape = { child_id: z.string(), name: z.string().min(1) } as const;
const ChildRenameSchema = z.object(ChildRenameShape);
type ChildRenameInput = z.infer<typeof ChildRenameSchema>;

const ChildResetShape = { child_id: z.string(), keep_system: z.boolean().optional() } as const;
const ChildResetSchema = z.object(ChildResetShape);
type ChildResetInput = z.infer<typeof ChildResetSchema>;

const GraphForgeAnalysisShape = {
  name: z.string().min(1),
  args: z.array(z.string()).optional(),
  weight_key: z.string().optional()
} as const;
const GraphForgeAnalysisSchema = z.object(GraphForgeAnalysisShape);
type GraphForgeAnalysisInput = z.infer<typeof GraphForgeAnalysisSchema>;

const GraphForgeShape = {
  source: z.string().optional(),
  path: z.string().optional(),
  entry_graph: z.string().optional(),
  weight_key: z.string().optional(),
  use_defined_analyses: z.boolean().optional(),
  analyses: z.array(GraphForgeAnalysisSchema).optional()
} as const;
const GraphForgeSchemaBase = z.object(GraphForgeShape);
const GraphForgeSchema = GraphForgeSchemaBase.refine(
  (input) => Boolean(input.source) || Boolean(input.path),
  { message: "Provide 'source' or 'path'", path: ["source"] }
);
type GraphForgeInput = z.infer<typeof GraphForgeSchema>;

// Graph export/save/load
const GraphExportShape = {
  format: z.enum(["json", "mermaid", "dot", "graphml"]).default("json"),
  direction: z.enum(["LR", "TB"]).optional(),
  label_attribute: z.string().min(1).optional(),
  weight_attribute: z.string().min(1).optional(),
  max_label_length: z.number().int().min(8).max(160).optional(),
  inline: z.boolean().default(true),
  path: z.string().min(1).optional(),
  pretty: z.boolean().default(true),
  truncate: z.number().int().min(256).max(16384).optional(),
} as const;
const GraphExportSchema = z.object(GraphExportShape).superRefine((input, ctx) => {
  if (!input.inline && !input.path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "when inline=false a path must be provided",
      path: ["path"],
    });
  }
});
type GraphExportInput = z.infer<typeof GraphExportSchema>;

const GraphSaveShape = { path: z.string() } as const;
const GraphSaveSchema = z.object(GraphSaveShape);
type GraphSaveInput = z.infer<typeof GraphSaveSchema>;

const GraphLoadShape = { path: z.string() } as const;
const GraphLoadSchema = z.object(GraphLoadShape);
type GraphLoadInput = z.infer<typeof GraphLoadSchema>;

const GraphRuntimeShape = { runtime: z.string().optional(), reset: z.boolean().optional() } as const;
const GraphRuntimeSchema = z.object(GraphRuntimeShape);
type GraphRuntimeInput = z.infer<typeof GraphRuntimeSchema>;

const GraphStatsShape = {} as const;
const GraphStatsSchema = z.object(GraphStatsShape);
type GraphStatsInput = z.infer<typeof GraphStatsSchema>;

const GraphInactivityShape = {
  scope: z.enum(["children"]).optional(),
  idle_threshold_ms: z.number().min(0).optional(),
  pending_threshold_ms: z.number().min(0).optional(),
  inactivity_threshold_sec: z.number().min(0).optional(),
  inactivityThresholdSec: z.number().min(0).optional(),
  job_id: z.string().optional(),
  runtime: z.string().optional(),
  state: z.string().optional(),
  include_children_without_messages: z.boolean().optional(),
  limit: z.number().optional(),
  format: z.enum(["json", "text"]).optional()
} as const;
const GraphInactivitySchema = z.object(GraphInactivityShape);
type GraphInactivityInput = z.infer<typeof GraphInactivitySchema>;

// job_view
const JobViewShape = { job_id: z.string(), per_child_limit: z.number().optional(), format: z.enum(["json", "text"]).optional(), include_system: z.boolean().optional() } as const;
const JobViewSchema = z.object(JobViewShape);
type JobViewInput = z.infer<typeof JobViewSchema>;

const EventsViewLiveShape = {
  job_id: z.string().optional(),
  child_id: z.string().optional(),
  limit: z.number().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  min_seq: z.number().optional()
} as const;
const EventsViewLiveSchema = z.object(EventsViewLiveShape);
type EventsViewLiveInput = z.infer<typeof EventsViewLiveSchema>;

const GraphPruneShape = {
  action: z.enum(["transcript", "events"]),
  child_id: z.string().optional(),
  keep_last: z.number().optional(),
  job_id: z.string().optional(),
  max_events: z.number().optional()
} as const;
const GraphPruneSchema = z.object(GraphPruneShape);
type GraphPruneInput = z.infer<typeof GraphPruneSchema>;

// ---------------------------
// Serveur MCP + Tools
// ---------------------------

interface GraphForgeGraph {
  name: string;
  directives: Map<string, unknown>;
  listNodes(): { id: string; attributes: Record<string, unknown> }[];
  listEdges(): { from: string; to: string; attributes: Record<string, unknown> }[];
  getNode(id: string): { id: string; attributes: Record<string, unknown> } | undefined;
  getOutgoing(id: string): { from: string; to: string; attributes: Record<string, unknown> }[];
  getDirective?(name: string): unknown;
}

interface GraphForgeCompiledAnalysisArg {
  value: unknown;
  tokenLine: number;
  tokenColumn: number;
}

interface GraphForgeCompiledAnalysis {
  name: string;
  tokenLine: number;
  tokenColumn: number;
  args: GraphForgeCompiledAnalysisArg[];
}

interface GraphForgeCompiled {
  graph: GraphForgeGraph;
  analyses: GraphForgeCompiledAnalysis[];
}

interface GraphForgeModule {
  compileSource(source: string, options?: { entryGraph?: string }): GraphForgeCompiled;
  shortestPath(graph: GraphForgeGraph, start: string, goal: string, options?: { weightAttribute?: string }): unknown;
  criticalPath(graph: GraphForgeGraph, options?: { weightAttribute?: string }): unknown;
  tarjanScc(graph: GraphForgeGraph): unknown;
}

type GraphForgeTaskSource = "dsl" | "request";

interface GraphForgeTask {
  name: string;
  args: string[];
  weightKey?: string;
  source: GraphForgeTaskSource;
}

let graphForgeModulePromise: Promise<GraphForgeModule> | null = null;

async function loadGraphForge(): Promise<GraphForgeModule> {
  if (!graphForgeModulePromise) {
    graphForgeModulePromise = (async () => {
      const distUrl = new URL("../graph-forge/dist/index.js", import.meta.url);
      try {
        return (await import(distUrl.href)) as GraphForgeModule;
      } catch (distError) {
        const srcUrl = new URL("../graph-forge/src/index.ts", import.meta.url);
        try {
          return (await import(srcUrl.href)) as GraphForgeModule;
        } catch {
          throw distError;
        }
      }
    })();
  }
  return graphForgeModulePromise;
}

function describeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "UnknownError", message: String(err) };
}

function toStringArg(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function runGraphForgeAnalysis(
  mod: GraphForgeModule,
  compiled: GraphForgeCompiled,
  task: GraphForgeTask,
  defaultWeightKey?: string
): unknown {
  const weightAttribute = task.weightKey ?? defaultWeightKey;
  switch (task.name) {
    case "shortestPath": {
      if (task.args.length < 2) {
        throw new Error("shortestPath requires <start> and <goal>");
      }
      const [start, goal] = task.args;
      return mod.shortestPath(compiled.graph, start, goal, { weightAttribute });
    }
    case "criticalPath":
      return mod.criticalPath(compiled.graph, { weightAttribute });
    case "stronglyConnected": {
      if (task.args.length) {
        throw new Error("stronglyConnected does not accept arguments");
      }
      return mod.tarjanScc(compiled.graph);
    }
    default:
      throw new Error(`Unknown analysis '${task.name}'`);
  }
}

const SERVER_NAME = "mcp-self-fork-orchestrator";
const SERVER_VERSION = "1.3.0";
const MCP_PROTOCOL_VERSION = "1.0";

updateMcpRuntimeSnapshot({
  server: { name: SERVER_NAME, version: SERVER_VERSION, protocol: MCP_PROTOCOL_VERSION },
});

async function invokeToolForRegistry(
  tool: string,
  args: unknown,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<CallToolResult> {
  const headers: Record<string, string> | undefined = extra.requestInfo?.headers
    ? Object.fromEntries(
        Object.entries(extra.requestInfo.headers).flatMap(([key, value]) => {
          if (typeof value === "string") {
            return [[key, value]];
          }
          if (Array.isArray(value)) {
            return [[key, value.join(", ")]];
          }
          return [] as Array<[string, string]>;
        }),
      )
    : undefined;
  const result = await routeJsonRpcRequest(tool, args, {
    headers,
    transport: "tool-os",
  });
  return result as CallToolResult;
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

const toolRegistry = await ToolRegistry.create({
  server,
  logger,
  runsRoot: process.env.MCP_RUNS_ROOT,
  clock: () => new Date(),
  invokeTool: invokeToolForRegistry,
});
process.once("exit", () => toolRegistry.close());

// Keep the MCP capabilities export in sync with the tools registered on the
// underlying `McpServer` instance. The SDK stores registrations in a private
// field therefore we rely on a defensive cast to access the internal map.
bindToolIntrospectionProvider(() => {
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { inputSchema?: ZodTypeAny; enabled?: boolean }>;
  })._registeredTools;
  if (!registry) {
    return [];
  }
  return Object.entries(registry).map(([name, tool]) => ({
    name,
    inputSchema: tool.inputSchema as ZodTypeAny | undefined,
    enabled: tool.enabled !== false,
  }));
});

/**
 * Tool exposing the runtime metadata so MCP clients can negotiate transports
 * and limits before issuing heavier requests.
 */
server.registerTool(
  "mcp_info",
  {
    title: "MCP info",
    description: "Expose les métadonnées du serveur MCP (transports, limites, flags).",
    inputSchema: McpIntrospectionInputShape,
  },
  async () => {
    const disabled = ensureMcpIntrospectionEnabled("mcp_info");
    if (disabled) {
      return disabled;
    }
    const info = getMcpInfo();
    return { content: [{ type: "text", text: j({ format: "json", info }) }] };
  },
);

/**
 * Tool exposing the namespace and schema catalogue so clients can discover the
 * enabled optional modules.
 */
server.registerTool(
  "mcp_capabilities",
  {
    title: "MCP capabilities",
    description: "Détaille les namespaces disponibles et leurs schémas résumés.",
    inputSchema: McpIntrospectionInputShape,
  },
  async () => {
    const disabled = ensureMcpIntrospectionEnabled("mcp_capabilities");
    if (disabled) {
      return disabled;
    }
    const capabilities = getMcpCapabilities();
    return { content: [{ type: "text", text: j({ format: "json", capabilities }) }] };
  },
);

server.registerTool(
  "tools_list",
  {
    title: "Tools list",
    description: "Répertorie les manifests dynamiques exposés via le Tool-OS.",
    inputSchema: ToolsListInputShape,
  },
  async (input: unknown) => {
    const parsed = ToolsListInputSchema.parse(input ?? {});
    const manifests = toolRegistry.list();
    const byName = parsed.names ? manifests.filter((manifest) => parsed.names!.includes(manifest.name)) : manifests;
    const filtered = parsed.kinds ? byName.filter((manifest) => parsed.kinds!.includes(manifest.kind)) : byName;
    const payload = { generated_at: new Date().toISOString(), tools: filtered };
    return {
      content: [{ type: "text", text: j({ tool: "tools_list", result: payload }) }],
      structuredContent: payload,
    };
  },
);

/**
 * Lightweight RPC used by smoke tests to validate the orchestrator without
 * invoking domain specific tools. The response aggregates a handful of quick
 * probes that cover the primary observability surfaces used in production.
 */
server.registerTool(
  "health_check",
  {
    title: "Health check",
    description: "Retourne l'état courant du serveur MCP et de ses sondes clés.",
    inputSchema: HealthCheckInputShape,
  },
  async (input: unknown) => {
    const parsed = HealthCheckInputSchema.parse(input ?? {});
    const includeDetails = parsed.include_details ?? false;
    const observedAt = new Date();

    const probes: HealthCheckProbeResult[] = [
      runHealthCheckProbe("mcp_info", includeDetails, () => {
        const info = getMcpInfo();
        if (!includeDetails) {
          return undefined;
        }
        return {
          transports: info.mcp.transports.map((transport) => transport.kind),
          feature_flags: info.features.length,
        } satisfies Record<string, unknown>;
      }),
      runHealthCheckProbe("event_bus", includeDetails, () => {
        const latest = eventBus.list({ limit: 1 });
        if (!includeDetails) {
          return undefined;
        }
        const mostRecent = latest.at(-1) ?? null;
        return {
          backlog_size: latest.length,
          latest_seq: mostRecent?.seq ?? null,
          latest_kind: mostRecent?.kind ?? null,
        } satisfies Record<string, unknown>;
      }),
      runHealthCheckProbe("log_journal", includeDetails, () => {
        const tail = logJournal.tail({ stream: "server", limit: 1 });
        if (!includeDetails) {
          return undefined;
        }
        const lastEntry = tail.entries.at(-1) ?? null;
        return {
          next_seq: tail.nextSeq,
          last_level: lastEntry?.level ?? null,
          last_message: lastEntry?.message ?? null,
        } satisfies Record<string, unknown>;
      }),
    ];

    const status: HealthCheckStatus = probes.some((probe) => probe.status !== "ok") ? "error" : "ok";
    const payload: HealthCheckPayload = {
      status,
      observed_at: observedAt.toISOString(),
      uptime_ms: Math.max(0, observedAt.getTime() - SERVER_STARTED_AT),
      server: { name: SERVER_NAME, version: SERVER_VERSION, protocol: MCP_PROTOCOL_VERSION },
      probes,
    };

    return {
      content: [{ type: "text" as const, text: j({ tool: "health_check", result: payload }) }],
      structuredContent: payload,
    };
  },
);

server.registerTool(
  "tool_compose_register",
  {
    title: "Tool compose register",
    description: "Assemble un pipeline de tools et persiste le manifest composite.",
    inputSchema: ToolComposeRegisterInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = ToolComposeRegisterInputSchema.parse(input);
      const request: CompositeRegistrationRequest = {
        name: parsed.name,
        title: parsed.title,
        description: parsed.description,
        tags: parsed.tags ?? [],
        steps: parsed.steps.map((step) => ({
          id: step.id,
          tool: step.tool,
          arguments: step.arguments ?? undefined,
          capture: step.capture ?? undefined,
        })),
      };
      const manifest = await toolRegistry.registerComposite(request);
      const payload = { tool: manifest.name, manifest };
      return {
        content: [{ type: "text", text: j({ tool: "tool_compose_register", result: payload }) }],
        structuredContent: payload,
      };
    } catch (error) {
      if (error instanceof ToolRegistrationError) {
        logger.warn("tool_compose_register_failed", { message: error.message });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: j({ error: "TOOL_REGISTRATION_FAILED", message: error.message }),
            },
          ],
        };
      }
      throw error;
    }
  },
);

server.registerTool(
  "resources_list",
  {
    title: "Resources list",
    description: "Répertorie les ressources MCP (graphes, runs, journaux, blackboard).",
    inputSchema: ResourceListInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = ResourceListInputSchema.parse(input ?? {});
      const entries = resources.list(parsed.prefix);
      const limited = parsed.limit ? entries.slice(0, parsed.limit) : entries;
      const result = { items: limited };
      return {
        content: [{ type: "text" as const, text: j({ tool: "resources_list", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const prefix =
        input && typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).prefix ?? null
          : null;
      return resourceToolError(logger, "resources_list", error, { prefix });
    }
  },
);

server.registerTool(
  "resources_read",
  {
    title: "Resources read",
    description: "Lit le contenu normalisé d'une ressource MCP (graphes, runs, logs, namespaces).",
    inputSchema: ResourceReadInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = ResourceReadInputSchema.parse(input);
      const registryResult = resources.read(parsed.uri);
      /**
       * Normalised payload returned by the `resources_read` tool. The helper
       * mirrors the checklist example by surfacing both the MIME type and the
       * decoded data while preserving the historical `{ uri, kind, payload }`
       * properties expected by existing clients and end-to-end tests.
       */
      const structuredResult = {
        ...registryResult,
        mime: "application/json" as const,
        data: registryResult,
      };
      return {
        content: [{ type: "text" as const, text: j({ tool: "resources_read", result: structuredResult }) }],
        structuredContent: structuredResult,
      };
    } catch (error) {
      const uri =
        input && typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).uri ?? null
          : null;
      return resourceToolError(logger, "resources_read", error, { uri });
    }
  },
);

server.registerTool(
  "resources_watch",
  {
    title: "Resources watch",
    description: "Récupère les événements séquentiels pour une ressource observable.",
    inputSchema: ResourceWatchInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = ResourceWatchInputSchema.parse(input);
      const result = resources.watch(parsed.uri, {
        fromSeq: parsed.from_seq,
        limit: parsed.limit,
        keys: parsed.keys,
        blackboard: parsed.blackboard
          ? {
              keys: parsed.blackboard.keys,
              kinds: parsed.blackboard.kinds,
              tags: parsed.blackboard.tags,
              sinceTs: parsed.blackboard.since_ts,
              untilTs: parsed.blackboard.until_ts,
            }
          : undefined,
        run: parsed.run
          ? {
              levels: parsed.run.levels,
              kinds: parsed.run.kinds,
              jobIds: parsed.run.job_ids,
              opIds: parsed.run.op_ids,
              graphIds: parsed.run.graph_ids,
              nodeIds: parsed.run.node_ids,
              childIds: parsed.run.child_ids,
              runIds: parsed.run.run_ids,
              sinceTs: parsed.run.since_ts,
              untilTs: parsed.run.until_ts,
            }
          : undefined,
        child: parsed.child
          ? {
              streams: parsed.child.streams,
              jobIds: parsed.child.job_ids,
              runIds: parsed.child.run_ids,
              opIds: parsed.child.op_ids,
              graphIds: parsed.child.graph_ids,
              nodeIds: parsed.child.node_ids,
              sinceTs: parsed.child.since_ts,
              untilTs: parsed.child.until_ts,
            }
          : undefined,
      });
      const format = parsed.format ?? "json";
      const filtersSnapshot = result.filters
        ? (structuredClone(result.filters) as ResourceWatchResult["filters"])
        : undefined;
      const baseStructured: {
        uri: string;
        kind: typeof result.kind;
        events: typeof result.events;
        next_seq: number;
        format: string;
        filters?: ResourceWatchResult["filters"];
      } = {
        uri: result.uri,
        kind: result.kind,
        events: result.events,
        next_seq: result.nextSeq,
        format,
      };
      if (filtersSnapshot) {
        baseStructured.filters = filtersSnapshot;
      }

      if (format === "sse") {
        // Convert each record to a single-line SSE payload so streaming transports remain
        // resilient when cancellation reasons or log lines contain control characters.
        const messages = serialiseResourceWatchResultForSse(result);
        const stream = renderResourceWatchSseMessages(messages);
        const structured = { ...baseStructured, stream, messages };
        return {
          content: [{ type: "text" as const, text: j({ tool: "resources_watch", result: structured }) }],
          structuredContent: structured,
        };
      }

      return {
        content: [{ type: "text" as const, text: j({ tool: "resources_watch", result: baseStructured }) }],
        structuredContent: baseStructured,
      };
    } catch (error) {
      const uri =
        input && typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).uri ?? null
          : null;
      return resourceToolError(logger, "resources_watch", error, { uri });
    }
  },
);

server.registerTool(
  "events_subscribe",
  {
    title: "Events subscribe",
    description: "Diffuse les événements corrélés du bus MCP en JSON Lines ou SSE.",
    inputSchema: EventSubscribeInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureEventsBusEnabled("events_subscribe");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = EventSubscribeInputSchema.parse(input ?? {});
      const limit = parsed.limit ?? 100;
      const cats = parseEventCategories(parsed.cats);
      const filter: EventFilter = {
        cats,
        levels: parsed.levels as BusEventLevel[] | undefined,
        jobId: parsed.job_id,
        runId: parsed.run_id,
        opId: parsed.op_id,
        graphId: parsed.graph_id,
        nodeId: parsed.node_id,
        childId: parsed.child_id,
        afterSeq: typeof parsed.from_seq === "number" ? parsed.from_seq : undefined,
        limit,
      };
      const events = eventBus.list(filter).sort((a, b) => a.seq - b.seq);
      const serialised = events.map((evt) => {
        const eventKind = evt.kind && evt.kind.trim().length > 0 ? evt.kind : evt.cat.toUpperCase();
        return {
          seq: evt.seq,
          ts: evt.ts,
          cat: evt.cat,
          kind: eventKind,
          level: evt.level,
          job_id: evt.jobId ?? null,
          run_id: evt.runId ?? null,
          op_id: evt.opId ?? null,
          graph_id: evt.graphId ?? null,
          node_id: evt.nodeId ?? null,
          child_id: evt.childId ?? null,
          msg: evt.msg,
          data: evt.data ?? null,
        };
      });
      const format = parsed.format ?? "jsonlines";
      const stream =
        format === "sse"
          ? serialised
              .map((evt) =>
                [
                  `id: ${evt.seq}`,
                  // Use the semantic `kind` identifier so SSE consumers observe the
                  // same PROMPT/PENDING/... tokens exposed via the JSON Lines payload.
                  // When bridges have not supplied a kind yet we fall back to the
                  // upper-cased message to keep identifiers deterministic.
                  `event: ${evt.kind}`,
                  `data: ${serialiseForSse(evt)}`,
                  ``,
                ].join("\n"),
              )
              .join("\n")
          : serialised.map((evt) => JSON.stringify(evt)).join("\n");
      const nextSeq = events.length ? events[events.length - 1].seq : parsed.from_seq ?? null;
      const structured = {
        format,
        events: serialised,
        stream,
        next_seq: nextSeq,
        count: serialised.length,
      };
      return {
        content: [{ type: "text" as const, text: j({ tool: "events_subscribe", result: structured }) }],
        structuredContent: structured,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("events_subscribe_failed", { message });
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: j({ error: "E-EVT-INVALID", message, hint: "invalid_filters" }),
          },
        ],
      };
    }
  },
);

server.registerTool(
  "logs_tail",
  {
    title: "Logs tail",
    description: "Diffuse un extrait corrélé des journaux orchestrateur, runs et enfants.",
    inputSchema: LogsTailInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = LogsTailInputSchema.parse(input ?? {});
      const stream = (parsed.stream ?? "server") as LogStream;
      const bucketId = parsed.id?.trim();

      if ((stream === "run" || stream === "child") && (!bucketId || bucketId.length === 0)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: j({
                error: "E-LOGS-MISSING_ID",
                message: "id is required when tailing run or child streams",
                stream,
              }),
            },
          ],
        };
      }

      const targetBucket = bucketId ?? "orchestrator";
      // Normalise requested levels to lowercase and de-duplicate them so the
      // journal performs a single case-insensitive comparison per unique
      // severity requested by the caller.
      const requestedLevels = parsed.levels
        ? Array.from(new Set(parsed.levels.map((level) => level.toLowerCase())))
        : undefined;
      const normaliseIdList = (values?: readonly string[]) => {
        if (!values || values.length === 0) {
          return undefined;
        }
        const deduped = Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
        return deduped.length > 0 ? deduped : undefined;
      };
      // Ensure timestamp filters remain deterministic by clamping negative values
      // and rounding to integers so the journal can perform direct comparisons.
      const normaliseTimestamp = (value?: number) => {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          return undefined;
        }
        return Math.floor(value);
      };
      // Ensure substring filters remain predictable by normalising them to
      // lowercase, trimming whitespace and de-duplicating while preserving
      // caller-provided order for deterministic echoes.
      const normaliseSubstringList = (values?: readonly string[]) => {
        if (!values || values.length === 0) {
          return undefined;
        }
        const seen = new Set<string>();
        const collected: string[] = [];
        for (const value of values) {
          const trimmed = value.trim().toLowerCase();
          if (trimmed.length === 0 || seen.has(trimmed)) {
            continue;
          }
          seen.add(trimmed);
          collected.push(trimmed);
        }
        return collected.length > 0 ? collected : undefined;
      };

      const runIds = normaliseIdList(parsed.filters?.run_ids);
      const jobIds = normaliseIdList(parsed.filters?.job_ids);
      const opIds = normaliseIdList(parsed.filters?.op_ids);
      const graphIds = normaliseIdList(parsed.filters?.graph_ids);
      const nodeIds = normaliseIdList(parsed.filters?.node_ids);
      const childIds = normaliseIdList(parsed.filters?.child_ids);
      const messageContains = normaliseSubstringList(parsed.filters?.message_contains);
      const sinceTs = normaliseTimestamp(parsed.filters?.since_ts);
      const untilTs = normaliseTimestamp(parsed.filters?.until_ts);

      const hasFilters =
        !!runIds ||
        !!jobIds ||
        !!opIds ||
        !!graphIds ||
        !!nodeIds ||
        !!childIds ||
        !!messageContains ||
        sinceTs !== undefined ||
        untilTs !== undefined;

      const result = logJournal.tail({
        stream,
        bucketId: targetBucket,
        fromSeq: parsed.from_seq,
        limit: parsed.limit,
        levels: requestedLevels,
        filters: hasFilters
          ? {
              runIds,
              jobIds,
              opIds,
              graphIds,
              nodeIds,
              childIds,
              messageIncludes: messageContains,
              sinceTs,
              untilTs,
            }
          : undefined,
      });

      const entries = result.entries.map((entry) => ({
        seq: entry.seq,
        ts: entry.ts,
        stream: entry.stream,
        bucket_id: entry.bucketId,
        level: entry.level,
        message: entry.message,
        data: entry.data ?? null,
        job_id: entry.jobId ?? null,
        run_id: entry.runId ?? null,
        op_id: entry.opId ?? null,
        graph_id: entry.graphId ?? null,
        node_id: entry.nodeId ?? null,
        child_id: entry.childId ?? null,
      }));

      const structured = {
        stream,
        bucket_id: targetBucket,
        entries,
        next_seq: result.nextSeq,
        levels: requestedLevels ?? null,
        filters: hasFilters
          ? {
              run_ids: runIds ?? null,
              job_ids: jobIds ?? null,
              op_ids: opIds ?? null,
              graph_ids: graphIds ?? null,
              node_ids: nodeIds ?? null,
              child_ids: childIds ?? null,
              message_contains: messageContains ?? null,
              since_ts: sinceTs ?? null,
              until_ts: untilTs ?? null,
            }
          : null,
      };

      return {
        content: [{ type: "text" as const, text: j({ tool: "logs_tail", result: structured }) }],
        structuredContent: structured,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("logs_tail_failed", { message });
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: j({ error: "E-LOGS-INVALID", message }),
          },
        ],
      };
    }
  },
);

// job_view (apercu d'un job avec previsualisation transcript + liens VS Code)
server.registerTool(
  "job_view",
  { title: "Job view", description: "Vue d'ensemble d'un job avec un extrait par enfant.", inputSchema: JobViewShape },
  async (input: JobViewInput) => {
    const job = graphState.getJob(input.job_id);
    if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };
    const perChild = Math.max(1, Math.min(input.per_child_limit ?? 20, 200));
    const includeSystem = input.include_system ?? true;
    const children = graphState.listChildren(job.id).map((child) => {
      const slice = graphState.getTranscript(child.id, { limit: perChild });
      const items = slice.items.filter((m) => (m.role === "system" ? includeSystem : true));
      const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(child.id)}`;
      const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: child.id }))}`;
      return {
        id: child.id,
        name: child.name,
        state: child.state,
        runtime: child.runtime,
        waiting_for: child.waitingFor,
        pending_id: child.pendingId,
        transcript_preview: items,
        vscode_deeplink: deepLink,
        vscode_command: commandUri
      };
    });
    if ((input.format ?? "json") === "text") {
      const lines: string[] = [`# Job ${job.id} (${children.length} enfants)`];
      for (const c of children) {
        lines.push(`\n## ${c.name} (${c.id}) [${c.state}] runtime=${c.runtime}`);
        for (const m of c.transcript_preview) lines.push(`- [${m.role}] ${m.content}`);
        lines.push(`(open) ${c.vscode_deeplink}`);
      }
      return { content: [{ type: "text", text: j({ format: "text", render: lines.join("\n") }) }] };
    }
    return { content: [{ type: "text", text: j({ format: "json", job: { id: job.id, state: job.state }, children }) }] };
  }
);

// graph_export
server.registerTool(
  "graph_export",
  { title: "Graph export", description: "Exporte l'etat graphe en JSON.", inputSchema: GraphExportShape },
  async (input: GraphExportInput) => {
    try {
      const parsed = GraphExportSchema.parse(input);
      const snapshot = graphState.serialize();
      const descriptor = snapshotToGraphDescriptor(snapshot, {
        labelAttribute: parsed.label_attribute,
      });

      let payloadString = "";
      let structuredPayload: unknown = null;

      switch (parsed.format) {
        case "json": {
          structuredPayload = {
            snapshot,
            descriptor,
          };
          payloadString = JSON.stringify(
            structuredPayload,
            null,
            parsed.pretty ? 2 : 0,
          );
          break;
        }
        case "mermaid": {
          payloadString = renderMermaidFromGraph(descriptor, {
            direction: parsed.direction ?? "LR",
            labelAttribute: parsed.label_attribute,
            weightAttribute: parsed.weight_attribute,
            maxLabelLength: parsed.max_label_length,
          });
          break;
        }
        case "dot": {
          payloadString = renderDotFromGraph(descriptor, {
            labelAttribute: parsed.label_attribute,
            weightAttribute: parsed.weight_attribute,
          });
          break;
        }
        case "graphml": {
          payloadString = renderGraphmlFromGraph(descriptor, {
            labelAttribute: parsed.label_attribute,
            weightAttribute: parsed.weight_attribute,
          });
          break;
        }
      }

      const bytes = Buffer.byteLength(payloadString, "utf8");
      const maxPreview = parsed.truncate ?? 4096;
      const notes: string[] = [];

      let absolutePath: string | null = null;
      if (parsed.path) {
        let absolute: string;
        try {
          absolute = resolveWorkspacePath(parsed.path);
        } catch (error) {
          if (error instanceof PathResolutionError) {
            return formatWorkspacePathError(error);
          }
          throw error;
        }

        await ensureParentDirectory(absolute);
        await writeFile(absolute, payloadString, "utf8");
        absolutePath = absolute;
      }

      const inline = parsed.inline ?? true;
      let preview = payloadString;
      let truncated = false;
      if (payloadString.length > maxPreview) {
        preview = payloadString.slice(0, maxPreview);
        truncated = true;
        notes.push("content_truncated");
      }

      const result: Record<string, unknown> = {
        format: parsed.format,
        bytes,
        inline,
        truncated,
        path: absolutePath,
        notes,
      };

      if (inline) {
        if (parsed.format === "json") {
          result.payload = structuredPayload;
        } else {
          result.preview = preview;
        }
      } else {
        result.preview = preview;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: j({ tool: "graph_export", result }),
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError(logger, "graph_export", error);
    }
  }
);

// graph_state_save
server.registerTool(
  "graph_state_save",
  { title: "Graph save", description: "Sauvegarde l'etat graphe dans un fichier JSON.", inputSchema: GraphSaveShape },
  async (input: GraphSaveInput) => {
    let abs: string;
    try {
      abs = resolveWorkspacePath(input.path);
    } catch (error) {
      if (error instanceof PathResolutionError) {
        return formatWorkspacePathError(error);
      }
      throw error;
    }

    await ensureParentDirectory(abs);
    const snap = graphState.serialize();
    await writeFile(abs, JSON.stringify(snap, null, 2), "utf8");
    return { content: [{ type: "text", text: j({ format: "json", ok: true, path: abs }) }] };
  }
);

// graph_state_load
server.registerTool(
  "graph_state_load",
  { title: "Graph load", description: "Recharge l'etat graphe depuis un fichier JSON.", inputSchema: GraphLoadShape },
  async (input: GraphLoadInput) => {
    let abs: string;
    try {
      abs = resolveWorkspacePath(input.path);
    } catch (error) {
      if (error instanceof PathResolutionError) {
        return formatWorkspacePathError(error);
      }
      throw error;
    }
    const data = await readFile(abs, "utf8");
    const snap = JSON.parse(data);
    graphState.resetFromSnapshot(snap);
    return { content: [{ type: "text", text: j({ format: "json", ok: true, path: abs }) }] };
  }
);

// conversation_view (vue conviviale de la discussion orchestrateur<->enfant)
server.registerTool(
  "conversation_view",
  { title: "Conversation view", description: "Affiche la conversation d'un enfant (texte ou JSON).", inputSchema: { child_id: z.string(), since_index: z.number().optional(), since_ts: z.number().optional(), limit: z.number().optional(), format: z.enum(["text", "json"]).optional(), include_system: z.boolean().optional() } },
  async (input: { child_id: string; since_index?: number; since_ts?: number; limit?: number; format?: "text" | "json"; include_system?: boolean }) => {
    const child = graphState.getChild(input.child_id);
    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    const slice = graphState.getTranscript(child.id, { sinceIndex: input.since_index, sinceTs: input.since_ts, limit: input.limit });
    const items = slice.items.filter((m) => (m.role === "system" ? (input.include_system ?? true) : true));
    const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(child.id)}`;
    const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: child.id }))}`;
    if ((input.format ?? "text") === "json") {
      return { content: [{ type: "text", text: j({ format: "json", child: { id: child.id, name: child.name }, total: slice.total, items, vscode_deeplink: deepLink, vscode_command: commandUri }) }] };
    }
    const lines: string[] = [
      `# ${child.name} (${child.id})`,
      ...items.map((m) => `- [${m.role}] ${m.content}`)
    ];
    return { content: [{ type: "text", text: j({ format: "text", render: lines.join("\n"), vscode_deeplink: deepLink, vscode_command: commandUri }) }] };
  }
);

// events_view (liste des evenements recents ou pending)
server.registerTool(
  "events_view",
  { title: "Events view", description: "Affiche les evenements (recent/pending/live)", inputSchema: { mode: z.enum(["recent", "pending", "live"]).optional(), job_id: z.string().optional(), child_id: z.string().optional(), limit: z.number().optional(), order: z.enum(["asc", "desc"]).optional(), min_seq: z.number().optional() } },
  async (input: { mode?: "recent" | "pending" | "live"; job_id?: string; child_id?: string; limit?: number; order?: "asc" | "desc"; min_seq?: number }) => {
    const mode = input.mode ?? "recent";
    if (mode === "pending") {
      const nodes = graphState.filterNodes({ type: "pending" }, undefined);
      const items = nodes
        .filter((n) => (input.child_id ? String(n.attributes.child_id ?? "") === input.child_id : true))
        .map((n) => {
          const childId = String(n.attributes.child_id ?? "");
          const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(childId)}`;
          const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: childId }))}`;
          return { id: n.id, child_id: childId, created_at: Number(n.attributes.created_at ?? 0), vscode_deeplink: deepLink, vscode_command: commandUri };
        });
      return { content: [{ type: "text", text: j({ format: "json", mode: "pending", pending: items }) }] };
    }
    if (mode === "live") {
      const events = buildLiveEvents({ job_id: input.job_id, child_id: input.child_id, limit: input.limit, order: input.order, min_seq: input.min_seq });
      return { content: [{ type: "text", text: j({ format: "json", mode: "live", events, via: "events_view" }) }] };
    }
    const limit = input.limit && input.limit > 0 ? input.limit : 100;
    const events = graphState
      .filterNodes({ type: "event" }, undefined)
      .filter((n) => (input.job_id ? String(n.attributes.job_id ?? "") === input.job_id : true))
      .filter((n) => (input.child_id ? String(n.attributes.child_id ?? "") === input.child_id : true))
      .map((n) => {
        const childId = String(n.attributes.child_id ?? "");
        const deepLink = childId ? `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(childId)}` : null;
        const commandUri = childId ? `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: childId }))}` : null;
        return {
          id: n.id,
          seq: Number(n.attributes.seq ?? 0),
          ts: Number(n.attributes.ts ?? 0),
          kind: String(n.attributes.kind ?? ""),
          level: String(n.attributes.level ?? "info"),
          job_id: String(n.attributes.job_id ?? ""),
          child_id: childId,
          vscode_deeplink: deepLink,
          vscode_command: commandUri
        };
      })
      .sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq))
      .slice(0, limit);
    return { content: [{ type: "text", text: j({ format: "json", mode: "recent", events, live_hint: { tool: "events_view_live", suggested_input: { job_id: input.job_id ?? null, child_id: input.child_id ?? null, limit: input.limit ?? null, order: input.order ?? null, min_seq: input.min_seq ?? null } } }) }] };
  }
);

// events_view_live (liste les evenements du bus live, sans dependre du graphe ni des suppressions cote client)
server.registerTool(
  "events_view_live",
  { title: "Events view (live)", description: "Affiche les evenements issus du bus live.", inputSchema: EventsViewLiveShape },
  async (input: EventsViewLiveInput) => {
    const events = buildLiveEvents(input);
    return { content: [{ type: "text", text: j({ format: "json", mode: "live", events, via: "events_view_live" }) }] };
  }
);

// Autosave (start/stop)
let AUTOSAVE_TIMER: IntervalHandle | null = null;
let AUTOSAVE_PATH: string | null = null;
server.registerTool(
  "graph_state_autosave",
  { title: "Graph autosave", description: "Demarre/arrete la sauvegarde periodique du graphe.", inputSchema: { action: z.enum(["start", "stop"]), path: z.string().optional(), interval_ms: z.number().optional() } },
  async (input: { action: "start" | "stop"; path?: string; interval_ms?: number }) => {
    if (input.action === "stop") {
      if (AUTOSAVE_TIMER) runtimeTimers.clearInterval(AUTOSAVE_TIMER);
      AUTOSAVE_TIMER = null;
      AUTOSAVE_PATH = null;
      return { content: [{ type: "text", text: j({ format: "json", ok: true, status: "stopped" }) }] };
    }
    let targetPath: string;
    try {
      targetPath = resolveWorkspacePath(input.path ?? "graph-autosave.json");
    } catch (error) {
      if (error instanceof PathResolutionError) {
        return formatWorkspacePathError(error);
      }
      throw error;
    }
    const interval = Math.min(Math.max(input.interval_ms ?? 5000, 1000), 600000);
    if (AUTOSAVE_TIMER) runtimeTimers.clearInterval(AUTOSAVE_TIMER);
    await ensureParentDirectory(targetPath);
    AUTOSAVE_PATH = targetPath;
    AUTOSAVE_TIMER = runtimeTimers.setInterval(async () => {
      try {
        const snap = graphState.serialize();
        const metadata = {
          saved_at: new Date().toISOString(),
          inactivity_threshold_ms: lastInactivityThresholdMs,
          event_history_limit: eventStore.getMaxHistory()
        };
        await ensureParentDirectory(AUTOSAVE_PATH!);
        await writeFile(
          AUTOSAVE_PATH!,
          JSON.stringify({ metadata, snapshot: snap }, null, 2),
          "utf8"
        );
        logger.info("graph_autosave_written", {
          path: AUTOSAVE_PATH,
          node_count: snap.nodes.length,
          edge_count: snap.edges.length
        });
      } catch (error) {
        logger.error("graph_autosave_failed", {
          path: AUTOSAVE_PATH,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }, interval);
    return {
      content: [
        {
          type: "text",
          text: j({
            format: "json",
            ok: true,
            status: "started",
            path: targetPath,
            interval_ms: interval,
            inactivity_threshold_ms: lastInactivityThresholdMs,
            event_history_limit: eventStore.getMaxHistory()
          })
        }
      ]
    };
  }
);

// graph_config_retention
server.registerTool(
  "graph_config_retention",
  { title: "Graph retention", description: "Configure la retention (transcripts, events).", inputSchema: { max_transcript_per_child: z.number().optional(), max_event_nodes: z.number().optional() } },
  async (input: { max_transcript_per_child?: number; max_event_nodes?: number }) => {
    graphState.configureRetention({
      maxTranscriptPerChild: input.max_transcript_per_child,
      maxEventNodes: input.max_event_nodes
    });
    return { content: [{ type: "text", text: j({ format: "json", ok: true }) }] };
  }
);

// graph_prune
server.registerTool(
  "graph_prune",
  { title: "Graph prune", description: "Prune manuellement des transcripts ou evenements.", inputSchema: GraphPruneShape },
  async (input: GraphPruneInput) => {
    if (input.action === "transcript") {
      if (!input.child_id || typeof input.keep_last !== "number") {
        return {
          isError: true,
          content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "child_id et keep_last requis" }) }]
        };
      }
      const keep = Math.max(0, Math.floor(input.keep_last));
      graphState.pruneChildTranscript(input.child_id, keep);
      return { content: [{ type: "text", text: j({ ok: true, action: "transcript", child_id: input.child_id, keep_last: keep }) }] };
    }
    const max = typeof input.max_events === "number" ? Math.max(0, Math.floor(input.max_events)) : 0;
    if (max <= 0) {
      return {
        isError: true,
        content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "max_events > 0 requis" }) }]
      };
    }
    graphState.pruneEvents(max, input.job_id ?? undefined, input.child_id ?? undefined);
    return {
      content: [
        {
          type: "text",
          text: j({ ok: true, action: "events", job_id: input.job_id ?? null, child_id: input.child_id ?? null, max_events: max })
        }
      ]
    };
  }
);

// graph_query
server.registerTool(
  "graph_config_runtime",
  { title: "Graph runtime", description: "Configure le runtime par defaut des enfants planifies.", inputSchema: GraphRuntimeShape },
  async (input: GraphRuntimeInput) => {
    const previous = DEFAULT_CHILD_RUNTIME;
    if (input.reset) {
      setDefaultChildRuntime("codex");
    } else if (typeof input.runtime === 'string' && input.runtime.trim().length) {
      setDefaultChildRuntime(input.runtime);
    }
    return { content: [{ type: "text", text: j({ format: "json", ok: true, runtime: DEFAULT_CHILD_RUNTIME, previous }) }] };
  }
);

server.registerTool(
  "graph_state_stats",
  { title: "Graph stats", description: "Expose des compteurs sur les noeuds/aretes et runtimes.", inputSchema: GraphStatsShape },
  async (_input: GraphStatsInput) => {
    const nodes = graphState.listNodeRecords();
    const edges = graphState.listEdgeRecords();
    const stats: { nodes: number; edges: number; jobs: number; children: number; messages: number; pending: number; events: number; subscriptions: number } = {
      nodes: nodes.length,
      edges: edges.length,
      jobs: 0,
      children: 0,
      messages: 0,
      pending: 0,
      events: 0,
      subscriptions: 0
    };
    const runtimeCounts: Record<string, number> = {};
    const childStateCounts: Record<string, number> = {};
    for (const node of nodes) {
      const attrs = node.attributes ?? {};
      const type = String(attrs.type ?? '');
      switch (type) {
        case 'job':
          stats.jobs += 1;
          break;
        case 'child': {
          stats.children += 1;
          const runtime = String(attrs.runtime ?? DEFAULT_CHILD_RUNTIME);
          runtimeCounts[runtime] = (runtimeCounts[runtime] ?? 0) + 1;
          const state = String(attrs.state ?? '');
          if (state) childStateCounts[state] = (childStateCounts[state] ?? 0) + 1;
          break;
        }
        case 'message':
          stats.messages += 1;
          break;
        case 'pending':
          stats.pending += 1;
          break;
        case 'event':
          stats.events += 1;
          break;
        case 'subscription':
          stats.subscriptions += 1;
          break;
        default:
          break;
      }
    }
    const jobs = graphState.listJobs().map((job) => ({ id: job.id, state: job.state, child_count: job.childIds.length }));
    return {
      content: [
        {
          type: 'text',
          text: j({
            format: 'json',
            stats,
            runtimes: runtimeCounts,
            child_states: childStateCounts,
            jobs,
            default_runtime: DEFAULT_CHILD_RUNTIME
          })
        }
      ]
    };
  }
);

server.registerTool(
  "graph_state_metrics",
  {
    title: "Graph metrics",
    description: "Expose des métriques synthétiques (jobs actifs, événements, heartbeats).",
    inputSchema: GraphStatsShape
  },
  async () => {
    const metrics = graphState.collectMetrics();
    const heartbeatEvents = eventStore.getEventsByKind("HEARTBEAT").sort((a, b) => a.ts - b.ts);
    let averageHeartbeatMs: number | null = null;
    if (heartbeatEvents.length > 1) {
      let total = 0;
      for (let index = 1; index < heartbeatEvents.length; index += 1) {
        total += heartbeatEvents[index].ts - heartbeatEvents[index - 1].ts;
      }
      averageHeartbeatMs = Math.round(total / (heartbeatEvents.length - 1));
    }

    const payload = {
      format: "json" as const,
      jobs: {
        total: metrics.totalJobs,
        active: metrics.activeJobs,
        completed: metrics.completedJobs
      },
      children: {
        total: metrics.totalChildren,
        active: metrics.activeChildren,
        pending: metrics.pendingChildren
      },
      events: {
        total: eventStore.getEventCount(),
        last_seq: eventStore.getLastSequence(),
        history_limit: eventStore.getMaxHistory(),
        average_heartbeat_ms: averageHeartbeatMs
      },
      messages: metrics.totalMessages,
      subscriptions: metrics.subscriptions
    };

    return { content: [{ type: "text", text: j(payload) }] };
  }
);

server.registerTool(
  "graph_state_inactivity",
  {
    title: "Graph inactivity",
    description: "Identifie les enfants inactifs ou avec pending prolongé.",
    inputSchema: GraphInactivityShape
  },
  async (input: GraphInactivityInput) => {
    const scope = input.scope ?? "children";
    if (scope !== "children") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: j({ error: "UNSUPPORTED_SCOPE", message: `graph_state_inactivity does not support scope=${scope}` })
          }
        ]
      };
    }

    const inactivitySec = input.inactivity_threshold_sec ?? input.inactivityThresholdSec;
    const inactivityMs = typeof inactivitySec === "number" ? Math.max(0, inactivitySec) * 1000 : undefined;
    const idleThreshold = input.idle_threshold_ms ?? inactivityMs ?? 120_000;
    const pendingThreshold = input.pending_threshold_ms ?? idleThreshold;
    const includeWithoutMessages = input.include_children_without_messages ?? true;
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;
    lastInactivityThresholdMs = idleThreshold;
    const reports = graphState.findInactiveChildren({
      idleThresholdMs: idleThreshold,
      pendingThresholdMs: pendingThreshold,
      includeChildrenWithoutMessages: includeWithoutMessages
    });
    const filtered = reports.filter((report) => {
      if (input.job_id && report.jobId !== input.job_id) return false;
      if (input.runtime && report.runtime !== input.runtime) return false;
      if (input.state && report.state !== input.state) return false;
      return true;
    });
    const ordered = [...filtered].sort((a, b) => {
      const scoreA = Math.max(a.idleMs ?? 0, a.pendingMs ?? 0);
      const scoreB = Math.max(b.idleMs ?? 0, b.pendingMs ?? 0);
      if (scoreA === scoreB) {
        return a.childId.localeCompare(b.childId);
      }
      return scoreB - scoreA;
    });
    const limited = ordered.slice(0, limit);
    const defaultFormat = input.format ?? "json";

    if (defaultFormat === "text") {
      if (!limited.length) {
        const idleSec = Math.round(idleThreshold / 1000);
        const pendingSec = Math.round(pendingThreshold / 1000);
        return {
          content: [
            {
              type: "text",
              text: `Aucune inactivité détectée (idle ≥ ${idleSec}s, pending ≥ ${pendingSec}s).`
            }
          ]
        };
      }
      const lines = limited.map((report) => {
        const idleSec = report.idleMs !== null ? Math.round(report.idleMs / 1000) : null;
        const pendingSec = report.pendingMs !== null ? Math.round(report.pendingMs / 1000) : null;
        const flagSummary = report.flags
          .map((flag) => `${flag.type}:${Math.round(flag.valueMs / 1000)}s≥${Math.round(flag.thresholdMs / 1000)}s`)
          .join(", ");
        const waiting = report.waitingFor ?? "∅";
        const job = report.jobId || "∅";
        const actions = report.suggestedActions.length ? report.suggestedActions.join("|") : "∅";
        return `- ${report.childId} (${report.state}) job=${job} runtime=${report.runtime} idle=${idleSec ?? "∅"}s pending=${
          pendingSec ?? "∅"
        }s waiting=${waiting} actions=${actions} flags=[${flagSummary}]`;
      });
      const header = `Enfants inactifs (idle ≥ ${Math.round(idleThreshold / 1000)}s, pending ≥ ${Math.round(
        pendingThreshold / 1000
      )}s) :`;
      return {
        content: [
          {
            type: "text",
            text: [header, ...lines].join("\n")
          }
        ]
      };
    }

    const payload = {
      format: "json" as const,
      idle_threshold_ms: idleThreshold,
      pending_threshold_ms: pendingThreshold,
      inactivity_threshold_sec: inactivityMs !== undefined ? inactivityMs / 1000 : Math.round(idleThreshold / 1000),
      total: filtered.length,
      returned: limited.length,
      items: limited.map((report) => ({
        child_id: report.childId,
        job_id: report.jobId || null,
        name: report.name,
        state: report.state,
        runtime: report.runtime,
        waiting_for: report.waitingFor,
        pending_id: report.pendingId,
        created_at: report.createdAt,
        last_activity_ts: report.lastActivityTs,
        idle_ms: report.idleMs,
        pending_since: report.pendingSince,
        pending_ms: report.pendingMs,
        transcript_size: report.transcriptSize,
        flags: report.flags.map((flag) => ({
          type: flag.type,
          value_ms: flag.valueMs,
          threshold_ms: flag.thresholdMs
        })),
        suggested_actions: report.suggestedActions
      }))
    };

    return { content: [{ type: "text", text: j(payload) }] };
  }
);

server.registerTool(
  "graph_query",
  { title: "Graph query", description: "Requete simple: neighbors ou filter.", inputSchema: { kind: z.enum(["neighbors", "filter"]), node_id: z.string().optional(), direction: z.enum(["out", "in", "both"]).optional(), edge_type: z.string().optional(), select: z.enum(["nodes", "edges", "both"]).optional(), where: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), limit: z.number().optional() } },
  async (input: { kind: "neighbors" | "filter"; node_id?: string; direction?: "out" | "in" | "both"; edge_type?: string; select?: "nodes" | "edges" | "both"; where?: Record<string, string | number | boolean>; limit?: number }) => {
    if (input.kind === "neighbors") {
      if (!input.node_id) return { isError: true, content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "node_id requis" }) }] };
      const res = graphState.neighbors(input.node_id, input.direction ?? "both", input.edge_type);
      return { content: [{ type: "text", text: j({ format: "json", data: res }) }] };
    }
    // filter
    const select = input.select ?? "nodes";
    const where = input.where ?? {};
    const limit = input.limit && input.limit > 0 ? input.limit : undefined;
    if (select === "nodes") {
      const nodes = graphState.filterNodes(where, limit);
      return { content: [{ type: "text", text: j({ format: "json", nodes }) }] };
    } else if (select === "edges") {
      const edges = graphState.filterEdges(where, limit);
      return { content: [{ type: "text", text: j({ format: "json", edges }) }] };
    } else {
      const nodes = graphState.filterNodes(where, limit);
      const edges = graphState.filterEdges(where, limit);
      return { content: [{ type: "text", text: j({ format: "json", nodes, edges }) }] };
    }
  }
);

server.registerTool(
  "graph_generate",
  {
    title: "Graph generate",
    description: "Genere un graphe de dependances a partir de taches (preset, texte ou JSON).",
    inputSchema: GraphGenerateInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = GraphGenerateInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_generate_op");
      const enrichedInput = { ...parsed, op_id: opId };
      logger.info("graph_generate_requested", {
        preset: parsed.preset ?? null,
        has_tasks: parsed.tasks !== undefined,
        op_id: opId,
      });
      const result = handleGraphGenerate(enrichedInput, {
        knowledgeGraph: runtimeFeatures.enableKnowledge ? knowledgeGraph : undefined,
        knowledgeEnabled: runtimeFeatures.enableKnowledge,
      });
      const summary = summariseSubgraphUsage(result.graph);
      if (summary.references.length > 0) {
        logger.info("graph_generate_subgraphs_detected", {
          references: summary.references.length,
          missing: summary.missing.length,
          op_id: opId,
        });
      }
      let notes = result.notes;
      if (summary.missing.length > 0) {
        const deduped = new Set(result.notes);
        deduped.add("missing_subgraph_descriptors");
        notes = Array.from(deduped);
        logger.warn("graph_generate_missing_subgraphs", {
          missing: summary.missing,
          graph_id: result.graph.graph_id ?? null,
          op_id: opId,
        });
      }
      const enriched = {
        ...result,
        notes,
        subgraph_refs: summary.references,
        ...(summary.missing.length > 0 ? { missing_subgraph_descriptors: summary.missing } : {}),
      };
      logger.info("graph_generate_succeeded", {
        nodes: result.graph.nodes.length,
        edges: result.graph.edges.length,
        op_id: opId,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_generate", result: enriched }) }],
        structuredContent: enriched,
      };
    } catch (error) {
      const providedOpId = extractStringProperty(input as Record<string, unknown>, "op_id");
      return graphToolError(logger, "graph_generate", error, { op_id: providedOpId ?? undefined });
    }
  },
);

server.registerTool(
  "graph_mutate",
  {
    title: "Graph mutate",
    description: "Applique des operations idempotentes (add/remove/rename) sur un graphe.",
    inputSchema: GraphMutateInputShape,
  },
  async (input: unknown) => {
    let graphIdForError: string | null = null;
    let graphVersionForError: number | null = null;
    try {
      const parsed = GraphMutateInputSchema.parse(input);
      graphIdForError = parsed.graph.graph_id ?? null;
      graphVersionForError = parsed.graph.graph_version ?? null;
      const opId = resolveOperationId(parsed.op_id, "graph_mutate_op");
      logger.info("graph_mutate_requested", {
        operations: parsed.operations.length,
        graph_id: graphIdForError,
        version: graphVersionForError,
        op_id: opId,
      });

      const baseGraph = normaliseGraphPayload(parsed.graph);
      graphLocks.assertCanMutate(baseGraph.graphId, null);
      const tx = graphTransactions.begin(baseGraph);
      resources.recordGraphSnapshot({
        graphId: tx.graphId,
        txId: tx.txId,
        baseVersion: tx.baseVersion,
        startedAt: tx.startedAt,
        graph: tx.workingCopy,
      });
      let committed: ReturnType<typeof graphTransactions.commit> | undefined;
      try {
        const mutateInput = {
          ...parsed,
          graph: serialiseNormalisedGraph(tx.workingCopy),
          op_id: opId,
        };
        const intermediate = handleGraphMutate(mutateInput);
        graphLocks.assertCanMutate(baseGraph.graphId, null);
        committed = graphTransactions.commit(tx.txId, normaliseGraphPayload(intermediate.graph));
        resources.markGraphSnapshotCommitted({
          graphId: committed.graphId,
          txId: tx.txId,
          committedAt: committed.committedAt,
          finalVersion: committed.version,
          finalGraph: committed.graph,
        });
        resources.recordGraphVersion({
          graphId: committed.graphId,
          version: committed.version,
          committedAt: committed.committedAt,
          graph: committed.graph,
        });
        const finalGraph = serialiseNormalisedGraph(committed.graph);
        const result = { ...intermediate, graph: finalGraph };
        const summary = summariseSubgraphUsage(result.graph);
        if (summary.references.length > 0) {
          logger.info("graph_mutate_subgraphs_detected", {
            references: summary.references.length,
            missing: summary.missing.length,
            graph_id: committed.graphId,
            op_id: opId,
          });
        }
        if (summary.missing.length > 0) {
          logger.warn("graph_mutate_missing_subgraphs", {
            missing: summary.missing,
            graph_id: committed.graphId,
            op_id: opId,
          });
        }
        const enrichedResult = {
          ...result,
          subgraph_refs: summary.references,
          ...(summary.missing.length > 0 ? { missing_subgraph_descriptors: summary.missing } : {}),
        };
        const changed = enrichedResult.applied.filter((entry) => entry.changed).length;

        logger.info("graph_mutate_succeeded", {
          operations: parsed.operations.length,
          changed,
          graph_id: committed.graphId,
          version: committed.version,
          committed_at: committed.committedAt,
          op_id: opId,
        });

        return {
          content: [{ type: "text" as const, text: j({ tool: "graph_mutate", result: enrichedResult }) }],
          structuredContent: enrichedResult,
        };
      } catch (error) {
        if (!committed) {
          try {
            graphTransactions.rollback(tx.txId);
            resources.markGraphSnapshotRolledBack(tx.graphId, tx.txId);
            logger.warn("graph_mutate_rolled_back", {
              graph_id: tx.graphId,
              base_version: tx.baseVersion,
              reason: error instanceof Error ? error.message : String(error),
            });
          } catch (rollbackError) {
            logger.error("graph_mutate_rollback_failed", {
              graph_id: tx.graphId,
              message:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
            });
          }
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof GraphVersionConflictError) {
        return graphToolError(logger, "graph_mutate", error, {
          graph_id: graphIdForError,
          version: graphVersionForError,
          op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
        });
      }
      return graphToolError(logger, "graph_mutate", error, {
        graph_id: graphIdForError,
        version: graphVersionForError ?? undefined,
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      });
    }
  },
);

server.registerTool(
  "graph_batch_mutate",
  {
    title: "Graph batch mutate",
    description: "Applique un lot d'opérations sur le graphe côté serveur avec rollback atomique.",
    inputSchema: GraphBatchMutateInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureBulkEnabled("graph_batch_mutate");
    if (disabled) {
      return disabled;
    }
    pruneExpired();
    let graphIdForError: string | null = null;
    let opIdForError: string | null = null;
    try {
      const parsed = GraphBatchMutateInputSchema.parse(input);
      graphIdForError = parsed.graph_id;
      const existingEntry = (() => {
        if (!runtimeFeatures.enableIdempotency || !parsed.idempotency_key) {
          return null;
        }
        const { op_id: _omitOpId, idempotency_key: _omitKey, ...fingerprint } = parsed;
        const cacheKey = buildIdempotencyCacheKey(
          "graph_batch_mutate",
          parsed.idempotency_key,
          fingerprint,
        );
        return idempotencyRegistry.peek<GraphBatchMutateResult>(cacheKey);
      })();
      const existingOpId = existingEntry?.value?.op_id;
      const opId = resolveOperationId(parsed.op_id ?? existingOpId, "graph_batch_mutate_op");
      opIdForError = opId;
      const enrichedInput = { ...parsed, op_id: opId };
      logger.info("graph_batch_mutate_requested", {
        graph_id: parsed.graph_id,
        operations: parsed.operations.length,
        expected_version: parsed.expected_version ?? null,
        owner: parsed.owner ?? null,
        note: parsed.note ?? null,
        idempotency_key: parsed.idempotency_key ?? null,
        op_id: opId,
      });

      const result = await handleGraphBatchMutate(getGraphBatchToolContext(), enrichedInput);
      const logPayload = {
        graph_id: result.graph_id,
        base_version: result.base_version,
        committed_version: result.committed_version,
        committed_at: result.committed_at,
        changed: result.changed,
        operations: parsed.operations.length,
        idempotent: result.idempotent,
        idempotency_key: result.idempotency_key,
        op_id: result.op_id,
      };
      if (result.idempotent) {
        logger.info("graph_batch_mutate_replayed", logPayload);
      } else {
        logger.info("graph_batch_mutate_succeeded", logPayload);
      }

      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_batch_mutate", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof GraphVersionConflictError) {
        return graphToolError(logger, "graph_batch_mutate", error, {
          graph_id: graphIdForError,
          op_id: opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
        });
      }
      if (error instanceof GraphTransactionError) {
        return graphToolError(logger, "graph_batch_mutate", error, {
          graph_id: graphIdForError,
          op_id: opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
        });
      }
      return graphToolError(logger, "graph_batch_mutate", error, {
        graph_id: graphIdForError ?? undefined,
        op_id: opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      });
    }
  },
);

server.registerTool(
  "graph_diff",
  {
    title: "Graph diff",
    description: "Calcule un patch JSON (RFC 6902) entre deux versions ou descripteurs de graphe.",
    inputSchema: GraphDiffInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = GraphDiffInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_diff_op");
      logger.info("graph_diff_requested", {
        graph_id: parsed.graph_id,
        from: describeSelectorForLog(parsed.from),
        to: describeSelectorForLog(parsed.to),
        op_id: opId,
      });
      const result = handleGraphDiff(getGraphDiffToolContext(), { ...parsed, op_id: opId });
      logger.info("graph_diff_succeeded", {
        graph_id: result.graph_id,
        changed: result.changed,
        operations: result.operations.length,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_diff", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId = extractStringProperty(input as Record<string, unknown>, "op_id");
      return graphToolError(logger, "graph_diff", error, { op_id: providedOpId ?? undefined }, {
        defaultCode: "E-PATCH-DIFF",
        invalidInputCode: "E-PATCH-INVALID",
      });
    }
  },
);

server.registerTool(
  "graph_patch",
  {
    title: "Graph patch",
    description:
      "Applique un patch JSON sur le dernier graphe committe en verifiant les invariants structurels.",
    inputSchema: GraphPatchInputShape,
  },
  async (input: unknown) => {
    let graphIdForError: string | undefined;
    try {
      const parsed = GraphPatchInputSchema.parse(input);
      graphIdForError = parsed.graph_id;
      const opId = resolveOperationId(parsed.op_id, "graph_patch_op");
      logger.info("graph_patch_requested", {
        graph_id: parsed.graph_id,
        operations: parsed.patch.length,
        base_version: parsed.base_version ?? null,
        enforce_invariants: parsed.enforce_invariants,
        op_id: opId,
      });
      const result = handleGraphPatch(getGraphDiffToolContext(), { ...parsed, op_id: opId });
      logger.info("graph_patch_succeeded", {
        graph_id: result.graph_id,
        committed_version: result.committed_version,
        changed: result.changed,
        operations: result.operations_applied,
        invariants_ok: result.invariants ? result.invariants.ok : true,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_patch", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError(logger, "graph_patch", error, {
        graph_id: graphIdForError,
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      }, {
        defaultCode: "E-PATCH-APPLY",
        invalidInputCode: "E-PATCH-INVALID",
      });
    }
  },
);

server.registerTool(
  "graph_lock",
  {
    title: "Graph lock",
    description: "Acquiert ou rafraichit un verrou cooperatif sur un graphe afin de proteger les mutations.",
    inputSchema: GraphLockInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureLocksEnabled("graph_lock");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = GraphLockInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_lock_op");
      logger.info("graph_lock_requested", {
        graph_id: parsed.graph_id,
        holder: parsed.holder,
        ttl_ms: parsed.ttl_ms ?? null,
        op_id: opId,
      });
      const result = handleGraphLock(getGraphLockToolContext(), { ...parsed, op_id: opId });
      logger.info("graph_lock_acquired", {
        graph_id: result.graph_id,
        holder: result.holder,
        lock_id: result.lock_id,
        expires_at: result.expires_at ?? null,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_lock", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError(logger, "graph_lock", error, {
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      }, {
        defaultCode: "E-LOCK-ACQUIRE",
        invalidInputCode: "E-LOCK-INVALID-INPUT",
      });
    }
  },
);

server.registerTool(
  "graph_unlock",
  {
    title: "Graph unlock",
    description: "Libere un verrou cooperatif precedemment acquis sur un graphe.",
    inputSchema: GraphUnlockInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureLocksEnabled("graph_unlock");
    if (disabled) {
      return disabled;
    }
    let lockIdForError: string | undefined;
    try {
      const parsed = GraphUnlockInputSchema.parse(input);
      lockIdForError = parsed.lock_id;
      const opId = resolveOperationId(parsed.op_id, "graph_unlock_op");
      logger.info("graph_unlock_requested", {
        lock_id: parsed.lock_id,
        op_id: opId,
      });
      const result = handleGraphUnlock(getGraphLockToolContext(), { ...parsed, op_id: opId });
      logger.info("graph_unlock_succeeded", {
        lock_id: result.lock_id,
        graph_id: result.graph_id,
        expired: result.expired,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_unlock", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError(logger, "graph_unlock", error, {
        lock_id: lockIdForError,
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      }, {
        defaultCode: "E-LOCK-RELEASE",
        invalidInputCode: "E-LOCK-INVALID-INPUT",
      });
    }
  },
);

server.registerTool(
  "graph_subgraph_extract",
  {
    title: "Graph subgraph extract",
    description: "Exporte le descripteur d'un sous-graphe vers le dossier de run.",
    inputSchema: GraphSubgraphExtractInputShape,
  },
  async (input: unknown) => {
    let parsed: GraphSubgraphExtractInput | undefined;
    try {
      parsed = GraphSubgraphExtractInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_subgraph_extract_op");
      logger.info("graph_subgraph_extract_requested", {
        node_id: parsed.node_id,
        run_id: parsed.run_id,
        op_id: opId,
      });
      const extraction = await extractSubgraphToFile({
        graph: parsed.graph,
        nodeId: parsed.node_id,
        runId: parsed.run_id,
        childrenRoot: CHILDREN_ROOT,
        directoryName: parsed.directory,
      });
      logger.info("graph_subgraph_extract_succeeded", {
        node_id: parsed.node_id,
        run_id: extraction.runId,
        subgraph_ref: extraction.subgraphRef,
        version: extraction.version,
        op_id: opId,
      });
      const descriptorPayload = {
        run_id: extraction.runId,
        node_id: extraction.nodeId,
        subgraph_ref: extraction.subgraphRef,
        version: extraction.version,
        extracted_at: extraction.extractedAt,
        absolute_path: extraction.absolutePath,
        relative_path: extraction.relativePath,
        graph_id: extraction.graphId,
        graph_version: extraction.graphVersion,
        op_id: opId,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: j({ tool: "graph_subgraph_extract", result: descriptorPayload }),
          },
        ],
        structuredContent: {
          ...descriptorPayload,
          descriptor: extraction.descriptor,
          metadata_key: SUBGRAPH_REGISTRY_KEY,
        },
      };
    } catch (error) {
      return graphToolError(logger, "graph_subgraph_extract", error, {
        node_id: parsed?.node_id,
        run_id: parsed?.run_id,
        op_id: parsed ? parsed.op_id ?? undefined : undefined,
      });
    }
  },
);

server.registerTool(
  "graph_hyper_export",
  {
    title: "Graph hyper export",
    description: "Projette un hyper-graphe en graphe orienté avec métadonnées conservées.",
    inputSchema: GraphHyperExportInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = GraphHyperExportInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_hyper_export_op");
      logger.info("graph_hyper_export_requested", {
        graph_id: parsed.id,
        nodes: parsed.nodes.length,
        hyper_edges: parsed.hyper_edges.length,
        op_id: opId,
      });
      const result = handleGraphHyperExport({ ...parsed, op_id: opId });
      logger.info("graph_hyper_export_succeeded", {
        graph_id: result.graph.graph_id,
        nodes: result.stats.nodes,
        edges: result.stats.edges,
        hyper_edges: result.stats.hyper_edges,
        op_id: result.op_id,
      });
      return {
        content: [
          { type: "text" as const, text: j({ tool: "graph_hyper_export", result }) },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError(logger, "graph_hyper_export", error, {
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      });
    }
  },
);

server.registerTool(
  "memory_vector_search",
  {
    title: "Memory vector search",
    description: "Recherche des artefacts textuels en mémoire vectorielle (cosine).",
    inputSchema: MemoryVectorSearchInputShape,
  },
  async (
    input: unknown,
    _extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => {
    const disabled = ensureKnowledgeEnabled("memory_vector_search");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = MemoryVectorSearchInputSchema.parse(input);
      const result = handleMemoryVectorSearch(getMemoryVectorToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "memory_vector_search", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return knowledgeToolError(logger, "memory_vector_search", error);
    }
  },
);

server.registerTool(
  "kg_insert",
  {
    title: "Knowledge insert",
    description: "Insère ou met à jour des triplets dans le graphe de connaissances.",
    inputSchema: KgInsertInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureKnowledgeEnabled("kg_insert");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = KgInsertInputSchema.parse(input);
      const result = handleKgInsert(getKnowledgeToolContext(), parsed);
      await knowledgeGraphPersistence.persist();
      return {
        content: [{ type: "text" as const, text: j({ tool: "kg_insert", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return knowledgeToolError(logger, "kg_insert", error);
    }
  },
);

server.registerTool(
  "kg_upsert",
  {
    title: "Knowledge upsert",
    description: "Alias de kg_insert garantissant la persistance immédiate du graphe.",
    inputSchema: KgInsertInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureKnowledgeEnabled("kg_upsert");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = KgInsertInputSchema.parse(input);
      const result = handleKgInsert(getKnowledgeToolContext(), parsed);
      await knowledgeGraphPersistence.persist();
      return {
        content: [{ type: "text" as const, text: j({ tool: "kg_upsert", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return knowledgeToolError(logger, "kg_upsert", error);
    }
  },
);

server.registerTool(
  "kg_query",
  {
    title: "Knowledge query",
    description: "Recherche des triplets par motif (joker * supporté).",
    inputSchema: KgQueryInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureKnowledgeEnabled("kg_query");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = KgQueryInputSchema.parse(input);
      const result = handleKgQuery(getKnowledgeToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "kg_query", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return knowledgeToolError(logger, "kg_query", error);
    }
  },
);

server.registerTool(
  "kg_export",
  {
    title: "Knowledge export",
    description: "Exporte l'intégralité du graphe de connaissances (ordre déterministe).",
    inputSchema: KgExportInputShape,
  },
  async (input) => {
    const disabled = ensureKnowledgeEnabled("kg_export");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = KgExportInputSchema.parse(input);
      const result = handleKgExport(getKnowledgeToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "kg_export", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return knowledgeToolError(logger, "kg_export", error);
    }
  },
);

server.registerTool(
  "kg_suggest_plan",
  {
    title: "Knowledge suggest plan",
    description:
      "Propose des fragments hiérarchiques issus du graphe de connaissances (sources, dépendances, couverture).",
    inputSchema: KgSuggestPlanInputShape,
  },
  async (input) => {
    const disabled = ensureAssistEnabled("kg_suggest_plan");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = KgSuggestPlanInputSchema.parse(input);
      const result = handleKgSuggestPlan(getKnowledgeToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "kg_suggest_plan", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return knowledgeToolError(logger, "kg_suggest_plan", error);
    }
  },
);

server.registerTool(
  "values_set",
  {
    title: "Values graph set",
    description: "Définit les valeurs, priorités et contraintes du garde-fou.",
    inputSchema: ValuesSetInputShape,
  },
  async (input) => {
    const disabled = ensureValueGuardEnabled("values_set");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ValuesSetInputSchema.parse(input);
      const result = handleValuesSet(getValueToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "values_set", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return valueToolError(logger, "values_set", error);
    }
  },
);

server.registerTool(
  "values_score",
  {
    title: "Values score",
    description: "Évalue un plan par rapport au graphe de valeurs.",
    inputSchema: ValuesScoreInputShape,
  },
  async (input) => {
    const disabled = ensureValueGuardEnabled("values_score");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ValuesScoreInputSchema.parse(input);
      const result = handleValuesScore(getValueToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "values_score", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return valueToolError(logger, "values_score", error);
    }
  },
);

server.registerTool(
  "values_filter",
  {
    title: "Values filter",
    description: "Applique le seuil du garde-fou et retourne la décision détaillée.",
    inputSchema: ValuesFilterInputShape,
  },
  async (input) => {
    const disabled = ensureValueGuardEnabled("values_filter");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ValuesFilterInputSchema.parse(input);
      const result = handleValuesFilter(getValueToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "values_filter", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return valueToolError(logger, "values_filter", error);
    }
  },
);

server.registerTool(
  "values_explain",
  {
    title: "Values explain",
    description: "Explique les violations du garde-fou avec corrélations plan.",
    inputSchema: ValuesExplainInputShape,
  },
  async (input) => {
    const disabled = ensureValueGuardEnabled("values_explain");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ValuesExplainInputSchema.parse(input);
      const result = handleValuesExplain(getValueToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "values_explain", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return valueToolError(logger, "values_explain", error);
    }
  },
);

server.registerTool(
  "causal_export",
  {
    title: "Causal memory export",
    description: "Exporte la mémoire causale pour analyse hors-ligne.",
    inputSchema: CausalExportInputShape,
  },
  async (input) => {
    const disabled = ensureCausalMemoryEnabled("causal_export");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = CausalExportInputSchema.parse(input);
      const result = handleCausalExport(getCausalToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "causal_export", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return causalToolError(logger, "causal_export", error);
    }
  },
);

server.registerTool(
  "causal_explain",
  {
    title: "Causal memory explain",
    description: "Reconstruit l'arbre des causes pour un événement donné.",
    inputSchema: CausalExplainInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureCausalMemoryEnabled("causal_explain");
    if (disabled) {
      return disabled;
    }
    let parsed: z.infer<typeof CausalExplainInputSchema> | undefined;
    try {
      parsed = CausalExplainInputSchema.parse(input);
      const result = handleCausalExplain(getCausalToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "causal_explain", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return causalToolError(logger, "causal_explain", error, parsed ? { outcome_id: parsed.outcome_id } : {});
    }
  },
);

server.registerTool(
  "graph_rewrite_apply",
  {
    title: "Graph rewrite apply",
    description: "Applique les règles de réécriture (manuelles ou adaptatives) sur un graphe hiérarchique.",
    inputSchema: GraphRewriteApplyInputShape,
  },
  async (input: unknown) => {
    let parsed: GraphRewriteApplyInput | undefined;
    let graphIdForError: string | null = null;
    let graphVersionForError: number | null = null;
    try {
      parsed = GraphRewriteApplyInputSchema.parse(input);
      graphIdForError = parsed.graph.graph_id ?? null;
      graphVersionForError = parsed.graph.graph_version ?? null;
      const opId = resolveOperationId(parsed.op_id, "graph_rewrite_apply_op");
      logger.info("graph_rewrite_apply_requested", {
        mode: parsed.mode,
        graph_id: graphIdForError,
        version: graphVersionForError,
        op_id: opId,
      });

      const baseGraph = normaliseGraphPayload(parsed.graph);
      const tx = graphTransactions.begin(baseGraph);
      resources.recordGraphSnapshot({
        graphId: tx.graphId,
        txId: tx.txId,
        baseVersion: tx.baseVersion,
        startedAt: tx.startedAt,
        graph: tx.workingCopy,
      });
      let committed: ReturnType<typeof graphTransactions.commit> | undefined;
      try {
        const rewriteInput: GraphRewriteApplyInput = {
          ...parsed,
          graph: serialiseNormalisedGraph(tx.workingCopy),
          op_id: opId,
        };
        const intermediate = handleGraphRewriteApply(rewriteInput);
        committed = graphTransactions.commit(
          tx.txId,
          normaliseGraphPayload(intermediate.graph),
        );
        resources.markGraphSnapshotCommitted({
          graphId: committed.graphId,
          txId: tx.txId,
          committedAt: committed.committedAt,
          finalVersion: committed.version,
          finalGraph: committed.graph,
        });
        resources.recordGraphVersion({
          graphId: committed.graphId,
          version: committed.version,
          committedAt: committed.committedAt,
          graph: committed.graph,
        });
        const finalGraph = serialiseNormalisedGraph(committed.graph);
        const result = { ...intermediate, graph: finalGraph };
        const summary = summariseSubgraphUsage(result.graph);
        if (summary.references.length > 0) {
          logger.info("graph_rewrite_apply_subgraphs_detected", {
            graph_id: committed.graphId,
            references: summary.references.length,
            missing: summary.missing.length,
            op_id: opId,
          });
        }
        if (summary.missing.length > 0) {
          logger.warn("graph_rewrite_apply_missing_subgraphs", {
            graph_id: committed.graphId,
            missing: summary.missing,
            op_id: opId,
          });
        }
        const enrichedResult = {
          ...result,
          subgraph_refs: summary.references,
          ...(summary.missing.length > 0
            ? { missing_subgraph_descriptors: summary.missing }
            : {}),
        };
        logger.info("graph_rewrite_apply_succeeded", {
          mode: parsed.mode,
          total_applied: enrichedResult.total_applied,
          changed: enrichedResult.changed,
          graph_id: committed.graphId,
          version: committed.version,
          committed_at: committed.committedAt,
          op_id: opId,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: j({ tool: "graph_rewrite_apply", result: enrichedResult }),
            },
          ],
          structuredContent: enrichedResult,
        };
      } catch (error) {
        if (!committed) {
          try {
            graphTransactions.rollback(tx.txId);
            resources.markGraphSnapshotRolledBack(tx.graphId, tx.txId);
            logger.warn("graph_rewrite_apply_rolled_back", {
              graph_id: tx.graphId,
              base_version: tx.baseVersion,
              reason: error instanceof Error ? error.message : String(error),
            });
          } catch (rollbackError) {
            logger.error("graph_rewrite_apply_rollback_failed", {
              graph_id: tx.graphId,
              message:
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
            });
          }
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof GraphVersionConflictError) {
        return graphToolError(logger, "graph_rewrite_apply", error, {
          graph_id: graphIdForError ?? undefined,
          version: graphVersionForError ?? undefined,
          mode: parsed?.mode,
          op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
        });
      }
      return graphToolError(logger, "graph_rewrite_apply", error, {
        graph_id: graphIdForError ?? undefined,
        version: graphVersionForError ?? undefined,
        mode: parsed?.mode,
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      });
    }
  },
);

server.registerTool(
  "tx_begin",
  {
    title: "Transaction begin",
    description: "Ouvre une transaction optimiste et retourne une copie de travail du graphe.",
    inputSchema: TxBeginInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureTransactionsEnabled("tx_begin");
    if (disabled) {
      return disabled;
    }
    let graphIdForError: string | null = null;
    let opIdForError: string | undefined;
    try {
      const parsed = TxBeginInputSchema.parse(input ?? {});
      graphIdForError = parsed.graph_id;
      opIdForError = parsed.op_id ?? undefined;
      const result = handleTxBegin(getTxToolContext(), parsed);
      opIdForError = result.op_id;
      logger.info("tx_begin_requested", {
        graph_id: parsed.graph_id,
        expected_version: parsed.expected_version ?? null,
        owner: parsed.owner ?? null,
        ttl_ms: parsed.ttl_ms ?? null,
        idempotency_key: parsed.idempotency_key ?? null,
        op_id: result.op_id,
      });
      if (result.idempotent) {
        logger.info("tx_begin_replayed", {
          graph_id: result.graph_id,
          tx_id: result.tx_id,
          base_version: result.base_version,
          owner: result.owner,
          expires_at: result.expires_at,
          idempotency_key: result.idempotency_key,
          op_id: result.op_id,
        });
      } else {
        logger.info("tx_begin_opened", {
          graph_id: result.graph_id,
          tx_id: result.tx_id,
          base_version: result.base_version,
          owner: result.owner,
          expires_at: result.expires_at,
          idempotency_key: result.idempotency_key,
          op_id: result.op_id,
        });
      }
      return {
        content: [{ type: "text" as const, text: j({ tool: "tx_begin", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return transactionToolError(logger, "tx_begin", error, {
        graph_id: graphIdForError ?? undefined,
        op_id: opIdForError,
      });
    }
  },
);

server.registerTool(
  "tx_apply",
  {
    title: "Transaction apply",
    description: "Applique des opérations sur la copie de travail d'une transaction en cours.",
    inputSchema: TxApplyInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureTransactionsEnabled("tx_apply");
    if (disabled) {
      return disabled;
    }
    let txIdForError: string | null = null;
    let opIdForError: string | undefined;
    try {
      const parsed = TxApplyInputSchema.parse(input);
      txIdForError = parsed.tx_id;
      opIdForError = parsed.op_id ?? undefined;
      const result = handleTxApply(getTxToolContext(), parsed);
      opIdForError = result.op_id;
      logger.info("tx_apply_requested", {
        tx_id: parsed.tx_id,
        operations: parsed.operations.length,
        op_id: result.op_id,
      });
      logger.info("tx_apply_mutated", {
        tx_id: result.tx_id,
        graph_id: result.graph_id,
        base_version: result.base_version,
        preview_version: result.preview_version,
        changed: result.changed,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "tx_apply", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return transactionToolError(logger, "tx_apply", error, {
        tx_id: txIdForError ?? undefined,
        op_id: opIdForError,
      });
    }
  },
);

server.registerTool(
  "tx_commit",
  {
    title: "Transaction commit",
    description: "Valide la transaction en appliquant les mutations du graphe.",
    inputSchema: TxCommitInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureTransactionsEnabled("tx_commit");
    if (disabled) {
      return disabled;
    }
    let txIdForError: string | null = null;
    let opIdForError: string | undefined;
    try {
      const parsed = TxCommitInputSchema.parse(input);
      txIdForError = parsed.tx_id;
      opIdForError = parsed.op_id ?? undefined;
      const result = handleTxCommit(getTxToolContext(), parsed);
      opIdForError = result.op_id;
      logger.info("tx_commit_requested", { tx_id: parsed.tx_id, op_id: result.op_id });
      logger.info("tx_commit_succeeded", {
        tx_id: result.tx_id,
        graph_id: result.graph_id,
        version: result.version,
        committed_at: result.committed_at,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "tx_commit", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return transactionToolError(logger, "tx_commit", error, {
        tx_id: txIdForError ?? undefined,
        op_id: opIdForError,
      });
    }
  },
);

server.registerTool(
  "tx_rollback",
  {
    title: "Transaction rollback",
    description: "Annule une transaction et restaure le snapshot d'origine.",
    inputSchema: TxRollbackInputShape,
  },
  async (input: unknown) => {
    const disabled = ensureTransactionsEnabled("tx_rollback");
    if (disabled) {
      return disabled;
    }
    let txIdForError: string | null = null;
    let opIdForError: string | undefined;
    try {
      const parsed = TxRollbackInputSchema.parse(input);
      txIdForError = parsed.tx_id;
      opIdForError = parsed.op_id ?? undefined;
      const result = handleTxRollback(getTxToolContext(), parsed);
      opIdForError = result.op_id;
      logger.info("tx_rollback_requested", { tx_id: parsed.tx_id, op_id: result.op_id });
      logger.info("tx_rollback_succeeded", {
        tx_id: result.tx_id,
        graph_id: result.graph_id,
        version: result.version,
        rolled_back_at: result.rolled_back_at,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "tx_rollback", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return transactionToolError(logger, "tx_rollback", error, {
        tx_id: txIdForError ?? undefined,
        op_id: opIdForError,
      });
    }
  },
);

server.registerTool(
  "graph_validate",
  {
    title: "Graph validate",
    description: "Analyse un graphe (cycles, noeuds isoles, poids) et retourne erreurs/avertissements.",
    inputSchema: GraphValidateInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = GraphValidateInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_validate_op");
      logger.info("graph_validate_requested", {
        strict_weights: parsed.strict_weights ?? false,
        cycle_limit: parsed.cycle_limit,
        op_id: opId,
      });
      const result = handleGraphValidate({ ...parsed, op_id: opId });
      logger.info("graph_validate_completed", {
        ok: result.ok,
        errors: result.errors.length,
        warnings: result.warnings.length,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_validate", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError(logger, "graph_validate", error, {
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      });
    }
  },
);

server.registerTool(
  "graph_summarize",
  {
    title: "Graph summarize",
    description: "Resume un graphe (layers, metriques, centralites).",
    inputSchema: GraphSummarizeInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = GraphSummarizeInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_summarize_op");
      logger.info("graph_summarize_requested", {
        include_centrality: parsed.include_centrality,
        op_id: opId,
      });
      const result = handleGraphSummarize({ ...parsed, op_id: opId });
      logger.info("graph_summarize_succeeded", {
        nodes: result.metrics.node_count,
        edges: result.metrics.edge_count,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_summarize", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError(logger, "graph_summarize", error, {
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      });
    }
  },
);

server.registerTool(
  "graph_paths_k_shortest",
  {
    title: "Graph k-shortest paths",
    description: "Calcule les k plus courts chemins (Yen) entre deux noeuds.",
    inputSchema: GraphPathsKShortestInputShape,
  },
  async (input: unknown) => {
    try {
      const parsed = GraphPathsKShortestInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_paths_k_shortest_op");
      logger.info("graph_paths_k_shortest_requested", {
        from: parsed.from,
        to: parsed.to,
        k: parsed.k,
        weight_attribute: parsed.weight_attribute,
        max_deviation: parsed.max_deviation ?? null,
        op_id: opId,
      });
      const result = handleGraphPathsKShortest({ ...parsed, op_id: opId });
      logger.info("graph_paths_k_shortest_succeeded", {
        returned_k: result.returned_k,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_paths_k_shortest", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError(logger, "graph_paths_k_shortest", error, {
        op_id: extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined,
      });
    }
  },
);

server.registerTool(
  "graph_paths_constrained",
  {
    title: "Graph constrained path",
    description: "Recherche un chemin optimal en excluant certains noeuds/arcs.",
    inputSchema: GraphPathsConstrainedInputShape,
  },
  async (input) => {
    let opIdForError: string | undefined;
    try {
      const parsed = GraphPathsConstrainedInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_paths_constrained_op");
      opIdForError = opId;
      logger.info("graph_paths_constrained_requested", {
        from: parsed.from,
        to: parsed.to,
        avoid_nodes: parsed.avoid_nodes.length,
        avoid_edges: parsed.avoid_edges.length,
        max_cost: parsed.max_cost ?? null,
        op_id: opId,
      });
      const result = handleGraphPathsConstrained({ ...parsed, op_id: opId });
      opIdForError = result.op_id;
      logger.info("graph_paths_constrained_completed", {
        status: result.status,
        reason: result.reason,
        cost: result.cost,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_paths_constrained", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId =
        opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined;
      return graphToolError(logger, "graph_paths_constrained", error, { op_id: providedOpId });
    }
  },
);

server.registerTool(
  "graph_centrality_betweenness",
  {
    title: "Graph betweenness centrality",
    description: "Calcule les scores de centralite de Brandes (pondere ou non).",
    inputSchema: GraphCentralityBetweennessInputShape,
  },
  async (input) => {
    let opIdForError: string | undefined;
    try {
      const parsed = GraphCentralityBetweennessInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_centrality_betweenness_op");
      opIdForError = opId;
      logger.info("graph_centrality_betweenness_requested", {
        weighted: parsed.weighted,
        normalise: parsed.normalise,
        top_k: parsed.top_k,
        op_id: opId,
      });
      const result = handleGraphCentralityBetweenness({ ...parsed, op_id: opId });
      opIdForError = result.op_id;
      logger.info("graph_centrality_betweenness_succeeded", {
        top_count: result.top.length,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_centrality_betweenness", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId =
        opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined;
      return graphToolError(logger, "graph_centrality_betweenness", error, { op_id: providedOpId });
    }
  },
);

server.registerTool(
  "graph_partition",
  {
    title: "Graph partition",
    description: "Partitionne le graphe en communautés ou minimise les coupures.",
    inputSchema: GraphPartitionInputShape,
  },
  async (input) => {
    let opIdForError: string | undefined;
    try {
      const parsed = GraphPartitionInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_partition_op");
      opIdForError = opId;
      logger.info("graph_partition_requested", {
        k: parsed.k,
        objective: parsed.objective,
        seed: parsed.seed ?? null,
        op_id: opId,
      });
      const result = handleGraphPartition({ ...parsed, op_id: opId });
      opIdForError = result.op_id;
      logger.info("graph_partition_succeeded", {
        partition_count: result.partition_count,
        cut_edges: result.cut_edges,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_partition", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId =
        opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined;
      return graphToolError(logger, "graph_partition", error, { op_id: providedOpId });
    }
  },
);

server.registerTool(
  "graph_critical_path",
  {
    title: "Graph critical path",
    description: "Analyse le chemin critique et expose les marges/slacks.",
    inputSchema: GraphCriticalPathInputShape,
  },
  async (input) => {
    let opIdForError: string | undefined;
    try {
      const parsed = GraphCriticalPathInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_critical_path_op");
      opIdForError = opId;
      logger.info("graph_critical_path_requested", {
        duration_attribute: parsed.duration_attribute,
        fallback_duration_attribute: parsed.fallback_duration_attribute ?? null,
        op_id: opId,
      });
      const result = handleGraphCriticalPath({ ...parsed, op_id: opId });
      opIdForError = result.op_id;
      logger.info("graph_critical_path_succeeded", {
        duration: result.duration,
        path_length: result.critical_path.length,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_critical_path", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId =
        opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined;
      return graphToolError(logger, "graph_critical_path", error, { op_id: providedOpId });
    }
  },
);

server.registerTool(
  "graph_simulate",
  {
    title: "Graph simulate",
    description: "Simule l'execution du graphe et retourne un planning détaillé.",
    inputSchema: GraphSimulateInputShape,
  },
  async (input) => {
    let opIdForError: string | undefined;
    try {
      const parsed = GraphSimulateInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_simulate_op");
      opIdForError = opId;
      logger.info("graph_simulate_requested", {
        parallelism: parsed.parallelism,
        duration_attribute: parsed.duration_attribute,
        op_id: opId,
      });
      const result = handleGraphSimulate({ ...parsed, op_id: opId });
      opIdForError = result.op_id;
      logger.info("graph_simulate_succeeded", {
        makespan: result.metrics.makespan,
        queue_events: result.metrics.queue_events,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_simulate", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId =
        opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined;
      return graphToolError(logger, "graph_simulate", error, { op_id: providedOpId });
    }
  },
);

server.registerTool(
  "graph_optimize",
  {
    title: "Graph optimize",
    description: "Analyse un graphe planifié et propose des leviers de réduction du makespan.",
    inputSchema: GraphOptimizeInputShape,
  },
  async (input) => {
    let opIdForError: string | undefined;
    try {
      const parsed = GraphOptimizeInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_optimize_op");
      opIdForError = opId;
      logger.info("graph_optimize_requested", {
        parallelism: parsed.parallelism,
        max_parallelism: parsed.max_parallelism,
        explore_count: parsed.explore_parallelism?.length ?? 0,
        op_id: opId,
      });
      const result = handleGraphOptimize({ ...parsed, op_id: opId });
      opIdForError = result.op_id;
      const bestMakespan = result.projections.reduce(
        (acc, projection) => Math.min(acc, projection.makespan),
        Number.POSITIVE_INFINITY,
      );
      logger.info("graph_optimize_completed", {
        suggestions: result.suggestions.length,
        best_makespan: Number.isFinite(bestMakespan) ? bestMakespan : null,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_optimize", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId =
        opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined;
      return graphToolError(logger, "graph_optimize", error, { op_id: providedOpId });
    }
  },
);

server.registerTool(
  "graph_optimize_moo",
  {
    title: "Graph optimize multi-objectifs",
    description: "Explore les pareto fronts pour plusieurs objectifs (makespan/coût/risque).",
    inputSchema: GraphOptimizeMooInputShape,
  },
  async (input) => {
    let opIdForError: string | undefined;
    try {
      const parsed = GraphOptimizeMooInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_optimize_moo_op");
      opIdForError = opId;
      logger.info("graph_optimize_moo_requested", {
        candidates: parsed.parallelism_candidates.length,
        objectives: parsed.objectives.length,
        op_id: opId,
      });
      const result = handleGraphOptimizeMoo({ ...parsed, op_id: opId });
      opIdForError = result.op_id;
      logger.info("graph_optimize_moo_completed", {
        pareto_count: result.pareto_front.length,
        scalarized: result.scalarization ? true : false,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_optimize_moo", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId =
        opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined;
      return graphToolError(logger, "graph_optimize_moo", error, { op_id: providedOpId });
    }
  },
);

server.registerTool(
  "graph_causal_analyze",
  {
    title: "Graph causal analysis",
    description: "Analyse causale: ordre topo, cycles et coupure minimale.",
    inputSchema: GraphCausalAnalyzeInputShape,
  },
  async (input) => {
    let opIdForError: string | undefined;
    try {
      const parsed = GraphCausalAnalyzeInputSchema.parse(input);
      const opId = resolveOperationId(parsed.op_id, "graph_causal_analyze_op");
      opIdForError = opId;
      logger.info("graph_causal_analyze_requested", {
        max_cycles: parsed.max_cycles,
        compute_min_cut: parsed.compute_min_cut,
        op_id: opId,
      });
      const result = handleGraphCausalAnalyze({ ...parsed, op_id: opId });
      opIdForError = result.op_id;
      logger.info("graph_causal_analyze_completed", {
        acyclic: result.acyclic,
        cycles: result.cycles.length,
        min_cut_size: result.min_cut?.size ?? null,
        op_id: result.op_id,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_causal_analyze", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const providedOpId =
        opIdForError ?? extractStringProperty(input as Record<string, unknown>, "op_id") ?? undefined;
      return graphToolError(logger, "graph_causal_analyze", error, { op_id: providedOpId });
    }
  },
);

// plan_fanout
server.registerTool(
  "plan_fanout",
  {
    title: "Plan fan-out",
    description: "Planifie des enfants en parallele, retourne job_id et child_ids.",
    inputSchema: PlanFanoutInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = PlanFanoutInputSchema.parse(input);
      const result = await handlePlanFanout(getPlanToolContext(), parsed);
      startHeartbeat();
      return {
        content: [
          { type: "text" as const, text: j({ tool: "plan_fanout", result }) },
        ],
        structuredContent: result,
      };
    } catch (error) {
      if (error instanceof ValueGuardRequiredError) {
        logger.warn("plan_fanout_value_guard_required", {
          children: error.children.length,
          names: error.children,
        });
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: j({
                error: error.code,
                tool: "plan_fanout",
                message: error.message,
                hint: error.hint,
                children: error.children,
              }),
            },
          ],
        };
      }
      if (error instanceof ValueGuardRejectionError) {
        logger.error("plan_fanout_rejected_by_value_guard", {
          rejected: error.rejections.length,
        });
        const rejected = error.rejections.map((entry) => ({
          name: entry.name,
          value_guard: {
            allowed: entry.decision.allowed,
            score: entry.decision.score,
            total: entry.decision.total,
            threshold: entry.decision.threshold,
            violations: entry.decision.violations,
          },
        }));
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: j({
                error: "E-VALUES-VIOLATION",
                tool: "plan_fanout",
                message: error.message,
                rejected,
              }),
            },
          ],
        };
      }
      return planToolError(logger, "plan_fanout", error);
    }
  },
);

server.registerTool(
  "plan_join",
  {
    title: "Plan join",
    description: "Attend les reponses des enfants selon une politique de quorum ou de premiere reussite.",
    inputSchema: PlanJoinInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = PlanJoinInputSchema.parse(input);
      const result = await handlePlanJoin(getPlanToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_join", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_join", error);
    }
  },
);

server.registerTool(
  "plan_reduce",
  {
    title: "Plan reduce",
    description: "Combine les sorties des enfants (concat, merge_json, vote, custom).",
    inputSchema: PlanReduceInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanReduceInputSchema.parse(input);
      const result = await handlePlanReduce(getPlanToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_reduce", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_reduce", error);
    }
  },
);

server.registerTool(
  "plan_compile_execute",
  {
    title: "Plan compile & schedule",
    description: "Compile un plan YAML/JSON en Behaviour Tree et planning critique.",
    inputSchema: PlanCompileExecuteInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanCompileExecuteInputSchema.parse(input);
      const result = handlePlanCompileExecute(getPlanToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_compile_execute", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_compile_execute", error, {}, {
        defaultCode: "E-PLAN-INVALID",
        invalidInputCode: "E-PLAN-INVALID",
      });
    }
  },
);

server.registerTool(
  "plan_compile_bt",
  {
    title: "Plan compile Behaviour Tree",
    description: "Compile un graphe hiérarchique en Behaviour Tree exécutable.",
    inputSchema: PlanCompileBTInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanCompileBTInputSchema.parse(input);
      const result = handlePlanCompileBT(getPlanToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_compile_bt", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_compile_bt", error, {}, {
        defaultCode: "E-BT-INVALID",
        invalidInputCode: "E-BT-INVALID",
      });
    }
  },
);

server.registerTool(
  "plan_run_bt",
  {
    title: "Plan run Behaviour Tree",
    description: "Exécute un Behaviour Tree et trace chaque invocation de tool.",
    inputSchema: PlanRunBTInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanRunBTInputSchema.parse(input);
      const result = await handlePlanRunBT(getPlanToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_run_bt", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_run_bt", error, {}, {
        defaultCode: "E-BT-INVALID",
        invalidInputCode: "E-BT-INVALID",
      });
    }
  },
);

server.registerTool(
  "plan_run_reactive",
  {
    title: "Plan run reactive loop",
    description:
      "Exécute un Behaviour Tree via le scheduler réactif et la boucle de ticks (autoscaler/superviseur).",
    inputSchema: PlanRunReactiveInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanRunReactiveInputSchema.parse(input);
      const result = await handlePlanRunReactive(getPlanToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_run_reactive", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_run_reactive", error, {}, {
        defaultCode: "E-BT-INVALID",
        invalidInputCode: "E-BT-INVALID",
      });
    }
  },
);

server.registerTool(
  "plan_dry_run",
  {
    title: "Plan dry run",
    description:
      "Compile un plan et projette ses impacts valeurs sans exécuter les outils, afin d'anticiper les violations potentielles.",
    inputSchema: PlanDryRunInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanDryRunInputSchema.parse(input);
      const result = handlePlanDryRun(getPlanToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_dry_run", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_dry_run", error, {}, {
        defaultCode: "E-PLAN-DRY-RUN",
        invalidInputCode: "E-PLAN-INVALID-INPUT",
      });
    }
  },
);

server.registerTool(
  "plan_status",
  {
    title: "Plan status",
    description: "Expose l'état courant d'un run de plan (running/paused/done/failed).",
    inputSchema: PlanStatusInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanStatusInputSchema.parse(input);
      logger.info("plan_status_requested", { run_id: parsed.run_id });
      const result = handlePlanStatus(getPlanToolContext(), parsed);
      logger.info("plan_status_resolved", {
        run_id: result.run_id,
        state: result.state,
        progress: result.progress,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_status", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_status", error, {}, {
        defaultCode: "E-PLAN-STATUS",
        invalidInputCode: "E-PLAN-INVALID-INPUT",
      });
    }
  },
);

server.registerTool(
  "plan_pause",
  {
    title: "Plan pause",
    description: "Met en pause un run de plan actif via le lifecycle registry.",
    inputSchema: PlanPauseInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanPauseInputSchema.parse(input);
      logger.info("plan_pause_requested", { run_id: parsed.run_id });
      const result = await handlePlanPause(getPlanToolContext(), parsed);
      logger.info("plan_pause_applied", { run_id: result.run_id, state: result.state });
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_pause", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_pause", error, {}, {
        defaultCode: "E-PLAN-PAUSE",
        invalidInputCode: "E-PLAN-INVALID-INPUT",
      });
    }
  },
);

server.registerTool(
  "plan_resume",
  {
    title: "Plan resume",
    description: "Reprend un run de plan précédemment mis en pause.",
    inputSchema: PlanResumeInputShape,
  },
  async (input) => {
    try {
      const parsed = PlanResumeInputSchema.parse(input);
      logger.info("plan_resume_requested", { run_id: parsed.run_id });
      const result = await handlePlanResume(getPlanToolContext(), parsed);
      logger.info("plan_resume_applied", { run_id: result.run_id, state: result.state });
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_resume", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_resume", error, {}, {
        defaultCode: "E-PLAN-RESUME",
        invalidInputCode: "E-PLAN-INVALID-INPUT",
      });
    }
  },
);

server.registerTool(
  "op_cancel",
  {
    title: "Operation cancel",
    description: "Demande l'annulation d'une opération identifiée par son op_id.",
    inputSchema: OpCancelInputShape,
  },
  async (input) => {
    try {
      if (!runtimeFeatures.enableCancellation) {
        throw new CancellationFeatureDisabledError();
      }
      const parsed = OpCancelInputSchema.parse(input);
      const outcome = requestCancellation(parsed.op_id, { reason: parsed.reason ?? null });
      const handle = getCancellation(parsed.op_id);
      const lifecycleSnapshot =
        handle?.runId != null
          ? tryGetPlanLifecycleSnapshot(handle.runId, logger, "op_cancel_lifecycle_snapshot_failed")
          : null;
      // Surface the correlation metadata recorded when the operation was
      // registered so observers can link cancellation requests to plan
      // lifecycle artefacts.
      const result = {
        // Surface the `{ ok:true }` contract documented in the checklist while
        // preserving the richer correlation metadata already returned.
        ok: true as const,
        op_id: parsed.op_id,
        outcome,
        reason: handle?.reason ?? parsed.reason ?? null,
        run_id: handle?.runId ?? null,
        job_id: handle?.jobId ?? null,
        graph_id: handle?.graphId ?? null,
        node_id: handle?.nodeId ?? null,
        child_id: handle?.childId ?? null,
        progress: lifecycleSnapshot?.progress ?? null,
        lifecycle: lifecycleSnapshot,
      };
      logger.info("op_cancel", result);
      return {
        content: [{ type: "text" as const, text: j({ tool: "op_cancel", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "op_cancel", error, {}, {
        defaultCode: "E-CANCEL-OP",
        invalidInputCode: "E-CANCEL-INVALID-INPUT",
      });
    }
  },
);

server.registerTool(
  "plan_cancel",
  {
    title: "Plan cancel",
    description: "Annule toutes les opérations associées à un run_id.",
    inputSchema: PlanCancelInputShape,
  },
  async (input) => {
    try {
      if (!runtimeFeatures.enableCancellation) {
        throw new CancellationFeatureDisabledError();
      }
      const parsed = PlanCancelInputSchema.parse(input);
      const operations = cancelRun(parsed.run_id, { reason: parsed.reason ?? null });
      // Normalise the registry metadata so downstream MCP clients receive
      // consistent snake_cased correlation hints for every cancelled operation.
      const serialisedOperations = operations.map((operation) => ({
        op_id: operation.opId,
        outcome: operation.outcome,
        run_id: operation.runId,
        job_id: operation.jobId,
        graph_id: operation.graphId,
        node_id: operation.nodeId,
        child_id: operation.childId,
      }));
      const reason = parsed.reason ?? null;
      // Surface the lifecycle snapshot (state, progress, failure details) when
      // the plan registry is enabled so MCP clients do not need to issue an
      // immediate follow-up `plan_status` call after cancelling a run.
      const lifecycleSnapshot = tryGetPlanLifecycleSnapshot(
        parsed.run_id,
        logger,
        "plan_cancel_lifecycle_snapshot_failed",
      );
      logger.info("plan_cancel", {
        run_id: parsed.run_id,
        reason,
        affected: serialisedOperations.length,
        operations: serialisedOperations,
        progress: lifecycleSnapshot?.progress ?? null,
      });
      const result = {
        run_id: parsed.run_id,
        reason,
        operations: serialisedOperations,
        progress: lifecycleSnapshot?.progress ?? null,
        lifecycle: lifecycleSnapshot,
      };
      return {
        content: [{ type: "text" as const, text: j({ tool: "plan_cancel", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return planToolError(logger, "plan_cancel", error, {}, {
        defaultCode: "E-CANCEL-PLAN",
        invalidInputCode: "E-CANCEL-INVALID-INPUT",
      });
    }
  },
);

server.registerTool(
  "bb_batch_set",
  {
    title: "Blackboard batch set",
    description: "Met à jour plusieurs entrées du tableau noir dans une transaction atomique.",
    inputSchema: BbBatchSetInputShape,
  },
  async (input) => {
    const disabled = ensureBulkEnabled("bb_batch_set");
    if (disabled) {
      return disabled;
    }
    try {
      pruneExpired();
      const parsed = BbBatchSetInputSchema.parse(input);
      const result = handleBbBatchSet(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "bb_batch_set", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "bb_batch_set", error);
    }
  },
);

server.registerTool(
  "bb_set",
  {
    title: "Blackboard set",
    description: "Définit ou met à jour une clé sur le tableau noir partagé.",
    inputSchema: BbSetInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = BbSetInputSchema.parse(input);
      const result = handleBbSet(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "bb_set", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "bb_set", error);
    }
  },
);

server.registerTool(
  "bb_get",
  {
    title: "Blackboard get",
    description: "Récupère la dernière valeur connue pour une clé.",
    inputSchema: BbGetInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = BbGetInputSchema.parse(input);
      const result = handleBbGet(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "bb_get", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "bb_get", error);
    }
  },
);

server.registerTool(
  "bb_query",
  {
    title: "Blackboard query",
    description: "Liste les entrées filtrées par tags et/ou clés.",
    inputSchema: BbQueryInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = BbQueryInputSchema.parse(input);
      const result = handleBbQuery(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "bb_query", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "bb_query", error);
    }
  },
);

server.registerTool(
  "bb_watch",
  {
    title: "Blackboard watch",
    description: "Retourne les événements après une version donnée pour suivre les changements.",
    inputSchema: BbWatchInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = BbWatchInputSchema.parse(input);
      const result = handleBbWatch(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "bb_watch", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "bb_watch", error);
    }
  },
);

server.registerTool(
  "stig_mark",
  {
    title: "Stigmergie mark",
    description: "Dépose des phéromones sur un nœud pour influencer la planification.",
    inputSchema: StigMarkInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = StigMarkInputSchema.parse(input);
      const result = handleStigMark(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "stig_mark", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "stig_mark", error);
    }
  },
);

server.registerTool(
  "stig_batch",
  {
    title: "Stigmergie batch",
    description: "Applique plusieurs dépôts de phéromones de façon atomique (rollback sur erreur).",
    inputSchema: StigBatchInputShape,
  },
  async (input) => {
    const disabled = ensureBulkEnabled("stig_batch");
    if (disabled) {
      return disabled;
    }
    try {
      pruneExpired();
      const parsed = StigBatchInputSchema.parse(input);
      const result = handleStigBatch(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "stig_batch", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "stig_batch", error);
    }
  },
);

server.registerTool(
  "stig_decay",
  {
    title: "Stigmergie decay",
    description: "Fait s'évaporer les phéromones selon une demi-vie déterministe.",
    inputSchema: StigDecayInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = StigDecayInputSchema.parse(input);
      const result = handleStigDecay(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "stig_decay", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "stig_decay", error);
    }
  },
);

server.registerTool(
  "stig_snapshot",
  {
    title: "Stigmergie snapshot",
    description: "Expose l'intensité des phéromones pour chaque nœud et type.",
    inputSchema: StigSnapshotInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = StigSnapshotInputSchema.parse(input);
      const result = handleStigSnapshot(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "stig_snapshot", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "stig_snapshot", error);
    }
  },
);

server.registerTool(
  "cnp_announce",
  {
    title: "Contract-Net announce",
    description: "Annonce une tâche au protocole Contract-Net et retourne l'attribution.",
    inputSchema: CnpAnnounceInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = CnpAnnounceInputSchema.parse(input);
      const result = handleCnpAnnounce(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "cnp_announce", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "cnp_announce", error);
    }
  },
);

server.registerTool(
  "cnp_refresh_bounds",
  {
    title: "Contract-Net refresh bounds",
    description: "Met à jour les bornes de phéromones d'un appel Contract-Net ouvert.",
    inputSchema: CnpRefreshBoundsInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = CnpRefreshBoundsInputSchema.parse(input);
      const result = handleCnpRefreshBounds(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "cnp_refresh_bounds", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "cnp_refresh_bounds", error);
    }
  },
);

server.registerTool(
  "cnp_watcher_telemetry",
  {
    title: "Contract-Net watcher telemetry",
    description: "Expose les compteurs du watcher de bornes Contract-Net (rafraîchissements auto).",
    inputSchema: CnpWatcherTelemetryInputShape,
  },
  async (input) => {
    try {
      const parsed = CnpWatcherTelemetryInputSchema.parse(input);
      const result = handleCnpWatcherTelemetry(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "cnp_watcher_telemetry", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "cnp_watcher_telemetry", error);
    }
  },
);

server.registerTool(
  "consensus_vote",
  {
    title: "Consensus vote",
    description: "Agrège des bulletins pour calculer une décision de consensus auditable.",
    inputSchema: ConsensusVoteInputShape,
  },
  async (input) => {
    try {
      pruneExpired();
      const parsed = ConsensusVoteInputSchema.parse(input);
      logger.info("consensus_vote_requested", {
        mode: parsed.config?.mode ?? "majority",
        votes: parsed.votes.length,
      });
      const result = handleConsensusVote(getCoordinationToolContext(), parsed);
      logger.info("consensus_vote_succeeded", {
        mode: result.mode,
        outcome: result.outcome,
        satisfied: result.satisfied,
        votes: result.votes,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "consensus_vote", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError(logger, "consensus_vote", error);
    }
  },
);

server.registerTool(
  "agent_autoscale_set",
  {
    title: "Agent autoscale set",
    description: "Configure les bornes de l'autoscaler de runtimes enfants.",
    inputSchema: AgentAutoscaleSetInputShape,
  },
  async (input) => {
    try {
      const parsed = AgentAutoscaleSetInputSchema.parse(input);
      const result = handleAgentAutoscaleSet(getAgentToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "agent_autoscale_set", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("agent_autoscale_set_failed", { message });
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: j({ error: "AGENT_AUTOSCALE_ERROR", message }),
          },
        ],
      };
    }
  },
);



// start
server.registerTool(

  "start",

  { title: "Start job", description: "Met les enfants d un job en waiting.", inputSchema: StartShape },

  async (input: StartInput) => {

    pruneExpired();



    const { job_id, children } = input;

    const job = graphState.getJob(job_id);

    if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };



    if (children?.length) {

      for (const spec of children) {
        const normalized: SpawnChildSpec = { ...spec, runtime: spec.runtime ?? DEFAULT_CHILD_RUNTIME };
        createChild(job_id, normalized);
      }

    }



    let started = 0;

    for (const child of graphState.listChildren(job_id)) {

      if (child.state === "idle") {

        graphState.patchChild(child.id, { state: "waiting", waitingFor: "reply", pendingId: null });

        started++;

        const correlation = resolveChildEventCorrelation(child.id, { child });
        pushEvent({
          kind: "START",
          jobId: correlation.jobId ?? undefined,
          childId: correlation.childId ?? child.id,
          payload: { name: child.name },
          correlation,
        });

      }

    }



    return { content: [{ type: "text", text: j({ started, job_id }) }] };

  }

);



// child runtime management (process-based)
server.registerTool(
  "child_batch_create",
  {
    title: "Child batch create",
    description: "Démarre plusieurs enfants Codex avec rollback atomique en cas d'échec.",
    inputSchema: ChildBatchCreateInputShape,
  },
  async (input) => {
    const disabled = ensureBulkEnabled("child_batch_create");
    if (disabled) {
      return disabled;
    }
    pruneExpired();
    try {
      const parsed = ChildBatchCreateInputSchema.parse(input);
      const result = await handleChildBatchCreate(getChildToolContext(), parsed);
      result.children.forEach((child, index) => {
        const entry = parsed.entries[index] ?? parsed.entries[parsed.entries.length - 1]!;
        ensureChildVisibleInGraph({
          childId: child.child_id,
          snapshot: child.index_snapshot,
          metadata: child.index_snapshot.metadata,
          prompt: entry.prompt,
          runtimeStatus: child.runtime_status,
          startedAt: child.started_at,
        });
      });
      const payload = { tool: "child_batch_create", result };
      return {
        content: [{ type: "text" as const, text: j(payload) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_batch_create", error, { child_id: null });
    }
  },
);

server.registerTool(
  "child_spawn_codex",
  {
    title: "Child spawn Codex",
    description: "Démarre un enfant Codex avec un prompt structuré et des limites optionnelles.",
    inputSchema: ChildSpawnCodexInputShape,
  },
  async (input) => {
    const disabled = ensureChildOpsFineEnabled("child_spawn_codex");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ChildSpawnCodexInputSchema.parse(input);
      const result = await handleChildSpawnCodex(getChildToolContext(), parsed);
      ensureChildVisibleInGraph({
        childId: result.child_id,
        snapshot: result.index_snapshot,
        metadata: result.index_snapshot.metadata,
        prompt: parsed.prompt,
        runtimeStatus: result.runtime_status,
        startedAt: result.started_at,
      });
      const payload = { tool: "child_spawn_codex", result };
      return {
        content: [{ type: "text" as const, text: j(payload) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_spawn_codex", error, { child_id: null });
    }
  },
);

server.registerTool(
  "child_attach",
  {
    title: "Child attach",
    description: "Rafraîchit le manifest d'un enfant déjà actif et note la ré-connexion.",
    inputSchema: ChildAttachInputShape,
  },
  async (input) => {
    const disabled = ensureChildOpsFineEnabled("child_attach");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ChildAttachInputSchema.parse(input);
      const result = await handleChildAttach(getChildToolContext(), parsed);
      graphState.syncChildIndexSnapshot(result.index_snapshot);
      const payload = { tool: "child_attach", result };
      return {
        content: [{ type: "text" as const, text: j(payload) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_attach", error, { child_id: input?.child_id ?? null });
    }
  },
);

server.registerTool(
  "child_set_role",
  {
    title: "Child set role",
    description: "Met à jour le rôle annoncé d'un enfant en cours d'exécution.",
    inputSchema: ChildSetRoleInputShape,
  },
  async (input) => {
    const disabled = ensureChildOpsFineEnabled("child_set_role");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ChildSetRoleInputSchema.parse(input);
      const result = await handleChildSetRole(getChildToolContext(), parsed);
      graphState.syncChildIndexSnapshot(result.index_snapshot);
      const payload = { tool: "child_set_role", result };
      return {
        content: [{ type: "text" as const, text: j(payload) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_set_role", error, { child_id: input?.child_id ?? null });
    }
  },
);

server.registerTool(
  "child_set_limits",
  {
    title: "Child set limits",
    description: "Ajuste les limites déclaratives d'un enfant actif (tokens, temps, etc.).",
    inputSchema: ChildSetLimitsInputShape,
  },
  async (input) => {
    const disabled = ensureChildOpsFineEnabled("child_set_limits");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ChildSetLimitsInputSchema.parse(input);
      const result = await handleChildSetLimits(getChildToolContext(), parsed);
      graphState.syncChildIndexSnapshot(result.index_snapshot);
      const payload = { tool: "child_set_limits", result };
      return {
        content: [{ type: "text" as const, text: j(payload) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_set_limits", error, { child_id: input?.child_id ?? null });
    }
  },
);

server.registerTool(
  "child_create",
  {
    title: "Child create",
    description: "Démarre un runtime enfant sandboxé (Codex) et peut envoyer un payload initial.",
    inputSchema: ChildCreateInputShape,
  },
  async (input) => {
    try {
      const parsed = ChildCreateInputSchema.parse(input);
      const metadata = parsed.metadata ?? {};
      const goals = extractMetadataGoals(metadata);
      const tags = extractMetadataTags(metadata);
      const contextSelection = selectMemoryContext(memoryStore, {
        tags,
        goals,
        query: renderPromptForMemory(parsed.prompt),
        limit: 4,
      });

      if (goals.length > 0) {
        memoryStore.upsertKeyValue("orchestrator.last_goals", goals, {
          tags: goals,
          importance: 0.6,
          metadata: { source: "child_create" },
        });
      }

      const enrichedInput = { ...parsed } as z.infer<typeof ChildCreateInputSchema>;
      if (contextSelection.episodes.length > 0 || contextSelection.keyValues.length > 0) {
        enrichedInput.manifest_extras = {
          ...(parsed.manifest_extras ?? {}),
          memory_context: contextSelection,
        };
      }

      const result = await handleChildCreate(getChildToolContext(), enrichedInput);
      ensureChildVisibleInGraph({
        childId: result.child_id,
        snapshot: result.index_snapshot,
        metadata: result.index_snapshot.metadata,
        prompt: enrichedInput.prompt,
        runtimeStatus: result.runtime_status,
        startedAt: result.started_at,
      });
      const payload =
        contextSelection.episodes.length > 0 || contextSelection.keyValues.length > 0
          ? { ...result, memory_context: contextSelection }
          : result;

      return {
        content: [{ type: "text" as const, text: j({ tool: "child_create", result: payload }) }],
        structuredContent: payload,
      };
    } catch (error) {
      return childToolError(logger, "child_create", error, { child_id: input.child_id ?? null });
    }
  },
);

server.registerTool(
  "child_send",
  {
    title: "Child send",
    description: "Envoie un message JSON arbitraire à un runtime enfant.",
    inputSchema: ChildSendInputShape,
  },
  async (input) => {
    try {
      const parsed = ChildSendInputSchema.parse(input);
      const result = await handleChildSend(getChildToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "child_send", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_send", error, { child_id: input.child_id });
    }
  },
);

server.registerTool(
  "child_status",
  {
    title: "Child status",
    description: "Expose l'état runtime/index d'un enfant (pid, heartbeats, retries…).",
    inputSchema: ChildStatusInputShape,
  },
  (input) => {
    const disabled = ensureChildOpsFineEnabled("child_status");
    if (disabled) {
      return disabled;
    }
    try {
      const parsed = ChildStatusInputSchema.parse(input);
      const result = handleChildStatus(getChildToolContext(), parsed);
      graphState.syncChildIndexSnapshot(result.index_snapshot);
      return {
        content: [{ type: "text" as const, text: j({ tool: "child_status", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_status", error, { child_id: input.child_id });
    }
  },
);

server.registerTool(
  "child_collect",
  {
    title: "Child collect",
    description: "Collecte les messages et artefacts produits par un enfant.",
    inputSchema: ChildCollectInputShape,
  },
  async (input) => {
    try {
      const parsed = ChildCollectInputSchema.parse(input);
      const result = await handleChildCollect(getChildToolContext(), parsed);

      const summary = summariseChildOutputs(result.outputs);
      const review = metaCritic.review(summary.text, summary.kind, []);
      logger.logCognitive({
        actor: "meta-critic",
        phase: "score",
        childId: parsed.child_id,
        score: review.overall,
        content: review.feedback.join(" | "),
        metadata: {
          verdict: review.verdict,
          suggestions: review.suggestions.slice(0, 3),
        },
      });
      let reflectionSummary: ReflectionResult | null = null;
      const shouldReflect = reflectionEnabled || REFLECTION_PRIORITY_KINDS.has(summary.kind);
      if (shouldReflect) {
        try {
          reflectionSummary = await reflect({
            kind: summary.kind,
            input: summary.text,
            output: summary.text,
            meta: {
              score: review.overall,
              artifacts: result.outputs.artifacts.length,
              messages: result.outputs.messages.length,
            },
          });
          logger.logCognitive({
            actor: "self-reflect",
            phase: "resume",
            childId: parsed.child_id,
            content: reflectionSummary.insights.slice(0, 3).join(" | "),
            metadata: {
              kind: summary.kind,
              next_steps: reflectionSummary.nextSteps.slice(0, 2),
              risks: reflectionSummary.risks.slice(0, 2),
            },
          });
        } catch (error) {
          logger.warn("self_reflection_failed", {
            child_id: parsed.child_id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const qualityComputation = computeQualityAssessment(summary.kind, summary.text, review);
      let qualityAssessment: QualityAssessmentSnapshot | null = null;
      if (qualityComputation) {
        const needsRevision = qualityGateEnabled && qualityComputation.score < qualityGateThreshold;
        qualityAssessment = {
          kind: summary.kind,
          score: qualityComputation.score,
          rubric: { ...qualityComputation.rubric },
          metrics: { ...qualityComputation.metrics },
          gate: {
            enabled: qualityGateEnabled,
            threshold: qualityGateThreshold,
            needs_revision: needsRevision,
          },
        };
        logger.logCognitive({
          actor: "quality-scorer",
          phase: "score",
          childId: parsed.child_id,
          score: qualityAssessment.score / 100,
          content: `quality-${summary.kind}`,
          metadata: {
            threshold: qualityGateThreshold,
            needs_revision: needsRevision,
            rubric: qualityAssessment.rubric,
          },
        });
      }
      const childSnapshot = childSupervisor.childrenIndex.getChild(parsed.child_id);
      const jobId = findJobIdByChild(parsed.child_id) ?? null;
      const metadataTags = extractMetadataTags(childSnapshot?.metadata);
      const tags = new Set<string>([...summary.tags, ...metadataTags, parsed.child_id]);
      const goals = extractMetadataGoals(childSnapshot?.metadata);

      const episodeMetadata: Record<string, unknown> = {
        child_id: parsed.child_id,
        review,
        artifact_count: result.outputs.artifacts.length,
      };
      if (reflectionSummary) {
        episodeMetadata.reflection = reflectionSummary;
      }
      if (qualityAssessment) {
        episodeMetadata.quality = {
          kind: qualityAssessment.kind,
          score: qualityAssessment.score,
          rubric: qualityAssessment.rubric,
          gate: qualityAssessment.gate,
        };
      }

      const cognitiveEvents = buildChildCognitiveEvents({
        childId: parsed.child_id,
        jobId,
        summary,
        review,
        reflection: reflectionSummary,
        quality: qualityAssessment,
        artifactCount: result.outputs.artifacts.length,
        messageCount: result.outputs.messages.length,
        correlationSources: [childSnapshot?.metadata, result.outputs, result],
      });

      pushEvent({
        kind: cognitiveEvents.review.kind,
        level: cognitiveEvents.review.level,
        jobId: cognitiveEvents.review.jobId ?? undefined,
        childId: cognitiveEvents.review.childId,
        payload: cognitiveEvents.review.payload,
        correlation: cognitiveEvents.review.correlation,
      });

      if (cognitiveEvents.reflection) {
        pushEvent({
          kind: cognitiveEvents.reflection.kind,
          level: cognitiveEvents.reflection.level,
          jobId: cognitiveEvents.reflection.jobId ?? undefined,
          childId: cognitiveEvents.reflection.childId,
          payload: cognitiveEvents.reflection.payload,
          correlation: cognitiveEvents.reflection.correlation,
        });
      }

      const episode = memoryStore.recordEpisode({
        goal: goals.length > 0 ? goals.join(" | ") : `Collecte ${parsed.child_id}`,
        decision: "Synthèse des sorties enfant",
        outcome: summary.text.slice(0, 512),
        tags: Array.from(tags),
        importance: review.overall,
        metadata: episodeMetadata,
      });

      const payload: Record<string, unknown> = {
        ...result,
        review,
        memory_snapshot: {
          episode_id: episode.id,
          tags: episode.tags,
          stored_at: episode.createdAt,
        },
      };
      if (reflectionSummary) {
        payload.reflection = reflectionSummary;
      }
      if (qualityAssessment) {
        payload.quality_assessment = {
          kind: qualityAssessment.kind,
          score: qualityAssessment.score,
          rubric: qualityAssessment.rubric,
          metrics: qualityAssessment.metrics,
          gate: qualityAssessment.gate,
        };
        payload.needs_revision = qualityAssessment.gate.needs_revision;
      }

      await maybeIndexChildCollectMemory({
        childId: parsed.child_id,
        summaryText: summary.text,
        tags: Array.from(tags),
        reviewScore: review.overall,
        artifactCount: result.outputs.artifacts.length,
        reflection: reflectionSummary,
      });

      return {
        content: [{ type: "text" as const, text: j({ tool: "child_collect", result: payload }) }],
        structuredContent: payload,
      };
    } catch (error) {
      return childToolError(logger, "child_collect", error, { child_id: input.child_id });
    }
  },
);

server.registerTool(
  "child_stream",
  {
    title: "Child stream",
    description: "Pagine les messages stdout/stderr enregistrés pour un enfant.",
    inputSchema: ChildStreamInputShape,
  },
  (input) => {
    try {
      const parsed = ChildStreamInputSchema.parse(input);
      const result = handleChildStream(getChildToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "child_stream", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_stream", error, {
        child_id: input.child_id,
        after_sequence: input.after_sequence ?? null,
      });
    }
  },
);

server.registerTool(
  "child_cancel",
  {
    title: "Child cancel",
    description: "Demande un arrêt gracieux (SIGINT/SIGTERM) avec timeout optionnel.",
    inputSchema: ChildCancelInputShape,
  },
  async (input) => {
    try {
      const parsed = ChildCancelInputSchema.parse(input);
      const result = await handleChildCancel(getChildToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "child_cancel", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_cancel", error, { child_id: input.child_id });
    }
  },
);

server.registerTool(
  "child_kill",
  {
    title: "Child kill",
    description: "Force la terminaison d'un enfant après le délai indiqué.",
    inputSchema: ChildKillInputShape,
  },
  async (input) => {
    try {
      const parsed = ChildKillInputSchema.parse(input);
      const result = await handleChildKill(getChildToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "child_kill", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_kill", error, { child_id: input.child_id });
    }
  },
);

server.registerTool(
  "child_gc",
  {
    title: "Child gc",
    description: "Nettoie les métadonnées d'un enfant terminé.",
    inputSchema: ChildGcInputShape,
  },
  (input) => {
    try {
      const parsed = ChildGcInputSchema.parse(input);
      const result = handleChildGc(getChildToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "child_gc", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError(logger, "child_gc", error, { child_id: input.child_id });
    }
  },
);



// child_prompt

server.registerTool(

  "child_prompt",

  { title: "Child prompt", description: "Ajoute des messages au sous-chat et retourne un pending_id.", inputSchema: ChildPromptShape },

  async (input: ChildPromptInput) => {

    pruneExpired();



    const { child_id, messages } = input;

    const child = graphState.getChild(child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };

    if (child.state === "killed") return { isError: true, content: [{ type: "text", text: j({ error: "KILLED", message: "Child termine" }) }] };



    for (const message of messages) {

      const entry: MessageRecord = {

        role: message.role,

        content: message.content,

        ts: now(),

        actor: message.role === "user" ? "user" : "orchestrator"

      };

      graphState.appendMessage(child_id, entry);

    }
    graphState.patchChild(child_id, { state: "running", waitingFor: "reply" });

    const pendingId = `pending_${randomUUID()}`;

    graphState.setPending(child_id, pendingId, now());



    const correlation = resolveChildEventCorrelation(child_id, { child });
    const jobId = correlation.jobId ?? undefined;

    pushEvent({
      kind: "PROMPT",
      jobId,
      childId: correlation.childId ?? child_id,
      source: "orchestrator",
      payload: { appended: messages.length },
      correlation,
    });

    pushEvent({
      kind: "PENDING",
      jobId,
      childId: correlation.childId ?? child_id,
      payload: { pendingId },
      correlation,
    });



    const payload: ChildPromptStructuredPayload = {
      // Propagate the pending identifier so callers can reference the stream
      // produced by the child when acknowledgments arrive asynchronously.
      pending_id: pendingId,
      // Echo the targeted child identifier to ease debugging on the consumer
      // side when multiple conversations are active in parallel.
      child_id,
      // Advertise how many messages have been appended to the transcript so the
      // caller can reconcile the expected transcript growth without re-reading
      // the entire history.
      appended: messages.length,
    };

    return {
      content: [{ type: "text", text: j(payload) }],
      structuredContent: payload,
    } satisfies ChildPromptToolResult;

  }

);



// child_push_partial

server.registerTool(

  "child_push_partial",

  { title: "Child push partial", description: "Pousse un fragment de reponse (stream).", inputSchema: ChildPushPartialShape },

  async (input: ChildPushPartialInput) => {

    pruneExpired();



    const { pending_id, delta, done } = input;

    const pending = graphState.getPending(pending_id);

    if (!pending) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "pending_id inconnu" }) }] };



    const child = graphState.getChild(pending.childId);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child introuvable" }) }] };



    const text = String(delta ?? "").trim();
    if (text.length) {
      graphState.appendMessage(child.id, { role: "assistant", content: text, ts: now(), actor: "child" });
    }

    const correlation = resolveChildEventCorrelation(child.id, { child });
    const jobId = correlation.jobId ?? undefined;

    pushEvent({
      kind: "REPLY_PART",
      jobId,
      childId: correlation.childId ?? child.id,
      source: "child",
      payload: { len: text.length },
      correlation,
    });



    if (done) {

      graphState.clearPending(pending_id);

      graphState.patchChild(child.id, { state: "waiting", waitingFor: null, pendingId: null });

      pushEvent({
        kind: "REPLY",
        jobId,
        childId: correlation.childId ?? child.id,
        source: "child",
        payload: { final: true },
        correlation,
      });

    }

    return { content: [{ type: "text", text: j({ ok: true }) }] };

  }

);



// child_push_reply

server.registerTool(

  "child_push_reply",

  { title: "Child push reply", description: "Finalise la reponse pour un pending_id.", inputSchema: ChildPushReplyShape },

  async (input: ChildPushReplyInput) => {

    pruneExpired();



    const { pending_id, content } = input;

    const pending = graphState.getPending(pending_id);

    if (!pending) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "pending_id inconnu" }) }] };



    const child = graphState.getChild(pending.childId);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child introuvable" }) }] };



    graphState.appendMessage(child.id, { role: "assistant", content, ts: now(), actor: "child" });

    graphState.clearPending(pending_id);

    graphState.patchChild(child.id, { state: "waiting", waitingFor: null, pendingId: null });



    const correlation = resolveChildEventCorrelation(child.id, { child });
    const jobId = correlation.jobId ?? undefined;

    pushEvent({
      kind: "REPLY",
      jobId,
      childId: correlation.childId ?? child.id,
      source: "child",
      payload: { length: content.length, final: true },
      correlation,
    });



    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id }) }] };

  }

);



// child_chat

server.registerTool(

  "child_chat",

  { title: "Child chat", description: "Envoie un message orchestrateur->enfant et retourne un pending_id.", inputSchema: ChildChatShape },

  async (input: ChildChatInput) => {

    pruneExpired();



    const { child_id, content, role: requestedRole } = input;
    const role: ChildChatStructuredPayload["role"] = requestedRole ?? "user";

    const child = graphState.getChild(child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };

    if (child.state === "killed") return { isError: true, content: [{ type: "text", text: j({ error: "KILLED", message: "Child termine" }) }] };



    graphState.appendMessage(child_id, { role, content, ts: now(), actor: role === "user" ? "user" : "orchestrator" });

    graphState.patchChild(child_id, { state: "running", waitingFor: "reply" });



    const pendingId = `pending_${randomUUID()}`;

    graphState.setPending(child_id, pendingId, now());



    const correlation = resolveChildEventCorrelation(child_id, { child });
    const jobId = correlation.jobId ?? undefined;

    pushEvent({
      kind: "PROMPT",
      jobId,
      childId: correlation.childId ?? child_id,
      source: "orchestrator",
      payload: { oneShot: true },
      correlation,
    });

    pushEvent({
      kind: "PENDING",
      jobId,
      childId: correlation.childId ?? child_id,
      payload: { pendingId },
      correlation,
    });



    const payload: ChildChatStructuredPayload = {
      // Expose the pending identifier so streaming acknowledgments can reference
      // the correct in-flight reply when the child pushes partial chunks.
      pending_id: pendingId,
      // Echo the child identifier to simplify correlation when operators run
      // multiple conversations in parallel and need to attribute events.
      child_id,
      // Surface the role/content that triggered the prompt so downstream
      // analytics do not need to rehydrate the original request payload.
      role,
      content,
    };

    return {
      content: [{ type: "text", text: j(payload) }],
      structuredContent: payload,
    } satisfies ChildChatToolResult;

  }

);



// child_info

server.registerTool(

  "child_info",

  { title: "Child info", description: "Retourne l etat et les metadonnees d un enfant.", inputSchema: ChildInfoShape },

  async (input: ChildInfoInput) => {

    const child = graphState.getChild(input.child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };



    const info = {

      id: child.id,

      name: child.name,

      state: child.state,

      runtime: child.runtime,

      waiting_for: child.waitingFor,

      pending_id: child.pendingId,

      system: child.systemMessage,

      ttl_at: child.ttlAt,

      transcript_size: child.transcriptSize,

      last_ts: child.lastTs

    };

    return { content: [{ type: "text", text: j(info) }] };

  }

);



// child_transcript

server.registerTool(

  "child_transcript",

  { title: "Child transcript", description: "Retourne une tranche du transcript d un enfant.", inputSchema: ChildTranscriptShape },

  async (input: ChildTranscriptInput) => {

    const child = graphState.getChild(input.child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };



    const slice = graphState.getTranscript(child.id, {

      sinceIndex: input.since_index,

      sinceTs: input.since_ts,

      limit: input.limit,

      reverse: input.reverse

    });



    return { content: [{ type: "text", text: j({ child_id: child.id, total: slice.total, items: slice.items }) }] };

  }

);



// child_rename

server.registerTool(

  "child_rename",

  { title: "Child rename", description: "Renomme un enfant.", inputSchema: ChildRenameShape },

  async (input: ChildRenameInput) => {

    const child = graphState.getChild(input.child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };

    const oldName = child.name;

    graphState.patchChild(child.id, { name: input.name });

    const correlation = resolveChildEventCorrelation(child.id, { child });
    pushEvent({
      kind: "INFO",
      childId: correlation.childId ?? child.id,
      jobId: correlation.jobId ?? undefined,
      payload: { rename: { from: oldName, to: input.name } },
      correlation,
    });

    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id, name: input.name }) }] };

  }

);



// child_reset

server.registerTool(

  "child_reset",

  { title: "Child reset", description: "Reinitialise la session d un enfant.", inputSchema: ChildResetShape },

  async (input: ChildResetInput) => {

    const child = graphState.getChild(input.child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };



    graphState.resetChild(child.id, { keepSystem: !!input.keep_system, timestamp: now() });

    const correlation = resolveChildEventCorrelation(child.id, { child });
    pushEvent({
      kind: "INFO",
      childId: correlation.childId ?? child.id,
      jobId: correlation.jobId ?? undefined,
      payload: { reset: { keep_system: !!input.keep_system } },
      correlation,
    });

    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id }) }] };

  }

);



// status

server.registerTool(

  "status",

  { title: "Status", description: "Snapshot d un job ou liste des jobs.", inputSchema: StatusShape },

  async (input: StatusInput) => {

    pruneExpired();



    const { job_id } = input;

    if (job_id) {

      const job = graphState.getJob(job_id);

      if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };

      const children = graphState.listChildren(job_id).map((child) => ({

        id: child.id,

        name: child.name,

        state: child.state,

        runtime: child.runtime,

        waiting_for: child.waitingFor,

        last_update: child.lastTs ?? child.ttlAt ?? null,

        pending_id: child.pendingId,

        transcript_size: child.transcriptSize

      }));

      const payload = { job_id, state: job.state, children };
      const correlation = resolveJobEventCorrelation(job.id, { job, extraSources: [payload] });

      pushEvent({
        kind: "STATUS",
        jobId: correlation.jobId ?? job.id,
        payload,
        correlation,
      });

      return { content: [{ type: "text", text: j(payload) }] };

    }



    const jobs = graphState.listJobs().map((job) => ({ id: job.id, state: job.state, child_count: job.childIds.length }));

    return { content: [{ type: "text", text: j({ jobs }) }] };

  }

);



// graph_forge_analyze
server.registerTool(
  "graph_forge_analyze",
  { title: "Graph Forge analyze", description: "Compile un script Graph Forge et execute les analyses demandees.", inputSchema: GraphForgeShape },
  async (input: GraphForgeInput) => {
    let cfg: GraphForgeInput;
    try {
      cfg = GraphForgeSchema.parse(input);
    } catch (validationError) {
      return {
        isError: true,
        content: [{ type: "text", text: j({ error: "GRAPH_FORGE_INPUT_INVALID", detail: describeError(validationError) }) }]
      };
    }
    try {
      const mod = await loadGraphForge();
      let resolvedPath: string | undefined;
      let source = cfg.source;
      if (!source && cfg.path) {
        try {
          resolvedPath = resolveWorkspacePath(cfg.path);
        } catch (error) {
          if (error instanceof PathResolutionError) {
            return formatWorkspacePathError(error);
          }
          throw error;
        }

        try {
          source = await readFile(resolvedPath, "utf8");
        } catch (fsError) {
          const info = describeError(fsError);
          throw new Error(`Impossible de lire le fichier Graph Forge \`${resolvedPath}\`: ${info.message}`);
        }
      }
      if (!source) {
        throw new Error("No Graph Forge source provided");
      }

      const compiled = mod.compileSource(source, { entryGraph: cfg.entry_graph });
      const graphSummary = {
        name: compiled.graph.name,
        directives: Array.from(compiled.graph.directives.entries()).map(([key, value]) => ({ name: key, value })),
        nodes: compiled.graph.listNodes().map(node => ({ id: node.id, attributes: node.attributes })),
        edges: compiled.graph.listEdges().map(edge => ({ from: edge.from, to: edge.to, attributes: edge.attributes }))
      };

      const analysisDefinitions = compiled.analyses.map(analysis => ({
        name: analysis.name,
        args: analysis.args.map(arg => arg.value),
        location: { line: analysis.tokenLine, column: analysis.tokenColumn }
      }));

      const tasks: GraphForgeTask[] = [];
      if (cfg.use_defined_analyses ?? true) {
        for (const analysis of compiled.analyses) {
          tasks.push({
            name: analysis.name,
            args: analysis.args.map(arg => toStringArg(arg.value)),
            source: "dsl"
          });
        }
      }
      if (cfg.analyses?.length) {
        for (const req of cfg.analyses) {
          tasks.push({
            name: req.name,
            args: req.args ?? [],
            weightKey: req.weight_key ?? undefined,
            source: "request"
          });
        }
      }

      const analysisReports = tasks.map(task => {
        try {
          const result = runGraphForgeAnalysis(mod, compiled, task, cfg.weight_key);
          return { name: task.name, source: task.source, args: task.args, result };
        } catch (err) {
          return { name: task.name, source: task.source, args: task.args, error: describeError(err) };
        }
      });

      const payload = {
        entry_graph: cfg.entry_graph ?? compiled.graph.name,
        source: {
          path: resolvedPath ?? null,
          provided_inline: Boolean(cfg.source),
          length: source.length
        },
        graph: graphSummary,
        analyses_defined: analysisDefinitions,
        analyses_resolved: analysisReports
      };

      return { content: [{ type: "text", text: j(payload) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: j({ error: "GRAPH_FORGE_FAILED", detail: describeError(err) }) }]
      };
    }
  }
);

// aggregate

server.registerTool(

  "aggregate",

  { title: "Aggregate", description: "Agrege les sorties d un job (concat par defaut).", inputSchema: AggregateShape },

  async (input: AggregateInput) => {

    pruneExpired();



    const { job_id } = input;

    const job = graphState.getJob(job_id);

    if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };

    const strategyRaw = typeof input.strategy === "string" ? input.strategy.trim() : undefined;
    const knownStrategies = new Set(["concat", "json_merge", "vote", "markdown_compact", "jsonl"]);
    let strategy: "concat" | "json_merge" | "vote" | "markdown_compact" | "jsonl" | undefined;
    if (strategyRaw && knownStrategies.has(strategyRaw)) {
      strategy = strategyRaw as "concat" | "json_merge" | "vote" | "markdown_compact" | "jsonl";
    } else {
      strategy = undefined;
    }

    const res = aggregate(job_id, strategy, { includeSystem: input.include_system, includeGoals: input.include_goals });

    graphState.patchJob(job_id, { state: "done" });

    const correlation = resolveJobEventCorrelation(job.id, { job });

    pushEvent({
      kind: "AGGREGATE",
      jobId: correlation.jobId ?? job.id,
      payload: { strategy: strategy ?? "concat", requested: strategyRaw ?? null },
      correlation,
    });



    return { content: [{ type: "text", text: j(res) }] };

  }

);



// kill

server.registerTool(

  "kill",

  { title: "Kill", description: "Termine un child_id ou un job_id.", inputSchema: KillShape },

  async (input: KillInput) => {

    pruneExpired();



    const { child_id, job_id } = input;



    if (child_id) {

      const child = graphState.getChild(child_id);

      if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };

      graphState.clearPendingForChild(child_id);

      graphState.patchChild(child_id, { state: "killed", waitingFor: null, pendingId: null });

      const correlation = resolveChildEventCorrelation(child_id, { child });

      pushEvent({
        kind: "KILL",
        jobId: correlation.jobId ?? undefined,
        childId: correlation.childId ?? child_id,
        level: "warn",
        payload: { scope: "child" },
        correlation,
      });

      return { content: [{ type: "text", text: j({ ok: true, child_id }) }] };

    }



    if (job_id) {

      const job = graphState.getJob(job_id);

      if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };

      for (const child of graphState.listChildren(job_id)) {

        graphState.clearPendingForChild(child.id);

        graphState.patchChild(child.id, { state: "killed", waitingFor: null, pendingId: null });

      }

      graphState.patchJob(job_id, { state: "killed" });
      const correlation = resolveJobEventCorrelation(job_id, { job });

      pushEvent({
        kind: "KILL",
        jobId: correlation.jobId ?? job_id,
        level: "warn",
        payload: { scope: "job" },
        correlation,
      });

      return { content: [{ type: "text", text: j({ ok: true, job_id }) }] };

    }



    return { isError: true, content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "Fournis child_id ou job_id" }) }] };

  }

);



/** JSON-RPC request payload accepted by {@link handleJsonRpc}. */
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

/** Successful or erroneous JSON-RPC response returned by {@link handleJsonRpc}. */
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

/**
 * Context propagated when routing JSON-RPC calls through {@link routeJsonRpcRequest}.
 *
 * The structure purposely mirrors the headers we need to surface when Codex reuses
 * the HTTP transport internally (child sessions, idempotency keys, etc.). Tests
 * currently rely on the headers snapshot to assert FS-Bridge behaviour without
 * requiring a real HTTP stack.
 */
export interface JsonRpcRouteContext {
  /** Optional HTTP-like headers to expose to downstream handlers. */
  headers?: Record<string, string>;
  /** Identifier reused when the upstream caller provided one. */
  requestId?: string | number | null;
  /** Logical transport tag (e.g. "http", "fs") for diagnostics. */
  transport?: string;
  /** Logical child identifier propagated by self-provider orchestration. */
  childId?: string;
  /** Optional limits advertised by the child session. */
  childLimits?: { cpuMs?: number; memMb?: number; wallMs?: number };
  /** Idempotency key supplied by HTTP callers. */
  idempotencyKey?: string;
  /** Number of bytes contained in the JSON-RPC request payload. */
  payloadSizeBytes?: number;
  /** Timeout budget (milliseconds) applied to the JSON-RPC handler. */
  timeoutMs?: number;
  /** Budget tracker attached to the current request lifecycle. */
  budget?: BudgetTracker;
}

/** Signature of the internal request handler registered by the MCP SDK. */
type InternalJsonRpcHandler = (
  request: { jsonrpc: "2.0"; id: string | number | null; method: string; params?: unknown },
  extra: {
    signal: AbortSignal;
    sessionId?: string;
    sendNotification: (notification: unknown) => Promise<void>;
    sendRequest: (req: unknown, schema?: unknown, options?: unknown) => Promise<unknown>;
    authInfo?: unknown;
    requestId: string | number | null;
    requestInfo?: { headers?: Record<string, string> };
  },
) => Promise<unknown> | unknown;

/**
 * Normalises human-friendly method names (e.g. `mcp_info`) into actual MCP
 * requests understood by the underlying SDK. Tools are exposed via
 * `tools/call`, therefore we transparently translate direct tool invocations
 * into the canonical request form.
 */
function normaliseJsonRpcInvocation(method: string, params: unknown): {
  method: string;
  params?: unknown;
} {
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

/**
 * Ensures idempotency-aware tools observe the HTTP header forwarded by the bridge.
 *
 * The helper mirrors the behaviour expected by `child_*`, `tx_*`, and graph tools which
 * all accept an optional `idempotency_key` property. When HTTP clients rely on the
 * dedicated header instead of duplicating the field in the JSON body we transparently
 * inject it here so downstream validation keeps succeeding.
 */
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

/**
 * Delegates the JSON-RPC method to the handler registered on the underlying
 * MCP server. The helper mirrors the transport layer implemented by the SDK
 * so tests and the FS-Bridge can issue requests without going through HTTP.
 */
export async function routeJsonRpcRequest(
  method: string,
  params?: unknown,
  context: JsonRpcRouteContext = {},
): Promise<unknown> {
  const originalMethod = method.trim();
  const internalServer = server.server as unknown as {
    _requestHandlers?: Map<string, InternalJsonRpcHandler>;
  };

  const handlers = internalServer._requestHandlers;
  if (!handlers) {
    throw new Error("JSON-RPC handlers not initialised");
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
  if (timeoutBudget && timeoutBudget > 0) {
    headersSnapshot["x-timeout-ms"] = String(timeoutBudget);
  }

  if (context.idempotencyKey) {
    invocation = {
      method: invocation.method,
      params: injectIdempotencyKey(invocation.method, invocation.params, context.idempotencyKey),
    };
  }

  const extra = {
    signal: abort.signal,
    sessionId: undefined,
    sendNotification: async () => {
      // Notifications are not routed when using the in-process adapter. They are
      // primarily used by streaming transports, therefore we simply swallow them
      // to keep the call fire-and-forget while documenting the limitation.
    },
    sendRequest: async () => {
      throw new Error("Nested requests are not supported via handleJsonRpc");
    },
    requestId,
    requestInfo: Object.keys(headersSnapshot).length > 0 ? { headers: headersSnapshot } : undefined,
  };

  const executeInvocation = () =>
    runWithJsonRpcContext(context, async () => {
      const rawResult = await handler(
        { jsonrpc: "2.0", id: requestId, method: invocation.method, params: invocation.params },
        extra,
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
}

/**
 * Attempts to extract a structured payload from a tool response by leveraging
 * the `structuredContent` field or the canonical JSON blob stored in
 * `content[].text`. The helper keeps backward compatibility with clients that
 * expect the raw MCP response while presenting a friendlier payload to the
 * FS-Bridge and its tests.
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
          // Ignore parse failures and fall back to the raw response.
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Validates and executes a JSON-RPC request using the in-process router. Errors
 * are serialised following the JSON-RPC 2.0 specification so callers receive a
 * deterministic payload whether the failure originates from validation or the
 * underlying handler.
 */
/**
 * Determines whether the incoming JSON-RPC payload targets the `mcp_info`
 * tool either directly or via the canonical `tools/call` indirection.
 *
 * The helper keeps the transport helpers agnostic of how callers choose to
 * address the introspection tool, which allows tests to exercise both code
 * paths while sharing the same response normalisation logic.
 */
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

/**
 * Checks whether the fast-path HTTP transport should hydrate the `mcp_info`
 * response with the latest runtime snapshot. When introspection is disabled we
 * still serve a minimal descriptor so stateless HTTP clients can negotiate the
 * transport before toggling feature flags. Other transports (FS bridge, STDIO)
 * retain the stricter behaviour enforced by {@link ensureMcpIntrospectionEnabled}.
 */
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
      // Structured tool responses mirror the textual JSON while surfacing fields such as
      // `child_id` and `run_id`. Propagate those identifiers into the correlation snapshot so
      // observability logs can attribute results even when callers rely on the richer payload.
      snapshot = mergeCorrelationSnapshots(snapshot, collectCorrelationFromPayload(structured));
    }
  }

  return snapshot;
}

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

function recordJsonRpcObservability(input: JsonRpcObservabilityInput): void {
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
  const payload = {
    msg: `jsonrpc_${input.stage}`,
    method: input.method,
    tool: input.toolName ?? null,
    request_id: input.requestId ?? null,
    transport: input.transport ?? null,
    status: input.status ?? null,
    elapsed_ms:
      typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs)
        ? Math.max(0, Math.round(input.elapsedMs))
        : null,
    trace_id: trace?.traceId ?? null,
    span_id: trace?.spanId ?? null,
    duration_ms: duration !== null ? Math.round(duration) : null,
    bytes_in: bytesIn !== null ? Math.round(bytesIn) : null,
    bytes_out: bytesOut !== null ? Math.round(bytesOut) : null,
    run_id: input.correlation.runId ?? null,
    op_id: input.correlation.opId ?? null,
    child_id: input.correlation.childId ?? null,
    job_id: input.correlation.jobId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    error_message: input.errorMessage ?? null,
    error_code: input.errorCode ?? null,
    timeout_ms:
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.max(0, Math.round(input.timeoutMs))
        : null,
  } as const;

  if (input.stage === "error") {
    registerRpcError(input.errorCode ?? null);
  } else if (input.stage === "response") {
    registerRpcSuccess();
  }

  let envelope: ReturnType<EventBus["publish"]> | undefined;
  try {
    envelope = eventBus.publish({
      cat: "scheduler",
      level: input.stage === "error" ? "error" : "info",
      runId: input.correlation.runId ?? null,
      opId: input.correlation.opId ?? null,
      childId: input.correlation.childId ?? null,
      jobId: input.correlation.jobId ?? null,
      component: "jsonrpc",
      stage: payload.msg,
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

  const seq = envelope?.seq;
  const ts = envelope?.ts;
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
}
/** Configuration describing how to persist a WAL entry for an idempotent mutation. */
interface IdempotentWalConfig {
  /** Logical channel receiving the append-only entry (tx, graph, child, ...). */
  readonly topic: string;
  /** Semantic label stored alongside the payload to ease replay filtering. */
  readonly event: string;
}

/**
 * Lookup table enumerating JSON-RPC methods that must append an invocation to the
 * write-ahead log whenever an idempotent HTTP request is executed. The keys are
 * normalised to lowercase so callers can safely trim/transform method names
 * before querying the table.
 */
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

/** Normalises a method/tool name before probing {@link IDEMPOTENT_MUTATION_WAL_MAP}. */
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

/**
 * Resolves the WAL configuration associated with the provided JSON-RPC
 * invocation. The helper first inspects the logical tool name (when available)
 * and falls back to the raw method, which keeps `tools/call` invocations
 * compatible with the lookup table.
 */
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

/**
 * Best-effort serialisation guard used before persisting JSON-RPC parameters in
 * the WAL. Structured cloning keeps the payload compact while avoiding
 * accidental references to mutable objects shared with the live request.
 */
function serialiseWalPayload(value: unknown): unknown {
  try {
    // Using JSON as an intermediary avoids pulling `structuredClone` into the
    // runtime bundle while still guaranteeing deterministic snapshots.
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { non_serialisable: true, reason };
  }
}

/**
 * Appends an invocation snapshot to the WAL before executing the underlying
 * handler. Failures are logged but never propagated to keep the request flow
 * resilient: observability should not compromise availability.
 */
async function recordIdempotentWalInvocation(
  config: IdempotentWalConfig,
  request: JsonRpcRequest,
  context: JsonRpcRouteContext | undefined,
  toolName: string | null,
): Promise<void> {
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
}

/**
 * Convenience wrapper exposed to transports so they can append WAL entries when
 * the fast-path bypasses {@link handleJsonRpc}. Callers can optionally provide
 * the already normalised method/tool names to avoid duplicate computation.
 */
export async function maybeRecordIdempotentWalEntry(
  request: JsonRpcRequest,
  context: JsonRpcRouteContext | undefined,
  overrides: { method?: string; toolName?: string | null } = {},
): Promise<void> {
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
}


export async function handleJsonRpc(
  req: JsonRpcRequest,
  context?: JsonRpcRouteContext,
): Promise<JsonRpcResponse> {
  const rawId = req?.id ?? null;
  const runtimeContext: JsonRpcRouteContext = context ? { ...context } : {};
  const requestIdHint = runtimeContext.requestId ?? rawId;
  const requestBudget = new BudgetTracker(REQUEST_BUDGET_LIMITS);
  runtimeContext.budget = requestBudget;
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
        transport: runtimeContext?.transport,
        idempotencyKey: runtimeContext?.idempotencyKey ?? null,
        correlation: collectCorrelationFromContext(runtimeContext),
        status: "error",
        errorMessage: error.data?.hint ?? error.message,
        errorCode: error.code,
      });
      return buildJsonRpcErrorResponse(rawId, error);
    }
    throw error;
  }

  const id = sanitizedRequest.id ?? null;
  const request = sanitizedRequest;
  const rawMethod = typeof request.method === "string" ? request.method : "";
  const invocationArgs = extractInvocationArguments(rawMethod, request.params);
  let correlation = mergeCorrelationSnapshots(
    collectCorrelationFromContext(runtimeContext),
    collectCorrelationFromPayload(invocationArgs),
  );
  const transport = runtimeContext?.transport ?? null;
  const childId = runtimeContext?.childId ?? null;
  const payloadBytes = runtimeContext?.payloadSizeBytes ?? 0;
  const timeoutBudget = normaliseTimeoutBudget(
    resolveRpcTimeoutBudget(method, toolName ?? null),
    DEFAULT_RPC_TIMEOUT_OVERRIDE,
  );
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
        return buildJsonRpcErrorResponse(id, budgetError);
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
          {
            actor: "transport",
            operation: method,
            stage: errorSnapshot ? "egress_error" : "egress",
          },
        );
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          const budgetError = createJsonRpcError("BUDGET_EXCEEDED", "Request budget exhausted", {
            requestId: id,
            hint: `response budget exceeded on ${error.dimension}`,
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
            elapsedMs,
            errorMessage: budgetError.data?.hint ?? budgetError.message,
            errorCode: budgetError.code,
            timeoutMs,
          });
          return buildJsonRpcErrorResponse(id, budgetError);
        }
        throw error;
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
          return buildJsonRpcErrorResponse(id, jsonRpcError);
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
}

// --- Transports ---
const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  let options;
  try {
    options = parseOrchestratorRuntimeOptions(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("cli_options_invalid", { message });
    process.exit(1);
  }

  configureRuntimeFeatures(options.features);
  configureRuntimeTimings(options.timings);
  configureChildSafetyLimits(options.safety);
  reflectionEnabled = options.enableReflection;
  qualityGateEnabled = options.enableQualityGate;
  qualityGateThreshold = options.qualityThreshold;

  if (options.logFile) {
    activeLoggerOptions = { ...activeLoggerOptions, logFile: options.logFile };
    logger = instantiateLogger(activeLoggerOptions);
    eventStore.setLogger(logger);
    logger.info("logger_configured", {
      log_file: options.logFile,
      max_size_bytes: activeLoggerOptions.maxFileSizeBytes ?? null,
      max_file_count: activeLoggerOptions.maxFileCount ?? null,
      redacted_tokens: activeLoggerOptions.redactSecrets?.length ?? 0,
      source: "cli",
    });
  }

  eventStore.setMaxHistory(options.maxEventHistory);
  eventBus.setHistoryLimit(options.maxEventHistory);
  updateMcpRuntimeSnapshot({ limits: { maxEventHistory: options.maxEventHistory } });

  let enableStdio = options.enableStdio;
  const httpEnabled = options.http.enabled;

  updateMcpRuntimeSnapshot({
    transports: {
      stdio: { enabled: enableStdio },
      http: {
        enabled: httpEnabled,
        host: httpEnabled ? options.http.host : null,
        port: httpEnabled ? options.http.port : null,
        path: httpEnabled ? options.http.path : null,
        enableJson: options.http.enableJson,
        stateless: options.http.stateless,
      },
    },
  });

  if (!enableStdio && !httpEnabled) {
    logger.error("no_transport_enabled", {});
    process.exit(1);
  }

  const cleanup: Array<() => Promise<void>> = [];

  if (httpEnabled) {
    if (enableStdio) {
      logger.warn("stdio_disabled_due_to_http");
      enableStdio = false;
    }

    let httpExtras: HttpServerExtras = {};
    let httpIdempotencyStore: FileIdempotencyStore | null = null;
    if (options.http.stateless) {
      try {
        const store = await FileIdempotencyStore.create();
        const ttlMs = IDEMPOTENCY_TTL_OVERRIDE ?? 600_000;
        httpIdempotencyStore = store;
        httpExtras = { idempotency: { store, ttlMs } };
        logger.info("http_idempotency_store_ready", {
          directory: resolveIdempotencyDirectory(),
          ttl_ms: ttlMs,
        });
      } catch (error) {
        logger.error("http_idempotency_store_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    httpExtras = {
      ...httpExtras,
      readiness: {
        check: async (): Promise<HttpReadinessReport> => {
          const components: HttpReadinessReport["components"] = {
            graphForge: { ok: true, message: "module loaded" },
            idempotency: httpIdempotencyStore
              ? { ok: true, message: "store available" }
              : { ok: true, message: "idempotency disabled" },
            eventQueue: { ok: true, usage: eventStore.getEventCount(), capacity: eventStore.getMaxHistory() },
          };
          let ok = true;

          try {
            await loadGraphForge();
          } catch (error) {
            ok = false;
            components.graphForge = {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            };
          }

          if (httpIdempotencyStore?.checkHealth) {
            try {
              await httpIdempotencyStore.checkHealth();
            } catch (error) {
              ok = false;
              components.idempotency = {
                ok: false,
                message: error instanceof Error ? error.message : String(error),
              };
            }
          }

          const capacity = Math.max(1, eventStore.getMaxHistory());
          const usage = eventStore.getEventCount();
          const threshold = Math.ceil(capacity * 0.9);
          const queueHealthy = usage < threshold;
          components.eventQueue = { ok: queueHealthy, usage, capacity };
          if (!queueHealthy) {
            ok = false;
          }

          return { ok, components };
        },
      },
    };

    try {
      const handle = await startHttpServer(server, options.http, logger, httpExtras);
      cleanup.push(handle.close);
    } catch (error) {
      logger.error("http_start_failed", { message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  }

  // Start the monitoring dashboard when operators enabled it via CLI. The
  // server shares the orchestrator in-memory state so the cleanup hook mirrors
  // the HTTP transport lifecycle.
  if (options.dashboard.enabled) {
    try {
      const handle = await startDashboardServer({
        host: options.dashboard.host,
        port: options.dashboard.port,
        streamIntervalMs: options.dashboard.streamIntervalMs,
        graphState,
        supervisor: childSupervisor,
        eventStore,
        stigmergy,
        btStatusRegistry,
        supervisorAgent: orchestratorSupervisor,
        logger,
        contractNetWatcherTelemetry,
      });
      cleanup.push(handle.close);
    } catch (error) {
      logger.error("dashboard_start_failed", { message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  }

  if (enableStdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("stdio_listening");
  }

  logger.info("runtime_started", {
    stdio: enableStdio,
    http: httpEnabled,
    max_event_history: eventStore.getMaxHistory()
  });

  process.on("SIGINT", async () => {
    logger.warn("shutdown_signal", { signal: "SIGINT" });
    for (const closer of cleanup) {
      try {
        await closer();
      } catch (error) {
        logger.error("transport_close_failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }
    process.exit(0);
  });
}

/**
 * Expose the shared Contract-Net coordinator for integration tests that
 * manipulate agents and calls while exercising the MCP interface end to end.
 * Tests rely on this handle to cleanly seed and restore coordinator state
 * without reaching into private supervisor internals.
 */
export {
  server,
  graphState,
  childSupervisor,
  resources,
  logJournal,
  DEFAULT_CHILD_RUNTIME,
  buildLiveEvents,
  setDefaultChildRuntime,
  GraphSubgraphExtractInputSchema,
  GraphSubgraphExtractInputShape,
  emitHeartbeatTick,
  startHeartbeat,
  stopHeartbeat,
  contractNet,
  snapshotKnowledgeGraph,
  restoreKnowledgeGraph,
  snapshotValueGraphConfiguration,
  restoreValueGraphConfiguration,
};

/**
 * Helper returning the latest lifecycle snapshot associated with the provided run identifier.
 * The lookup is guarded by the feature toggle so cancellation tools can call the helper without
 * duplicating defensive checks or log plumbing in every handler.
 */
function tryGetPlanLifecycleSnapshot(
  runId: string,
  logger: StructuredLogger,
  logEvent: string,
): PlanLifecycleSnapshot | null {
  if (!runtimeFeatures.enablePlanLifecycle) {
    return null;
  }
  try {
    return planLifecycle.getSnapshot(runId);
  } catch (error) {
    if (error instanceof PlanRunNotFoundError) {
      return null;
    }
    logger.warn(logEvent, {
      run_id: runId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
