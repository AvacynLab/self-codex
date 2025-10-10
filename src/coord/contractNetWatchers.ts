import { runtimeTimers, type TimeoutHandle } from "../runtime/timers.js";

import { ContractNetCoordinator, type ContractNetPheromoneBounds } from "./contractNet.js";
import { StigmergyField } from "./stigmergy.js";
import { StructuredLogger } from "../logger.js";

/**
 * Options consumed when synchronising Contract-Net calls with the latest
 * stigmergic bounds. The watcher reacts to every change reported by the
 * {@link StigmergyField} and transparently refreshes heuristic bids so
 * operators do not have to trigger manual updates.
 */
export interface ContractNetPheromoneWatcherOptions {
  /** Stigmergic field emitting intensity changes. */
  field: StigmergyField;
  /** Contract-Net coordinator holding the calls to refresh. */
  contractNet: ContractNetCoordinator;
  /** Optional structured logger used for observability. */
  logger?: StructuredLogger;
  /**
   * When true (default), the watcher reissues heuristic bids so the refreshed
   * snapshots line up with the latest pheromone pressure.
   */
  refreshAutoBids?: boolean;
  /**
   * Controls whether agents registered after the call announcement should be
   * invited to submit heuristic bids during an automatic refresh. Defaults to
   * true so newly available workers participate in the auction.
   */
  includeNewAgents?: boolean;
  /**
   * Duration (milliseconds) used to coalesce successive stigmergy updates
   * before refreshing every open call. Defaults to `50ms`, providing enough
   * time for bursts of pheromone updates (e.g. batch marks) to settle while
   * still keeping the Contract-Net snapshots fresh. Setting the value to `0`
   * disables coalescing and forces immediate refreshes, matching the historic
   * behaviour.
   */
  coalesceWindowMs?: number;
  /**
   * Optional telemetry sink invoked whenever the watcher refreshes or skips a
   * batch of Contract-Net calls. The callback receives cumulative counters so
   * operators can observe how often updates are coalesced or short-circuited.
   */
  onTelemetry?: (snapshot: ContractNetWatcherTelemetrySnapshot) => void;
}

/**
 * Aggregated counters emitted whenever the watcher performs a refresh cycle or
 * detaches. The fields capture both the raw number of stigmergy updates and the
 * amount of work suppressed by the coalescing window.
 */
export interface ContractNetWatcherTelemetrySnapshot {
  /**
   * Reason that triggered the telemetry emission. Useful to distinguish the
   * initial prime, subsequent flushes, and the final snapshot collected when
   * the watcher is detached.
   */
  readonly reason: "initial" | "flush" | "detach";
  /** Total number of change notifications received from the stigmergy field. */
  readonly receivedUpdates: number;
  /**
   * Number of notifications that landed while a coalescing timer was pending
   * and therefore did not trigger an immediate refresh.
   */
  readonly coalescedUpdates: number;
  /**
   * Number of flush attempts skipped because the resolved bounds did not
   * change. This helps quantify how often the watcher avoided unnecessary
   * Contract-Net refreshes.
   */
  readonly skippedRefreshes: number;
  /**
   * Number of refresh operations that actually called
   * {@link ContractNetCoordinator.updateCallPheromoneBounds}. Each refresh may
   * still choose to refresh zero calls if none are open.
   */
  readonly appliedRefreshes: number;
  /** Count of flushes that resolved new bounds regardless of open call count. */
  readonly flushes: number;
  /** Last bounds applied by the watcher (mirrors the coordinator snapshots). */
  readonly lastBounds: ContractNetPheromoneBounds | null;
}

/**
 * Snapshot returned by {@link ContractNetWatcherTelemetryRecorder} aggregating
 * the latest watcher counters and some metadata about the emission cadence.
 */
export interface ContractNetWatcherTelemetryState {
  /**
   * Number of telemetry emissions recorded since the watcher was started. The
   * initial prime counts as the first emission.
   */
  readonly emissions: number;
  /**
   * Epoch millisecond timestamp captured when the last snapshot was recorded.
   * `null` indicates that no telemetry has been observed yet.
   */
  readonly lastEmittedAtMs: number | null;
  /** Latest watcher counters, or `null` when nothing has been recorded. */
  readonly lastSnapshot: ContractNetWatcherTelemetrySnapshot | null;
}

/**
 * Collector recording the latest Contract-Net bounds watcher telemetry. The
 * recorder stores cumulative counters and the timestamp of the last emission so
 * MCP tools can surface up-to-date diagnostics without holding a reference to
 * the watcher itself.
 */
export class ContractNetWatcherTelemetryRecorder {
  private lastSnapshot: ContractNetWatcherTelemetrySnapshot | null = null;
  private emissions = 0;
  private lastEmittedAtMs: number | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Records a new watcher snapshot and updates the aggregated metadata. */
  record(snapshot: ContractNetWatcherTelemetrySnapshot): void {
    this.lastSnapshot = {
      ...snapshot,
      lastBounds: snapshot.lastBounds ? { ...snapshot.lastBounds } : null,
    };
    this.emissions += 1;
    this.lastEmittedAtMs = this.now();
  }

  /** Clears the aggregated counters, useful when restarting the watcher. */
  reset(): void {
    this.lastSnapshot = null;
    this.emissions = 0;
    this.lastEmittedAtMs = null;
  }

  /** Returns the most recent watcher telemetry alongside emission metadata. */
  snapshot(): ContractNetWatcherTelemetryState {
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
export function watchContractNetPheromoneBounds(options: ContractNetPheromoneWatcherOptions): () => void {
  const {
    field,
    contractNet,
    logger,
    refreshAutoBids = true,
    includeNewAgents = true,
    coalesceWindowMs = 50,
    onTelemetry,
  } = options;
  if (!Number.isFinite(coalesceWindowMs) || coalesceWindowMs < 0) {
    throw new Error("coalesceWindowMs must be a finite number greater than or equal to 0");
  }
  let lastBounds: ContractNetPheromoneBounds | null = null;
  let flushTimer: TimeoutHandle | null = null;
  let pendingDirty = false;
  let receivedUpdates = 0;
  let coalescedUpdates = 0;
  let skippedRefreshes = 0;
  let appliedRefreshes = 0;
  let flushes = 0;

  const emitTelemetry = (reason: ContractNetWatcherTelemetrySnapshot["reason"]): void => {
    if (!onTelemetry && !logger) {
      return;
    }
    const snapshot: ContractNetWatcherTelemetrySnapshot = {
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

  const captureBounds = (): ContractNetPheromoneBounds | null => {
    const snapshot = field.getIntensityBounds();
    return {
      min_intensity: snapshot.minIntensity,
      max_intensity: Number.isFinite(snapshot.maxIntensity) ? snapshot.maxIntensity : null,
      normalisation_ceiling: snapshot.normalisationCeiling,
    };
  };

  const refreshOpenCalls = (bounds: ContractNetPheromoneBounds | null): void => {
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
      } catch (error) {
        logger?.warn("contract_net_auto_bounds_refresh_failed", {
          call_id: call.callId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const flush = (reason: "flush" | "detach"): void => {
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

  const scheduleRefresh = (): void => {
    pendingDirty = true;
    if (coalesceWindowMs === 0) {
      flush("flush");
      return;
    }
    if (flushTimer) {
      coalescedUpdates += 1;
      return;
    }
    flushTimer = runtimeTimers.setTimeout(() => {
      flushTimer = null;
      flush("flush");
    }, coalesceWindowMs);
    flushTimer.unref?.();
  };

  const listener = (): void => {
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
      runtimeTimers.clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush("detach");
  };
}

function boundsEqual(
  a: ContractNetPheromoneBounds | null,
  b: ContractNetPheromoneBounds | null,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    almostEqual(a.min_intensity, b.min_intensity) &&
    ((a.max_intensity === null && b.max_intensity === null) ||
      (a.max_intensity !== null && b.max_intensity !== null && almostEqual(a.max_intensity, b.max_intensity))) &&
    almostEqual(a.normalisation_ceiling, b.normalisation_ceiling)
  );
}

function almostEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6;
}
