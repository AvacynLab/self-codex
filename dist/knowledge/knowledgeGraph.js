/**
 * Error raised when a caller attempts to persist a triple with blank fields.
 * The orchestration server relies on the `code` and `details` payload to emit
 * actionable MCP error responses while keeping logs informative.
 */
export class KnowledgeBadTripleError extends Error {
    code = "E-KG-BAD-TRIPLE";
    details;
    constructor(triple) {
        super("Knowledge triples require non-empty subject, predicate and object");
        this.name = "KnowledgeBadTripleError";
        this.details = {
            subject: triple.subject,
            predicate: triple.predicate,
            object: triple.object,
        };
    }
}
/**
 * Simple, fully in-memory knowledge graph. Triples are indexed by subject,
 * predicate and object to make motif based queries deterministic. Confidence
 * scores stay bounded between 0 and 1 to ease downstream computations.
 */
export class KnowledgeGraph {
    now;
    records = new Map();
    keyIndex = new Map();
    subjectIndex = new Map();
    predicateIndex = new Map();
    objectIndex = new Map();
    sequence = 0;
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
    }
    /** Returns the total number of stored triples. */
    count() {
        return this.records.size;
    }
    /** Inserts or updates a triple and returns the resulting snapshot. */
    insert(triple) {
        const subject = triple.subject.trim();
        const predicate = triple.predicate.trim();
        const object = triple.object.trim();
        if (!subject || !predicate || !object) {
            throw new KnowledgeBadTripleError(triple);
        }
        const source = triple.source?.trim() ?? null;
        const confidence = clampConfidence(triple.confidence);
        const timestamp = this.now();
        const key = makeKey(subject, predicate, object);
        const existingId = this.keyIndex.get(key);
        if (existingId) {
            const record = this.records.get(existingId);
            if (!record) {
                this.keyIndex.delete(key);
                return this.insert(triple);
            }
            const updated = {
                ...record,
                source,
                confidence,
                updatedAt: timestamp,
                revision: record.revision + 1,
            };
            this.records.set(existingId, updated);
            return { snapshot: cloneRecord(updated), created: false, updated: true };
        }
        const id = `kg-${++this.sequence}`;
        const ordinal = this.sequence;
        const record = {
            id,
            key,
            subject,
            predicate,
            object,
            source,
            confidence,
            insertedAt: timestamp,
            updatedAt: timestamp,
            revision: 0,
            ordinal,
        };
        this.records.set(id, record);
        this.keyIndex.set(key, id);
        this.index(this.subjectIndex, subject, id);
        this.index(this.predicateIndex, predicate, id);
        this.index(this.objectIndex, object, id);
        return { snapshot: cloneRecord(record), created: true, updated: false };
    }
    /**
     * Retrieves triples matching the provided pattern. Wildcards (`*`) are
     * supported anywhere within the pattern fields and match any sequence.
     */
    query(pattern = {}, options = {}) {
        const candidates = this.collectCandidates(pattern);
        const ordered = candidates
            .map((id) => this.records.get(id))
            .filter((record) => Boolean(record))
            .filter((record) => matchesRecord(record, pattern))
            .sort((a, b) => (options.order === "desc" ? b.ordinal - a.ordinal : a.ordinal - b.ordinal));
        const limit = options.limit && options.limit > 0 ? Math.min(options.limit, ordered.length) : ordered.length;
        const sliced = ordered.slice(0, limit);
        return sliced.map(cloneRecord);
    }
    /** Returns every triple ordered by insertion time. */
    exportAll() {
        return this.query({}, { order: "asc" });
    }
    /**
     * Reconstructs a plan pattern based on triples shaped as follows:
     *
     * - `(plan, "includes", taskId)` defines tasks belonging to the pattern.
     * - `(task:ID, "label", label)` declares a human readable label.
     * - `(task:ID, "depends_on", otherTask)` records dependencies.
     * - `(task:ID, "duration", value)` and `(task:ID, "weight", value)` expose metadata.
     */
    buildPlanPattern(plan) {
        const includes = this.query({ subject: plan, predicate: "includes" });
        if (!includes.length) {
            return null;
        }
        const tasks = [];
        const sources = new Set();
        let confidenceSum = 0;
        for (const include of includes) {
            const taskId = include.object;
            const subject = taskSubject(taskId);
            const taskTriples = this.query({ subject });
            const dependsOn = taskTriples.filter((triple) => triple.predicate === "depends_on").map((triple) => triple.object);
            const label = taskTriples.find((triple) => triple.predicate === "label")?.object;
            const duration = toNumber(taskTriples.find((triple) => triple.predicate === "duration")?.object);
            const weight = toNumber(taskTriples.find((triple) => triple.predicate === "weight")?.object);
            const source = include.source;
            const confidence = include.confidence;
            if (source) {
                sources.add(source);
            }
            confidenceSum += confidence;
            tasks.push({
                id: taskId,
                label,
                dependsOn: dedupe(dependsOn),
                duration: duration ?? undefined,
                weight: weight ?? undefined,
                source,
                confidence,
            });
        }
        const averageConfidence = tasks.length > 0 ? confidenceSum / tasks.length : null;
        return {
            plan,
            tasks,
            averageConfidence,
            sourceCount: sources.size,
        };
    }
    collectCandidates(pattern) {
        const sets = [];
        if (pattern.subject && !hasWildcard(pattern.subject)) {
            const set = this.subjectIndex.get(pattern.subject);
            if (set)
                sets.push(set);
        }
        if (pattern.predicate && !hasWildcard(pattern.predicate)) {
            const set = this.predicateIndex.get(pattern.predicate);
            if (set)
                sets.push(set);
        }
        if (pattern.object && !hasWildcard(pattern.object)) {
            const set = this.objectIndex.get(pattern.object);
            if (set)
                sets.push(set);
        }
        if (!sets.length) {
            return Array.from(this.records.keys());
        }
        let intersection = new Set(sets[0]);
        for (let i = 1; i < sets.length; i += 1) {
            intersection = intersect(intersection, sets[i]);
        }
        return Array.from(intersection);
    }
    index(map, key, id) {
        const existing = map.get(key);
        if (existing) {
            existing.add(id);
            return;
        }
        map.set(key, new Set([id]));
    }
}
function makeKey(subject, predicate, object) {
    return `${subject}\u0000${predicate}\u0000${object}`;
}
function cloneRecord(record) {
    return { ...record };
}
function intersect(left, right) {
    const result = new Set();
    for (const value of left) {
        if (right.has(value)) {
            result.add(value);
        }
    }
    return result;
}
function hasWildcard(value) {
    return value.includes("*");
}
function wildcardMatch(value, pattern) {
    if (!hasWildcard(pattern)) {
        return value === pattern;
    }
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`);
    return regex.test(value);
}
function matchesRecord(record, pattern) {
    if (pattern.subject && !wildcardMatch(record.subject, pattern.subject))
        return false;
    if (pattern.predicate && !wildcardMatch(record.predicate, pattern.predicate))
        return false;
    if (pattern.object && !wildcardMatch(record.object, pattern.object))
        return false;
    if (pattern.source) {
        const source = record.source ?? "";
        if (!wildcardMatch(source, pattern.source))
            return false;
    }
    if (pattern.minConfidence !== undefined) {
        const threshold = clampConfidence(pattern.minConfidence);
        if (record.confidence < threshold)
            return false;
    }
    return true;
}
function clampConfidence(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return 1;
    }
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
function dedupe(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            result.push(value);
        }
    }
    return result;
}
function taskSubject(taskId) {
    return `task:${taskId}`;
}
function toNumber(value) {
    if (value === undefined) {
        return null;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}
