/**
 * Helper utilities bridging existing coordination/event emitters with the unified
 * {@link EventBus}. The functions provided here act as glue so legacy modules
 * such as the blackboard or the stigmergic field can surface structured MCP
 * events without pulling in the bus implementation directly.
 */
import type { EventBus, EventInput } from "./bus.js";
import { mergeCorrelationHints, type EventCorrelationHints } from "./correlation.js";
import type { BlackboardEvent, BlackboardStore } from "../coord/blackboard.js";
import type { StigmergyChangeEvent, StigmergyField } from "../coord/stigmergy.js";
import type {
  ChildRuntime,
  ChildRuntimeLifecycleEvent,
  ChildRuntimeMessage,
} from "../childRuntime.js";
import type {
  ContractNetCoordinator,
  ContractNetEvent,
  ContractNetEventListener,
} from "../coord/contractNet.js";
import {
  subscribeConsensusEvents,
  type ConsensusEvent,
  type ConsensusEventListener,
} from "../coord/consensus.js";
import type { CancellationEventPayload } from "../executor/cancel.js";
import { subscribeCancellationEvents } from "../executor/cancel.js";
import type {
  ValueGraph,
  ValueGraphEvent,
  ValueGraphEventListener,
} from "../values/valueGraph.js";

/**
 * Union describing the event currently being bridged. The context is forwarded
 * to correlation resolvers so they can surface identifiers from the original
 * payloads.
 */
export type ChildRuntimeBridgeContext =
  | { kind: "message"; runtime: ChildRuntime; message: ChildRuntimeMessage }
  | { kind: "lifecycle"; runtime: ChildRuntime; lifecycle: ChildRuntimeLifecycleEvent };

/** Options consumed when bridging blackboard events to the {@link EventBus}. */
export interface BlackboardBridgeOptions {
  /** Blackboard instance to observe. */
  blackboard: BlackboardStore;
  /** Event bus receiving the translated events. */
  bus: EventBus;
  /**
   * Optional resolver deriving correlation metadata (run/op identifiers) from
   * the raw blackboard event. Keeping it injectable ensures tests can stub the
   * behaviour until higher layers propagate correlation IDs.
   */
  resolveCorrelation?: (event: BlackboardEvent) => EventCorrelationHints | void;
}

/**
 * Subscribes to the blackboard change stream and publishes structured events on
 * the unified bus. The function returns a disposer so callers can detach the
 * bridge when shutting the orchestrator down.
 */
export function bridgeBlackboardEvents(options: BlackboardBridgeOptions): () => void {
  const { blackboard, bus, resolveCorrelation } = options;
  let lastVersion = blackboard.getCurrentVersion();

  const listener = (event: BlackboardEvent) => {
    lastVersion = Math.max(lastVersion, event.version);
    const correlation = resolveCorrelation?.(event) ?? {};

    const level: EventInput["level"] = event.kind === "expire" ? "warn" : "info";
    const payload = {
      kind: event.kind,
      key: event.key,
      version: event.version,
      timestamp: event.timestamp,
      reason: event.reason ?? null,
      entry: event.entry ?? null,
      previous: event.previous ?? null,
    };

    bus.publish({
      cat: "blackboard",
      level,
      jobId: correlation.jobId ?? null,
      runId: correlation.runId ?? null,
      opId: correlation.opId ?? null,
      graphId: correlation.graphId ?? null,
      nodeId: correlation.nodeId ?? null,
      childId: correlation.childId ?? null,
      msg: `bb_${event.kind}`,
      data: payload,
    });
  };

  const detach = blackboard.watch({ fromVersion: lastVersion, listener });
  return () => {
    detach();
  };
}

/** Options consumed when bridging stigmergy events to the {@link EventBus}. */
export interface StigmergyBridgeOptions {
  /** Stigmergic field emitting change notifications. */
  field: StigmergyField;
  /** Event bus receiving the translated events. */
  bus: EventBus;
  /** Optional resolver enriching emitted events with correlation hints. */
  resolveCorrelation?: (event: StigmergyChangeEvent) => EventCorrelationHints | void;
}

/**
 * Observes stigmergic field mutations and mirrors them on the unified bus so
 * downstream MCP clients can reason about pheromone dynamics in real time.
 */
export function bridgeStigmergyEvents(options: StigmergyBridgeOptions): () => void {
  const { field, bus, resolveCorrelation } = options;

  const detach = field.onChange((event) => {
    const correlation = resolveCorrelation?.(event) ?? {};
    bus.publish({
      cat: "stigmergy",
      level: "info",
      jobId: correlation.jobId ?? null,
      runId: correlation.runId ?? null,
      opId: correlation.opId ?? null,
      graphId: correlation.graphId ?? null,
      nodeId: event.nodeId,
      childId: correlation.childId ?? null,
      msg: "stigmergy_change",
      data: {
        nodeId: event.nodeId,
        type: event.type,
        intensity: event.intensity,
        totalIntensity: event.totalIntensity,
        updatedAt: event.updatedAt,
      },
    });
  });

  return () => {
    detach();
  };
}

/** Options consumed when bridging cancellation events to the {@link EventBus}. */
export interface CancellationBridgeOptions {
  /** Event bus receiving structured cancellation lifecycle events. */
  bus: EventBus;
  /**
   * Optional subscriber used to observe the cancellation registry. Mainly
   * exposed for tests so they can stub deterministic feeds.
   */
  subscribe?: (listener: (event: CancellationEventPayload) => void) => () => void;
  /**
   * Optional resolver enriching emitted events with correlation hints such as
   * job identifiers or related child runtimes.
   */
  resolveCorrelation?: (event: CancellationEventPayload) => EventCorrelationHints | void;
}

/** Options consumed when bridging child runtime events to the {@link EventBus}. */
export interface ChildRuntimeBridgeOptions {
  /** Child runtime emitting message and lifecycle events. */
  runtime: ChildRuntime;
  /** Event bus receiving structured child lifecycle outputs. */
  bus: EventBus;
  /** Optional resolver enriching emitted events with correlation hints. */
  resolveCorrelation?: (context: ChildRuntimeBridgeContext) => EventCorrelationHints | void;
}

/** Options consumed when bridging Contract-Net events to the {@link EventBus}. */
export interface ContractNetBridgeOptions {
  /** Contract-Net coordinator emitting lifecycle updates. */
  coordinator: ContractNetCoordinator;
  /** Event bus receiving structured auction events. */
  bus: EventBus;
  /** Optional subscriber override, exposed for deterministic tests. */
  subscribe?: (listener: ContractNetEventListener) => () => void;
  /** Optional resolver enriching emitted events with correlation hints. */
  resolveCorrelation?: (event: ContractNetEvent) => EventCorrelationHints | void;
}

/** Options consumed when bridging consensus events to the {@link EventBus}. */
export interface ConsensusBridgeOptions {
  /** Event bus receiving structured consensus decisions. */
  bus: EventBus;
  /** Optional subscriber override so tests can inject deterministic feeds. */
  subscribe?: (listener: ConsensusEventListener) => () => void;
  /** Optional resolver enriching emitted events with correlation hints. */
  resolveCorrelation?: (event: ConsensusEvent) => EventCorrelationHints | void;
}

/** Options consumed when bridging value guard events to the {@link EventBus}. */
export interface ValueGuardBridgeOptions {
  /** Value graph emitting configuration and plan evaluation telemetry. */
  graph: ValueGraph;
  /** Event bus receiving structured value guard events. */
  bus: EventBus;
  /** Optional subscriber override to facilitate deterministic tests. */
  subscribe?: (listener: ValueGraphEventListener) => () => void;
  /** Optional resolver enriching emitted events with correlation hints. */
  resolveCorrelation?: (event: ValueGraphEvent) => EventCorrelationHints | void;
}

/**
 * Observes cancellation registry notifications and forwards them to the unified
 * bus. The bridge differentiates between brand new requests and idempotent
 * retries so MCP clients can surface the correct severity.
 */
export function bridgeCancellationEvents(options: CancellationBridgeOptions): () => void {
  const { bus, subscribe = subscribeCancellationEvents, resolveCorrelation } = options;

  const unsubscribe = subscribe((event) => {
    // Seed the hints with the identifiers recorded by the cancellation registry
    // and merge resolver outputs afterwards so sparse resolvers cannot wipe the
    // native metadata (while still allowing deliberate overrides with `null`).
    const hints: EventCorrelationHints = {
      opId: event.opId,
      runId: event.runId,
      jobId: event.jobId,
      graphId: event.graphId,
      nodeId: event.nodeId,
      childId: event.childId,
    };
    const resolved = resolveCorrelation?.(event);
    mergeCorrelationHints(hints, resolved ?? undefined);

    const level: EventInput["level"] = event.outcome === "requested" ? "info" : "warn";
    const message = event.outcome === "requested" ? "cancel_requested" : "cancel_repeat";

    bus.publish({
      cat: "cancel",
      level,
      jobId: hints.jobId ?? null,
      runId: hints.runId ?? null,
      opId: hints.opId ?? event.opId,
      graphId: hints.graphId ?? null,
      nodeId: hints.nodeId ?? null,
      childId: hints.childId ?? null,
      msg: message,
      data: {
        opId: event.opId,
        runId: event.runId ?? null,
        jobId: event.jobId ?? null,
        graphId: event.graphId ?? null,
        nodeId: event.nodeId ?? null,
        childId: event.childId ?? null,
        reason: event.reason,
        at: event.at,
        outcome: event.outcome,
      },
    });
  });

  return () => {
    unsubscribe();
  };
}

/**
 * Observes child runtime events and forwards them to the unified bus. Messages
 * are categorised by stream while lifecycle notifications surface spawn/exit
 * transitions so MCP clients can correlate orchestrator decisions.
 */
export function bridgeChildRuntimeEvents(options: ChildRuntimeBridgeOptions): () => void {
  const { runtime, bus, resolveCorrelation } = options;

  const handleCorrelation = (context: ChildRuntimeBridgeContext): EventCorrelationHints => {
    // Always start with the runtime identifier so lifecycle publications stay
    // correlated even when resolvers stay silent.
    const hints: EventCorrelationHints = { childId: runtime.childId };

    if (context.kind === "message") {
      // Children frequently embed correlation hints directly in their payloads;
      // merge them first so resolvers can still override specific fields.
      const payload = context.message.parsed as Record<string, unknown> | null;
      if (payload && typeof payload === "object") {
        const embedded: EventCorrelationHints = {};
        const runId = payload.runId;
        const opId = payload.opId;
        const jobId = payload.jobId;
        const graphId = payload.graphId;
        const nodeId = payload.nodeId;
        const childId = payload.childId;
        if (typeof runId === "string" && runId.length > 0) embedded.runId = runId;
        if (typeof opId === "string" && opId.length > 0) embedded.opId = opId;
        if (typeof jobId === "string" && jobId.length > 0) embedded.jobId = jobId;
        if (typeof graphId === "string" && graphId.length > 0) embedded.graphId = graphId;
        if (typeof nodeId === "string" && nodeId.length > 0) embedded.nodeId = nodeId;
        if (typeof childId === "string" && childId.length > 0) embedded.childId = childId;
        mergeCorrelationHints(hints, embedded);
      }
    }

    const resolved = resolveCorrelation?.(context);
    mergeCorrelationHints(hints, resolved ?? undefined);
    if (hints.childId === undefined) {
      hints.childId = runtime.childId;
    }
    return hints;
  };

  const messageListener = (message: ChildRuntimeMessage) => {
    const correlation = handleCorrelation({ kind: "message", runtime, message });
    const level: EventInput["level"] = message.stream === "stderr" ? "warn" : "info";

    bus.publish({
      cat: "child",
      level,
      childId: correlation.childId ?? null,
      jobId: correlation.jobId ?? null,
      runId: correlation.runId ?? null,
      opId: correlation.opId ?? null,
      graphId: correlation.graphId ?? null,
      nodeId: correlation.nodeId ?? null,
      msg: message.stream === "stderr" ? "child_stderr" : "child_stdout",
      data: {
        childId: runtime.childId,
        stream: message.stream,
        raw: message.raw,
        parsed: message.parsed,
        receivedAt: message.receivedAt,
        sequence: message.sequence,
      },
    });
  };

  const lifecycleListener = (event: ChildRuntimeLifecycleEvent) => {
    const correlation = handleCorrelation({ kind: "lifecycle", runtime, lifecycle: event });

    let level: EventInput["level"] = "info";
    let msg = "child_lifecycle";
    const data: Record<string, unknown> = {
      childId: runtime.childId,
      phase: event.phase,
      at: event.at,
      pid: event.pid,
      forced: event.forced,
      reason: event.reason,
    };

    if (event.phase === "spawned") {
      msg = "child_spawned";
    } else if (event.phase === "exit") {
      msg = "child_exit";
      data.code = event.code;
      data.signal = event.signal;
      if (event.forced || (typeof event.code === "number" && event.code !== 0) || event.signal) {
        level = "warn";
      }
    } else if (event.phase === "error") {
      msg = "child_error";
      level = "error";
    }

    bus.publish({
      cat: "child",
      level,
      childId: correlation.childId ?? null,
      jobId: correlation.jobId ?? null,
      runId: correlation.runId ?? null,
      opId: correlation.opId ?? null,
      graphId: correlation.graphId ?? null,
      nodeId: correlation.nodeId ?? null,
      msg,
      data,
    });
  };

  runtime.on("message", messageListener);
  runtime.on("lifecycle", lifecycleListener);

  return () => {
    runtime.off("message", messageListener);
    runtime.off("lifecycle", lifecycleListener);
  };
}

/**
 * Observes Contract-Net lifecycle events and forwards them to the unified bus
 * so MCP tooling can audit announcements, bids and awards alongside other
 * orchestration streams.
 */
export function bridgeContractNetEvents(options: ContractNetBridgeOptions): () => void {
  const { coordinator, bus, subscribe = (listener) => coordinator.observe(listener), resolveCorrelation } = options;

  const listener: ContractNetEventListener = (event) => {
    const correlation: EventCorrelationHints = {};
    if ("correlation" in event && event.correlation) {
      mergeCorrelationHints(correlation, event.correlation);
    } else if ("call" in event && event.call && "correlation" in event.call && event.call.correlation) {
      mergeCorrelationHints(correlation, event.call.correlation);
    }
    const resolved = resolveCorrelation?.(event);
    if (resolved) {
      mergeCorrelationHints(correlation, resolved);
    }
    let level: EventInput["level"] = "info";
    let msg = "cnp_event";
    let data: Record<string, unknown> = {};

    switch (event.kind) {
      case "agent_registered":
        msg = event.updated ? "cnp_agent_updated" : "cnp_agent_registered";
        data = { agent: event.agent, updated: event.updated };
        break;
      case "agent_unregistered":
        msg = "cnp_agent_unregistered";
        data = { agentId: event.agentId, remainingAssignments: event.remainingAssignments };
        break;
      case "call_announced":
        msg = "cnp_call_announced";
        data = { call: event.call };
        break;
      case "bid_recorded":
        msg = event.previousKind ? "cnp_bid_updated" : "cnp_bid_recorded";
        data = {
          callId: event.callId,
          agentId: event.agentId,
          bid: event.bid,
          previousKind: event.previousKind,
        };
        break;
      case "call_awarded":
        msg = "cnp_call_awarded";
        data = { call: event.call, decision: event.decision };
        break;
      case "call_completed":
        msg = "cnp_call_completed";
        data = { call: event.call };
        break;
      default:
        data = event as Record<string, unknown>;
        break;
    }

    bus.publish({
      cat: "contract_net",
      level,
      jobId: correlation.jobId ?? null,
      runId: correlation.runId ?? null,
      opId: correlation.opId ?? null,
      graphId: correlation.graphId ?? null,
      nodeId: correlation.nodeId ?? null,
      childId: correlation.childId ?? null,
      msg,
      data,
    });
  };

  const dispose = subscribe(listener);
  return () => {
    dispose();
  };
}

/**
 * Observes consensus computation events and forwards them to the unified bus so
 * operators can audit quorum evaluations without adding bespoke hooks.
 */
export function bridgeConsensusEvents(options: ConsensusBridgeOptions): () => void {
  const { bus, subscribe = subscribeConsensusEvents, resolveCorrelation } = options;

  const dispose = subscribe((event) => {
    const correlation: EventCorrelationHints = {
      jobId: event.jobId ?? null,
      runId: event.runId ?? null,
      opId: event.opId ?? null,
    };
    const resolved = resolveCorrelation?.(event);
    mergeCorrelationHints(correlation, resolved ?? undefined);

    let level: EventInput["level"] = event.satisfied ? "info" : "warn";
    let msg = "consensus_decision";
    if (event.tie && !event.outcome) {
      msg = "consensus_tie_unresolved";
      level = "warn";
    } else if (!event.satisfied) {
      msg = "consensus_decision_unsatisfied";
    }

    bus.publish({
      cat: "consensus",
      level,
      jobId: correlation.jobId ?? null,
      runId: correlation.runId ?? null,
      opId: correlation.opId ?? null,
      graphId: correlation.graphId ?? null,
      nodeId: correlation.nodeId ?? null,
      childId: correlation.childId ?? null,
      msg,
      data: {
        source: event.source,
        at: event.at,
        mode: event.mode,
        outcome: event.outcome,
        satisfied: event.satisfied,
        tie: event.tie,
        threshold: event.threshold,
        total_weight: event.totalWeight,
        votes: event.votes,
        tally: event.tally,
        metadata: event.metadata ?? null,
      },
    });
  });

  return () => {
    dispose();
  };
}

/**
 * Observes value guard events and forwards them to the unified bus. The bridge
 * surfaces configuration updates alongside plan evaluations so MCP clients can
 * audit guard outcomes without directly coupling to the `ValueGraph`.
 */
export function bridgeValueEvents(options: ValueGuardBridgeOptions): () => void {
  const {
    graph,
    bus,
    subscribe = (listener: ValueGraphEventListener) => graph.subscribe(listener),
    resolveCorrelation,
  } = options;

  const listener: ValueGraphEventListener = (event) => {
    // Combine the hints emitted by the value graph with optional resolver
    // outputs so tests can inject overrides without losing the original ids.
    const hints: EventCorrelationHints = {};
    mergeCorrelationHints(hints, event.correlation);
    const resolved = resolveCorrelation?.(event);
    mergeCorrelationHints(hints, resolved ?? undefined);
    let level: EventInput["level"] = "info";
    let msg = "values_event";
    let data: Record<string, unknown> = {};

    switch (event.kind) {
      case "config_updated":
        msg = "values_config_updated";
        data = {
          summary: event.summary,
        };
        break;
      case "plan_scored": {
        msg = "values_scored";
        const violations = event.result.violations.length;
        if (violations > 0) {
          level = "warn";
        }
        data = {
          plan_id: event.planId,
          plan_label: event.planLabel,
          impacts_count: event.impacts.length,
          impacts: event.impacts,
          result: event.result,
          violations_count: violations,
        };
        break;
      }
      case "plan_filtered": {
        const allowed = event.decision.allowed;
        msg = allowed ? "values_filter_allowed" : "values_filter_blocked";
        level = allowed ? "info" : "warn";
        data = {
          plan_id: event.planId,
          plan_label: event.planLabel,
          impacts_count: event.impacts.length,
          impacts: event.impacts,
          decision: event.decision,
        };
        break;
      }
      case "plan_explained": {
        const allowed = event.result.decision.allowed;
        msg = allowed ? "values_explain_allowed" : "values_explain_blocked";
        level = allowed ? "info" : "warn";
        data = {
          plan_id: event.planId,
          plan_label: event.planLabel,
          impacts_count: event.impacts.length,
          impacts: event.impacts,
          result: event.result,
        };
        break;
      }
      default:
        data = event as Record<string, unknown>;
        break;
    }

    bus.publish({
      cat: "values",
      level,
      jobId: hints.jobId ?? null,
      runId: hints.runId ?? null,
      opId: hints.opId ?? null,
      graphId: hints.graphId ?? null,
      nodeId: hints.nodeId ?? null,
      childId: hints.childId ?? null,
      msg,
      data,
      ts: event.at,
    });
  };

  const dispose = subscribe(listener);
  return () => {
    dispose();
  };
}
