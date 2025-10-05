import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve as resolvePath, dirname as pathDirname, basename as pathBasename } from "node:path";
import { pathToFileURL } from "url";
import { GraphState, type ChildSnapshot, type JobSnapshot } from "./graphState.js";
import { GraphTransactionManager, GraphTransactionError, GraphVersionConflictError } from "./graph/tx.js";
import { GraphLockManager } from "./graph/locks.js";
import { LoggerOptions, StructuredLogger, type LogEntry } from "./logger.js";
import { EventStore, OrchestratorEvent } from "./eventStore.js";
import { EventBus, type EventLevel as BusEventLevel } from "./events/bus.js";
import {
  buildChildCorrelationHints,
  buildJobCorrelationHints,
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
import { startHttpServer } from "./httpServer.js";
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
import { ChildRecordSnapshot, UnknownChildError } from "./state/childrenIndex.js";
import { ChildCollectedOutputs, ChildRuntimeStatus } from "./childRuntime.js";
import { Autoscaler } from "./agents/autoscaler.js";
import { OrchestratorSupervisor, inferSupervisorIncidentCorrelation } from "./agents/supervisor.js";
import { MetaCritic, ReviewKind, ReviewResult } from "./agents/metaCritic.js";
import { reflect, ReflectionResult } from "./agents/selfReflect.js";
import { scoreCode, scorePlan, scoreText, ScoreCodeInput, ScorePlanInput, ScoreTextInput } from "./quality/scoring.js";
import { SharedMemoryStore } from "./memory/store.js";
import { selectMemoryContext } from "./memory/attention.js";
import { LoopDetector } from "./guard/loopDetector.js";
import { BlackboardStore } from "./coord/blackboard.js";
import { ContractNetCoordinator } from "./coord/contractNet.js";
import { ContractNetWatcherTelemetryRecorder, watchContractNetPheromoneBounds } from "./coord/contractNetWatchers.js";
import { StigmergyField } from "./coord/stigmergy.js";
import { KnowledgeGraph } from "./knowledge/knowledgeGraph.js";
import { CausalMemory } from "./knowledge/causalMemory.js";
import { ValueGraph } from "./values/valueGraph.js";
import type { ValueFilterDecision } from "./values/valueGraph.js";
import { ResourceRegistry, ResourceRegistryError } from "./resources/registry.js";
import { renderResourceWatchSseMessages, serialiseResourceWatchResultForSse } from "./resources/sse.js";
import { IdempotencyRegistry } from "./infra/idempotency.js";
import { PlanLifecycleRegistry, PlanRunNotFoundError } from "./executor/planLifecycle.js";
import type { PlanLifecycleSnapshot } from "./executor/planLifecycle.js";
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
  PlanFanoutInputSchema,
  PlanFanoutInputShape,
  PlanJoinInputSchema,
  PlanJoinInputShape,
  PlanCompileBTInputSchema,
  PlanCompileBTInputShape,
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
  handlePlanCompileBT,
  handlePlanRunBT,
  handlePlanRunReactive,
  handlePlanReduce,
  handlePlanDryRun,
  handlePlanStatus,
  handlePlanPause,
  handlePlanResume,
  ValueGuardRejectionError,
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
  KnowledgeToolContext,
  handleKgExport,
  handleKgInsert,
  handleKgQuery,
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
  SUBGRAPH_REGISTRY_KEY,
  collectMissingSubgraphDescriptors,
  collectSubgraphReferences,
} from "./graph/subgraphRegistry.js";
import { extractSubgraphToFile } from "./graph/subgraphExtract.js";
import {
  getMcpCapabilities,
  getMcpInfo,
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
/** Registry replaying cached results for idempotent operations. */
const idempotencyRegistry = new IdempotencyRegistry();
/** Shared knowledge graph storing reusable plan patterns. */
const knowledgeGraph = new KnowledgeGraph();
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
};

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
  runtimeTimings = { ...next };
  updateMcpRuntimeSnapshot({ timings: runtimeTimings });
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
  const runId = extractRunId(payload);
  const opId = extractOpId(payload);
  const graphId = extractGraphId(payload);
  const nodeId = extractNodeId(payload);
  const childId = extractChildId(payload);
  const jobId = extractJobId(payload);

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

const defaultChildCommand = process.env.MCP_CHILD_COMMAND ?? process.execPath;
const defaultChildArgs = parseDefaultChildArgs(process.env.MCP_CHILD_ARGS);

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

function getCausalToolContext(): CausalToolContext {
  return { causalMemory, logger };
}

function getValueToolContext(): ValueToolContext {
  return { valueGraph, logger };
}

class CancellationFeatureDisabledError extends Error {
  public readonly code = "E-CANCEL-DISABLED";
  public readonly hint = "enable_cancellation";

  constructor() {
    super("cancellation feature disabled");
    this.name = "CancellationFeatureDisabledError";
  }
}

interface NormalisedToolError {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

function normaliseToolError(
  error: unknown,
  defaultCode: string,
): NormalisedToolError {
  const message = error instanceof Error ? error.message : String(error);
  let code = defaultCode;
  let hint: string | undefined;
  let details: unknown;

  if (error instanceof z.ZodError) {
    code = defaultCode;
    hint = "invalid_input";
    details = { issues: error.issues };
  } else if (typeof (error as { code?: unknown }).code === "string") {
    code = (error as { code: string }).code;
    if (typeof (error as { hint?: unknown }).hint === "string") {
      hint = (error as { hint: string }).hint;
    }
    if (Object.prototype.hasOwnProperty.call(error as object, "details")) {
      details = (error as { details?: unknown }).details;
    }
  } else if (Object.prototype.hasOwnProperty.call(error as object, "details")) {
    details = (error as { details?: unknown }).details;
  }

  return { code, message, hint, details };
}

function childToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  const defaultCode = error instanceof UnknownChildError ? "NOT_FOUND" : "CHILD_TOOL_ERROR";
  const normalised = normaliseToolError(error, defaultCode);
  logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
}

function planToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  defaultCode = "PLAN_TOOL_ERROR",
) {
  const normalised = normaliseToolError(error, defaultCode);
  logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
}

function graphToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  defaultCode = "GRAPH_TOOL_ERROR",
) {
  const normalised = normaliseToolError(error, defaultCode);
  logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
}

function transactionToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  const normalised = normaliseToolError(error, "E-TX-UNEXPECTED");
  logger.error(`${toolName}_failed`, {
    ...context,
    message: normalised.message,
    code: normalised.code,
    details: normalised.details,
  });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
}

function coordinationToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  defaultCode = "COORD_TOOL_ERROR",
) {
  const normalised = normaliseToolError(error, defaultCode);
  logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
}

function knowledgeToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  defaultCode = "KNOWLEDGE_TOOL_ERROR",
) {
  const normalised = normaliseToolError(error, defaultCode);
  logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
}

function causalToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  defaultCode = "CAUSAL_TOOL_ERROR",
) {
  const normalised = normaliseToolError(error, defaultCode);
  logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
}

function valueToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
  defaultCode = "VALUE_TOOL_ERROR",
) {
  const normalised = normaliseToolError(error, defaultCode);
  logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
}

function resourceToolError(
  toolName: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  const normalised =
    error instanceof ResourceRegistryError
      ? {
          code: error.code,
          message: error.message,
          hint: error.hint,
          details: error.details,
        }
      : normaliseToolError(error, "E-RES-UNEXPECTED");
  logger.error(`${toolName}_failed`, {
    ...context,
    message: normalised.message,
    code: normalised.code,
    details: normalised.details,
  });
  const payload: Record<string, unknown> = {
    error: normalised.code,
    tool: toolName,
    message: normalised.message,
  };
  if (normalised.hint) {
    payload.hint = normalised.hint;
  }
  if (normalised.details !== undefined) {
    payload.details = normalised.details;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: j(payload) }],
  };
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

// ---------------------------
// Utils
// ---------------------------

const now = () => Date.now();
const j = (o: unknown) => JSON.stringify(o, null, 2);

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

function deriveEventMessage(kind: string, payload: unknown): string {
  const msg = extractStringProperty(payload, "msg");
  if (msg) {
    return msg;
  }
  return kind.toLowerCase();
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
const ResourceWatchInputSchema = z
  .object({
    uri: z.string().min(1),
    from_seq: z.number().int().min(0).optional(),
    limit: z.number().int().positive().max(500).optional(),
    format: z.enum(["json", "sse"]).optional(),
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

const LogsTailInputSchema = z
  .object({
    stream: z.enum(["server", "run", "child"]).default("server"),
    id: z.string().trim().min(1).optional(),
    from_seq: z.number().int().min(0).optional(),
    limit: z.number().int().positive().max(500).optional(),
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
  })
  .strict();

const GraphSubgraphExtractInputShape = GraphSubgraphExtractInputSchema.shape;

type GraphSubgraphExtractInput = z.infer<typeof GraphSubgraphExtractInputSchema>;

function pushEvent(
  event: Omit<OrchestratorEvent, "seq" | "ts" | "source" | "level"> &
    Partial<Pick<OrchestratorEvent, "source" | "level">> & { correlation?: EventCorrelationHints | null }
): OrchestratorEvent {
  const emitted = eventStore.emit({
    kind: event.kind,
    level: event.level,
    source: event.source,
    jobId: event.jobId,
    childId: event.childId,
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

  eventBus.publish({
    cat: event.kind,
    level: (event.level ?? emitted.level) as BusEventLevel,
    jobId,
    runId,
    opId,
    graphId,
    nodeId,
    childId,
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
    return {
      seq: evt.seq,
      ts: evt.ts,
      kind: evt.cat.toUpperCase(),
      level: evt.level,
      jobId: evt.jobId ?? null,
      childId,
      runId: evt.runId ?? null,
      opId: evt.opId ?? null,
      msg: evt.msg,
      payload: evt.data,
      vscode_deeplink: deepLink,
      vscode_command: commandUri,
    };
  });
}

// Heartbeat
let HEARTBEAT_TIMER: NodeJS.Timeout | null = null;

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
  HEARTBEAT_TIMER = setInterval(() => {
    emitHeartbeatTick();
  }, 2000);
}

/** Stop the heartbeat interval to avoid leaking timers when shutting down tests or transports. */
function stopHeartbeat(): void {
  if (!HEARTBEAT_TIMER) {
    return;
  }
  clearInterval(HEARTBEAT_TIMER);
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
  server: { name: SERVER_NAME, version: SERVER_VERSION, mcpVersion: MCP_PROTOCOL_VERSION },
});

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

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
    const capabilities = getMcpCapabilities();
    return { content: [{ type: "text", text: j({ format: "json", capabilities }) }] };
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
      return resourceToolError("resources_list", error, { prefix });
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
      const result = resources.read(parsed.uri);
      return {
        content: [{ type: "text" as const, text: j({ tool: "resources_read", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      const uri =
        input && typeof input === "object" && input !== null
          ? (input as Record<string, unknown>).uri ?? null
          : null;
      return resourceToolError("resources_read", error, { uri });
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
      });
      const format = parsed.format ?? "json";
      const baseStructured = {
        uri: result.uri,
        kind: result.kind,
        events: result.events,
        next_seq: result.nextSeq,
        format,
      } as const;

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
      return resourceToolError("resources_watch", error, { uri });
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
      const catsRaw = parsed.cats?.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0);
      const cats = catsRaw && catsRaw.length > 0 ? catsRaw : undefined;
      const filter = {
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
      const serialised = events.map((evt) => ({
        seq: evt.seq,
        ts: evt.ts,
        cat: evt.cat,
        kind: evt.cat.toUpperCase(),
        level: evt.level,
        job_id: evt.jobId ?? null,
        run_id: evt.runId ?? null,
        op_id: evt.opId ?? null,
        graph_id: evt.graphId ?? null,
        node_id: evt.nodeId ?? null,
        child_id: evt.childId ?? null,
        msg: evt.msg,
        data: evt.data ?? null,
      }));
      const format = parsed.format ?? "jsonlines";
      const stream =
        format === "sse"
          ? serialised
              .map((evt) => [`id: ${evt.seq}`, `event: ${evt.cat}`, `data: ${serialiseForSse(evt)}`, ``].join("\n"))
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
      const result = logJournal.tail({
        stream,
        bucketId: targetBucket,
        fromSeq: parsed.from_seq,
        limit: parsed.limit,
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
        const cwd = process.cwd();
        const absolute = resolvePath(cwd, parsed.path);
        if (!absolute.toLowerCase().startsWith(cwd.toLowerCase())) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }),
              },
            ],
          };
        }
        await mkdir(pathDirname(absolute), { recursive: true });
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
      return graphToolError("graph_export", error);
    }
  }
);

// graph_state_save
server.registerTool(
  "graph_state_save",
  { title: "Graph save", description: "Sauvegarde l'etat graphe dans un fichier JSON.", inputSchema: GraphSaveShape },
  async (input: GraphSaveInput) => {
    const cwd = process.cwd();
    const abs = resolvePath(cwd, input.path);
    if (!abs.toLowerCase().startsWith(cwd.toLowerCase())) {
      return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
    }
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
    const cwd = process.cwd();
    const abs = resolvePath(cwd, input.path);
    if (!abs.toLowerCase().startsWith(cwd.toLowerCase())) {
      return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
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
let AUTOSAVE_TIMER: NodeJS.Timeout | null = null;
let AUTOSAVE_PATH: string | null = null;
server.registerTool(
  "graph_state_autosave",
  { title: "Graph autosave", description: "Demarre/arrete la sauvegarde periodique du graphe.", inputSchema: { action: z.enum(["start", "stop"]), path: z.string().optional(), interval_ms: z.number().optional() } },
  async (input: { action: "start" | "stop"; path?: string; interval_ms?: number }) => {
    if (input.action === "stop") {
      if (AUTOSAVE_TIMER) clearInterval(AUTOSAVE_TIMER);
      AUTOSAVE_TIMER = null;
      AUTOSAVE_PATH = null;
      return { content: [{ type: "text", text: j({ format: "json", ok: true, status: "stopped" }) }] };
    }
    const cwd = process.cwd();
    const p = input.path ? resolvePath(cwd, input.path) : resolvePath(cwd, "graph-autosave.json");
    if (!p.toLowerCase().startsWith(cwd.toLowerCase())) {
      return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
    }
    const interval = Math.min(Math.max(input.interval_ms ?? 5000, 1000), 600000);
    if (AUTOSAVE_TIMER) clearInterval(AUTOSAVE_TIMER);
    AUTOSAVE_PATH = p;
    AUTOSAVE_TIMER = setInterval(async () => {
      try {
        const snap = graphState.serialize();
        const metadata = {
          saved_at: new Date().toISOString(),
          inactivity_threshold_ms: lastInactivityThresholdMs,
          event_history_limit: eventStore.getMaxHistory()
        };
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
            path: p,
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
      logger.info("graph_generate_requested", {
        preset: parsed.preset ?? null,
        has_tasks: parsed.tasks !== undefined,
      });
      const result = handleGraphGenerate(parsed, {
        knowledgeGraph: runtimeFeatures.enableKnowledge ? knowledgeGraph : undefined,
        knowledgeEnabled: runtimeFeatures.enableKnowledge,
      });
      const summary = summariseSubgraphUsage(result.graph);
      if (summary.references.length > 0) {
        logger.info("graph_generate_subgraphs_detected", {
          references: summary.references.length,
          missing: summary.missing.length,
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
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_generate", result: enriched }) }],
        structuredContent: enriched,
      };
    } catch (error) {
      return graphToolError("graph_generate", error);
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
      logger.info("graph_mutate_requested", {
        operations: parsed.operations.length,
        graph_id: graphIdForError,
        version: graphVersionForError,
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
          });
        }
        if (summary.missing.length > 0) {
          logger.warn("graph_mutate_missing_subgraphs", {
            missing: summary.missing,
            graph_id: committed.graphId,
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
        return graphToolError("graph_mutate", error, {
          graph_id: graphIdForError,
          version: graphVersionForError,
        });
      }
      return graphToolError("graph_mutate", error, {
        graph_id: graphIdForError,
        version: graphVersionForError ?? undefined,
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
    pruneExpired();
    let graphIdForError: string | null = null;
    try {
      const parsed = GraphBatchMutateInputSchema.parse(input);
      graphIdForError = parsed.graph_id;
      logger.info("graph_batch_mutate_requested", {
        graph_id: parsed.graph_id,
        operations: parsed.operations.length,
        expected_version: parsed.expected_version ?? null,
        owner: parsed.owner ?? null,
        note: parsed.note ?? null,
        idempotency_key: parsed.idempotency_key ?? null,
      });

      const result = await handleGraphBatchMutate(getGraphBatchToolContext(), parsed);
      const logPayload = {
        graph_id: result.graph_id,
        base_version: result.base_version,
        committed_version: result.committed_version,
        committed_at: result.committed_at,
        changed: result.changed,
        operations: parsed.operations.length,
        idempotent: result.idempotent,
        idempotency_key: result.idempotency_key,
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
        return graphToolError("graph_batch_mutate", error, { graph_id: graphIdForError });
      }
      if (error instanceof GraphTransactionError) {
        return graphToolError("graph_batch_mutate", error, { graph_id: graphIdForError });
      }
      return graphToolError("graph_batch_mutate", error, {
        graph_id: graphIdForError ?? undefined,
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
      logger.info("graph_diff_requested", {
        graph_id: parsed.graph_id,
        from: describeSelectorForLog(parsed.from),
        to: describeSelectorForLog(parsed.to),
      });
      const result = handleGraphDiff(getGraphDiffToolContext(), parsed);
      logger.info("graph_diff_succeeded", {
        graph_id: result.graph_id,
        changed: result.changed,
        operations: result.operations.length,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_diff", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_diff", error);
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
      logger.info("graph_patch_requested", {
        graph_id: parsed.graph_id,
        operations: parsed.patch.length,
        base_version: parsed.base_version ?? null,
        enforce_invariants: parsed.enforce_invariants,
      });
      const result = handleGraphPatch(getGraphDiffToolContext(), parsed);
      logger.info("graph_patch_succeeded", {
        graph_id: result.graph_id,
        committed_version: result.committed_version,
        changed: result.changed,
        operations: result.operations_applied,
        invariants_ok: result.invariants ? result.invariants.ok : true,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_patch", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_patch", error, {
        graph_id: graphIdForError,
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
    try {
      const parsed = GraphLockInputSchema.parse(input);
      logger.info("graph_lock_requested", {
        graph_id: parsed.graph_id,
        holder: parsed.holder,
        ttl_ms: parsed.ttl_ms ?? null,
      });
      const result = handleGraphLock(getGraphLockToolContext(), parsed);
      logger.info("graph_lock_acquired", {
        graph_id: result.graph_id,
        holder: result.holder,
        lock_id: result.lock_id,
        expires_at: result.expires_at ?? null,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_lock", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_lock", error);
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
    let lockIdForError: string | undefined;
    try {
      const parsed = GraphUnlockInputSchema.parse(input);
      lockIdForError = parsed.lock_id;
      logger.info("graph_unlock_requested", {
        lock_id: parsed.lock_id,
      });
      const result = handleGraphUnlock(getGraphLockToolContext(), parsed);
      logger.info("graph_unlock_succeeded", {
        lock_id: result.lock_id,
        graph_id: result.graph_id,
        expired: result.expired,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_unlock", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_unlock", error, { lock_id: lockIdForError });
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
      logger.info("graph_subgraph_extract_requested", {
        node_id: parsed.node_id,
        run_id: parsed.run_id,
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
      return graphToolError("graph_subgraph_extract", error, {
        node_id: parsed?.node_id,
        run_id: parsed?.run_id,
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
      logger.info("graph_hyper_export_requested", {
        graph_id: parsed.id,
        nodes: parsed.nodes.length,
        hyper_edges: parsed.hyper_edges.length,
      });
      const result = handleGraphHyperExport(parsed);
      logger.info("graph_hyper_export_succeeded", {
        graph_id: result.graph.graph_id,
        nodes: result.stats.nodes,
        edges: result.stats.edges,
        hyper_edges: result.stats.hyper_edges,
      });
      return {
        content: [
          { type: "text" as const, text: j({ tool: "graph_hyper_export", result }) },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_hyper_export", error);
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
      return {
        content: [{ type: "text" as const, text: j({ tool: "kg_insert", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return knowledgeToolError("kg_insert", error);
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
      return knowledgeToolError("kg_query", error);
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
      return knowledgeToolError("kg_export", error);
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
      return valueToolError("values_set", error);
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
      return valueToolError("values_score", error);
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
      return valueToolError("values_filter", error);
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
      return valueToolError("values_explain", error);
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
      return causalToolError("causal_export", error);
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
      return causalToolError("causal_explain", error, parsed ? { outcome_id: parsed.outcome_id } : {});
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
      logger.info("graph_rewrite_apply_requested", {
        mode: parsed.mode,
        graph_id: graphIdForError,
        version: graphVersionForError,
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
          });
        }
        if (summary.missing.length > 0) {
          logger.warn("graph_rewrite_apply_missing_subgraphs", {
            graph_id: committed.graphId,
            missing: summary.missing,
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
        return graphToolError("graph_rewrite_apply", error, {
          graph_id: graphIdForError ?? undefined,
          version: graphVersionForError ?? undefined,
          mode: parsed?.mode,
        });
      }
      return graphToolError("graph_rewrite_apply", error, {
        graph_id: graphIdForError ?? undefined,
        version: graphVersionForError ?? undefined,
        mode: parsed?.mode,
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
    try {
      const parsed = TxBeginInputSchema.parse(input ?? {});
      graphIdForError = parsed.graph_id;
      logger.info("tx_begin_requested", {
        graph_id: parsed.graph_id,
        expected_version: parsed.expected_version ?? null,
        owner: parsed.owner ?? null,
        ttl_ms: parsed.ttl_ms ?? null,
        idempotency_key: parsed.idempotency_key ?? null,
      });
      const result = handleTxBegin(getTxToolContext(), parsed);
      if (result.idempotent) {
        logger.info("tx_begin_replayed", {
          graph_id: result.graph_id,
          tx_id: result.tx_id,
          base_version: result.base_version,
          owner: result.owner,
          expires_at: result.expires_at,
          idempotency_key: result.idempotency_key,
        });
      } else {
        logger.info("tx_begin_opened", {
          graph_id: result.graph_id,
          tx_id: result.tx_id,
          base_version: result.base_version,
          owner: result.owner,
          expires_at: result.expires_at,
          idempotency_key: result.idempotency_key,
        });
      }
      return {
        content: [{ type: "text" as const, text: j({ tool: "tx_begin", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return transactionToolError("tx_begin", error, { graph_id: graphIdForError ?? undefined });
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
    try {
      const parsed = TxApplyInputSchema.parse(input);
      txIdForError = parsed.tx_id;
      logger.info("tx_apply_requested", {
        tx_id: parsed.tx_id,
        operations: parsed.operations.length,
      });
      const result = handleTxApply(getTxToolContext(), parsed);
      logger.info("tx_apply_mutated", {
        tx_id: result.tx_id,
        graph_id: result.graph_id,
        base_version: result.base_version,
        preview_version: result.preview_version,
        changed: result.changed,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "tx_apply", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return transactionToolError("tx_apply", error, { tx_id: txIdForError ?? undefined });
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
    try {
      const parsed = TxCommitInputSchema.parse(input);
      txIdForError = parsed.tx_id;
      logger.info("tx_commit_requested", { tx_id: parsed.tx_id });
      const result = handleTxCommit(getTxToolContext(), parsed);
      logger.info("tx_commit_succeeded", {
        tx_id: result.tx_id,
        graph_id: result.graph_id,
        version: result.version,
        committed_at: result.committed_at,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "tx_commit", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return transactionToolError("tx_commit", error, { tx_id: txIdForError ?? undefined });
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
    try {
      const parsed = TxRollbackInputSchema.parse(input);
      txIdForError = parsed.tx_id;
      logger.info("tx_rollback_requested", { tx_id: parsed.tx_id });
      const result = handleTxRollback(getTxToolContext(), parsed);
      logger.info("tx_rollback_succeeded", {
        tx_id: result.tx_id,
        graph_id: result.graph_id,
        version: result.version,
        rolled_back_at: result.rolled_back_at,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "tx_rollback", result }) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return transactionToolError("tx_rollback", error, { tx_id: txIdForError ?? undefined });
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
      logger.info("graph_validate_requested", {
        strict_weights: parsed.strict_weights ?? false,
        cycle_limit: parsed.cycle_limit,
      });
      const result = handleGraphValidate(parsed);
      logger.info("graph_validate_completed", {
        ok: result.ok,
        errors: result.errors.length,
        warnings: result.warnings.length,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_validate", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_validate", error);
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
      logger.info("graph_summarize_requested", {
        include_centrality: parsed.include_centrality,
      });
      const result = handleGraphSummarize(parsed);
      logger.info("graph_summarize_succeeded", {
        nodes: result.metrics.node_count,
        edges: result.metrics.edge_count,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_summarize", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_summarize", error);
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
      logger.info("graph_paths_k_shortest_requested", {
        from: parsed.from,
        to: parsed.to,
        k: parsed.k,
        weight_attribute: parsed.weight_attribute,
        max_deviation: parsed.max_deviation ?? null,
      });
      const result = handleGraphPathsKShortest(parsed);
      logger.info("graph_paths_k_shortest_succeeded", {
        returned_k: result.returned_k,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_paths_k_shortest", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_paths_k_shortest", error);
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
    try {
      const parsed = GraphPathsConstrainedInputSchema.parse(input);
      logger.info("graph_paths_constrained_requested", {
        from: parsed.from,
        to: parsed.to,
        avoid_nodes: parsed.avoid_nodes.length,
        avoid_edges: parsed.avoid_edges.length,
        max_cost: parsed.max_cost ?? null,
      });
      const result = handleGraphPathsConstrained(parsed);
      logger.info("graph_paths_constrained_completed", {
        status: result.status,
        reason: result.reason,
        cost: result.cost,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_paths_constrained", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_paths_constrained", error);
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
    try {
      const parsed = GraphCentralityBetweennessInputSchema.parse(input);
      logger.info("graph_centrality_betweenness_requested", {
        weighted: parsed.weighted,
        normalise: parsed.normalise,
        top_k: parsed.top_k,
      });
      const result = handleGraphCentralityBetweenness(parsed);
      logger.info("graph_centrality_betweenness_succeeded", {
        top_count: result.top.length,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_centrality_betweenness", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_centrality_betweenness", error);
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
    try {
      const parsed = GraphPartitionInputSchema.parse(input);
      logger.info("graph_partition_requested", {
        k: parsed.k,
        objective: parsed.objective,
        seed: parsed.seed ?? null,
      });
      const result = handleGraphPartition(parsed);
      logger.info("graph_partition_succeeded", {
        partition_count: result.partition_count,
        cut_edges: result.cut_edges,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_partition", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_partition", error);
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
    try {
      const parsed = GraphCriticalPathInputSchema.parse(input);
      logger.info("graph_critical_path_requested", {
        duration_attribute: parsed.duration_attribute,
        fallback_duration_attribute: parsed.fallback_duration_attribute ?? null,
      });
      const result = handleGraphCriticalPath(parsed);
      logger.info("graph_critical_path_succeeded", {
        duration: result.duration,
        path_length: result.critical_path.length,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_critical_path", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_critical_path", error);
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
    try {
      const parsed = GraphSimulateInputSchema.parse(input);
      logger.info("graph_simulate_requested", {
        parallelism: parsed.parallelism,
        duration_attribute: parsed.duration_attribute,
      });
      const result = handleGraphSimulate(parsed);
      logger.info("graph_simulate_succeeded", {
        makespan: result.metrics.makespan,
        queue_events: result.metrics.queue_events,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_simulate", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_simulate", error);
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
    try {
      const parsed = GraphOptimizeInputSchema.parse(input);
      logger.info("graph_optimize_requested", {
        parallelism: parsed.parallelism,
        max_parallelism: parsed.max_parallelism,
        explore_count: parsed.explore_parallelism?.length ?? 0,
      });
      const result = handleGraphOptimize(parsed);
      const bestMakespan = result.projections.reduce(
        (acc, projection) => Math.min(acc, projection.makespan),
        Number.POSITIVE_INFINITY,
      );
      logger.info("graph_optimize_completed", {
        suggestions: result.suggestions.length,
        best_makespan: Number.isFinite(bestMakespan) ? bestMakespan : null,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_optimize", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_optimize", error);
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
    try {
      const parsed = GraphOptimizeMooInputSchema.parse(input);
      logger.info("graph_optimize_moo_requested", {
        candidates: parsed.parallelism_candidates.length,
        objectives: parsed.objectives.length,
      });
      const result = handleGraphOptimizeMoo(parsed);
      logger.info("graph_optimize_moo_completed", {
        pareto_count: result.pareto_front.length,
        scalarized: result.scalarization ? true : false,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_optimize_moo", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_optimize_moo", error);
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
    try {
      const parsed = GraphCausalAnalyzeInputSchema.parse(input);
      logger.info("graph_causal_analyze_requested", {
        max_cycles: parsed.max_cycles,
        compute_min_cut: parsed.compute_min_cut,
      });
      const result = handleGraphCausalAnalyze(parsed);
      logger.info("graph_causal_analyze_completed", {
        acyclic: result.acyclic,
        cycles: result.cycles.length,
        min_cut_size: result.min_cut?.size ?? null,
      });
      return {
        content: [{ type: "text" as const, text: j({ tool: "graph_causal_analyze", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return graphToolError("graph_causal_analyze", error);
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
      return planToolError("plan_fanout", error);
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
      return planToolError("plan_join", error);
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
      return planToolError("plan_reduce", error);
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
      return planToolError("plan_compile_bt", error, {}, "E-BT-INVALID");
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
      return planToolError("plan_run_bt", error, {}, "E-BT-INVALID");
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
      return planToolError("plan_run_reactive", error, {}, "E-BT-INVALID");
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
      return planToolError("plan_dry_run", error, {}, "E-PLAN-DRY-RUN");
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
      return planToolError("plan_status", error, {}, "E-PLAN-STATUS");
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
      return planToolError("plan_pause", error, {}, "E-PLAN-PAUSE");
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
      return planToolError("plan_resume", error, {}, "E-PLAN-RESUME");
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
      return planToolError("op_cancel", error, {}, "E-CANCEL-OP");
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
      return planToolError("plan_cancel", error, {}, "E-CANCEL-PLAN");
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
    try {
      pruneExpired();
      const parsed = BbBatchSetInputSchema.parse(input);
      const result = handleBbBatchSet(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "bb_batch_set", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError("bb_batch_set", error);
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
      return coordinationToolError("bb_set", error);
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
      return coordinationToolError("bb_get", error);
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
      return coordinationToolError("bb_query", error);
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
      return coordinationToolError("bb_watch", error);
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
      return coordinationToolError("stig_mark", error);
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
    try {
      pruneExpired();
      const parsed = StigBatchInputSchema.parse(input);
      const result = handleStigBatch(getCoordinationToolContext(), parsed);
      return {
        content: [{ type: "text" as const, text: j({ tool: "stig_batch", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return coordinationToolError("stig_batch", error);
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
      return coordinationToolError("stig_decay", error);
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
      return coordinationToolError("stig_snapshot", error);
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
      return coordinationToolError("cnp_announce", error);
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
      return coordinationToolError("cnp_refresh_bounds", error);
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
      return coordinationToolError("cnp_watcher_telemetry", error);
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
      return coordinationToolError("consensus_vote", error);
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
      return childToolError("child_batch_create", error, { child_id: null });
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
      return childToolError("child_spawn_codex", error, { child_id: null });
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
      return childToolError("child_attach", error, { child_id: input?.child_id ?? null });
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
      return childToolError("child_set_role", error, { child_id: input?.child_id ?? null });
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
      return childToolError("child_set_limits", error, { child_id: input?.child_id ?? null });
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
      return childToolError("child_create", error, { child_id: input.child_id ?? null });
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
      return childToolError("child_send", error, { child_id: input.child_id });
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
    try {
      const parsed = ChildStatusInputSchema.parse(input);
      const result = handleChildStatus(getChildToolContext(), parsed);
      graphState.syncChildIndexSnapshot(result.index_snapshot);
      return {
        content: [{ type: "text" as const, text: j({ tool: "child_status", result }) }],
        structuredContent: result,
      };
    } catch (error) {
      return childToolError("child_status", error, { child_id: input.child_id });
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

      return {
        content: [{ type: "text" as const, text: j({ tool: "child_collect", result: payload }) }],
        structuredContent: payload,
      };
    } catch (error) {
      return childToolError("child_collect", error, { child_id: input.child_id });
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
      return childToolError("child_stream", error, {
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
      return childToolError("child_cancel", error, { child_id: input.child_id });
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
      return childToolError("child_kill", error, { child_id: input.child_id });
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
      return childToolError("child_gc", error, { child_id: input.child_id });
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



    return { content: [{ type: "text", text: j({ pending_id: pendingId, child_id }) }] };

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



    const { child_id, content, role = "user" } = input;

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



    return { content: [{ type: "text", text: j({ pending_id: pendingId, child_id }) }] };

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
        resolvedPath = resolvePath(process.cwd(), cfg.path);
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

    try {
      const handle = await startHttpServer(server, options.http, logger);
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
  stopHeartbeat,
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
