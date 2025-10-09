/**
 * Collector recording the latest Contract-Net bounds watcher telemetry. The
 * recorder stores cumulative counters and the timestamp of the last emission so
 * MCP tools can surface up-to-date diagnostics without holding a reference to
 * the watcher itself.
 */
export class ContractNetWatcherTelemetryRecorder {
    now;
    lastSnapshot = null;
    emissions = 0;
    lastEmittedAtMs = null;
    constructor(now = () => Date.now()) {
        this.now = now;
    }
    /** Records a new watcher snapshot and updates the aggregated metadata. */
    record(snapshot) {
        this.lastSnapshot = {
            ...snapshot,
            lastBounds: snapshot.lastBounds ? { ...snapshot.lastBounds } : null,
        };
        this.emissions += 1;
        this.lastEmittedAtMs = this.now();
    }
    /** Clears the aggregated counters, useful when restarting the watcher. */
    reset() {
        this.lastSnapshot = null;
        this.emissions = 0;
        this.lastEmittedAtMs = null;
    }
    /** Returns the most recent watcher telemetry alongside emission metadata. */
    snapshot() {
        return {
            emissions: this.emissions,
            lastEmittedAtMs: this.lastEmittedAtMs,
            lastSnapshot: this.lastSnapshot
                ? {
                    ...this.lastSnapshot,
                    lastBounds: this.lastSnapshot.lastBounds ? { ...this.lastSnapshot.lastBounds } : null,
                }
                : null,
        };
    }
}
/**
 * Subscribes to stigmergy updates and refreshes the pheromone bounds of every
 * open Contract-Net call whenever the normalisation ceiling changes.
 */
export function watchContractNetPheromoneBounds(options) {
    const { field, contractNet, logger, refreshAutoBids = true, includeNewAgents = true, coalesceWindowMs = 50, onTelemetry, } = options;
    if (!Number.isFinite(coalesceWindowMs) || coalesceWindowMs < 0) {
        throw new Error("coalesceWindowMs must be a finite number greater than or equal to 0");
    }
    let lastBounds = null;
    let flushTimer = null;
    let pendingDirty = false;
    let receivedUpdates = 0;
    let coalescedUpdates = 0;
    let skippedRefreshes = 0;
    let appliedRefreshes = 0;
    let flushes = 0;
    const emitTelemetry = (reason) => {
        if (!onTelemetry && !logger) {
            return;
        }
        const snapshot = {
            reason,
            receivedUpdates,
            coalescedUpdates,
            skippedRefreshes,
            appliedRefreshes,
            flushes,
            lastBounds: lastBounds ? { ...lastBounds } : null,
        };
        onTelemetry?.(snapshot);
        logger?.debug?.("contract_net_bounds_watcher_telemetry", {
            reason,
            received_updates: snapshot.receivedUpdates,
            coalesced_updates: snapshot.coalescedUpdates,
            skipped_refreshes: snapshot.skippedRefreshes,
            applied_refreshes: snapshot.appliedRefreshes,
            last_bounds: snapshot.lastBounds,
        });
    };
    const captureBounds = () => {
        const snapshot = field.getIntensityBounds();
        return {
            min_intensity: snapshot.minIntensity,
            max_intensity: Number.isFinite(snapshot.maxIntensity) ? snapshot.maxIntensity : null,
            normalisation_ceiling: snapshot.normalisationCeiling,
        };
    };
    const refreshOpenCalls = (bounds) => {
        const openCalls = contractNet.listOpenCalls();
        if (openCalls.length === 0) {
            return;
        }
        appliedRefreshes += 1;
        for (const call of openCalls) {
            try {
                const result = contractNet.updateCallPheromoneBounds(call.callId, bounds, {
                    refreshAutoBids,
                    includeNewAgents,
                });
                logger?.info("contract_net_auto_bounds_refresh", {
                    call_id: call.callId,
                    refreshed_agents: result.refreshedAgents.length,
                    auto_bid_refreshed: result.autoBidRefreshed,
                    bounds: result.pheromoneBounds,
                });
            }
            catch (error) {
                logger?.warn("contract_net_auto_bounds_refresh_failed", {
                    call_id: call.callId,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    };
    const flush = (reason) => {
        const shouldProcess = pendingDirty;
        pendingDirty = false;
        if (!shouldProcess) {
            if (reason === "detach") {
                emitTelemetry("detach");
            }
            return;
        }
        const bounds = captureBounds();
        if (boundsEqual(bounds, lastBounds)) {
            skippedRefreshes += 1;
            emitTelemetry(reason);
            return;
        }
        lastBounds = bounds ? { ...bounds } : null;
        flushes += 1;
        refreshOpenCalls(lastBounds ? { ...lastBounds } : null);
        emitTelemetry(reason);
    };
    const scheduleRefresh = () => {
        pendingDirty = true;
        if (coalesceWindowMs === 0) {
            flush("flush");
            return;
        }
        if (flushTimer) {
            coalescedUpdates += 1;
            return;
        }
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flush("flush");
        }, coalesceWindowMs);
        flushTimer.unref?.();
    };
    const listener = () => {
        receivedUpdates += 1;
        scheduleRefresh();
    };
    // Prime the watcher so calls announced before the subscription stays aligned.
    lastBounds = captureBounds();
    refreshOpenCalls(lastBounds ? { ...lastBounds } : null);
    emitTelemetry("initial");
    const detach = field.onChange(listener);
    return () => {
        detach();
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        flush("detach");
    };
}
function boundsEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    return (almostEqual(a.min_intensity, b.min_intensity) &&
        ((a.max_intensity === null && b.max_intensity === null) ||
            (a.max_intensity !== null && b.max_intensity !== null && almostEqual(a.max_intensity, b.max_intensity))) &&
        almostEqual(a.normalisation_ceiling, b.normalisation_ceiling));
}
function almostEqual(a, b) {
    return Math.abs(a - b) <= 1e-6;
}
//# sourceMappingURL=contractNetWatchers.js.map