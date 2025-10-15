import type { BlackboardEventKind } from "../coord/blackboard.js";
import type { EventKind as StoreEventKind } from "../eventStore.js";

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

/** Message identifiers emitted by smoke/introspection probes. */
export type IntrospectionEventMessage = "introspection_probe";

/** Message identifier emitted by periodic heartbeat ticks. */
export type HeartbeatEventMessage = "alive";

/** Message identifier emitted by the stigmergy bridge. */
export type StigmergyEventMessage = "stigmergy_change";

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
  | IntrospectionEventMessage
  | HeartbeatEventMessage
  | StigmergyEventMessage;

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
