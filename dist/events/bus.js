import { EventEmitter } from "node:events";
/** Internal event emitted whenever the bus records a new envelope. */
const BUS_EVENT = "event";
/** Utility ensuring categories remain normalised for lookups. */
function normaliseCategory(cat) {
    return cat.trim().toLowerCase();
}
/** Utility ensuring event messages are compact and predictable. */
function normaliseMessage(msg) {
    const trimmed = msg.trim();
    return trimmed.length > 0 ? trimmed : "event";
}
/**
 * Async iterator used to expose live streams. The iterator buffers events until
 * a consumer reads them, mirroring the behaviour of a JSON Lines stream.
 */
class EventStream {
    emitter;
    matcher;
    buffer = [];
    resolve;
    closed = false;
    constructor(emitter, matcher, seed) {
        this.emitter = emitter;
        this.matcher = matcher;
        for (const event of seed) {
            if (this.matcher(event)) {
                this.buffer.push(event);
            }
        }
        this.emitter.on(BUS_EVENT, this.handleEvent);
    }
    [Symbol.asyncIterator]() {
        return this;
    }
    async next() {
        if (this.buffer.length > 0) {
            return { value: this.buffer.shift(), done: false };
        }
        if (this.closed) {
            return { value: undefined, done: true };
        }
        return new Promise((resolve) => {
            this.resolve = resolve;
        });
    }
    async return() {
        this.close();
        return { value: undefined, done: true };
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.emitter.removeListener(BUS_EVENT, this.handleEvent);
        if (this.resolve) {
            this.resolve({ value: undefined, done: true });
            this.resolve = undefined;
        }
    }
    handleEvent = (event) => {
        if (this.closed || !this.matcher(event)) {
            return;
        }
        if (this.resolve) {
            this.resolve({ value: event, done: false });
            this.resolve = undefined;
            return;
        }
        this.buffer.push(event);
    };
}
/**
 * Unified event bus buffering orchestration events in memory. The bus offers
 * both random access (via {@link list}) and live streaming (via
 * {@link subscribe}) which keeps downstream MCP tools deterministic and easy
 * to test.
 */
export class EventBus {
    emitter = new EventEmitter();
    history = [];
    historyLimit;
    now;
    seq = 0;
    constructor(options = {}) {
        this.historyLimit = Math.max(1, options.historyLimit ?? 1_000);
        this.now = options.now ?? (() => Date.now());
    }
    /** Adjust the history limit at runtime and trim existing entries accordingly. */
    setHistoryLimit(limit) {
        this.historyLimit = Math.max(1, limit);
        while (this.history.length > this.historyLimit) {
            this.history.shift();
        }
    }
    /** Determine whether an event matches the provided filters. */
    matches(event, filter) {
        const normalisedCats = filter.cats?.map(normaliseCategory);
        const normalisedLevels = filter.levels?.map((level) => level.toLowerCase());
        if (normalisedCats && normalisedCats.length > 0 && !normalisedCats.includes(event.cat)) {
            return false;
        }
        if (normalisedLevels && normalisedLevels.length > 0 && !normalisedLevels.includes(event.level)) {
            return false;
        }
        if (filter.jobId && event.jobId !== filter.jobId) {
            return false;
        }
        if (filter.runId && event.runId !== filter.runId) {
            return false;
        }
        if (filter.opId && event.opId !== filter.opId) {
            return false;
        }
        if (filter.graphId && event.graphId !== filter.graphId) {
            return false;
        }
        if (filter.childId && event.childId !== filter.childId) {
            return false;
        }
        if (filter.nodeId && event.nodeId !== filter.nodeId) {
            return false;
        }
        if (typeof filter.afterSeq === "number" && !(event.seq > filter.afterSeq)) {
            return false;
        }
        return true;
    }
    /** Publish a new event on the bus. */
    publish(input) {
        const envelope = {
            seq: ++this.seq,
            ts: input.ts ?? this.now(),
            cat: normaliseCategory(input.cat),
            level: input.level ?? "info",
            jobId: input.jobId ?? null,
            runId: input.runId ?? null,
            opId: input.opId ?? null,
            graphId: input.graphId ?? null,
            nodeId: input.nodeId ?? null,
            childId: input.childId ?? null,
            msg: normaliseMessage(input.msg),
            data: input.data,
        };
        this.history.push(envelope);
        if (this.history.length > this.historyLimit) {
            this.history.shift();
        }
        this.emitter.emit(BUS_EVENT, envelope);
        return envelope;
    }
    /**
     * Returns a snapshot of events matching the provided filters. The snapshot is
     * sorted chronologically and truncated to `limit` when specified.
     */
    list(filter = {}) {
        const sliced = this.history.filter((event) => this.matches(event, filter));
        const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, this.historyLimit) : this.historyLimit;
        return sliced.slice(-limit);
    }
    /**
     * Creates an async iterator streaming live events. Consumers should call
     * {@link EventStream.close} once finished to avoid leaking listeners.
     */
    subscribe(filter = {}) {
        const matcher = (event) => this.matches(event, filter);
        const seed = this.list(filter);
        return new EventStream(this.emitter, matcher, seed);
    }
}
