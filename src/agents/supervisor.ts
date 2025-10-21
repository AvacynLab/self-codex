import { StructuredLogger } from "../logger.js";
import type { ChildRecordSnapshot } from "../state/childrenIndex.js";
import type { LoopReconciler, LoopTickContext } from "../executor/loop.js";
import type { LoopAlert } from "../guard/loopDetector.js";
import { extractCorrelationHints, type EventCorrelationHints } from "../events/correlation.js";

/**
 * Minimal subset of the {@link ChildSupervisor} consumed by the supervisor.
 * The abstraction keeps the class easy to test by allowing lightweight doubles
 * to stand in for the real supervisor used by the server.
 */
export interface SupervisorChildManager {
  /** Lifecycle index exposing the current set of children. */
  readonly childrenIndex: {
    list(): ChildRecordSnapshot[];
  };
  /** Requests a graceful stop for a misbehaving child. */
  cancel(childId: string, options?: { timeoutMs?: number }): Promise<unknown>;
  /** Optional forceful stop fallback when graceful shutdown fails. */
  kill?(childId: string, options?: { timeoutMs?: number }): Promise<unknown>;
}

/** Incident types surfaced by the supervisor. */
export type SupervisorIncidentType = "loop" | "stagnation" | "starvation";

/** Severity levels attached to incidents. */
export type SupervisorIncidentSeverity = "info" | "warning" | "critical";

/** Structured description of an incident emitted by the supervisor. */
export interface SupervisorIncident {
  readonly type: SupervisorIncidentType;
  readonly severity: SupervisorIncidentSeverity;
  readonly reason: string;
  readonly context: Record<string, unknown>;
}

/** Runtime metrics produced by the scheduler after each tick. */
export interface SupervisorSchedulerSnapshot {
  /** Tick index reported by the scheduler. */
  readonly schedulerTick: number;
  /** Number of pending tasks waiting for execution. */
  readonly backlog: number;
  /** Number of tasks that completed successfully during the tick. */
  readonly completed: number;
  /** Number of tasks that failed during the tick. */
  readonly failed: number;
}

/** Optional callbacks triggered when the supervisor escalates an incident. */
export interface SupervisorActions {
  requestRewrite?(incident: SupervisorIncident): Promise<void> | void;
  requestRedispatch?(incident: SupervisorIncident): Promise<void> | void;
  emitAlert?(incident: SupervisorIncident): Promise<void> | void;
}

/** Options accepted when constructing an {@link OrchestratorSupervisor}. */
export interface OrchestratorSupervisorOptions {
  childManager: SupervisorChildManager;
  logger?: StructuredLogger;
  actions?: SupervisorActions;
  now?: () => number;
  stagnationTickThreshold?: number;
  stagnationBacklogThreshold?: number;
  starvationIdleMs?: number;
  starvationRepeatMs?: number;
}

/**
 * Contract satisfied by supervisor implementations registered in orchestrator
 * contexts. Tests rely on the interface to provide lightweight doubles without
 * bypassing the type system via double assertions.
 */
export interface OrchestratorSupervisorContract extends LoopReconciler {
  /** Identifier surfaced in execution loop diagnostics and lifecycle events. */
  readonly id: string;
  /** Records the latest scheduler snapshot emitted after a loop tick. */
  recordSchedulerSnapshot(snapshot: SupervisorSchedulerSnapshot): void;
  /** Retrieves the most recent scheduler snapshot alongside its timestamp. */
  getLastSchedulerSnapshot(): (SupervisorSchedulerSnapshot & { updatedAt: number }) | null;
  /** Processes loop alerts raised by the loop detector. */
  recordLoopAlert(alert: LoopAlert | null): Promise<void>;
}

/**
 * Supervisor observing scheduler progress, loop alerts and child inactivity to
 * initiate mitigating actions. The component implements {@link LoopReconciler}
 * so it can be registered alongside the autoscaler inside the execution loop.
 */
export class OrchestratorSupervisor implements OrchestratorSupervisorContract {
  /** Identifier surfaced in execution loop diagnostics and lifecycle events. */
  public readonly id = "supervisor";

  private readonly childManager: SupervisorChildManager;
  private readonly logger?: StructuredLogger;
  private readonly actions: Required<SupervisorActions>;
  private readonly now: () => number;
  private readonly stagnationTickThreshold: number;
  private readonly stagnationBacklogThreshold: number;
  private readonly starvationIdleMs: number;
  private readonly starvationRepeatMs: number;

  private lastSchedulerSnapshot: SupervisorSchedulerSnapshot | null = null;
  private lastSchedulerSnapshotAt: number | null = null;
  private lastBacklog = 0;
  private lastProgressTick = 0;
  private lastProgressAt = 0;
  private lastStagnationAlertTick: number | null = null;
  private lastStarvationAlertAt: number | null = null;
  private handledLoopSignatures = new Set<string>();

  constructor(options: OrchestratorSupervisorOptions) {
    this.childManager = options.childManager;
    if (options.logger) {
      // The optional logger is only persisted when explicitly provided so the
      // instance never assigns an `undefined` placeholder under strict optional
      // property typing.
      this.logger = options.logger;
    }
    this.now = options.now ?? Date.now;
    this.stagnationTickThreshold = Math.max(1, options.stagnationTickThreshold ?? 6);
    this.stagnationBacklogThreshold = Math.max(1, options.stagnationBacklogThreshold ?? 3);
    this.starvationIdleMs = Math.max(1_000, options.starvationIdleMs ?? 45_000);
    this.starvationRepeatMs = Math.max(5_000, options.starvationRepeatMs ?? 60_000);

    const defaultActions: Required<SupervisorActions> = {
      requestRewrite: async (incident) => {
        this.logger?.warn("supervisor_request_rewrite", incident.context);
      },
      requestRedispatch: async (incident) => {
        this.logger?.warn("supervisor_request_redispatch", incident.context);
      },
      emitAlert: async (incident) => {
        const level = incident.severity === "critical" ? "error" : "warn";
        this.logger?.[level === "error" ? "error" : "warn"]("supervisor_incident", incident);
      },
    };

    const overridesEntries = Object.entries(options.actions ?? {}).filter(
      (entry): entry is [keyof SupervisorActions, NonNullable<SupervisorActions[keyof SupervisorActions]>] =>
        entry[1] !== undefined,
    );
    // Undefined overrides are filtered above so every entry in the merged
    // structure is concrete, allowing the cast to `Required<>` without
    // surfacing assignments to `undefined` when strict optional typing is
    // enabled.
    this.actions = {
      ...defaultActions,
      ...Object.fromEntries(overridesEntries),
    } as Required<SupervisorActions>;
  }

  /**
   * Records the latest scheduler snapshot so the supervisor can detect lack of
   * progress across multiple loop ticks.
   */
  recordSchedulerSnapshot(snapshot: SupervisorSchedulerSnapshot): void {
    const backlog = Math.max(0, Math.floor(snapshot.backlog));
    const completed = Math.max(0, Math.floor(snapshot.completed));
    const failed = Math.max(0, Math.floor(snapshot.failed));

    const progress = completed > 0 || failed > 0 || backlog < this.lastBacklog;
    if (progress) {
      this.lastProgressTick = snapshot.schedulerTick;
      this.lastProgressAt = this.now();
      this.lastStagnationAlertTick = null;
    }

    this.lastBacklog = backlog;
    this.lastSchedulerSnapshot = {
      schedulerTick: snapshot.schedulerTick,
      backlog,
      completed,
      failed,
    };
    this.lastSchedulerSnapshotAt = this.now();
  }

  /** Returns the latest scheduler snapshot recorded by the supervisor. */
  getLastSchedulerSnapshot(): (SupervisorSchedulerSnapshot & { updatedAt: number }) | null {
    if (!this.lastSchedulerSnapshot || this.lastSchedulerSnapshotAt === null) {
      return null;
    }
    return {
      schedulerTick: this.lastSchedulerSnapshot.schedulerTick,
      backlog: this.lastSchedulerSnapshot.backlog,
      completed: this.lastSchedulerSnapshot.completed,
      failed: this.lastSchedulerSnapshot.failed,
      updatedAt: this.lastSchedulerSnapshotAt,
    };
  }

  /**
   * Processes a loop alert reported by the {@link LoopDetector}. The supervisor
   * escalates critical loops by cancelling affected children and emits rewrite
   * requests for persistent warnings.
   */
  async recordLoopAlert(alert: LoopAlert | null): Promise<void> {
    if (!alert) {
      return;
    }

    const signatureKey = `${alert.signature}|${alert.childIds.sort().join(",")}`;
    if (this.handledLoopSignatures.has(signatureKey)) {
      return;
    }
    this.handledLoopSignatures.add(signatureKey);

    const incident: SupervisorIncident = {
      type: "loop",
      severity: alert.recommendation === "kill" ? "critical" : "warning",
      reason: alert.reason,
      context: {
        signature: alert.signature,
        recommendation: alert.recommendation,
        child_ids: alert.childIds,
        participants: alert.participants,
        occurrences: alert.occurrences,
        first_timestamp: alert.firstTimestamp,
        last_timestamp: alert.lastTimestamp,
      },
    };

    await this.actions.emitAlert(incident);

    if (alert.recommendation === "kill" && alert.childIds.length > 0) {
      for (const childId of alert.childIds) {
        await this.terminateChild(childId);
      }
    } else {
      await this.actions.requestRewrite(incident);
    }
  }

  /** Implements the {@link LoopReconciler} interface. */
  async reconcile(context: LoopTickContext): Promise<void> {
    const snapshot = this.lastSchedulerSnapshot;
    if (!snapshot) {
      return;
    }

    const ticksWithoutProgress = context.tickIndex - this.lastProgressTick;
    const stagnationActive =
      snapshot.backlog >= this.stagnationBacklogThreshold &&
      ticksWithoutProgress >= this.stagnationTickThreshold;

    if (stagnationActive) {
      if (this.lastStagnationAlertTick === null || context.tickIndex - this.lastStagnationAlertTick >= this.stagnationTickThreshold) {
        const incident: SupervisorIncident = {
          type: "stagnation",
          severity: "warning",
          reason: "scheduler_backlog_stalled",
          context: {
            backlog: snapshot.backlog,
            ticks_without_progress: ticksWithoutProgress,
            last_progress_tick: this.lastProgressTick,
            last_progress_at: this.lastProgressAt,
          },
        };
        this.lastStagnationAlertTick = context.tickIndex;
        await this.actions.emitAlert(incident);
        await this.actions.requestRewrite(incident);
        await this.actions.requestRedispatch(incident);
      }
    }

    await this.detectStarvation(context.now());
  }

  /** Resets previously seen loop signatures (mainly for tests). */
  resetLoopCache(): void {
    this.handledLoopSignatures.clear();
  }

  private async detectStarvation(now: number): Promise<void> {
    const snapshot = this.lastSchedulerSnapshot;
    if (!snapshot || snapshot.backlog <= 0) {
      this.lastStarvationAlertAt = null;
      return;
    }

    const idleCandidates = this.childManager
      .childrenIndex
      .list()
      .filter((child) => this.isIdleCandidate(child, now));

    if (idleCandidates.length === 0) {
      this.lastStarvationAlertAt = null;
      return;
    }

    if (this.lastStarvationAlertAt && now - this.lastStarvationAlertAt < this.starvationRepeatMs) {
      return;
    }

    const worst = idleCandidates.reduce((current, next) => (next.lastHeartbeatAt ?? next.startedAt) < (current.lastHeartbeatAt ?? current.startedAt) ? next : current);

    const incident: SupervisorIncident = {
      type: "starvation",
      severity: "warning",
      reason: "idle_children_with_backlog",
      context: {
        backlog: snapshot.backlog,
        idle_children: idleCandidates.map((child) => child.childId),
        idle_duration_ms: now - (worst.lastHeartbeatAt ?? worst.startedAt),
        threshold_ms: this.starvationIdleMs,
      },
    };

    this.lastStarvationAlertAt = now;
    await this.actions.emitAlert(incident);
    await this.actions.requestRedispatch(incident);
  }

  private isIdleCandidate(child: ChildRecordSnapshot, now: number): boolean {
    const state = child.state;
    if (!["ready", "idle", "running"].includes(state)) {
      return false;
    }
    const lastActivity = child.lastHeartbeatAt ?? child.startedAt;
    return now - lastActivity >= this.starvationIdleMs;
  }

  private async terminateChild(childId: string): Promise<void> {
    try {
      await this.childManager.cancel(childId, { timeoutMs: 250 });
      this.logger?.warn("supervisor_cancelled_child", { child_id: childId });
    } catch (error) {
      this.logger?.warn("supervisor_cancel_failed", {
        child_id: childId,
        message: error instanceof Error ? error.message : String(error),
      });
      if (this.childManager.kill) {
        try {
          await this.childManager.kill(childId, { timeoutMs: 200 });
          this.logger?.error("supervisor_killed_child", { child_id: childId });
        } catch (killError) {
          this.logger?.error("supervisor_kill_failed", {
            child_id: childId,
            message: killError instanceof Error ? killError.message : String(killError),
          });
        }
      }
    }
  }
}

/**
 * Extracts correlation hints from a supervisor incident so downstream
 * orchestrator events can expose run/op identifiers when they are included in
 * the incident context. The helper accepts both camelCase and snake_case
 * fields and tolerates arrays when a single identifier is available.
 */
export function inferSupervisorIncidentCorrelation(incident: SupervisorIncident): EventCorrelationHints {
  return extractCorrelationHints(incident.context);
}
