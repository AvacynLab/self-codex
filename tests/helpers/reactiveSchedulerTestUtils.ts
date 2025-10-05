import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../../src/executor/bt/types.js";

/**
 * Manual clock mirroring {@link setTimeout} semantics so scheduler tests can
 * deterministically drive time-based heuristics without relying on real timers.
 */
export class ManualClock {
  private current = 0;

  private readonly scheduled: Array<{ at: number; resolve: () => void }> = [];

  /** Returns the current virtual timestamp. */
  now(): number {
    return this.current;
  }

  /**
   * Enqueues a virtual timeout resolved once the manual clock reaches the
   * target timestamp. Tests advance the clock explicitly via {@link advance}.
   */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduled.push({ at: this.current + ms, resolve });
    });
  }

  /** Advances the clock by the requested delta. */
  advance(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  /**
   * Jumps directly to the provided timestamp and resolves any pending waits
   * scheduled at or before that instant.
   */
  advanceTo(target: number): void {
    if (target < this.current) {
      this.current = target;
      return;
    }
    this.current = target;
    const remaining: Array<{ at: number; resolve: () => void }> = [];
    for (const entry of this.scheduled) {
      if (entry.at <= this.current) {
        entry.resolve();
      } else {
        remaining.push(entry);
      }
    }
    this.scheduled.length = 0;
    this.scheduled.push(...remaining);
  }
}

/**
 * Behaviour node returning a scripted sequence of results so tests can force
 * the interpreter to execute a predetermined number of ticks.
 */
export class ScriptedNode implements BehaviorNode {
  private index = 0;

  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(
    public readonly id: string,
    private readonly results: BehaviorTickResult[],
  ) {}

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    const result = this.results[Math.min(this.index, this.results.length - 1)];
    this.index += 1;
    this.status = result.status === "running" ? "running" : result.status;
    return result;
  }

  reset(): void {
    // Scripted node intentionally keeps its cursor so the interpreter consumes
    // the configured scenario without restarting from the beginning.
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "scripted-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { index: this.index, status: this.status },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "scripted-node") {
      throw new Error(`expected scripted-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { index?: number; status?: BehaviorNodeSnapshot["status"] } | undefined;
    this.index = typeof state?.index === "number" ? state.index : 0;
    this.status = state?.status ?? "idle";
  }

  getProgress(): number {
    if (this.results.length === 0) {
      return 1;
    }
    const consumed = Math.min(this.index, this.results.length);
    return consumed / this.results.length;
  }
}

/**
 * Behaviour node that simulates CPU-bound work by advancing the manual clock
 * on each tick, letting tests validate batch quantum enforcement.
 */
export class BusyNode implements BehaviorNode {
  private index = 0;

  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(
    public readonly id: string,
    private readonly durations: number[],
    private readonly clock: ManualClock,
  ) {}

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    const duration = this.durations[Math.min(this.index, this.durations.length - 1)];
    this.clock.advance(duration);
    this.index += 1;
    if (this.index >= this.durations.length) {
      this.status = "success";
      return { status: "success" };
    }
    this.status = "running";
    return { status: "running" };
  }

  reset(): void {
    this.status = "idle";
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "busy-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: { index: this.index, status: this.status },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "busy-node") {
      throw new Error(`expected busy-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { index?: number; status?: BehaviorNodeSnapshot["status"] } | undefined;
    this.index = typeof state?.index === "number" ? state.index : 0;
    this.status = state?.status ?? "idle";
  }

  getProgress(): number {
    if (this.durations.length === 0) {
      return 1;
    }
    return Math.min(1, this.index / this.durations.length);
  }
}
