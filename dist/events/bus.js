import { EventEmitter } from "node:events";
import { assertValidEventMessage, } from "./types.js";
const BUS_EVENT = "event";
const DEFAULT_HISTORY_LIMIT = 1_000;
const DEFAULT_STREAM_BUFFER = 256;
export const EVENT_CATEGORIES = [
    "bt",
    "scheduler",
    "child",
    "graph",
    "stig",
    "bb",
    "cnp",
    "consensus",
    "values",
];
const ALLOWED_CATEGORIES = new Set(EVENT_CATEGORIES);
function normaliseCategory(cat) {
    if (!ALLOWED_CATEGORIES.has(cat)) {
        throw new TypeError(`unknown event category: ${cat}`);
    }
    return cat;
}
function normaliseMessage(msg) {
    const trimmed = msg.trim();
    if (trimmed.length === 0) {
        throw new TypeError("event message must be non-empty");
    }
    assertValidEventMessage(trimmed);
    return trimmed;
}
/**
 * Normalise the optional semantic kind supplied by bridge publishers.
 *
 * The bus guarantees that subscribers observe upper-cased identifiers so
 * dashboards can compare against stable PROMPT/PENDING/etc. tokens regardless
 * of the original casing provided by upstream emitters.
 */
function normaliseKind(kind) {
    if (typeof kind !== "string") {
        return undefined;
    }
    const trimmed = kind.trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    // Preserve historical expectations by upper-casing the identifier so
    // subscribers receive stable PROMPT/PENDING/etc. tokens regardless of the
    // original casing supplied by publishers.
    return trimmed.toUpperCase();
}
/**
 * Normalise optional textual tags (component/stage) by trimming whitespace and
 * rejecting empty strings. The helper keeps casing untouched so downstream
 * dashboards can render human friendly identifiers while the bus guarantees the
 * property is either a non-empty string or `null`.
 */
function normaliseTag(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
/**
 * Normalise optional duration values (expressed in milliseconds). The bus
 * stores `null` instead of `undefined` to preserve deterministic JSON
 * serialisation for tests.
 */
function normaliseElapsed(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    if (value < 0) {
        return 0;
    }
    return Math.round(value);
}
class EventStream {
    emitter;
    matcher;
    maxBuffer;
    buffer = [];
    resolve = null;
    closed = false;
    /**
     * Precomputed iterator result returned whenever the stream completes. The
     * object is immutable to guarantee that awaiting consumers observe a stable
     * reference that cannot be mutated by publishers.
     */
    static DONE = Object.freeze({
        value: undefined,
        done: true,
    });
    constructor(emitter, matcher, seed, maxBuffer) {
        this.emitter = emitter;
        this.matcher = matcher;
        this.maxBuffer = maxBuffer;
        for (const event of seed) {
            this.enqueue(event);
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
            return EventStream.DONE;
        }
        return new Promise((resolve) => {
            this.resolve = resolve;
        });
    }
    async return() {
        this.close();
        return EventStream.DONE;
    }
    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.emitter.removeListener(BUS_EVENT, this.handleEvent);
        const pendingResolve = this.resolve;
        this.resolve = null;
        if (pendingResolve) {
            // Invoke the cached resolver after clearing the field to avoid retaining
            // a dangling reference when `exactOptionalPropertyTypes` narrows the
            // property type within the truthy branch.
            pendingResolve(EventStream.DONE);
        }
        this.buffer.length = 0;
    }
    handleEvent = (event) => {
        if (this.closed || !this.matcher(event)) {
            return;
        }
        const pendingResolve = this.resolve;
        if (pendingResolve) {
            // Clearing the resolver before invoking it prevents the type guard from
            // narrowing the property to the callable signature and therefore keeps
            // the assignment to `null` valid once optional properties become exact.
            this.resolve = null;
            pendingResolve({ value: event, done: false });
            return;
        }
        this.enqueue(event);
    };
    enqueue(event) {
        this.buffer.push(event);
        if (this.buffer.length > this.maxBuffer) {
            const idx = this.buffer.findIndex((candidate) => candidate.level === "info");
            if (idx >= 0) {
                this.buffer.splice(idx, 1);
            }
            else {
                this.buffer.shift();
            }
        }
    }
}
/**
 * Unified event bus buffering orchestration events in memory. The bus offers
 * both random access (via {@link list}) and streaming (via {@link subscribe}).
 */
export class EventBus {
    emitter = new EventEmitter();
    history = [];
    historyLimit;
    now;
    streamBufferSize;
    seq = 0;
    constructor(options = {}) {
        this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
        this.now = options.now ?? (() => Date.now());
        this.streamBufferSize = Math.max(1, options.streamBufferSize ?? DEFAULT_STREAM_BUFFER);
    }
    setHistoryLimit(limit) {
        this.historyLimit = Math.max(1, limit);
        this.trimHistory();
    }
    publish(input) {
        // The normaliser trims whitespace but preserves the semantic token, hence the
        // cast back to the caller-provided subtype remains safe.
        const message = normaliseMessage(input.msg);
        const component = normaliseTag(input.component ?? input.cat);
        const stage = normaliseTag(input.stage ?? message);
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
            component,
            stage,
            elapsedMs: normaliseElapsed(input.elapsedMs ?? null),
            msg: message,
        };
        const kind = normaliseKind(input.kind ?? null);
        if (kind !== undefined) {
            // Preserve the semantic identifier only when publishers provided a
            // meaningful token, keeping the envelope free of `undefined` placeholders
            // under strict optional typing.
            envelope.kind = kind;
        }
        if (input.data !== undefined) {
            // Forward structured payloads verbatim while avoiding the explicit
            // `data: undefined` pattern that breaks once optional properties become
            // exact.
            envelope.data = input.data;
        }
        this.history.push(envelope);
        if (this.history.length > this.historyLimit) {
            this.dropFromHistory();
        }
        this.emitter.emit(BUS_EVENT, envelope);
        return envelope;
    }
    list(filter = {}) {
        const filtered = this.history.filter((event) => this.matches(event, filter));
        const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, this.historyLimit) : this.historyLimit;
        return filtered.slice(-limit);
    }
    subscribe(filter = {}) {
        const matcher = (event) => this.matches(event, filter);
        const seed = this.list(filter);
        return new EventStream(this.emitter, matcher, seed, this.streamBufferSize);
    }
    matches(event, filter) {
        if (filter.cats && filter.cats.length > 0 && !filter.cats.includes(event.cat)) {
            return false;
        }
        if (filter.levels && filter.levels.length > 0 && !filter.levels.includes(event.level)) {
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
        if (filter.component && event.component !== filter.component) {
            return false;
        }
        if (filter.stage && event.stage !== filter.stage) {
            return false;
        }
        if (typeof filter.afterSeq === "number" && !(event.seq > filter.afterSeq)) {
            return false;
        }
        return true;
    }
    dropFromHistory() {
        const index = this.history.findIndex((event) => event.level === "info");
        if (index >= 0) {
            this.history.splice(index, 1);
        }
        else {
            this.history.shift();
        }
    }
    trimHistory() {
        while (this.history.length > this.historyLimit) {
            this.dropFromHistory();
        }
    }
}
//# sourceMappingURL=bus.js.map