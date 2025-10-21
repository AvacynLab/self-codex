import { mergeCorrelationHints } from "./correlation.js";
import { subscribeConsensusEvents, } from "../coord/consensus.js";
import { subscribeCancellationEvents } from "../executor/cancel.js";
/**
 * Subscribes to the blackboard change stream and publishes structured events on
 * the unified bus. The function returns a disposer so callers can detach the
 * bridge when shutting the orchestrator down.
 */
export function bridgeBlackboardEvents(options) {
    const { blackboard, bus, resolveCorrelation } = options;
    let lastVersion = blackboard.getCurrentVersion();
    const listener = (event) => {
        lastVersion = Math.max(lastVersion, event.version);
        const correlation = resolveCorrelation?.(event) ?? {};
        const level = event.kind === "expire" ? "warn" : "info";
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
            cat: "bb",
            level,
            jobId: correlation.jobId ?? null,
            runId: correlation.runId ?? null,
            opId: correlation.opId ?? null,
            graphId: correlation.graphId ?? null,
            nodeId: correlation.nodeId ?? null,
            childId: correlation.childId ?? null,
            // Promote the mutation kind (SET/DELETE/EXPIRE) so event subscribers can
            // filter with the same tokens exposed by the legacy EventStore feed.
            kind: `BB_${event.kind.toUpperCase()}`,
            msg: `bb_${event.kind}`,
            data: payload,
        });
    };
    const detach = blackboard.watch({ fromVersion: lastVersion, listener });
    return () => {
        detach();
    };
}
/**
 * Observes stigmergic field mutations and mirrors them on the unified bus so
 * downstream MCP clients can reason about pheromone dynamics in real time.
 */
export function bridgeStigmergyEvents(options) {
    const { field, bus, resolveCorrelation } = options;
    const detach = field.onChange((event) => {
        const correlation = resolveCorrelation?.(event) ?? {};
        const bounds = field.getIntensityBounds();
        bus.publish({
            cat: "stig",
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
                bounds: {
                    minIntensity: bounds.minIntensity,
                    maxIntensity: Number.isFinite(bounds.maxIntensity) ? bounds.maxIntensity : null,
                    normalisationCeiling: bounds.normalisationCeiling,
                },
            },
        });
    });
    return () => {
        detach();
    };
}
/**
 * Creates a Contract-Net watcher telemetry listener that records incoming
 * snapshots and forwards them to the unified event bus. The returned callback
 * is safe to feed directly into {@link watchContractNetPheromoneBounds}.
 */
export function createContractNetWatcherTelemetryListener(options) {
    const { bus, recorder, resolveCorrelation } = options;
    return (snapshot) => {
        recorder?.record(snapshot);
        const correlation = resolveCorrelation?.(snapshot) ?? {};
        bus.publish({
            cat: "cnp",
            level: "info",
            jobId: correlation.jobId ?? null,
            runId: correlation.runId ?? null,
            opId: correlation.opId ?? null,
            graphId: correlation.graphId ?? null,
            nodeId: correlation.nodeId ?? null,
            childId: correlation.childId ?? null,
            // Emit a dedicated watcher telemetry token so dashboards can monitor the
            // contract-net supervisor separate from regular auction lifecycle events.
            kind: "CNP_WATCHER_TELEMETRY",
            msg: "cnp_watcher_telemetry",
            data: {
                reason: snapshot.reason,
                received_updates: snapshot.receivedUpdates,
                coalesced_updates: snapshot.coalescedUpdates,
                skipped_refreshes: snapshot.skippedRefreshes,
                applied_refreshes: snapshot.appliedRefreshes,
                flushes: snapshot.flushes,
                last_bounds: snapshot.lastBounds
                    ? {
                        min_intensity: snapshot.lastBounds.min_intensity,
                        max_intensity: snapshot.lastBounds.max_intensity,
                        normalisation_ceiling: snapshot.lastBounds.normalisation_ceiling,
                    }
                    : null,
            },
        });
    };
}
/**
 * Observes cancellation registry notifications and forwards them to the unified
 * bus. The bridge differentiates between brand new requests and idempotent
 * retries so MCP clients can surface the correct severity.
 */
export function bridgeCancellationEvents(options) {
    const { bus, subscribe = subscribeCancellationEvents, resolveCorrelation } = options;
    const unsubscribe = subscribe((event) => {
        // Seed the hints with the identifiers recorded by the cancellation registry
        // and merge resolver outputs afterwards so sparse resolvers cannot wipe the
        // native metadata (while still allowing deliberate overrides with `null`).
        const hints = {
            opId: event.opId,
            runId: event.runId,
            jobId: event.jobId,
            graphId: event.graphId,
            nodeId: event.nodeId,
            childId: event.childId,
        };
        const resolved = resolveCorrelation?.(event);
        if (resolved !== undefined) {
            mergeCorrelationHints(hints, resolved);
        }
        const level = event.outcome === "requested" ? "info" : "warn";
        const message = event.outcome === "requested" ? "cancel_requested" : "cancel_repeat";
        bus.publish({
            cat: "scheduler",
            level,
            jobId: hints.jobId ?? null,
            runId: hints.runId ?? null,
            opId: hints.opId ?? event.opId,
            graphId: hints.graphId ?? null,
            nodeId: hints.nodeId ?? null,
            childId: hints.childId ?? null,
            // Reflect the cancellation channel (REQUESTED/CONFIRMED/...) directly in
            // the kind token so consumers can branch without parsing message bodies.
            kind: message.toUpperCase(),
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
export function bridgeChildRuntimeEvents(options) {
    const { runtime, bus, resolveCorrelation } = options;
    const handleCorrelation = (context) => {
        // Always start with the runtime identifier so lifecycle publications stay
        // correlated even when resolvers stay silent.
        const hints = { childId: runtime.childId };
        if (context.kind === "message") {
            // Children frequently embed correlation hints directly in their payloads;
            // merge them first so resolvers can still override specific fields.
            const payload = context.message.parsed;
            if (payload && typeof payload === "object") {
                const embedded = {};
                const runId = payload.runId;
                const opId = payload.opId;
                const jobId = payload.jobId;
                const graphId = payload.graphId;
                const nodeId = payload.nodeId;
                const childId = payload.childId;
                if (typeof runId === "string" && runId.length > 0)
                    embedded.runId = runId;
                if (typeof opId === "string" && opId.length > 0)
                    embedded.opId = opId;
                if (typeof jobId === "string" && jobId.length > 0)
                    embedded.jobId = jobId;
                if (typeof graphId === "string" && graphId.length > 0)
                    embedded.graphId = graphId;
                if (typeof nodeId === "string" && nodeId.length > 0)
                    embedded.nodeId = nodeId;
                if (typeof childId === "string" && childId.length > 0)
                    embedded.childId = childId;
                mergeCorrelationHints(hints, embedded);
            }
        }
        const resolved = resolveCorrelation?.(context);
        if (resolved !== undefined) {
            mergeCorrelationHints(hints, resolved);
        }
        if (hints.childId === undefined) {
            hints.childId = runtime.childId;
        }
        return hints;
    };
    const messageListener = (message) => {
        const correlation = handleCorrelation({ kind: "message", runtime, message });
        const level = message.stream === "stderr" ? "warn" : "info";
        const msg = message.stream === "stderr" ? "child_stderr" : "child_stdout";
        bus.publish({
            cat: "child",
            level,
            childId: correlation.childId ?? null,
            jobId: correlation.jobId ?? null,
            runId: correlation.runId ?? null,
            opId: correlation.opId ?? null,
            graphId: correlation.graphId ?? null,
            nodeId: correlation.nodeId ?? null,
            // Preserve the stream origin to disambiguate stdout vs stderr lines in
            // the consolidated bus feed.
            kind: msg === "child_stderr" ? "CHILD_STDERR" : "CHILD_STDOUT",
            msg,
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
    const lifecycleListener = (event) => {
        const correlation = handleCorrelation({ kind: "lifecycle", runtime, lifecycle: event });
        const base = {
            cat: "child",
            childId: correlation.childId ?? null,
            jobId: correlation.jobId ?? null,
            runId: correlation.runId ?? null,
            opId: correlation.opId ?? null,
            graphId: correlation.graphId ?? null,
            nodeId: correlation.nodeId ?? null,
        };
        switch (event.phase) {
            case "spawned": {
                bus.publish({
                    ...base,
                    level: "info",
                    kind: "CHILD_SPAWNED",
                    msg: "child_spawned",
                    data: {
                        childId: runtime.childId,
                        phase: event.phase,
                        at: event.at,
                        pid: event.pid,
                        forced: event.forced,
                        reason: null,
                    },
                });
                break;
            }
            case "exit": {
                const level = event.forced || (typeof event.code === "number" && event.code !== 0) || event.signal ? "warn" : "info";
                bus.publish({
                    ...base,
                    level,
                    kind: "CHILD_EXIT",
                    msg: "child_exit",
                    data: {
                        childId: runtime.childId,
                        phase: event.phase,
                        at: event.at,
                        pid: event.pid,
                        forced: event.forced,
                        reason: event.reason,
                        code: event.code,
                        signal: event.signal,
                    },
                });
                break;
            }
            case "error": {
                bus.publish({
                    ...base,
                    level: "error",
                    kind: "CHILD_ERROR",
                    msg: "child_error",
                    data: {
                        childId: runtime.childId,
                        phase: event.phase,
                        at: event.at,
                        pid: event.pid,
                        forced: event.forced,
                        reason: event.reason,
                    },
                });
                break;
            }
            default: {
                const neverEvent = event;
                throw new TypeError(`unsupported child lifecycle phase: ${neverEvent.phase}`);
            }
        }
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
export function bridgeContractNetEvents(options) {
    const { coordinator, bus, subscribe = (listener) => coordinator.observe(listener), resolveCorrelation } = options;
    const listener = (event) => {
        const correlation = {};
        if ("correlation" in event && event.correlation) {
            mergeCorrelationHints(correlation, event.correlation);
        }
        else if ("call" in event && event.call && "correlation" in event.call && event.call.correlation) {
            mergeCorrelationHints(correlation, event.call.correlation);
        }
        const resolved = resolveCorrelation?.(event);
        if (resolved) {
            mergeCorrelationHints(correlation, resolved);
        }
        const base = {
            cat: "cnp",
            level: "info",
            jobId: correlation.jobId ?? null,
            runId: correlation.runId ?? null,
            opId: correlation.opId ?? null,
            graphId: correlation.graphId ?? null,
            nodeId: correlation.nodeId ?? null,
            childId: correlation.childId ?? null,
        };
        switch (event.kind) {
            case "agent_registered": {
                const msg = event.updated ? "cnp_agent_updated" : "cnp_agent_registered";
                bus.publish({
                    ...base,
                    kind: msg.toUpperCase(),
                    msg,
                    data: {
                        kind: event.updated ? "agent_updated" : "agent_registered",
                        agent: event.agent,
                        updated: event.updated,
                    },
                });
                break;
            }
            case "agent_unregistered": {
                bus.publish({
                    ...base,
                    kind: "CNP_AGENT_UNREGISTERED",
                    msg: "cnp_agent_unregistered",
                    data: {
                        kind: "agent_unregistered",
                        agentId: event.agentId,
                        remainingAssignments: event.remainingAssignments,
                    },
                });
                break;
            }
            case "call_announced": {
                bus.publish({
                    ...base,
                    kind: "CNP_CALL_ANNOUNCED",
                    msg: "cnp_call_announced",
                    data: {
                        kind: "call_announced",
                        call: event.call,
                    },
                });
                break;
            }
            case "bid_recorded": {
                const msg = event.previousKind ? "cnp_bid_updated" : "cnp_bid_recorded";
                bus.publish({
                    ...base,
                    kind: msg.toUpperCase(),
                    msg,
                    data: {
                        kind: event.previousKind ? "bid_updated" : "bid_recorded",
                        callId: event.callId,
                        agentId: event.agentId,
                        bid: event.bid,
                        previousKind: event.previousKind,
                    },
                });
                break;
            }
            case "call_awarded": {
                bus.publish({
                    ...base,
                    kind: "CNP_CALL_AWARDED",
                    msg: "cnp_call_awarded",
                    data: {
                        kind: "call_awarded",
                        call: event.call,
                        decision: event.decision,
                    },
                });
                break;
            }
            case "call_bounds_updated": {
                bus.publish({
                    ...base,
                    kind: "CNP_CALL_BOUNDS_UPDATED",
                    msg: "cnp_call_bounds_updated",
                    data: {
                        kind: "call_bounds_updated",
                        call: event.call,
                        bounds: event.bounds,
                        refresh: {
                            requested: event.refresh.requested,
                            includeNewAgents: event.refresh.includeNewAgents,
                            autoBidRefreshed: event.refresh.autoBidRefreshed,
                            refreshedAgents: [...event.refresh.refreshedAgents],
                        },
                    },
                });
                break;
            }
            case "call_completed": {
                bus.publish({
                    ...base,
                    kind: "CNP_CALL_COMPLETED",
                    msg: "cnp_call_completed",
                    data: {
                        kind: "call_completed",
                        call: event.call,
                    },
                });
                break;
            }
            default: {
                bus.publish({
                    ...base,
                    kind: "CNP_EVENT",
                    msg: "cnp_event",
                    data: event,
                });
                break;
            }
        }
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
export function bridgeConsensusEvents(options) {
    const { bus, subscribe = subscribeConsensusEvents, resolveCorrelation } = options;
    const dispose = subscribe((event) => {
        const correlation = {
            jobId: event.jobId ?? null,
            runId: event.runId ?? null,
            opId: event.opId ?? null,
        };
        const resolved = resolveCorrelation?.(event);
        if (resolved !== undefined) {
            mergeCorrelationHints(correlation, resolved);
        }
        const msg = event.tie && !event.outcome
            ? "consensus_tie_unresolved"
            : event.satisfied
                ? "consensus_decision"
                : "consensus_decision_unsatisfied";
        const level = msg === "consensus_decision" && event.satisfied ? "info" : "warn";
        bus.publish({
            cat: "consensus",
            level,
            jobId: correlation.jobId ?? null,
            runId: correlation.runId ?? null,
            opId: correlation.opId ?? null,
            graphId: correlation.graphId ?? null,
            nodeId: correlation.nodeId ?? null,
            childId: correlation.childId ?? null,
            // Publish the consensus phase (ROUND_STARTED/DECIDED/...) to keep SSE
            // identifiers stable across transports.
            kind: msg.toUpperCase(),
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
export function bridgeValueEvents(options) {
    const { graph, bus, subscribe = (listener) => graph.subscribe(listener), resolveCorrelation, } = options;
    const listener = (event) => {
        // Combine the hints emitted by the value graph with optional resolver
        // outputs so tests can inject overrides without losing the original ids.
        const hints = {};
        mergeCorrelationHints(hints, event.correlation);
        const resolved = resolveCorrelation?.(event);
        if (resolved !== undefined) {
            mergeCorrelationHints(hints, resolved);
        }
        const base = {
            cat: "values",
            jobId: hints.jobId ?? null,
            runId: hints.runId ?? null,
            opId: hints.opId ?? null,
            graphId: hints.graphId ?? null,
            nodeId: hints.nodeId ?? null,
            childId: hints.childId ?? null,
            ts: event.at,
        };
        switch (event.kind) {
            case "config_updated": {
                bus.publish({
                    ...base,
                    level: "info",
                    kind: "VALUES_CONFIG_UPDATED",
                    msg: "values_config_updated",
                    data: {
                        summary: event.summary,
                    },
                });
                break;
            }
            case "plan_scored": {
                const violations = event.result.violations.length;
                const level = violations > 0 ? "warn" : "info";
                bus.publish({
                    ...base,
                    level,
                    kind: "VALUES_SCORED",
                    msg: "values_scored",
                    data: {
                        plan_id: event.planId,
                        plan_label: event.planLabel,
                        impacts_count: event.impacts.length,
                        impacts: event.impacts,
                        result: event.result,
                        violations_count: violations,
                    },
                });
                break;
            }
            case "plan_filtered": {
                const allowed = event.decision.allowed;
                const level = allowed ? "info" : "warn";
                bus.publish({
                    ...base,
                    level,
                    kind: allowed ? "VALUES_FILTER_ALLOWED" : "VALUES_FILTER_BLOCKED",
                    msg: allowed ? "values_filter_allowed" : "values_filter_blocked",
                    data: {
                        plan_id: event.planId,
                        plan_label: event.planLabel,
                        impacts_count: event.impacts.length,
                        impacts: event.impacts,
                        decision: event.decision,
                    },
                });
                break;
            }
            case "plan_explained": {
                const allowed = event.result.decision.allowed;
                const level = allowed ? "info" : "warn";
                bus.publish({
                    ...base,
                    level,
                    kind: allowed ? "VALUES_EXPLAIN_ALLOWED" : "VALUES_EXPLAIN_BLOCKED",
                    msg: allowed ? "values_explain_allowed" : "values_explain_blocked",
                    data: {
                        plan_id: event.planId,
                        plan_label: event.planLabel,
                        impacts_count: event.impacts.length,
                        impacts: event.impacts,
                        result: event.result,
                    },
                });
                break;
            }
            default: {
                bus.publish({
                    ...base,
                    level: "info",
                    kind: "VALUES_EVENT",
                    msg: "values_event",
                    data: event,
                });
                break;
            }
        }
    };
    const dispose = subscribe(listener);
    return () => {
        dispose();
    };
}
//# sourceMappingURL=bridges.js.map