import { StructuredLogger } from "./logger.js";
import { normaliseProvenanceList } from "./types/provenance.js";
/**
 * Maximum size (in characters) of the JSON representation we attempt to mirror
 * in log entries. Larger payloads are summarised to avoid bloating the
 * orchestrator logs when callers attach verbose artefacts to an event.
 */
const MAX_LOGGED_PAYLOAD_LENGTH = 4_096;
/** Builds a set from the user supplied kinds while ignoring duplicates or garbage values. */
function normaliseKindFilter(kinds) {
    if (!kinds || kinds.length === 0) {
        return null;
    }
    const set = new Set();
    for (const kind of kinds) {
        if (typeof kind !== "string") {
            continue;
        }
        set.add(kind);
    }
    return set.size > 0 ? set : null;
}
/** Coerces the optional limit to a safe integer, returning `0` for non-positive values. */
function normaliseLimit(limit) {
    if (limit === undefined) {
        return undefined;
    }
    if (!Number.isFinite(limit)) {
        return undefined;
    }
    const floored = Math.floor(limit);
    if (floored <= 0) {
        return 0;
    }
    return floored;
}
/**
 * Applies ordering and windowing to the filtered events. The helper returns a
 * brand new array so callers can freely mutate the result without observing
 * internal state changes.
 */
function applyWindow(events, options) {
    const ordered = options.reverse ? [...events].reverse() : [...events];
    const limit = normaliseLimit(options.limit);
    if (limit === undefined) {
        return ordered;
    }
    if (limit === 0) {
        return [];
    }
    return ordered.slice(0, limit);
}
/**
 * Event storage keeping a bounded history both globally and for individual
 * jobs. Consumers can request subsets filtered by sequence, job or child.
 */
export class EventStore {
    seq = 0;
    maxHistory;
    events = [];
    perJob = new Map();
    logger;
    constructor(options) {
        this.maxHistory = Math.max(1, options.maxHistory);
        this.logger = options.logger ?? new StructuredLogger();
    }
    emit(input) {
        const event = {
            seq: ++this.seq,
            ts: Date.now(),
            kind: input.kind,
            level: input.level ?? "info",
            source: input.source ?? "orchestrator",
            jobId: input.jobId,
            childId: input.childId,
            payload: input.payload,
            provenance: normaliseProvenanceList(input.provenance),
        };
        this.events.push(event);
        if (this.events.length > this.maxHistory) {
            const evicted = this.events.shift();
            if (evicted) {
                this.logEventEviction("global", evicted, { remaining: this.events.length });
            }
        }
        if (event.jobId) {
            const existing = this.perJob.get(event.jobId) ?? [];
            existing.push(event);
            if (existing.length > this.maxHistory) {
                const evicted = existing.shift();
                if (evicted) {
                    this.logEventEviction("job", evicted, {
                        jobId: event.jobId,
                        remaining: existing.length,
                    });
                }
            }
            if (existing.length === 0) {
                this.perJob.delete(event.jobId);
            }
            else {
                this.perJob.set(event.jobId, existing);
            }
        }
        this.logEventEmission(event);
        return event;
    }
    /**
     * Returns events filtered by job/child/kind selectors and optional windowing
     * controls. Results keep chronological ordering unless {@link EventFilters.reverse}
     * is explicitly enabled.
     */
    list(filters = {}) {
        const kindFilter = normaliseKindFilter(filters.kinds);
        const minSeq = typeof filters.minSeq === "number" ? filters.minSeq : undefined;
        const filtered = this.events.filter((event) => {
            if (minSeq !== undefined && event.seq <= minSeq) {
                return false;
            }
            if (filters.jobId && event.jobId !== filters.jobId) {
                return false;
            }
            if (filters.childId && event.childId !== filters.childId) {
                return false;
            }
            if (kindFilter && !kindFilter.has(event.kind)) {
                return false;
            }
            return true;
        });
        return applyWindow(filtered, { reverse: filters.reverse, limit: filters.limit });
    }
    /**
     * Efficient helper returning events scoped to a single job. Callers can pass
     * either the legacy `minSeq` number or the richer {@link JobEventFilters}
     * object when they need pagination and kind filtering.
     */
    listForJob(jobId, options) {
        const base = this.perJob.get(jobId) ?? [];
        const filters = typeof options === "number"
            ? { minSeq: options }
            : options
                ? options
                : {};
        const kindFilter = normaliseKindFilter(filters.kinds);
        const minSeq = typeof filters.minSeq === "number" ? filters.minSeq : undefined;
        const childId = filters.childId;
        const filtered = base.filter((event) => {
            if (minSeq !== undefined && event.seq <= minSeq) {
                return false;
            }
            if (childId && event.childId !== childId) {
                return false;
            }
            if (kindFilter && !kindFilter.has(event.kind)) {
                return false;
            }
            return true;
        });
        return applyWindow(filtered, { reverse: filters.reverse, limit: filters.limit });
    }
    getSnapshot() {
        return [...this.events];
    }
    setMaxHistory(limit) {
        this.maxHistory = Math.max(1, limit);
        this.trim();
        this.logger.debug("event_history_limit_updated", { limit: this.maxHistory });
    }
    setLogger(logger) {
        this.logger = logger;
    }
    getMaxHistory() {
        return this.maxHistory;
    }
    getLastSequence() {
        return this.seq;
    }
    getEventCount() {
        return this.events.length;
    }
    getEventsByKind(kind) {
        return this.events.filter((event) => event.kind === kind);
    }
    /**
     * Trims the global and per-job buffers so they do not exceed the configured
     * history. Per-job slices intentionally retain their own windows even when the
     * global buffer has already evicted the same entries to preserve job-centric
     * pagination semantics.
     */
    trim() {
        while (this.events.length > this.maxHistory) {
            const evicted = this.events.shift();
            if (evicted) {
                this.logEventEviction("global", evicted, { remaining: this.events.length });
            }
        }
        for (const [jobId, events] of this.perJob.entries()) {
            while (events.length > this.maxHistory) {
                const evicted = events.shift();
                if (evicted) {
                    this.logEventEviction("job", evicted, { jobId, remaining: events.length });
                }
            }
            if (events.length === 0) {
                this.perJob.delete(jobId);
            }
            else {
                this.perJob.set(jobId, events);
            }
        }
    }
    /**
     * Emits a structured log entry mirroring the recorded event without leaking
     * overly large payloads. The helper keeps the EventStore as the canonical
     * history while still surfacing a concise audit trail in the orchestrator
     * logs.
     */
    logEventEmission(event) {
        const logPayload = {
            seq: event.seq,
            ts: event.ts,
            kind: event.kind,
            source: event.source,
            level: event.level,
            job_id: event.jobId ?? null,
            child_id: event.childId ?? null,
            provenance_count: event.provenance.length,
        };
        if (event.payload !== undefined) {
            const serialised = this.serialisePayloadForLogging(event.payload);
            if (serialised.status === "success") {
                logPayload.payload = serialised.value;
            }
            else {
                logPayload.payload_summary = serialised.value;
            }
        }
        this.logWithLevel(event.level, "event_recorded", logPayload);
    }
    /**
     * Logs the eviction of an event from the bounded history. The structured
     * payload includes the eviction scope so operators can distinguish between
     * global and per-job trimming operations.
     */
    logEventEviction(scope, event, details) {
        const payload = {
            scope,
            seq: event.seq,
            kind: event.kind,
            job_id: details.jobId ?? event.jobId ?? null,
            child_id: event.childId ?? null,
            remaining: details.remaining,
            reason: "history_limit",
        };
        this.logger.info("event_evicted", payload);
    }
    /**
     * Maps the event level to the appropriate logger method. Using a dedicated
     * helper guarantees a consistent mapping should additional levels be added in
     * the future.
     */
    logWithLevel(level, message, payload) {
        switch (level) {
            case "warn":
                this.logger.warn(message, payload);
                break;
            case "error":
                this.logger.error(message, payload);
                break;
            case "info":
            default:
                this.logger.info(message, payload);
                break;
        }
    }
    /**
     * Serialises the payload attached to an event so logging remains deterministic
     * even when callers provide complex objects. Oversized payloads are replaced
     * with a summary noting the original length.
     */
    serialisePayloadForLogging(payload) {
        try {
            const json = JSON.stringify(payload);
            if (json === undefined) {
                return { status: "success", value: null };
            }
            if (json.length > MAX_LOGGED_PAYLOAD_LENGTH) {
                return {
                    status: "summary",
                    value: { summary: "payload_truncated", length: json.length },
                };
            }
            return { status: "success", value: JSON.parse(json) };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                status: "summary",
                value: { summary: "payload_serialization_failed", length: 0, error: message },
            };
        }
    }
}
//# sourceMappingURL=eventStore.js.map