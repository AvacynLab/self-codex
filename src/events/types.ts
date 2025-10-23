import type {
  BlackboardEntrySnapshot,
  BlackboardEvent,
  BlackboardEventKind,
} from "../coord/blackboard.js";
import type {
  ReviewBreakdownEntry,
  ReviewKind,
  ReviewResult,
} from "../agents/metaCritic.js";
import type { ReflectionResult } from "../agents/selfReflect.js";
import type { StigmergyChangeEvent, StigmergyIntensityBounds } from "../coord/stigmergy.js";
import type { CancellationEventPayload } from "../executor/cancel.js";
import type {
  ChildRuntimeLifecycleEvent,
  ChildRuntimeLimits,
  ChildRuntimeMessage,
} from "../childRuntime.js";
import type {
  ContractNetAgentSnapshot,
  ContractNetAwardDecision,
  ContractNetBidSnapshot,
  ContractNetCallSnapshot,
  ContractNetEvent,
} from "../coord/contractNet.js";
import type { ContractNetWatcherTelemetrySnapshot } from "../coord/contractNetWatchers.js";
import type { ConsensusEvent } from "../coord/consensus.js";
import type {
  ValueExplanationResult,
  ValueFilterDecision,
  ValueGraphEvent,
  ValueGraphPlanEventBase,
  ValueGraphSummary,
  ValueImpactInput,
  ValueScoreResult,
} from "../values/valueGraph.js";
import type { EventKind as StoreEventKind } from "../eventStore.js";
import type { BTStatus } from "../executor/bt/types.js";
import type { SchedulerEventName } from "../executor/reactiveScheduler.js";
import type { SupervisorEvent } from "../children/supervisionStrategy.js";
import type { PlanLifecycleMode, PlanLifecyclePhase } from "../executor/planLifecycle.js";
import type { LessonsPromptPayload } from "../learning/lessonPromptDiff.js";

/**
 * Union of semantic identifiers emitted by the legacy event store. The values
 * mirror the uppercase {@link StoreEventKind} literals but lowered to match the
 * message tokens historically surfaced by `/events` subscribers.
 */
export type EventStoreMessage = Lowercase<StoreEventKind>;

/** Message identifiers emitted when the blackboard mutates. */
export type BlackboardEventMessage = `bb_${BlackboardEventKind}`;

/** Message identifiers emitted by the cancellation registry bridge. */
export type CancellationEventMessage = "cancel_requested" | "cancel_repeat";

/** Message identifiers emitted by the child runtime stream bridge. */
export type ChildStreamMessage = "child_stdout" | "child_stderr";

/** Message identifiers emitted by the child runtime lifecycle bridge. */
export type ChildLifecycleMessage =
  | "child_lifecycle"
  | "child_spawned"
  | "child_exit"
  | "child_error";

/** Message identifiers emitted by the child supervisor. */
export type ChildSupervisorMessage =
  | "child.limits.updated"
  | "child.restart.scheduled"
  | "child.breaker.open"
  | "child.breaker.half_open"
  | "child.breaker.closed";

/** Message identifiers emitted by child cognitive assessments. */
export type ChildCognitiveMessage = "child_meta_review" | "child_reflection";

/** Contract-Net watcher telemetry message identifier. */
export type ContractNetWatcherMessage = "cnp_watcher_telemetry";

/** Message identifiers emitted by the Contract-Net bridge. */
export type ContractNetEventMessage =
  | "cnp_event"
  | "cnp_agent_registered"
  | "cnp_agent_updated"
  | "cnp_agent_unregistered"
  | "cnp_call_announced"
  | "cnp_bid_recorded"
  | "cnp_bid_updated"
  | "cnp_call_awarded"
  | "cnp_call_bounds_updated"
  | "cnp_call_completed";

/** Message identifiers emitted by the consensus bridge. */
export type ConsensusEventMessage =
  | "consensus_decision"
  | "consensus_tie_unresolved"
  | "consensus_decision_unsatisfied";

/** Message identifiers emitted by the value guard bridge. */
export type ValueGuardEventMessage =
  | "values_event"
  | "values_config_updated"
  | "values_scored"
  | "values_filter_allowed"
  | "values_filter_blocked"
  | "values_explain_allowed"
  | "values_explain_blocked";

/** Message identifiers emitted by JSON-RPC lifecycle telemetry. */
export type JsonRpcStage = "request" | "response" | "error";
export type JsonRpcEventMessage = `jsonrpc_${JsonRpcStage}`;

/** Message identifiers emitted by the autoscaler agent. */
export type AutoscalerEventMessage =
  | "scale_up"
  | "scale_up_failed"
  | "scale_down"
  | "scale_down_cancel_failed"
  | "scale_down_forced"
  | "scale_down_failed";

/** Message identifiers emitted by the reactive scheduler telemetry bridge. */
export type SchedulerEventMessage = "scheduler_event_enqueued" | "scheduler_tick_result";

/** Message identifiers emitted by smoke/introspection probes. */
export type IntrospectionEventMessage = "introspection_probe";

/** Message identifier emitted by periodic heartbeat ticks. */
export type HeartbeatEventMessage = "alive";

/** Message identifier emitted by the stigmergy bridge. */
export type StigmergyEventMessage = "stigmergy_change";

/**
 * Union of status labels reported by the JSON-RPC observability hooks. The
 * values mirror the lifecycle stages so downstream dashboards can colour code
 * request/response/error transitions deterministically.
 */
export type JsonRpcEventStatus = "pending" | "ok" | "error";

/**
 * Common telemetry fields shared by every JSON-RPC observability payload. The
 * structure mirrors the object assembled in
 * `recordJsonRpcObservability()` so runtime publishers can expose structured
 * telemetry without resorting to casts.
 *
 * Optional metrics such as `transport` or `elapsed_ms` are flagged with
 * `?` so the runtime can omit them entirely when a measurement is not
 * available. This keeps the JSON contract aligned with the
 * `exactOptionalPropertyTypes` requirements by avoiding `undefined`
 * assignments in the first place.
 */
export interface JsonRpcEventPayloadBase {
  /** Discriminant describing the lifecycle stage (request/response/error). */
  readonly msg: JsonRpcEventMessage;
  /** Fully qualified JSON-RPC method invoked by the caller. */
  readonly method: string;
  /** Metric-friendly label derived from {@link method} and tool usage. */
  readonly metric_method: string;
  /** Optional tool identifier extracted from the JSON-RPC request. */
  readonly tool: string | null;
  /** Identifier propagated by the client (string or numeric). */
  readonly request_id: string | number | null;
  /** Transport that carried the request (http, ws, ...). */
  readonly transport?: string | null;
  /** High level lifecycle status rendered by dashboards. */
  readonly status: JsonRpcEventStatus | null;
  /** Duration measured by the orchestrator for the lifecycle stage. */
  readonly elapsed_ms?: number | null;
  /** Distributed trace identifier when tracing is enabled. */
  readonly trace_id?: string | null;
  /** Distributed span identifier when tracing is enabled. */
  readonly span_id?: string | null;
  /** Trace duration captured by the tracing backend. */
  readonly duration_ms?: number | null;
  /** Payload size observed on ingress. */
  readonly bytes_in?: number | null;
  /** Payload size observed on egress. */
  readonly bytes_out?: number | null;
  /** Run correlation identifier propagated by tools. */
  readonly run_id: string | null;
  /** Operation correlation identifier propagated by tools. */
  readonly op_id: string | null;
  /** Child runtime correlation identifier propagated by transports. */
  readonly child_id: string | null;
  /** Job correlation identifier propagated by tools. */
  readonly job_id: string | null;
  /** Optional idempotency key used to deduplicate requests. */
  readonly idempotency_key?: string | null;
  /** Normalised error message when the request fails. */
  readonly error_message: string | null;
  /** Structured JSON-RPC error code when the request fails. */
  readonly error_code: number | null;
  /** Timeout configuration applied to the request if any. */
  readonly timeout_ms?: number | null;
}

/**
 * Shared telemetry fields reused across the discriminated JSON-RPC payload
 * union. Keeping the alias exported allows publishers to build the payload in
 * multiple steps without repeating the exhaustive set of keys.
 */
export type JsonRpcEventSharedFields = Omit<
  JsonRpcEventPayloadBase,
  "msg" | "status" | "error_message" | "error_code"
>;

/** Payload emitted when a JSON-RPC request is accepted for processing. */
export interface JsonRpcRequestPayload extends JsonRpcEventPayloadBase {
  readonly msg: "jsonrpc_request";
  readonly status: "pending";
  readonly error_message: null;
  readonly error_code: null;
}

/** Payload emitted after a JSON-RPC handler successfully produces a response. */
export interface JsonRpcResponsePayload extends JsonRpcEventPayloadBase {
  readonly msg: "jsonrpc_response";
  readonly status: "ok";
  readonly error_message: null;
  readonly error_code: null;
}

/** Payload emitted when a JSON-RPC handler fails or rejects. */
export interface JsonRpcErrorPayload extends JsonRpcEventPayloadBase {
  readonly msg: "jsonrpc_error";
  readonly status: "error";
  readonly error_message: string | null;
  readonly error_code: number | null;
}

/** Discriminated union of every JSON-RPC observability payload. */
export type JsonRpcEventPayload =
  | JsonRpcRequestPayload
  | JsonRpcResponsePayload
  | JsonRpcErrorPayload;

/** Helper resolving the payload type for a given JSON-RPC event message. */
export type JsonRpcEventPayloadByMessage<M extends JsonRpcEventMessage> = Extract<
  JsonRpcEventPayload,
  { msg: M }
>;

/**
 * Union of all structured message identifiers accepted by the event bus. The
 * list purposefully mirrors runtime behaviour so publishers cannot emit ad-hoc
 * tokens that would fragment downstream dashboards.
 */
export type EventMessage =
  | EventStoreMessage
  | BlackboardEventMessage
  | CancellationEventMessage
  | ChildStreamMessage
  | ChildLifecycleMessage
  | ChildSupervisorMessage
  | ChildCognitiveMessage
  | ContractNetWatcherMessage
  | ContractNetEventMessage
  | ConsensusEventMessage
  | ValueGuardEventMessage
  | JsonRpcEventMessage
  | AutoscalerEventMessage
  | SchedulerEventMessage
  | IntrospectionEventMessage
  | HeartbeatEventMessage
  | StigmergyEventMessage;

/**
 * Shared telemetry fields emitted by every autoscaler event payload. The structure mirrors the
 * `publishEvent` helper in `src/agents/autoscaler.ts` so downstream consumers can rely on consistent
 * numeric samples and structured reasons without resorting to casts.
 */
export interface AutoscalerTelemetryBase {
  /** Discriminant mirroring the autoscaler action (e.g. {@link AutoscalerEventMessage}). */
  readonly msg: AutoscalerEventMessage;
  /** Short label describing why the autoscaler triggered the action (pressure, relaxation, …). */
  readonly reason: string;
  /** Snapshot of the backlog depth that triggered the decision. */
  readonly backlog: number;
  /** Total number of sampled task results considered for the decision. */
  readonly samples: number;
  /** Optional identifier of the child runtime involved in the scaling action. */
  readonly child_id?: string;
}

/** Successful scale-up action published after the supervisor spawns a child runtime. */
export interface AutoscalerScaleUpPayload extends AutoscalerTelemetryBase {
  readonly msg: "scale_up";
}

/** Failure raised when the supervisor rejects a scale-up request. */
export interface AutoscalerScaleUpFailedPayload extends AutoscalerTelemetryBase {
  readonly msg: "scale_up_failed";
  /** Error message surfaced by the supervisor while spawning a child. */
  readonly message: string;
}

/** Graceful scale-down action executed once the backlog relaxes. */
export interface AutoscalerScaleDownPayload extends AutoscalerTelemetryBase {
  readonly msg: "scale_down";
}

/** Warning emitted when the supervisor cannot cancel a child gracefully. */
export interface AutoscalerScaleDownCancelFailedPayload extends AutoscalerTelemetryBase {
  readonly msg: "scale_down_cancel_failed";
  /** Reason returned by the supervisor while attempting a graceful shutdown. */
  readonly message: string;
}

/** Warning emitted when the autoscaler escalates to a forceful termination. */
export interface AutoscalerScaleDownForcedPayload extends AutoscalerTelemetryBase {
  readonly msg: "scale_down_forced";
}

/** Error surfaced when both graceful and forceful terminations fail. */
export interface AutoscalerScaleDownFailedPayload extends AutoscalerTelemetryBase {
  readonly msg: "scale_down_failed";
  /** Reason returned by the supervisor while attempting the forceful shutdown. */
  readonly message: string;
}

/** Union of every autoscaler payload published on the event bus. */
export type AutoscalerTelemetryPayload =
  | AutoscalerScaleUpPayload
  | AutoscalerScaleUpFailedPayload
  | AutoscalerScaleDownPayload
  | AutoscalerScaleDownCancelFailedPayload
  | AutoscalerScaleDownForcedPayload
  | AutoscalerScaleDownFailedPayload;

/** Structured correlation fields attached to scheduler telemetry payloads. */
export interface SchedulerTelemetryCorrelationFields {
  readonly run_id: string | null;
  readonly op_id: string | null;
  readonly job_id: string | null;
  readonly graph_id: string | null;
  readonly node_id: string | null;
  readonly child_id: string | null;
}

/**
 * Structured payload published when the scheduler enqueues a Behaviour Tree event. The shape mirrors
 * the telemetry assembled in `emitSchedulerTelemetry("scheduler_event_enqueued", …)` so dashboards
 * can rely on queue depth metrics and correlation hints.
 */
export interface SchedulerEventEnqueuedPayload extends SchedulerTelemetryCorrelationFields {
  readonly msg: "scheduler_event_enqueued";
  readonly event_type: SchedulerEventName;
  readonly pending: number;
  readonly pending_before: number;
  readonly pending_after: number;
  readonly base_priority: number;
  readonly enqueued_at_ms: number;
  readonly sequence: number;
  readonly event_payload: Record<string, unknown>;
  readonly duration_ms: null;
  readonly batch_index: null;
  readonly ticks_in_batch: null;
  /** Scheduler tick priority is not computed at enqueue time. */
  readonly priority?: undefined;
  /** Tick status is not known at enqueue time. */
  readonly status?: undefined;
  /** Source event is implicit for enqueued telemetry and omitted for backwards compatibility. */
  readonly source_event?: undefined;
}

/**
 * Structured payload published after the scheduler completes a tick. Includes execution metrics and
 * correlation hints so observers can reconcile queue pressure and execution results.
 */
export interface SchedulerTickResultPayload extends SchedulerTelemetryCorrelationFields {
  readonly msg: "scheduler_tick_result";
  readonly event_type: "tick_result";
  readonly pending: number;
  readonly pending_before: number;
  readonly pending_after: number;
  readonly base_priority: number;
  readonly priority: number;
  readonly enqueued_at_ms: number;
  readonly sequence: number;
  readonly duration_ms: number;
  readonly batch_index: number;
  readonly ticks_in_batch: number;
  readonly status: BTStatus;
  readonly source_event: SchedulerEventName;
  readonly event_payload: Record<string, unknown>;
}

/** Union of every scheduler telemetry payload published on the event bus. */
export type SchedulerTelemetryPayload = SchedulerEventEnqueuedPayload | SchedulerTickResultPayload;

/**
 * Correlation identifiers serialised alongside event store payloads. The shape mirrors
 * `serialiseCorrelationForPayload()` so downstream subscribers consistently receive the
 * canonical snake_case identifiers propagated throughout the orchestrator.
 */
export interface EventCorrelationPayload {
  readonly run_id: string | null;
  readonly op_id: string | null;
  readonly job_id: string | null;
  readonly graph_id: string | null;
  readonly node_id: string | null;
  readonly child_id: string | null;
}

/**
 * Snapshot describing the quality gate evaluation associated with a child collection.
 * The structure mirrors the enriched object produced by the meta critic so
 * downstream dashboards can surface actionable signals without casting.
 */
export interface QualityAssessmentSnapshot {
  readonly kind: ReviewKind;
  readonly score: number;
  readonly rubric: Readonly<Record<string, number>>;
  readonly metrics: Readonly<Record<string, number>>;
  readonly gate: {
    readonly enabled: boolean;
    readonly threshold: number;
    readonly needs_revision: boolean;
  };
}

/** Shared summary metadata included with every cognitive event payload. */
export interface ChildCognitiveSummary {
  readonly kind: ReviewKind;
  readonly text: string;
  readonly tags: ReadonlyArray<string>;
}

/** Correlation identifiers forwarded with child cognitive events. */
export interface ChildCognitiveEventPayloadBase {
  readonly child_id: string;
  readonly job_id: string | null;
  readonly run_id: EventCorrelationPayload["run_id"];
  readonly op_id: EventCorrelationPayload["op_id"];
  readonly graph_id: EventCorrelationPayload["graph_id"];
  readonly node_id: EventCorrelationPayload["node_id"];
}

/** Structured payload emitted when the meta critic evaluates a child output. */
export interface ChildMetaReviewEventPayload extends ChildCognitiveEventPayloadBase {
  readonly msg: "child_meta_review";
  readonly summary: ChildCognitiveSummary;
  readonly review: {
    readonly overall: ReviewResult["overall"];
    readonly verdict: ReviewResult["verdict"];
    readonly feedback: ReadonlyArray<ReviewResult["feedback"][number]>;
    readonly suggestions: ReadonlyArray<ReviewResult["suggestions"][number]>;
    readonly breakdown: ReadonlyArray<ReviewBreakdownEntry>;
  };
  readonly metrics: {
    readonly artifacts: number;
    readonly messages: number;
  };
  readonly quality_assessment: QualityAssessmentSnapshot | null;
}

/** Structured payload emitted when the self-reflection heuristics run. */
export interface ChildReflectionEventPayload extends ChildCognitiveEventPayloadBase {
  readonly msg: "child_reflection";
  readonly summary: ChildCognitiveSummary;
  readonly reflection: {
    readonly insights: ReadonlyArray<ReflectionResult["insights"][number]>;
    readonly next_steps: ReadonlyArray<ReflectionResult["nextSteps"][number]>;
    readonly risks: ReadonlyArray<ReflectionResult["risks"][number]>;
  };
}

/** Union of every structured payload published under the cognitive namespace. */
export type ChildCognitiveEventPayload =
  | ChildMetaReviewEventPayload
  | ChildReflectionEventPayload;

/** Structured payload emitted when the plan fan-out helper spawns child runs. */
export interface PlanFanoutEventPayload extends EventCorrelationPayload {
  readonly children: ReadonlyArray<{ name: string; runtime: string }>;
  readonly rejected: ReadonlyArray<string>;
}

/** Structured payload emitted after compiling a planner behaviour tree. */
export interface PlanCompiledEventPayload {
  readonly event: "plan_compiled";
  readonly plan_id: string;
  readonly plan_version: string | null;
  readonly run_id: string;
  readonly op_id: string;
  readonly total_tasks: number;
  readonly phases: number;
  readonly critical_path_length: number;
  readonly estimated_duration_ms: number;
}

/** Union describing every PLAN payload surfaced on the event bus. */
export type PlanEventPayload = PlanFanoutEventPayload | PlanCompiledEventPayload;

/** Payload embedded when lessons alter an outgoing prompt. */
export interface PromptEventPayload {
  readonly operation: string;
  readonly lessons_prompt: LessonsPromptPayload;
}

/** Aggregation summary emitted when the plan reduce helper completes. */
export interface PlanAggregateReducerPayload extends EventCorrelationPayload {
  readonly reducer: string;
  readonly children: ReadonlyArray<string>;
}

/** Aggregation summary emitted by the public `aggregate` tool. */
export interface PlanAggregateToolPayload {
  readonly strategy: string;
  readonly requested: string | null;
}

/** Union of payloads emitted for AGGREGATE events. */
export type PlanAggregateEventPayload = PlanAggregateReducerPayload | PlanAggregateToolPayload;

/** Consensus summary embedded in plan status payloads. */
export interface PlanStatusConsensusSummary {
  readonly mode: "majority" | "quorum" | "weighted";
  readonly outcome: string | null;
  readonly satisfied: boolean;
  readonly tie: boolean;
  readonly threshold: number | null;
  readonly total_weight: number;
  readonly tally: Record<string, number>;
}

/** Status snapshot emitted after plan joins evaluate their policy. */
export interface PlanJoinStatusPayload extends EventCorrelationPayload {
  readonly policy: string;
  readonly satisfied: boolean;
  readonly successes: number;
  readonly failures: number;
  readonly consensus?: PlanStatusConsensusSummary | undefined;
}

/** Child status snapshot emitted by orchestration dashboard helpers. */
export interface JobStatusChildSnapshot {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly runtime: string;
  readonly waiting_for: string | null;
  readonly last_update: number | null;
  readonly pending_id: string | null;
  readonly transcript_size: number;
}

/** Job overview payload returned by the status inspection tool. */
export interface JobStatusPayload {
  readonly job_id: string;
  readonly state: string;
  readonly children: ReadonlyArray<JobStatusChildSnapshot>;
}

/** Union grouping every STATUS payload emitted by the orchestrator. */
export type PlanStatusEventPayload = PlanJoinStatusPayload | JobStatusPayload;

/** Shared base structure for plan lifecycle breadcrumbs. */
export interface PlanLifecycleEventPayloadBase extends EventCorrelationPayload {
  readonly phase: PlanLifecyclePhase;
  readonly tree_id: string;
  readonly dry_run: boolean;
  readonly mode: PlanLifecycleMode;
}

/** Lifecycle breadcrumb emitted when a run starts executing. */
export interface PlanLifecycleStartPayload extends PlanLifecycleEventPayloadBase {
  readonly phase: "start";
  readonly tick_ms?: number | null;
  readonly budget_ms?: number | null;
}

/** Lifecycle breadcrumb emitted for node-level status updates. */
export interface PlanLifecycleNodePayload extends PlanLifecycleEventPayloadBase {
  readonly phase: "node";
  readonly node_id: string;
  readonly status: BTStatus;
}

/** Lifecycle breadcrumb emitted for scheduler ticks. */
export interface PlanLifecycleTickPayload extends PlanLifecycleEventPayloadBase {
  readonly phase: "tick";
  readonly status: BTStatus;
  readonly pending_after: number;
  readonly ticks?: number;
  readonly scheduler_ticks?: number;
  readonly tick_duration_ms?: number;
  readonly event?: SchedulerEventName;
  readonly event_payload?: Record<string, unknown>;
}

/** Lifecycle breadcrumb emitted after reconciler loops run. */
export interface PlanLifecycleLoopPayload extends PlanLifecycleEventPayloadBase {
  readonly phase: "loop";
  readonly loop_tick: number;
  readonly executed_ticks: number;
  readonly scheduler_ticks: number;
  readonly status: BTStatus;
  readonly reconcilers: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly duration_ms: number;
    readonly error: string | null;
  }>;
}

/** Lifecycle breadcrumb emitted when a run completes. */
export interface PlanLifecycleCompletePayload extends PlanLifecycleEventPayloadBase {
  readonly phase: "complete";
  readonly status: BTStatus;
  readonly ticks?: number;
  readonly scheduler_ticks?: number;
  readonly loop_ticks?: number;
  readonly duration_ms?: number;
  readonly invocations?: number;
  readonly last_output: unknown;
}

/** Lifecycle breadcrumb emitted when cancellation is requested. */
export interface PlanLifecycleCancelPayload extends PlanLifecycleEventPayloadBase {
  readonly phase: "cancel";
  readonly reason: string | null;
}

/** Lifecycle breadcrumb emitted when a run errors out. */
export interface PlanLifecycleErrorPayload extends PlanLifecycleEventPayloadBase {
  readonly phase: "error";
  readonly status: BTStatus | "cancelled";
  readonly reason?: string | null;
  readonly message?: string;
}

/** Union regrouping every lifecycle breadcrumb payload emitted on the bus. */
export type PlanLifecycleEventPayload =
  | PlanLifecycleStartPayload
  | PlanLifecycleNodePayload
  | PlanLifecycleTickPayload
  | PlanLifecycleLoopPayload
  | PlanLifecycleCompletePayload
  | PlanLifecycleCancelPayload
  | PlanLifecycleErrorPayload;

/** Payload emitted when the supervisor records a child spawn. */
export interface StartEventPayload {
  readonly name: string;
}

/** Mapping linking EventStore kinds to their structured payloads. */
export interface EventStorePayloadMap {
  PLAN: PlanEventPayload;
  PROMPT: PromptEventPayload;
  AGGREGATE: PlanAggregateEventPayload;
  STATUS: PlanStatusEventPayload;
  BT_RUN: PlanLifecycleEventPayload;
  SCHEDULER: SchedulerTelemetryPayload;
  AUTOSCALER: AutoscalerTelemetryPayload;
  START: StartEventPayload;
  COGNITIVE: ChildCognitiveEventPayload;
}

/** Resolves the payload type attached to a specific EventStore kind. */
export type EventStorePayload<K extends StoreEventKind> = K extends keyof EventStorePayloadMap
  ? EventStorePayloadMap[K]
  : unknown;

const EVENT_STORE_MESSAGES = [
  "plan",
  "start",
  "prompt",
  "pending",
  "reply_part",
  "reply",
  "status",
  "aggregate",
  "kill",
  "heartbeat",
  "info",
  "warn",
  "error",
  "bt_run",
  "scheduler",
  "autoscaler",
  "cognitive",
] as const satisfies readonly EventStoreMessage[];

const BLACKBOARD_MESSAGES = ["bb_set", "bb_delete", "bb_expire"] as const satisfies readonly BlackboardEventMessage[];

const CANCELLATION_MESSAGES = ["cancel_requested", "cancel_repeat"] as const satisfies readonly CancellationEventMessage[];

const CHILD_STREAM_MESSAGES = ["child_stdout", "child_stderr"] as const satisfies readonly ChildStreamMessage[];

const CHILD_LIFECYCLE_MESSAGES = [
  "child_lifecycle",
  "child_spawned",
  "child_exit",
  "child_error",
] as const satisfies readonly ChildLifecycleMessage[];

const CHILD_SUPERVISOR_MESSAGES = [
  "child.limits.updated",
  "child.restart.scheduled",
  "child.breaker.open",
  "child.breaker.half_open",
  "child.breaker.closed",
] as const satisfies readonly ChildSupervisorMessage[];

const CHILD_COGNITIVE_MESSAGES = ["child_meta_review", "child_reflection"] as const satisfies readonly ChildCognitiveMessage[];

const CONTRACT_NET_MESSAGES = [
  "cnp_event",
  "cnp_agent_registered",
  "cnp_agent_updated",
  "cnp_agent_unregistered",
  "cnp_call_announced",
  "cnp_bid_recorded",
  "cnp_bid_updated",
  "cnp_call_awarded",
  "cnp_call_bounds_updated",
  "cnp_call_completed",
] as const satisfies readonly ContractNetEventMessage[];

const CONSENSUS_MESSAGES = [
  "consensus_decision",
  "consensus_tie_unresolved",
  "consensus_decision_unsatisfied",
] as const satisfies readonly ConsensusEventMessage[];

const VALUE_GUARD_MESSAGES = [
  "values_event",
  "values_config_updated",
  "values_scored",
  "values_filter_allowed",
  "values_filter_blocked",
  "values_explain_allowed",
  "values_explain_blocked",
] as const satisfies readonly ValueGuardEventMessage[];

const JSONRPC_MESSAGES = [
  "jsonrpc_request",
  "jsonrpc_response",
  "jsonrpc_error",
] as const satisfies readonly JsonRpcEventMessage[];

const AUTOSCALER_MESSAGES = [
  "scale_up",
  "scale_up_failed",
  "scale_down",
  "scale_down_cancel_failed",
  "scale_down_forced",
  "scale_down_failed",
] as const satisfies readonly AutoscalerEventMessage[];

const SCHEDULER_MESSAGES = ["scheduler_event_enqueued", "scheduler_tick_result"] as const satisfies readonly SchedulerEventMessage[];

const INTROSPECTION_MESSAGES = ["introspection_probe"] as const satisfies readonly IntrospectionEventMessage[];

const HEARTBEAT_MESSAGES = ["alive"] as const satisfies readonly HeartbeatEventMessage[];

const STIGMERGY_MESSAGES = ["stigmergy_change"] as const satisfies readonly StigmergyEventMessage[];

const EVENT_MESSAGE_VALUES = [
  ...EVENT_STORE_MESSAGES,
  ...BLACKBOARD_MESSAGES,
  ...CANCELLATION_MESSAGES,
  ...CHILD_STREAM_MESSAGES,
  ...CHILD_LIFECYCLE_MESSAGES,
  ...CHILD_SUPERVISOR_MESSAGES,
  ...CHILD_COGNITIVE_MESSAGES,
  ...CONTRACT_NET_MESSAGES,
  "cnp_watcher_telemetry",
  ...CONSENSUS_MESSAGES,
  ...VALUE_GUARD_MESSAGES,
  ...JSONRPC_MESSAGES,
  ...AUTOSCALER_MESSAGES,
  ...SCHEDULER_MESSAGES,
  ...INTROSPECTION_MESSAGES,
  ...HEARTBEAT_MESSAGES,
  ...STIGMERGY_MESSAGES,
] as const satisfies readonly EventMessage[];

const EVENT_MESSAGE_SET: ReadonlySet<EventMessage> = new Set(EVENT_MESSAGE_VALUES);

/**
 * Returns `true` when the provided token matches a known {@link EventMessage}.
 */
export function isEventMessage(value: string): value is EventMessage {
  return EVENT_MESSAGE_SET.has(value as EventMessage);
}

/**
 * Throws when the provided token does not match a known {@link EventMessage}.
 * Publishing an untyped token would fragment downstream subscribers, hence the
 * helper keeps the bus defensive even when called from plain JavaScript.
 */
export function assertValidEventMessage(value: string): asserts value is EventMessage {
  if (!isEventMessage(value)) {
    throw new TypeError(`unknown event message: ${value}`);
  }
}

/** Expose the catalog for diagnostics and targeted assertions in tests. */
export const EVENT_MESSAGES: readonly EventMessage[] = EVENT_MESSAGE_VALUES;

/** Snapshot describing a single blackboard mutation mirrored on the bus. */
export interface BlackboardEventPayload {
  kind: BlackboardEventKind;
  key: string;
  version: number;
  timestamp: number;
  reason: BlackboardEvent["reason"] | null;
  entry: BlackboardEntrySnapshot | null;
  previous: BlackboardEntrySnapshot | null;
}

/** Structured payload emitted whenever the stigmergy field changes. */
export interface StigmergyEventPayload {
  nodeId: string;
  type: StigmergyChangeEvent["type"];
  intensity: number;
  totalIntensity: number;
  updatedAt: number;
  bounds: {
    minIntensity: StigmergyIntensityBounds["minIntensity"];
    maxIntensity: number | null;
    normalisationCeiling: StigmergyIntensityBounds["normalisationCeiling"];
  };
}

/**
 * Structured payload published by the validation harness when probing the event bus during
 * MCP introspection campaigns. The fields mirror the object assembled in
 * `scripts/lib/validation/stages/introspection.mjs` so dashboards can reason about the stage
 * without resorting to runtime casts.
 */
export interface IntrospectionProbePayload {
  /** Discriminant describing the probe event. */
  readonly msg: "introspection_probe";
  /** Name of the validation stage currently executing. */
  readonly stage: "introspection";
  /** ISO-8601 timestamp captured when the probe was emitted. */
  readonly emitted_at: string;
}

/**
 * Minimal heartbeat payload emitted by the orchestrator to indicate a job remains active. The
 * structure intentionally stays compact so subscribers can rely on the bus metadata (job/run ids)
 * for correlation while still receiving a typed message token.
 */
export interface HeartbeatEventPayload {
  /** Discriminant describing the heartbeat notification. */
  readonly msg: "alive";
}

/** Structured payload emitted for child runtime stdout/stderr events. */
export interface ChildRuntimeMessageEventPayload {
  childId: string;
  stream: ChildRuntimeMessage["stream"];
  raw: string;
  parsed: ChildRuntimeMessage["parsed"];
  receivedAt: number;
  sequence: number;
}

/** Structured payload emitted for child lifecycle transitions. */
export type ChildRuntimeLifecycleEventPayload =
  | {
      childId: string;
      phase: "spawned";
      at: number;
      pid: number;
      forced: boolean;
      reason: null;
    }
  | {
      childId: string;
      phase: "exit";
      at: number;
      pid: number;
      forced: boolean;
      reason: Extract<ChildRuntimeLifecycleEvent, { phase: "exit" }>["reason"];
      code: Extract<ChildRuntimeLifecycleEvent, { phase: "exit" }>["code"];
      signal: Extract<ChildRuntimeLifecycleEvent, { phase: "exit" }>["signal"];
    }
  | {
      childId: string;
      phase: "error";
      at: number;
      pid: number;
      forced: boolean;
      reason: Extract<ChildRuntimeLifecycleEvent, { phase: "error" }>["reason"];
    };

/**
 * Structured payload surfaced when declarative limits change for a child runtime.
 * Downstream observers rely on the snapshot to keep dashboards aligned with the
 * supervisor index while asserting the guardrails applied to the runtime.
 */
export interface ChildSupervisorLimitsUpdatedPayload {
  /** Identifier of the child runtime whose limits changed. */
  readonly childId: string;
  /** Resolved declarative limits after supervisor normalisation. */
  readonly limits: ChildRuntimeLimits | null;
}

/**
 * Structured payload emitted for supervision lifecycle events (restarts and
 * circuit breaker transitions). The envelope mirrors the structure assembled by
 * the supervisor before publishing to the event bus so tests and dashboards can
 * inspect the triggering event alongside correlated runtimes.
 */
export interface ChildSupervisorEventPayload {
  /** Original supervision event emitted by the runtime supervisor. */
  readonly event: SupervisorEvent;
  /** Identifiers of child runtimes sharing the supervision key. */
  readonly relatedChildren: readonly string[];
  /** Restart quota configured for the supervision strategy (null when disabled). */
  readonly maxRestartsPerMinute: number | null;
}

/** Structured payload emitted for Contract-Net watcher telemetry. */
export interface ContractNetWatcherTelemetryPayload {
  reason: ContractNetWatcherTelemetrySnapshot["reason"];
  received_updates: ContractNetWatcherTelemetrySnapshot["receivedUpdates"];
  coalesced_updates: ContractNetWatcherTelemetrySnapshot["coalescedUpdates"];
  skipped_refreshes: ContractNetWatcherTelemetrySnapshot["skippedRefreshes"];
  applied_refreshes: ContractNetWatcherTelemetrySnapshot["appliedRefreshes"];
  flushes: ContractNetWatcherTelemetrySnapshot["flushes"];
  last_bounds: ContractNetWatcherTelemetrySnapshot["lastBounds"] extends infer Bounds
    ? Bounds extends null
      ? null
      : {
          min_intensity: Bounds extends { min_intensity: infer Min } ? Min : number;
          max_intensity: Bounds extends { max_intensity: infer Max } ? Max : number | null;
          normalisation_ceiling: Bounds extends { normalisation_ceiling: infer Ceiling }
            ? Ceiling
            : number;
        }
    : null;
}

/** Structured payloads emitted by Contract-Net lifecycle bridges. */
export type ContractNetEventPayload =
  | {
      kind: "agent_registered" | "agent_updated";
      agent: ContractNetAgentSnapshot;
      updated: boolean;
    }
  | {
      kind: "agent_unregistered";
      agentId: string;
      remainingAssignments: number;
    }
  | {
      kind: "call_announced" | "call_completed";
      call: ContractNetCallSnapshot;
    }
  | {
      kind: "bid_recorded" | "bid_updated";
      callId: string;
      agentId: string;
      bid: ContractNetBidSnapshot;
      previousKind: Extract<ContractNetEvent, { kind: "bid_recorded" }>["previousKind"];
    }
  | {
      kind: "call_awarded";
      call: ContractNetCallSnapshot;
      decision: ContractNetAwardDecision;
    }
  | {
      kind: "call_bounds_updated";
      call: ContractNetCallSnapshot;
      bounds: Extract<ContractNetEvent, { kind: "call_bounds_updated" }>["bounds"];
      refresh: Extract<ContractNetEvent, { kind: "call_bounds_updated" }>["refresh"];
    };

/** Structured payload emitted for consensus lifecycle updates. */
export interface ConsensusEventPayload {
  source: ConsensusEvent["source"];
  at: ConsensusEvent["at"];
  mode: ConsensusEvent["mode"];
  outcome: ConsensusEvent["outcome"];
  satisfied: ConsensusEvent["satisfied"];
  tie: ConsensusEvent["tie"];
  threshold: ConsensusEvent["threshold"];
  total_weight: ConsensusEvent["totalWeight"];
  votes: ConsensusEvent["votes"];
  tally: ConsensusEvent["tally"];
  metadata: ConsensusEvent["metadata"] | null;
}

/** Structured payload emitted when the value guard configuration changes. */
export interface ValueConfigUpdatedPayload {
  summary: ValueGraphSummary;
}

/** Structured payload emitted when a plan receives a value guard score. */
export interface ValuePlanScoredPayload {
  plan_id: ValueGraphPlanEventBase["planId"];
  plan_label: ValueGraphPlanEventBase["planLabel"];
  impacts_count: number;
  impacts: ValueImpactInput[];
  result: ValueScoreResult;
  violations_count: number;
}

/** Structured payload emitted when the value guard filters a plan. */
export interface ValuePlanFilteredPayload {
  plan_id: ValueGraphPlanEventBase["planId"];
  plan_label: ValueGraphPlanEventBase["planLabel"];
  impacts_count: number;
  impacts: ValueImpactInput[];
  decision: ValueFilterDecision;
}

/** Structured payload emitted when the value guard explains a plan decision. */
export interface ValuePlanExplainedPayload {
  plan_id: ValueGraphPlanEventBase["planId"];
  plan_label: ValueGraphPlanEventBase["planLabel"];
  impacts_count: number;
  impacts: ValueImpactInput[];
  result: ValueExplanationResult;
}

/** Mapping describing payloads enforced for known event messages. */
export interface EventPayloadMap {
  plan: PlanEventPayload;
  start: StartEventPayload;
  prompt: PromptEventPayload;
  status: PlanStatusEventPayload;
  aggregate: PlanAggregateEventPayload;
  bt_run: PlanLifecycleEventPayload;
  scheduler: SchedulerTelemetryPayload;
  autoscaler: AutoscalerTelemetryPayload;
  bb_set: BlackboardEventPayload;
  bb_delete: BlackboardEventPayload;
  bb_expire: BlackboardEventPayload;
  stigmergy_change: StigmergyEventPayload;
  cancel_requested: CancellationEventPayload;
  cancel_repeat: CancellationEventPayload;
  child_stdout: ChildRuntimeMessageEventPayload;
  child_stderr: ChildRuntimeMessageEventPayload;
  child_lifecycle: ChildRuntimeLifecycleEventPayload;
  child_spawned: ChildRuntimeLifecycleEventPayload & { phase: "spawned" };
  child_exit: ChildRuntimeLifecycleEventPayload & { phase: "exit" };
  child_error: ChildRuntimeLifecycleEventPayload & { phase: "error" };
  child_meta_review: ChildMetaReviewEventPayload;
  child_reflection: ChildReflectionEventPayload;
  "child.limits.updated": ChildSupervisorLimitsUpdatedPayload;
  "child.restart.scheduled": ChildSupervisorEventPayload & { event: Extract<SupervisorEvent, { type: "child_restart" }> };
  "child.breaker.open": ChildSupervisorEventPayload & { event: Extract<SupervisorEvent, { type: "breaker_open" }> };
  "child.breaker.half_open": ChildSupervisorEventPayload & { event: Extract<SupervisorEvent, { type: "breaker_half_open" }> };
  "child.breaker.closed": ChildSupervisorEventPayload & { event: Extract<SupervisorEvent, { type: "breaker_closed" }> };
  cnp_watcher_telemetry: ContractNetWatcherTelemetryPayload;
  cnp_event: ContractNetEvent;
  cnp_agent_registered: ContractNetEventPayload & { kind: "agent_registered" | "agent_updated" };
  cnp_agent_updated: ContractNetEventPayload & { kind: "agent_registered" | "agent_updated" };
  cnp_agent_unregistered: ContractNetEventPayload & { kind: "agent_unregistered" };
  cnp_call_announced: ContractNetEventPayload & { kind: "call_announced" };
  cnp_bid_recorded: ContractNetEventPayload & { kind: "bid_recorded" | "bid_updated" };
  cnp_bid_updated: ContractNetEventPayload & { kind: "bid_recorded" | "bid_updated" };
  cnp_call_awarded: ContractNetEventPayload & { kind: "call_awarded" };
  cnp_call_bounds_updated: ContractNetEventPayload & { kind: "call_bounds_updated" };
  cnp_call_completed: ContractNetEventPayload & { kind: "call_completed" };
  consensus_decision: ConsensusEventPayload;
  consensus_tie_unresolved: ConsensusEventPayload;
  consensus_decision_unsatisfied: ConsensusEventPayload;
  values_event: ValueGraphEvent;
  values_config_updated: ValueConfigUpdatedPayload;
  values_scored: ValuePlanScoredPayload;
  values_filter_allowed: ValuePlanFilteredPayload;
  values_filter_blocked: ValuePlanFilteredPayload;
  values_explain_allowed: ValuePlanExplainedPayload;
  values_explain_blocked: ValuePlanExplainedPayload;
  jsonrpc_request: JsonRpcRequestPayload;
  jsonrpc_response: JsonRpcResponsePayload;
  jsonrpc_error: JsonRpcErrorPayload;
  scale_up: AutoscalerScaleUpPayload;
  scale_up_failed: AutoscalerScaleUpFailedPayload;
  scale_down: AutoscalerScaleDownPayload;
  scale_down_cancel_failed: AutoscalerScaleDownCancelFailedPayload;
  scale_down_forced: AutoscalerScaleDownForcedPayload;
  scale_down_failed: AutoscalerScaleDownFailedPayload;
  scheduler_event_enqueued: SchedulerEventEnqueuedPayload;
  scheduler_tick_result: SchedulerTickResultPayload;
  introspection_probe: IntrospectionProbePayload;
  alive: HeartbeatEventPayload;
}

/** Resolve the payload type associated with a specific event message. */
export type EventPayload<M extends EventMessage> = M extends keyof EventPayloadMap
  ? EventPayloadMap[M]
  : unknown;
