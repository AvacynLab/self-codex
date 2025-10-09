import { StructuredLogger } from "./logger.js";
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
            payload: input.payload
        };
        this.events.push(event);
        if (this.events.length > this.maxHistory) {
            this.events.shift();
        }
        if (event.jobId) {
            const existing = this.perJob.get(event.jobId) ?? [];
            existing.push(event);
            if (existing.length > this.maxHistory) {
                existing.shift();
            }
            this.perJob.set(event.jobId, existing);
        }
        return event;
    }
    list(filters = {}) {
        return this.events.filter((event) => {
            if (filters.minSeq !== undefined && event.seq <= filters.minSeq) {
                return false;
            }
            if (filters.jobId && event.jobId !== filters.jobId) {
                return false;
            }
            if (filters.childId && event.childId !== filters.childId) {
                return false;
            }
            return true;
        });
    }
    listForJob(jobId, minSeq) {
        const base = this.perJob.get(jobId) ?? [];
        if (minSeq === undefined) {
            return [...base];
        }
        return base.filter((event) => event.seq > minSeq);
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
    trim() {
        while (this.events.length > this.maxHistory) {
            this.events.shift();
        }
        for (const [jobId, events] of this.perJob.entries()) {
            while (events.length > this.maxHistory) {
                events.shift();
            }
            this.perJob.set(jobId, events);
        }
    }
}
//# sourceMappingURL=eventStore.js.map