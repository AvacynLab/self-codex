import { z, type ZodTypeAny } from "zod";

import {
  ChildBatchCreateInputSchema,
  ChildCancelInputSchema,
  ChildCollectInputSchema,
  ChildCreateInputSchema,
  ChildGcInputSchema,
  ChildKillInputSchema,
  ChildSendInputSchema,
  ChildSetLimitsInputSchema,
  ChildSetLimitsInputShape,
  ChildSetRoleInputSchema,
  ChildSpawnCodexInputSchema,
  ChildStatusInputSchema,
  ChildStreamInputSchema,
  ChildAttachInputSchema,
} from "../tools/childTools.js";
import {
  PlanFanoutInputSchema,
  PlanJoinInputSchema,
  PlanReduceInputSchema,
  PlanCompileBTInputSchema,
  PlanCompileBTInputShape,
  PlanRunBTInputSchema,
  PlanRunReactiveInputSchema,
  PlanDryRunInputSchema,
  PlanStatusInputSchema,
  PlanPauseInputSchema,
  PlanResumeInputSchema,
} from "../tools/planTools.js";
import {
  BbBatchSetInputSchema,
  BbSetInputSchema,
  BbGetInputSchema,
  BbQueryInputSchema,
  BbWatchInputSchema,
  StigMarkInputSchema,
  StigBatchInputSchema,
  StigDecayInputSchema,
  StigSnapshotInputSchema,
  CnpAnnounceInputSchema,
  CnpRefreshBoundsInputSchema,
  CnpWatcherTelemetryInputSchema,
  ConsensusVoteInputSchema,
} from "../tools/coordTools.js";
import { GraphDiffInputSchema, GraphPatchInputSchema, GraphPatchInputShape } from "../tools/graphDiffTools.js";
import { GraphLockInputSchema, GraphUnlockInputSchema } from "../tools/graphLockTools.js";
import { GraphBatchMutateInputSchema } from "../tools/graphBatchTools.js";
import { TxBeginInputSchema, TxApplyInputSchema, TxCommitInputSchema, TxRollbackInputSchema } from "../tools/txTools.js";
import {
  GraphGenerateInputSchema,
  GraphMutateInputSchema,
  GraphHyperExportInputSchema,
  GraphValidateInputSchema,
  GraphSummarizeInputSchema,
  GraphPathsKShortestInputSchema,
  GraphPathsConstrainedInputSchema,
  GraphCentralityBetweennessInputSchema,
  GraphPartitionInputSchema,
  GraphCriticalPathInputSchema,
  GraphSimulateInputSchema,
  GraphOptimizeInputSchema,
  GraphOptimizeMooInputSchema,
  GraphCausalAnalyzeInputSchema,
  GraphRewriteApplyInputSchema,
} from "../tools/graphTools.js";
import {
  ValuesSetInputSchema,
  ValuesScoreInputSchema,
  ValuesFilterInputSchema,
  ValuesExplainInputSchema,
} from "../tools/valueTools.js";
import {
  KgInsertInputSchema,
  KgQueryInputSchema,
  KgExportInputSchema,
  KgSuggestPlanInputSchema,
} from "../tools/knowledgeTools.js";
import { MemoryVectorSearchInputSchema } from "../tools/memoryTools.js";
import { CausalExportInputSchema, CausalExplainInputSchema } from "../tools/causalTools.js";
import { AgentAutoscaleSetInputSchema } from "../tools/agentTools.js";

// Schemas defined locally -----------------------------------------------------

export const McpIntrospectionInputSchema = z.object({}).strict();
export const HealthCheckInputSchema = z.object({ include_details: z.boolean().optional() }).strict();
export const ResourceListInputSchema = z
  .object({
    prefix: z.string().trim().min(1).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
export const ResourceReadInputSchema = z.object({ uri: z.string().min(1) }).strict();
export const ResourceWatchRunFilterSchema = z
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
export const ResourceWatchChildFilterSchema = z
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
export const ResourceWatchBlackboardFilterSchema = z
  .object({
    keys: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    kinds: z.array(z.enum(["set", "delete", "expire"])).max(3).optional(),
    tags: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    since_ts: z.number().int().min(0).optional(),
    until_ts: z.number().int().min(0).optional(),
  })
  .partial()
  .strict();
export const ResourceWatchInputSchema = z
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

export {
  IntentRouteDiagnosticsSchema,
  IntentRouteInputSchema,
  IntentRouteInputShape,
  IntentRouteOutputSchema,
  IntentRouteRecommendationSchema,
} from "./intentRouteSchemas.js";
export type {
  IntentRouteDiagnostics,
  IntentRouteInput,
  IntentRouteOutput,
  IntentRouteRecommendation,
} from "./intentRouteSchemas.js";
export {
  TOOL_HELP_CATEGORIES,
  ToolsHelpBudgetDiagnosticSchema,
  ToolsHelpInputSchema,
  ToolsHelpInputShape,
  ToolsHelpPackSchema,
  ToolsHelpOutputDetailsSchema,
  ToolsHelpOutputSchema,
  ToolsHelpToolSummarySchema,
  ToolsHelpVisibilityModeSchema,
} from "./toolsHelpSchemas.js";
export type {
  ToolsHelpBudgetDiagnostic,
  ToolsHelpInput,
  ToolsHelpOutput,
  ToolsHelpToolSummary,
} from "./toolsHelpSchemas.js";
export {
  RUNTIME_OBSERVE_SECTIONS,
  RuntimeObserveBudgetDiagnosticSchema,
  RuntimeObserveInputSchema,
  RuntimeObserveInputShape,
  RuntimeObserveMethodMetricSchema,
  RuntimeObserveOutputDetailsSchema,
  RuntimeObserveOutputSchema,
  RuntimeObserveSnapshotSchema,
} from "./runtimeObserveSchemas.js";
export type {
  RuntimeObserveBudgetDiagnostic,
  RuntimeObserveInput,
  RuntimeObserveMethodMetric,
  RuntimeObserveOutput,
  RuntimeObserveSnapshot,
} from "./runtimeObserveSchemas.js";
export {
  ProjectScaffoldRunBudgetDiagnosticSchema,
  ProjectScaffoldRunDirectoriesSchema,
  ProjectScaffoldRunErrorDiagnosticSchema,
  ProjectScaffoldRunInputSchema,
  ProjectScaffoldRunInputShape,
  ProjectScaffoldRunOutputDetailsSchema,
  ProjectScaffoldRunOutputShape,
  ProjectScaffoldRunOutputSchema,
} from "./projectScaffoldRunSchemas.js";
export type {
  ProjectScaffoldRunInput,
  ProjectScaffoldRunOutput,
} from "./projectScaffoldRunSchemas.js";
export {
  ArtifactBudgetDiagnosticSchema,
  ArtifactEncodingSchema,
  ArtifactOperationContextSchema,
  ArtifactOperationErrorSchema,
  ArtifactReadDetailsSchema,
  ArtifactReadInputSchema,
  ArtifactReadOutputSchema,
  ArtifactReadSuccessDetailsSchema,
  ArtifactSearchDetailsSchema,
  ArtifactSearchInputSchema,
  ArtifactSearchOutputSchema,
  ArtifactSearchResultEntrySchema,
  ArtifactWriteDetailsSchema,
  ArtifactWriteInputSchema,
  ArtifactWriteOutputSchema,
  ArtifactWriteSuccessDetailsSchema,
} from "./artifactSchemas.js";
export type {
  ArtifactReadInput,
  ArtifactReadOutput,
  ArtifactSearchInput,
  ArtifactSearchOutput,
  ArtifactWriteInput,
  ArtifactWriteOutput,
} from "./artifactSchemas.js";
export {
  GraphApplyChangeSetBudgetDetailsSchema,
  GraphApplyChangeSetInputSchema,
  GraphApplyChangeSetOutputSchema,
  GraphApplyChangeSetSuccessDetailsSchema,
  GraphApplyChangeSetValidationFailureDetailsSchema,
  GraphApplyChangeSetValidationSchema,
  GraphChangeOperationSchema,
} from "./graphApplyChangeSetSchemas.js";
export type {
  GraphApplyChangeSetInput,
  GraphApplyChangeSetOutput,
  GraphApplyChangeSetSuccessDetails,
  GraphApplyChangeSetValidation,
  GraphChangeOperation,
} from "./graphApplyChangeSetSchemas.js";
export {
  GRAPH_SNAPSHOT_TIME_TRAVEL_MODES,
  GraphSnapshotBudgetDiagnosticSchema,
  GraphSnapshotDescriptorSchema,
  GraphSnapshotTimeTravelBaseDetailsSchema,
  GraphSnapshotTimeTravelDetailsSchema,
  GraphSnapshotTimeTravelInputSchema,
  GraphSnapshotTimeTravelListDetailsSchema,
  GraphSnapshotTimeTravelModeSchema,
  GraphSnapshotTimeTravelOutputSchema,
  GraphSnapshotTimeTravelPreviewDetailsSchema,
  GraphSnapshotTimeTravelRestoreDetailsSchema,
} from "./graphSnapshotTimeTravelSchemas.js";
export type {
  GraphSnapshotDescriptor,
  GraphSnapshotTimeTravelInput,
  GraphSnapshotTimeTravelMode,
  GraphSnapshotTimeTravelOutput,
} from "./graphSnapshotTimeTravelSchemas.js";
export {
  MemorySearchHitSchema,
  MemorySearchInputSchema,
  MemorySearchInputShape,
  MemorySearchOutputSchema,
  MemoryUpsertInputSchema,
  MemoryUpsertInputShape,
  MemoryUpsertOutputSchema,
} from "./memoryFacadeSchemas.js";
export type {
  MemorySearchInput,
  MemorySearchOutput,
  MemorySearchBudgetDetails,
  MemorySearchErrorDetails,
  MemorySearchSuccessDetails,
  MemoryUpsertInput,
  MemoryUpsertOutput,
  MemoryUpsertBudgetDetails,
  MemoryUpsertErrorDetails,
  MemoryUpsertSuccessDetails,
} from "./memoryFacadeSchemas.js";
export {
  ChildOrchestrateCollectSchema,
  ChildOrchestrateInputSchema,
  ChildOrchestrateInputShape,
  ChildOrchestrateOutputSchema,
  ChildOrchestrateRuntimeMessageSchema,
  ChildOrchestrateSandboxSchema,
  ChildOrchestrateSuccessDetailsSchema,
} from "./childOrchestrateSchemas.js";
export type {
  ChildOrchestrateInput,
  ChildOrchestrateOutput,
  ChildOrchestrateSuccessDetails,
} from "./childOrchestrateSchemas.js";
export {
  PlanCompileExecuteBehaviorTreeSummarySchema,
  PlanCompileExecuteBindingSummarySchema,
  PlanCompileExecuteBudgetDiagnosticSchema,
  PlanCompileExecuteErrorDiagnosticSchema,
  PlanCompileExecuteInputSchemaFacade,
  PlanCompileExecuteOutputDetailsSchema,
  PlanCompileExecuteOutputSchema,
  PlanCompileExecutePlanPreviewSchema,
  PlanCompileExecuteSchedulePhaseSchema,
  PlanCompileExecuteScheduleSummarySchema,
  PlanCompileExecuteStatsSchema,
  hashPlanPayload,
} from "./planCompileExecuteFacadeSchemas.js";
export type {
  PlanCompileExecuteDryRunReport,
  PlanCompileExecuteFacadeInput,
  PlanCompileExecuteFacadeOutput,
} from "./planCompileExecuteFacadeSchemas.js";
export const EventSubscribeInputSchema = z
  .object({
    categories: z.array(z.string().trim().min(1)).max(10).optional(),
    since_seq: z.number().int().min(0).optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();
export const LogsTailFilterSchema = z
  .object({
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
    stream: z.enum(["server", "children", "events"]).optional(),
    limit: z.number().int().positive().max(500).optional(),
    since_seq: z.number().int().min(0).optional(),
    child_id: z.string().trim().min(1).max(200).optional(),
    job_id: z.string().trim().min(1).max(200).optional(),
    run_id: z.string().trim().min(1).max(200).optional(),
  })
  .partial()
  .strict();
export const LogsTailInputSchema = z
  .object({
    filters: LogsTailFilterSchema.optional(),
    format: z.enum(["json", "text"]).optional(),
  })
  .strict();
export const GraphSubgraphExtractInputSchema = z
  .object({
    root_id: z.string().min(1),
    radius: z.number().int().min(1).max(100).optional(),
    include_metadata: z.boolean().optional(),
    format: z.enum(["json", "dot", "graphml"]).optional(),
  })
  .strict();

export const ConversationViewInputSchema = z
  .object({
    child_id: z.string(),
    since_index: z.number().optional(),
    since_ts: z.number().optional(),
    limit: z.number().optional(),
    format: z.enum(["text", "json"]).optional(),
    include_system: z.boolean().optional(),
  })
  .strict();

export const EventsViewInputSchema = z
  .object({
    mode: z.enum(["recent", "pending", "live"]).optional(),
    job_id: z.string().optional(),
    child_id: z.string().optional(),
    limit: z.number().optional(),
    order: z.enum(["asc", "desc"]).optional(),
    min_seq: z.number().optional(),
  })
  .strict();

const ChildSpecShape = {
  name: z.string(),
  system: z.string().optional(),
  goals: z.array(z.string()).optional(),
  runtime: z.string().optional(),
} as const;
export const StartInputSchema = z
  .object({
    job_id: z.string(),
    children: z.array(z.object(ChildSpecShape)).optional(),
  })
  .strict();
export const ChildPromptInputSchema = z
  .object({
    child_id: z.string(),
    messages: z.array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    ),
  })
  .strict();
export const ChildPushReplyInputSchema = z.object({ pending_id: z.string(), content: z.string() }).strict();
export const ChildPushPartialInputSchema = z
  .object({ pending_id: z.string(), delta: z.string(), done: z.boolean().optional() })
  .strict();
export const StatusInputSchema = z.object({ job_id: z.string().optional() }).strict();
export const AggregateInputSchema = z
  .object({
    job_id: z.string(),
    strategy: z.string().optional(),
    include_system: z.boolean().optional(),
    include_goals: z.boolean().optional(),
  })
  .strict();
export const KillInputSchema = z
  .object({ child_id: z.string().optional(), job_id: z.string().optional() })
  .strict();
export const ChildInfoInputSchema = z.object({ child_id: z.string() }).strict();
export const ChildTranscriptInputSchema = z
  .object({
    child_id: z.string(),
    since_index: z.number().int().min(0).optional(),
    since_ts: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    reverse: z.boolean().optional(),
  })
  .strict();
export const ChildChatInputSchema = z
  .object({ child_id: z.string(), content: z.string(), role: z.enum(["user", "system"]).optional() })
  .strict();
export const ChildRenameInputSchema = z.object({ child_id: z.string(), name: z.string().min(1) }).strict();
export const ChildResetInputSchema = z.object({ child_id: z.string(), keep_system: z.boolean().optional() }).strict();
export const GraphForgeAnalysisInputSchema = z
  .object({ name: z.string().min(1), args: z.array(z.string()).optional(), weight_key: z.string().optional() })
  .strict();
export const GraphForgeInputSchema = z
  .object({
    source: z.string().optional(),
    path: z.string().optional(),
    entry_graph: z.string().optional(),
    weight_key: z.string().optional(),
    use_defined_analyses: z.boolean().optional(),
    analyses: z.array(GraphForgeAnalysisInputSchema).optional(),
  })
  .refine((input) => Boolean(input.source) || Boolean(input.path), {
    message: "Provide 'source' or 'path'",
    path: ["source"],
  });
export const GraphExportInputSchema = z
  .object({
    format: z.enum(["json", "mermaid", "dot", "graphml"]).default("json"),
    direction: z.enum(["LR", "TB"]).optional(),
    label_attribute: z.string().min(1).optional(),
    weight_attribute: z.string().min(1).optional(),
    max_label_length: z.number().int().min(8).max(160).optional(),
    inline: z.boolean().default(true),
    path: z.string().min(1).optional(),
    pretty: z.boolean().default(true),
    truncate: z.number().int().min(256).max(16384).optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.inline && !input.path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "when inline=false a path must be provided",
        path: ["path"],
      });
    }
  });
export const GraphSaveInputSchema = z.object({ path: z.string() }).strict();
export const GraphLoadInputSchema = z.object({ path: z.string() }).strict();
export const GraphRuntimeInputSchema = z.object({ runtime: z.string().optional(), reset: z.boolean().optional() }).strict();
export const GraphStatsInputSchema = z.object({}).strict();
export const GraphInactivityInputSchema = z
  .object({
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
    format: z.enum(["json", "text"]).optional(),
  })
  .strict();
export const JobViewInputSchema = z
  .object({
    job_id: z.string(),
    per_child_limit: z.number().optional(),
    format: z.enum(["json", "text"]).optional(),
    include_system: z.boolean().optional(),
  })
  .strict();
export const EventsViewLiveInputSchema = z
  .object({
    job_id: z.string().optional(),
    child_id: z.string().optional(),
    limit: z.number().optional(),
    order: z.enum(["asc", "desc"]).optional(),
    min_seq: z.number().optional(),
  })
  .strict();
export const GraphPruneInputSchema = z
  .object({
    action: z.enum(["transcript", "events"]),
    child_id: z.string().optional(),
    keep_last: z.number().optional(),
    job_id: z.string().optional(),
    max_events: z.number().optional(),
  })
  .strict();
export const GraphAutosaveInputSchema = z
  .object({ action: z.enum(["start", "stop"]), path: z.string().optional(), interval_ms: z.number().optional() })
  .strict();
export const OpCancelInputSchema = z
  .object({ op_id: z.string().min(1), reason: z.string().min(1).max(200).optional() })
  .strict();
export const PlanCancelInputSchema = z
  .object({ run_id: z.string().min(1), reason: z.string().min(1).max(200).optional() })
  .strict();

export const GraphConfigRetentionInputSchema = z
  .object({
    max_transcript_per_child: z.number().optional(),
    max_event_nodes: z.number().optional(),
  })
  .strict();

export const GraphQueryInputSchema = z
  .object({
    kind: z.enum(["neighbors", "filter"]),
    node_id: z.string().optional(),
    direction: z.enum(["out", "in", "both"]).optional(),
    edge_type: z.string().optional(),
    select: z.enum(["nodes", "edges", "both"]).optional(),
    where: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    limit: z.number().optional(),
  })
  .strict();

export const ToolsCallEnvelopeSchema = z
  .object({
    name: z.string().trim().min(1),
    arguments: z.unknown().optional(),
  })
  .strict();

export const ToolsListInputSchema = z
  .object({
    names: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    kinds: z.array(z.enum(["dynamic", "composite", "native"])).max(3).optional(),
    mode: z.enum(["basic", "pro"]).optional(),
    pack: z.enum(["basic", "authoring", "ops", "all"]).optional(),
  })
  .strict();
export const ToolsListInputShape = ToolsListInputSchema.shape;

export const ToolComposeStepSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    tool: z.string().trim().min(1).max(200),
    arguments: z.record(z.unknown()).optional(),
    capture: z.boolean().optional(),
  })
  .strict();

export const ToolComposeRegisterInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(16).optional(),
    steps: z.array(ToolComposeStepSchema).min(1).max(32),
  })
  .strict();
export const ToolComposeRegisterInputShape = ToolComposeRegisterInputSchema.shape;
export const MemoryVectorSearchInputShape = MemoryVectorSearchInputSchema.shape;

export type RpcMethodSchemaRegistry = Record<string, ZodTypeAny>;

type StrictZodShape = Record<string, ZodTypeAny>;

function mergeStrictShapes(
  base: StrictZodShape,
  overrides?: StrictZodShape | undefined,
): StrictZodShape {
  return Object.assign({}, base, overrides ?? {});
}

/**
 * Builder returning a fresh strict schema compatible with {@link GraphPatchInputSchema}.
 * Callers can optionally override individual fields (for instance to narrow
 * accepted operation types) without mutating the canonical registry version.
 */
export function buildGraphPatchInputSchema(
  overrides?: StrictZodShape,
) {
  return z.object(mergeStrictShapes(GraphPatchInputShape, overrides)).strict();
}

/**
 * Builder used by composite tools to customise child limit updates without
 * modifying the original schema exported by the child tool suite.
 */
export function buildChildSetLimitsInputSchema(
  overrides?: StrictZodShape,
) {
  return z.object(mergeStrictShapes(ChildSetLimitsInputShape, overrides)).strict();
}

/**
 * Builder mirroring {@link PlanCompileBTInputSchema} that downstream planners
 * can extend (for example to toggle experimental knobs) while preserving the
 * base validation rules expected by the orchestrator.
 */
export function buildPlanCompileBtInputSchema(
  overrides?: StrictZodShape,
) {
  return z.object(mergeStrictShapes(PlanCompileBTInputShape, overrides)).strict();
}

export const RPC_METHOD_SCHEMAS: RpcMethodSchemaRegistry = {
  mcp_info: McpIntrospectionInputSchema,
  mcp_capabilities: McpIntrospectionInputSchema,
  health_check: HealthCheckInputSchema,
  tools_list: ToolsListInputSchema,
  tool_compose_register: ToolComposeRegisterInputSchema,
  resources_list: ResourceListInputSchema,
  resources_read: ResourceReadInputSchema,
  resources_watch: ResourceWatchInputSchema,
  events_subscribe: EventSubscribeInputSchema,
  logs_tail: LogsTailInputSchema,
  job_view: JobViewInputSchema,
  graph_export: GraphExportInputSchema,
  graph_state_save: GraphSaveInputSchema,
  graph_state_load: GraphLoadInputSchema,
  graph_state_autosave: GraphAutosaveInputSchema,
  graph_state_stats: GraphStatsInputSchema,
  graph_state_metrics: GraphStatsInputSchema,
  graph_state_inactivity: GraphInactivityInputSchema,
  graph_query: GraphQueryInputSchema,
  graph_generate: GraphGenerateInputSchema,
  graph_mutate: GraphMutateInputSchema,
  graph_batch_mutate: GraphBatchMutateInputSchema,
  graph_diff: GraphDiffInputSchema,
  graph_patch: GraphPatchInputSchema,
  graph_lock: GraphLockInputSchema,
  graph_unlock: GraphUnlockInputSchema,
  graph_subgraph_extract: GraphSubgraphExtractInputSchema,
  graph_hyper_export: GraphHyperExportInputSchema,
  graph_config_retention: GraphConfigRetentionInputSchema,
  graph_config_runtime: GraphRuntimeInputSchema,
  conversation_view: ConversationViewInputSchema,
  events_view: EventsViewInputSchema,
  kg_insert: KgInsertInputSchema,
  kg_upsert: KgInsertInputSchema,
  kg_query: KgQueryInputSchema,
  kg_export: KgExportInputSchema,
  kg_suggest_plan: KgSuggestPlanInputSchema,
  memory_vector_search: MemoryVectorSearchInputSchema,
  values_set: ValuesSetInputSchema,
  values_score: ValuesScoreInputSchema,
  values_filter: ValuesFilterInputSchema,
  values_explain: ValuesExplainInputSchema,
  causal_export: CausalExportInputSchema,
  causal_explain: CausalExplainInputSchema,
  graph_rewrite_apply: GraphRewriteApplyInputSchema,
  tx_begin: TxBeginInputSchema,
  tx_apply: TxApplyInputSchema,
  tx_commit: TxCommitInputSchema,
  tx_rollback: TxRollbackInputSchema,
  graph_validate: GraphValidateInputSchema,
  graph_summarize: GraphSummarizeInputSchema,
  graph_paths_k_shortest: GraphPathsKShortestInputSchema,
  graph_paths_constrained: GraphPathsConstrainedInputSchema,
  graph_centrality_betweenness: GraphCentralityBetweennessInputSchema,
  graph_partition: GraphPartitionInputSchema,
  graph_critical_path: GraphCriticalPathInputSchema,
  graph_simulate: GraphSimulateInputSchema,
  graph_optimize: GraphOptimizeInputSchema,
  graph_optimize_moo: GraphOptimizeMooInputSchema,
  graph_causal_analyze: GraphCausalAnalyzeInputSchema,
  plan_fanout: PlanFanoutInputSchema,
  plan_join: PlanJoinInputSchema,
  plan_reduce: PlanReduceInputSchema,
  plan_compile_bt: PlanCompileBTInputSchema,
  plan_run_bt: PlanRunBTInputSchema,
  plan_run_reactive: PlanRunReactiveInputSchema,
  plan_dry_run: PlanDryRunInputSchema,
  plan_status: PlanStatusInputSchema,
  plan_pause: PlanPauseInputSchema,
  plan_resume: PlanResumeInputSchema,
  op_cancel: OpCancelInputSchema,
  plan_cancel: PlanCancelInputSchema,
  bb_batch_set: BbBatchSetInputSchema,
  bb_set: BbSetInputSchema,
  bb_get: BbGetInputSchema,
  bb_query: BbQueryInputSchema,
  bb_watch: BbWatchInputSchema,
  stig_mark: StigMarkInputSchema,
  stig_batch: StigBatchInputSchema,
  stig_decay: StigDecayInputSchema,
  stig_snapshot: StigSnapshotInputSchema,
  cnp_announce: CnpAnnounceInputSchema,
  cnp_refresh_bounds: CnpRefreshBoundsInputSchema,
  cnp_watcher_telemetry: CnpWatcherTelemetryInputSchema,
  consensus_vote: ConsensusVoteInputSchema,
  agent_autoscale_set: AgentAutoscaleSetInputSchema,
  start: StartInputSchema,
  child_batch_create: ChildBatchCreateInputSchema,
  child_spawn_codex: ChildSpawnCodexInputSchema,
  child_attach: ChildAttachInputSchema,
  child_set_role: ChildSetRoleInputSchema,
  child_set_limits: ChildSetLimitsInputSchema,
  child_create: ChildCreateInputSchema,
  child_send: ChildSendInputSchema,
  child_status: ChildStatusInputSchema,
  child_collect: ChildCollectInputSchema,
  child_stream: ChildStreamInputSchema,
  child_cancel: ChildCancelInputSchema,
  child_kill: ChildKillInputSchema,
  child_gc: ChildGcInputSchema,
  child_prompt: ChildPromptInputSchema,
  child_push_partial: ChildPushPartialInputSchema,
  child_push_reply: ChildPushReplyInputSchema,
  child_chat: ChildChatInputSchema,
  child_info: ChildInfoInputSchema,
  child_transcript: ChildTranscriptInputSchema,
  child_rename: ChildRenameInputSchema,
  child_reset: ChildResetInputSchema,
  status: StatusInputSchema,
  graph_forge_analyze: GraphForgeInputSchema,
  aggregate: AggregateInputSchema,
  kill: KillInputSchema,
};

/**
 * Output schemas mirroring {@link RPC_METHOD_SCHEMAS}. They currently fall back
 * to `z.unknown()` and act as placeholders so transports can attach result
 * validators incrementally as handlers adopt structured responses.
 */
export const RPC_METHOD_RESPONSE_SCHEMAS: RpcMethodSchemaRegistry = Object.freeze(
  Object.fromEntries(Object.keys(RPC_METHOD_SCHEMAS).map((method) => [method, z.unknown()])),
);
