import { EventEmitter } from "node:events";
/**
 * Event bus used by the scheduler and external components to exchange signals.
 * The API mirrors Node's {@link EventEmitter} while providing type inference on
 * event payloads.
 */
export class ReactiveEventBus {
    emitter = new EventEmitter();
    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }
    off(event, listener) {
        this.emitter.off(event, listener);
        return this;
    }
    once(event, listener) {
        this.emitter.once(event, listener);
        return this;
    }
    emit(event, payload) {
        return this.emitter.emit(event, payload);
    }
    removeAllListeners() {
        this.emitter.removeAllListeners();
    }
}
/** Default base priority assigned to each event type. */
const DEFAULT_BASE_PRIORITIES = {
    taskReady: 100,
    taskDone: 70,
    blackboardChanged: 55,
    stigmergyChanged: 45,
};
const DEFAULT_AGING_HALF_LIFE_MS = 3000;
const DEFAULT_AGING_FAIRNESS_BOOST = 35;
const DEFAULT_BATCH_QUANTUM_MS = 24;
const DEFAULT_MAX_BATCH_TICKS = 12;
/**
 * Reactive scheduler driving the Behaviour Tree interpreter whenever external
 * events indicate that progress can be made. The scheduler maintains a
 * priority-based queue that balances intrinsic criticality (event type),
 * user-provided hints (criticality/intensity) and the time spent waiting.
 */
export class ReactiveScheduler {
    events;
    interpreter;
    runtime;
    now;
    ageWeight;
    agingHalfLifeMs;
    agingFairnessBoost;
    basePriorities;
    onTick;
    getPheromoneIntensity;
    getPheromoneBounds;
    causalMemory;
    cancellation;
    batchQuantumMs;
    maxBatchTicks;
    queue = [];
    processing = false;
    scheduled = false;
    stopped = false;
    sequence = 0;
    tickCountInternal = 0;
    lastResult = { status: "running" };
    batchSequence = 0;
    settleResolvers = [];
    lastTickResultEventId = null;
    currentTickEventId = null;
    cancellationSubscription = null;
    currentPheromoneBounds = null;
    taskReadyHandler = (payload) => {
        this.enqueue("taskReady", payload);
    };
    taskDoneHandler = (payload) => {
        this.enqueue("taskDone", payload);
    };
    blackboardChangedHandler = (payload) => {
        this.enqueue("blackboardChanged", payload);
    };
    stigmergyChangedHandler = (payload) => {
        this.enqueue("stigmergyChanged", payload);
    };
    constructor(options) {
        this.interpreter = options.interpreter;
        this.runtime = options.runtime;
        this.events = options.eventBus ?? new ReactiveEventBus();
        this.now = options.now ?? (() => Date.now());
        this.ageWeight = options.ageWeight ?? 0.01;
        this.agingHalfLifeMs = Math.max(1, options.agingHalfLifeMs ?? DEFAULT_AGING_HALF_LIFE_MS);
        this.agingFairnessBoost = Math.max(0, options.agingFairnessBoost ?? DEFAULT_AGING_FAIRNESS_BOOST);
        this.basePriorities = {
            ...DEFAULT_BASE_PRIORITIES,
            ...(options.basePriorities ?? {}),
        };
        this.onTick = options.onTick;
        this.getPheromoneIntensity = options.getPheromoneIntensity;
        this.getPheromoneBounds = options.getPheromoneBounds;
        this.causalMemory = options.causalMemory;
        this.cancellation = options.cancellation;
        this.batchQuantumMs = Math.max(0, options.batchQuantumMs ?? DEFAULT_BATCH_QUANTUM_MS);
        this.maxBatchTicks = Math.max(1, options.maxBatchTicks ?? DEFAULT_MAX_BATCH_TICKS);
        this.events.on("taskReady", this.taskReadyHandler);
        this.events.on("taskDone", this.taskDoneHandler);
        this.events.on("blackboardChanged", this.blackboardChangedHandler);
        this.events.on("stigmergyChanged", this.stigmergyChangedHandler);
        if (this.cancellation) {
            this.cancellationSubscription = this.cancellation.onCancel(() => {
                this.stop();
                this.rejectSettlers(this.cancellation.toError());
            });
        }
    }
    /** Number of ticks executed since the scheduler was created. */
    get tickCount() {
        return this.tickCountInternal;
    }
    /** Returns the causal event identifier of the tick currently executing, if any. */
    getCurrentTickCausalEventId() {
        return this.currentTickEventId;
    }
    /** Stop processing new events and detach listeners from the event bus. */
    stop() {
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
    emit(event, payload) {
        this.enqueue(event, payload);
    }
    /** Wait until the current queue drains or a terminal status is reached. */
    async runUntilSettled(initialEvent) {
        this.ensureNotCancelled();
        if (initialEvent) {
            this.enqueue(initialEvent.type, initialEvent.payload);
        }
        if (!this.processing && !this.scheduled) {
            this.scheduleProcessing();
        }
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject };
            this.settleResolvers.push(entry);
            if (!this.processing && this.queue.length === 0) {
                try {
                    this.ensureNotCancelled();
                    this.resolveSettlers();
                }
                catch (error) {
                    this.rejectSettlers(error);
                }
            }
        });
    }
    enqueue(event, payload) {
        if (this.stopped) {
            return;
        }
        if (event === "taskReady") {
            const ready = payload;
            if (ready.pheromone === undefined && this.getPheromoneIntensity) {
                ready.pheromone = this.getPheromoneIntensity(ready.nodeId);
            }
            if (ready.pheromoneBounds) {
                this.currentPheromoneBounds = { ...ready.pheromoneBounds };
            }
            else {
                const bounds = this.capturePheromoneBounds();
                if (bounds) {
                    ready.pheromoneBounds = bounds;
                }
            }
        }
        if (event === "stigmergyChanged") {
            const change = payload;
            const total = this.getPheromoneIntensity?.(change.nodeId);
            if (total !== undefined) {
                change.intensity = total;
            }
            if (change.bounds) {
                this.currentPheromoneBounds = { ...change.bounds };
            }
            else {
                const bounds = this.capturePheromoneBounds();
                if (bounds) {
                    change.bounds = bounds;
                }
            }
            this.rebalancePheromone(change.nodeId, change.intensity ?? 0);
        }
        const entry = {
            id: this.sequence,
            event,
            payload,
            enqueuedAt: this.now(),
            basePriority: this.computeBasePriority(event, payload),
            causalEventId: this.recordCausalEvent(`scheduler.event.${event}`, this.serialiseEventPayload(event, payload), this.buildCauses(this.lastTickResultEventId)) ?? undefined,
        };
        this.sequence += 1;
        this.queue.push(entry);
        this.scheduleProcessing();
    }
    scheduleProcessing() {
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
    async drainQueue() {
        if (this.processing || this.stopped) {
            return;
        }
        this.processing = true;
        const batchIndex = this.batchSequence;
        const batchStart = this.now();
        let ticksInBatch = 0;
        let batchElapsed = 0;
        let shouldYield = false;
        try {
            while (!this.stopped && this.queue.length > 0) {
                this.ensureNotCancelled();
                const now = this.now();
                const nextIndex = this.selectNextIndex(now);
                const [next] = this.queue.splice(nextIndex, 1);
                const pendingBefore = this.queue.length + 1;
                const tickStartId = this.recordCausalEvent("scheduler.tick.start", {
                    event: next.event,
                    payload: this.serialiseEventPayload(next.event, next.payload),
                    pending_before: pendingBefore,
                }, this.buildCauses(next.causalEventId, this.lastTickResultEventId));
                this.currentTickEventId = tickStartId ?? null;
                const startedAt = now;
                const result = await this.interpreter.tick(this.runtime);
                const finishedAt = this.now();
                this.tickCountInternal += 1;
                this.lastResult = result;
                const priority = this.computeEffectivePriority(next, startedAt);
                const pendingAfter = this.queue.length;
                ticksInBatch += 1;
                batchElapsed = finishedAt - batchStart;
                this.onTick?.({
                    event: next.event,
                    payload: next.payload,
                    priority,
                    enqueuedAt: next.enqueuedAt,
                    startedAt,
                    finishedAt,
                    result,
                    pendingAfter,
                    batchIndex,
                    ticksInBatch,
                    batchElapsedMs: batchElapsed,
                });
                const tickResultId = this.recordCausalEvent("scheduler.tick.result", {
                    event: next.event,
                    status: result.status,
                    output: this.summariseForCausal("output" in result ? result.output : null),
                    priority,
                    pending_after: pendingAfter,
                }, tickStartId ? [tickStartId] : []);
                if (tickResultId) {
                    this.lastTickResultEventId = tickResultId;
                }
                this.currentTickEventId = null;
                if (result.status !== "running") {
                    this.batchSequence = batchIndex + 1;
                    this.stop();
                    this.resolveSettlers(result);
                    return;
                }
                if (this.shouldYieldBatch(batchElapsed, ticksInBatch) && this.queue.length > 0) {
                    shouldYield = true;
                    break;
                }
            }
        }
        catch (error) {
            this.currentTickEventId = null;
            this.stop();
            this.rejectSettlers(error);
            this.batchSequence = batchIndex + 1;
            throw error;
        }
        finally {
            this.processing = false;
        }
        this.batchSequence = batchIndex + 1;
        if (shouldYield && !this.stopped) {
            this.scheduleProcessing();
            return;
        }
        if (this.queue.length > 0) {
            this.scheduleProcessing();
            return;
        }
        this.resolveSettlers();
    }
    resolveSettlers(result) {
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
    rejectSettlers(error) {
        if (this.settleResolvers.length === 0) {
            return;
        }
        const pending = [...this.settleResolvers];
        this.settleResolvers = [];
        for (const { reject } of pending) {
            reject(error);
        }
    }
    computeBasePriority(event, payload) {
        const base = this.basePriorities[event];
        switch (event) {
            case "taskReady": {
                const readyPayload = payload;
                if (readyPayload.pheromone === undefined && this.getPheromoneIntensity) {
                    readyPayload.pheromone = this.getPheromoneIntensity(readyPayload.nodeId);
                }
                if (readyPayload.pheromoneBounds) {
                    this.currentPheromoneBounds = { ...readyPayload.pheromoneBounds };
                }
                else {
                    const bounds = this.capturePheromoneBounds();
                    if (bounds) {
                        readyPayload.pheromoneBounds = bounds;
                    }
                }
                const { criticality = 0 } = readyPayload;
                const pheromone = readyPayload.pheromone ?? 0;
                return base + criticality * 10 + pheromone;
            }
            case "taskDone": {
                const { success, duration_ms = 0 } = payload;
                const penalty = success ? 0 : 20;
                const reward = Math.max(0, 10 - Math.floor(duration_ms / 100));
                return base + penalty + reward;
            }
            case "blackboardChanged": {
                const { importance = 0 } = payload;
                return base + importance * 5;
            }
            case "stigmergyChanged": {
                const { intensity } = payload;
                return base + (intensity ?? 0);
            }
            default: {
                return base;
            }
        }
    }
    rebalancePheromone(nodeId, intensity) {
        const boundsSnapshot = this.capturePheromoneBounds();
        for (const entry of this.queue) {
            if (entry.event !== "taskReady") {
                continue;
            }
            const ready = entry.payload;
            if (ready.nodeId !== nodeId) {
                continue;
            }
            ready.pheromone = intensity;
            if (boundsSnapshot) {
                ready.pheromoneBounds = { ...boundsSnapshot };
            }
            else {
                delete ready.pheromoneBounds;
            }
            entry.basePriority = this.computeBasePriority("taskReady", ready);
        }
    }
    capturePheromoneBounds() {
        if (!this.getPheromoneBounds) {
            return this.currentPheromoneBounds ? { ...this.currentPheromoneBounds } : null;
        }
        try {
            const snapshot = this.getPheromoneBounds();
            if (!snapshot) {
                this.currentPheromoneBounds = null;
                return null;
            }
            this.currentPheromoneBounds = { ...snapshot };
        }
        catch {
            // Preserve the last known bounds when the provider fails.
        }
        return this.currentPheromoneBounds ? { ...this.currentPheromoneBounds } : null;
    }
    serialisePheromoneBounds(bounds) {
        if (!bounds) {
            return null;
        }
        return {
            min_intensity: bounds.minIntensity,
            max_intensity: Number.isFinite(bounds.maxIntensity) ? bounds.maxIntensity : null,
            normalisation_ceiling: bounds.normalisationCeiling,
        };
    }
    selectNextIndex(now) {
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
            if (priority === bestPriority && entry.id < this.queue[bestIndex].id) {
                bestIndex = index;
            }
        }
        return bestIndex;
    }
    computeEffectivePriority(entry, now) {
        const age = Math.max(0, now - entry.enqueuedAt);
        if (age === 0) {
            return entry.basePriority;
        }
        const linearBoost = age * this.ageWeight;
        const fairnessBoost = this.agingFairnessBoost * Math.log1p(age / this.agingHalfLifeMs);
        return entry.basePriority + linearBoost + fairnessBoost;
    }
    shouldYieldBatch(batchElapsed, ticksInBatch) {
        if (this.batchQuantumMs === 0 && this.maxBatchTicks === Number.POSITIVE_INFINITY) {
            return false;
        }
        if (this.batchQuantumMs > 0 && batchElapsed >= this.batchQuantumMs) {
            return true;
        }
        return ticksInBatch >= this.maxBatchTicks;
    }
    recordCausalEvent(type, data, causes) {
        if (!this.causalMemory) {
            return null;
        }
        const snapshot = this.causalMemory.record({
            type,
            data,
            tags: ["scheduler", type],
        }, causes);
        return snapshot.id;
    }
    buildCauses(...ids) {
        const causes = [];
        for (const id of ids) {
            if (typeof id === "string" && id.length > 0 && !causes.includes(id)) {
                causes.push(id);
            }
        }
        return causes;
    }
    serialiseEventPayload(event, payload) {
        switch (event) {
            case "taskReady": {
                const ready = payload;
                const bounds = ready.pheromoneBounds ?? this.capturePheromoneBounds();
                return {
                    node_id: ready.nodeId,
                    criticality: ready.criticality ?? null,
                    pheromone: ready.pheromone ?? null,
                    pheromone_bounds: this.serialisePheromoneBounds(bounds),
                };
            }
            case "taskDone": {
                const done = payload;
                return {
                    node_id: done.nodeId,
                    success: done.success,
                    duration_ms: done.duration_ms ?? null,
                };
            }
            case "blackboardChanged": {
                const change = payload;
                return {
                    key: change.key,
                    importance: change.importance ?? null,
                };
            }
            case "stigmergyChanged": {
                const change = payload;
                return {
                    node_id: change.nodeId,
                    intensity: change.intensity ?? null,
                    type: change.type ?? null,
                    bounds: this.serialisePheromoneBounds(change.bounds ?? this.capturePheromoneBounds()),
                };
            }
            default:
                return {};
        }
    }
    summariseForCausal(value, depth = 0) {
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
            const entries = Object.entries(value);
            const summary = {};
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
    ensureNotCancelled() {
        this.cancellation?.throwIfCancelled();
    }
}
