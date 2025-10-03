import { EventEmitter } from "node:events";

import type { CancellationHandle } from "./cancel.js";

import { CausalMemory } from "../knowledge/causalMemory.js";
import { BehaviorTreeInterpreter } from "./bt/interpreter.js";
import type {
  BehaviorTickResult,
  TickRuntime,
  ToolInvoker,
} from "./bt/types.js";

/** Payload emitted when a task node becomes ready to execute. */
export interface TaskReadyEvent {
  nodeId: string;
  criticality?: number;
  pheromone?: number;
}

/** Payload emitted once a task finished running. */
export interface TaskDoneEvent {
  nodeId: string;
  success: boolean;
  duration_ms?: number;
}

/** Payload emitted when the blackboard mutates. */
export interface BlackboardChangedEvent {
  key: string;
  importance?: number;
}

/** Payload emitted when the stigmergic field evolves. */
export interface StigmergyChangedEvent {
  nodeId: string;
  intensity: number;
  type?: string;
}

/** Mapping of every event name handled by the reactive scheduler. */
export interface SchedulerEventMap {
  taskReady: TaskReadyEvent;
  taskDone: TaskDoneEvent;
  blackboardChanged: BlackboardChangedEvent;
  stigmergyChanged: StigmergyChangedEvent;
}

export type SchedulerEventName = keyof SchedulerEventMap;

/**
 * Event bus used by the scheduler and external components to exchange signals.
 * The API mirrors Node's {@link EventEmitter} while providing type inference on
 * event payloads.
 */
export class ReactiveEventBus {
  private readonly emitter = new EventEmitter();

  on<E extends SchedulerEventName>(event: E, listener: (payload: SchedulerEventMap[E]) => void): this {
    this.emitter.on(event, listener as (payload: unknown) => void);
    return this;
  }

  off<E extends SchedulerEventName>(event: E, listener: (payload: SchedulerEventMap[E]) => void): this {
    this.emitter.off(event, listener as (payload: unknown) => void);
    return this;
  }

  once<E extends SchedulerEventName>(event: E, listener: (payload: SchedulerEventMap[E]) => void): this {
    this.emitter.once(event, listener as (payload: unknown) => void);
    return this;
  }

  emit<E extends SchedulerEventName>(event: E, payload: SchedulerEventMap[E]): boolean {
    return this.emitter.emit(event, payload);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

/** Metadata tracked for every scheduled tick waiting in the queue. */
interface ScheduledTick<E extends SchedulerEventName = SchedulerEventName> {
  id: number;
  event: E;
  payload: SchedulerEventMap[E];
  enqueuedAt: number;
  basePriority: number;
  causalEventId?: string;
}

/**
 * Information surfaced after each tick so observers can inspect the scheduler
 * decisions, mainly for debugging and tests.
 */
export interface SchedulerTickTrace<E extends SchedulerEventName = SchedulerEventName> {
  event: E;
  payload: SchedulerEventMap[E];
  priority: number;
  enqueuedAt: number;
  startedAt: number;
  finishedAt: number;
  result: BehaviorTickResult;
  pendingAfter: number;
}

/** Options accepted by the {@link ReactiveScheduler} constructor. */
export interface ReactiveSchedulerOptions {
  interpreter: BehaviorTreeInterpreter;
  runtime: Partial<TickRuntime> & { invokeTool: ToolInvoker };
  eventBus?: ReactiveEventBus;
  now?: () => number;
  ageWeight?: number;
  basePriorities?: Partial<Record<SchedulerEventName, number>>;
  onTick?: (trace: SchedulerTickTrace) => void;
  getPheromoneIntensity?: (nodeId: string) => number;
  causalMemory?: CausalMemory;
  /** Optional cancellation handle propagated from the orchestrator. */
  cancellation?: CancellationHandle;
}

/** Default base priority assigned to each event type. */
const DEFAULT_BASE_PRIORITIES: Record<SchedulerEventName, number> = {
  taskReady: 100,
  taskDone: 70,
  blackboardChanged: 55,
  stigmergyChanged: 45,
};

/**
 * Reactive scheduler driving the Behaviour Tree interpreter whenever external
 * events indicate that progress can be made. The scheduler maintains a
 * priority-based queue that balances intrinsic criticality (event type),
 * user-provided hints (criticality/intensity) and the time spent waiting.
 */
export class ReactiveScheduler {
  readonly events: ReactiveEventBus;

  private readonly interpreter: BehaviorTreeInterpreter;
  private readonly runtime: Partial<TickRuntime> & { invokeTool: ToolInvoker };
  private readonly now: () => number;
  private readonly ageWeight: number;
  private readonly basePriorities: Record<SchedulerEventName, number>;
  private readonly onTick?: (trace: SchedulerTickTrace) => void;
  private readonly getPheromoneIntensity?: (nodeId: string) => number;
  private readonly causalMemory?: CausalMemory;
  private readonly cancellation?: CancellationHandle;

  private readonly queue: ScheduledTick[] = [];
  private processing = false;
  private scheduled = false;
  private stopped = false;
  private sequence = 0;
  private tickCountInternal = 0;
  private lastResult: BehaviorTickResult = { status: "running" };
  private settleResolvers: Array<{
    resolve: (result: BehaviorTickResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private lastTickResultEventId: string | null = null;
  private currentTickEventId: string | null = null;
  private cancellationSubscription: (() => void) | null = null;

  private readonly taskReadyHandler = (payload: TaskReadyEvent) => {
    this.enqueue("taskReady", payload);
  };
  private readonly taskDoneHandler = (payload: TaskDoneEvent) => {
    this.enqueue("taskDone", payload);
  };
  private readonly blackboardChangedHandler = (payload: BlackboardChangedEvent) => {
    this.enqueue("blackboardChanged", payload);
  };
  private readonly stigmergyChangedHandler = (payload: StigmergyChangedEvent) => {
    this.enqueue("stigmergyChanged", payload);
  };

  constructor(options: ReactiveSchedulerOptions) {
    this.interpreter = options.interpreter;
    this.runtime = options.runtime;
    this.events = options.eventBus ?? new ReactiveEventBus();
    this.now = options.now ?? (() => Date.now());
    this.ageWeight = options.ageWeight ?? 0.01;
    this.basePriorities = {
      ...DEFAULT_BASE_PRIORITIES,
      ...(options.basePriorities ?? {}),
    };
    this.onTick = options.onTick;
    this.getPheromoneIntensity = options.getPheromoneIntensity;
    this.causalMemory = options.causalMemory;
    this.cancellation = options.cancellation;

    this.events.on("taskReady", this.taskReadyHandler);
    this.events.on("taskDone", this.taskDoneHandler);
    this.events.on("blackboardChanged", this.blackboardChangedHandler);
    this.events.on("stigmergyChanged", this.stigmergyChangedHandler);

    if (this.cancellation) {
      this.cancellationSubscription = this.cancellation.onCancel(() => {
        this.stop();
        this.rejectSettlers(this.cancellation!.toError());
      });
    }
  }

  /** Number of ticks executed since the scheduler was created. */
  get tickCount(): number {
    return this.tickCountInternal;
  }

  /** Returns the causal event identifier of the tick currently executing, if any. */
  getCurrentTickCausalEventId(): string | null {
    return this.currentTickEventId;
  }

  /** Stop processing new events and detach listeners from the event bus. */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.events.off("taskReady", this.taskReadyHandler);
    this.events.off("taskDone", this.taskDoneHandler);
    this.events.off("blackboardChanged", this.blackboardChangedHandler);
    this.events.off("stigmergyChanged", this.stigmergyChangedHandler);
    if (this.cancellationSubscription) {
      this.cancellationSubscription();
      this.cancellationSubscription = null;
    }
  }

  /** Enqueue a new event manually. Mainly exposed for tests. */
  emit<E extends SchedulerEventName>(event: E, payload: SchedulerEventMap[E]): void {
    this.enqueue(event, payload);
  }

  /** Wait until the current queue drains or a terminal status is reached. */
  async runUntilSettled<E extends SchedulerEventName>(initialEvent?: {
    type: E;
    payload: SchedulerEventMap[E];
  }): Promise<BehaviorTickResult> {
    this.ensureNotCancelled();
    if (initialEvent) {
      this.enqueue(initialEvent.type, initialEvent.payload);
    }

    if (!this.processing && !this.scheduled) {
      this.scheduleProcessing();
    }

    return new Promise<BehaviorTickResult>((resolve, reject) => {
      const entry = { resolve, reject };
      this.settleResolvers.push(entry);
      if (!this.processing && this.queue.length === 0) {
        try {
          this.ensureNotCancelled();
          this.resolveSettlers();
        } catch (error) {
          this.rejectSettlers(error);
        }
      }
    });
  }

  private enqueue<E extends SchedulerEventName>(event: E, payload: SchedulerEventMap[E]): void {
    if (this.stopped) {
      return;
    }
    if (event === "taskReady") {
      const ready = payload as TaskReadyEvent;
      if (ready.pheromone === undefined && this.getPheromoneIntensity) {
        ready.pheromone = this.getPheromoneIntensity(ready.nodeId);
      }
    }
    if (event === "stigmergyChanged") {
      const change = payload as StigmergyChangedEvent;
      const total = this.getPheromoneIntensity?.(change.nodeId);
      if (total !== undefined) {
        change.intensity = total;
      }
      this.rebalancePheromone(change.nodeId, change.intensity ?? 0);
    }
    const entry: ScheduledTick<E> = {
      id: this.sequence,
      event,
      payload,
      enqueuedAt: this.now(),
      basePriority: this.computeBasePriority(event, payload),
      causalEventId: this.recordCausalEvent(
        `scheduler.event.${event}`,
        this.serialiseEventPayload(event, payload),
        this.buildCauses(this.lastTickResultEventId),
      ) ?? undefined,
    };
    this.sequence += 1;
    this.queue.push(entry);
    this.scheduleProcessing();
  }

  private scheduleProcessing(): void {
    if (this.processing || this.stopped || this.scheduled || this.queue.length === 0) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drainQueue().catch((error) => {
        this.rejectSettlers(error);
      });
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.processing || this.stopped) {
      return;
    }
    this.processing = true;
    try {
      while (!this.stopped && this.queue.length > 0) {
        this.ensureNotCancelled();
        const now = this.now();
        const nextIndex = this.selectNextIndex(now);
        const [next] = this.queue.splice(nextIndex, 1);
        const pendingBefore = this.queue.length + 1;
        const tickStartId = this.recordCausalEvent(
          "scheduler.tick.start",
          {
            event: next.event,
            payload: this.serialiseEventPayload(next.event, next.payload),
            pending_before: pendingBefore,
          },
          this.buildCauses(next.causalEventId, this.lastTickResultEventId),
        );
        this.currentTickEventId = tickStartId ?? null;
        const startedAt = now;
        const result = await this.interpreter.tick(this.runtime);
        const finishedAt = this.now();
        this.tickCountInternal += 1;
        this.lastResult = result;

        const priority = this.computeEffectivePriority(next, startedAt);
        const pendingAfter = this.queue.length;
        this.onTick?.({
          event: next.event,
          payload: next.payload,
          priority,
          enqueuedAt: next.enqueuedAt,
          startedAt,
          finishedAt,
          result,
          pendingAfter,
        });

        const tickResultId = this.recordCausalEvent(
          "scheduler.tick.result",
          {
            event: next.event,
            status: result.status,
            output: this.summariseForCausal("output" in result ? result.output : null),
            priority,
            pending_after: pendingAfter,
          },
          tickStartId ? [tickStartId] : [],
        );
        if (tickResultId) {
          this.lastTickResultEventId = tickResultId;
        }
        this.currentTickEventId = null;

        if (result.status !== "running") {
          this.stop();
          this.resolveSettlers(result);
          return;
        }
      }
    } catch (error) {
      this.currentTickEventId = null;
      this.stop();
      this.rejectSettlers(error);
      throw error;
    } finally {
      this.processing = false;
    }

    if (this.queue.length > 0) {
      this.scheduleProcessing();
      return;
    }

    this.resolveSettlers();
  }

  private resolveSettlers(result?: BehaviorTickResult): void {
    if (this.settleResolvers.length === 0) {
      return;
    }
    const finalResult = result ?? this.lastResult;
    const pending = [...this.settleResolvers];
    this.settleResolvers = [];
    for (const { resolve } of pending) {
      resolve(finalResult);
    }
  }

  private rejectSettlers(error: unknown): void {
    if (this.settleResolvers.length === 0) {
      return;
    }
    const pending = [...this.settleResolvers];
    this.settleResolvers = [];
    for (const { reject } of pending) {
      reject(error);
    }
  }

  private computeBasePriority<E extends SchedulerEventName>(event: E, payload: SchedulerEventMap[E]): number {
    const base = this.basePriorities[event];
    switch (event) {
      case "taskReady": {
        const readyPayload = payload as TaskReadyEvent;
        if (readyPayload.pheromone === undefined && this.getPheromoneIntensity) {
          readyPayload.pheromone = this.getPheromoneIntensity(readyPayload.nodeId);
        }
        const { criticality = 0 } = readyPayload;
        const pheromone = readyPayload.pheromone ?? 0;
        return base + criticality * 10 + pheromone;
      }
      case "taskDone": {
        const { success, duration_ms = 0 } = payload as TaskDoneEvent;
        const penalty = success ? 0 : 20;
        const reward = Math.max(0, 10 - Math.floor(duration_ms / 100));
        return base + penalty + reward;
      }
      case "blackboardChanged": {
        const { importance = 0 } = payload as BlackboardChangedEvent;
        return base + importance * 5;
      }
      case "stigmergyChanged": {
        const { intensity } = payload as StigmergyChangedEvent;
        return base + (intensity ?? 0);
      }
      default: {
        return base;
      }
    }
  }

  private rebalancePheromone(nodeId: string, intensity: number): void {
    for (const entry of this.queue) {
      if (entry.event !== "taskReady") {
        continue;
      }
      const ready = entry.payload as TaskReadyEvent;
      if (ready.nodeId !== nodeId) {
        continue;
      }
      ready.pheromone = intensity;
      entry.basePriority = this.computeBasePriority("taskReady", ready);
    }
  }

  private selectNextIndex(now: number): number {
    let bestIndex = 0;
    let bestPriority = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < this.queue.length; index += 1) {
      const entry = this.queue[index];
      const priority = this.computeEffectivePriority(entry, now);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestIndex = index;
        continue;
      }
      if (priority === bestPriority && entry.id < this.queue[bestIndex]!.id) {
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  private computeEffectivePriority(entry: ScheduledTick, now: number): number {
    const age = Math.max(0, now - entry.enqueuedAt);
    return entry.basePriority + age * this.ageWeight;
  }

  private recordCausalEvent(type: string, data: Record<string, unknown>, causes: string[]): string | null {
    if (!this.causalMemory) {
      return null;
    }
    const snapshot = this.causalMemory.record(
      {
        type,
        data,
        tags: ["scheduler", type],
      },
      causes,
    );
    return snapshot.id;
  }

  private buildCauses(...ids: Array<string | null | undefined>): string[] {
    const causes: string[] = [];
    for (const id of ids) {
      if (typeof id === "string" && id.length > 0 && !causes.includes(id)) {
        causes.push(id);
      }
    }
    return causes;
  }

  private serialiseEventPayload<E extends SchedulerEventName>(event: E, payload: SchedulerEventMap[E]): Record<string, unknown> {
    switch (event) {
      case "taskReady": {
        const ready = payload as TaskReadyEvent;
        return {
          node_id: ready.nodeId,
          criticality: ready.criticality ?? null,
          pheromone: ready.pheromone ?? null,
        };
      }
      case "taskDone": {
        const done = payload as TaskDoneEvent;
        return {
          node_id: done.nodeId,
          success: done.success,
          duration_ms: done.duration_ms ?? null,
        };
      }
      case "blackboardChanged": {
        const change = payload as BlackboardChangedEvent;
        return {
          key: change.key,
          importance: change.importance ?? null,
        };
      }
      case "stigmergyChanged": {
        const change = payload as StigmergyChangedEvent;
        return {
          node_id: change.nodeId,
          intensity: change.intensity ?? null,
          type: change.type ?? null,
        };
      }
      default:
        return {};
    }
  }

  private summariseForCausal(value: unknown, depth = 0): unknown {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    }
    if (Array.isArray(value)) {
      if (depth >= 2) {
        return `array(${value.length})`;
      }
      const preview = value.slice(0, 3).map((item) => this.summariseForCausal(item, depth + 1));
      if (value.length > 3) {
        preview.push(`…${value.length - 3} more`);
      }
      return preview;
    }
    if (typeof value === "object" && value !== undefined) {
      if (depth >= 2) {
        return "object";
      }
      const entries = Object.entries(value as Record<string, unknown>);
      const summary: Record<string, unknown> = {};
      for (const [key, entry] of entries.slice(0, 5)) {
        summary[key] = this.summariseForCausal(entry, depth + 1);
      }
      if (entries.length > 5) {
        summary.__truncated__ = `${entries.length - 5} more`;
      }
      return summary;
    }
    if (typeof value === "undefined") {
      return null;
    }
    return String(value);
  }

  private ensureNotCancelled(): void {
    this.cancellation?.throwIfCancelled();
  }
}
