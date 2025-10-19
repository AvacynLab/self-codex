import { mergeProvenance, normaliseProvenanceList } from "../types/provenance.js";
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
    /** Index accelerating lookups constrained by both subject and predicate. */
    subjectPredicateIndex = new Map();
    /** Index accelerating lookups constrained by both object and predicate. */
    objectPredicateIndex = new Map();
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
        const provenance = normaliseProvenanceList(triple.provenance);
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
                provenance: mergeProvenance(record.provenance, provenance),
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
            provenance,
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
        this.index(this.subjectPredicateIndex, makePairKey(subject, predicate), id);
        this.index(this.objectPredicateIndex, makePairKey(object, predicate), id);
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
     * Synthesises RAG friendly documents by grouping triples per subject. Each
     * document contains a textual summary, automatically derived tags, metadata
     * describing the aggregated triples, and merged provenance entries. The
     * resulting payload can be ingested directly via `rag_ingest` to bootstrap
     * semantic recall from the knowledge graph content.
     */
    exportForRag(options = {}) {
        const minConfidence = clampThreshold(options.minConfidence);
        const includePredicates = normalisePredicateAllowList(options.includePredicates);
        const maxTriplesPerSubject = clampPositiveInteger(options.maxTriplesPerSubject);
        const buckets = new Map();
        const orderedSubjects = [];
        for (const triple of this.exportAll()) {
            if (triple.confidence < minConfidence) {
                continue;
            }
            if (includePredicates.size > 0 && !includePredicates.has(triple.predicate)) {
                continue;
            }
            let bucket = buckets.get(triple.subject);
            if (!bucket) {
                bucket = [];
                buckets.set(triple.subject, bucket);
                orderedSubjects.push(triple.subject);
            }
            if (maxTriplesPerSubject !== null && bucket.length >= maxTriplesPerSubject) {
                continue;
            }
            bucket.push(triple);
        }
        const documents = [];
        for (const subject of orderedSubjects) {
            const triples = buckets.get(subject);
            if (!triples || triples.length === 0) {
                continue;
            }
            const tags = new Set(["kg", `subject:${slugifyTag(subject)}`]);
            const predicateSet = new Set();
            const sourceSet = new Set();
            let provenance = [];
            let confidenceSum = 0;
            const lines = [`Subject: ${subject}`];
            for (const triple of triples) {
                predicateSet.add(triple.predicate);
                tags.add(`predicate:${slugifyTag(triple.predicate)}`);
                if (triple.source) {
                    sourceSet.add(triple.source);
                    tags.add(`source:${slugifyTag(triple.source)}`);
                }
                const enrichedProvenance = appendSourceProvenance(triple.provenance, triple.source);
                provenance = mergeProvenance(provenance, enrichedProvenance);
                confidenceSum += triple.confidence;
                const qualifiers = [];
                if (triple.source) {
                    qualifiers.push(`source=${triple.source}`);
                }
                if (Math.abs(triple.confidence - 1) > 1e-6) {
                    qualifiers.push(`confidence=${formatConfidence(triple.confidence)}`);
                }
                if (triple.provenance.length > 0) {
                    qualifiers.push(`provenance=${triple.provenance.length}`);
                }
                const qualifierSuffix = qualifiers.length ? ` (${qualifiers.join(", ")})` : "";
                lines.push(`- ${triple.predicate}: ${triple.object}${qualifierSuffix}`);
            }
            const averageConfidence = triples.length > 0 ? Number((confidenceSum / triples.length).toFixed(4)) : null;
            documents.push({
                id: subject,
                text: lines.join("\n"),
                tags: Array.from(tags).sort(),
                metadata: {
                    subject,
                    triple_count: triples.length,
                    predicates: Array.from(predicateSet).sort(),
                    sources: Array.from(sourceSet).sort(),
                    average_confidence: averageConfidence,
                },
                provenance,
            });
        }
        return documents;
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
            const provenance = cloneProvenanceList(include.provenance);
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
                provenance,
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
    /**
     * Removes every stored triple along with the derived indexes. The internal
     * ordinal counter is reset so future insertions start from a clean slate.
     */
    clear() {
        this.records.clear();
        this.keyIndex.clear();
        this.subjectIndex.clear();
        this.predicateIndex.clear();
        this.objectIndex.clear();
        this.subjectPredicateIndex.clear();
        this.objectPredicateIndex.clear();
        this.sequence = 0;
    }
    /**
     * Restores the graph to match the provided snapshots. Existing triples are
     * discarded before the snapshots are indexed so the graph mirrors the
     * captured state deterministically (including ordinals and revisions).
     */
    restore(snapshots) {
        this.clear();
        for (const snapshot of snapshots) {
            const provenance = normaliseProvenanceList(snapshot.provenance);
            const record = {
                ...snapshot,
                provenance,
                key: makeKey(snapshot.subject, snapshot.predicate, snapshot.object),
            };
            this.records.set(record.id, record);
            this.keyIndex.set(record.key, record.id);
            this.index(this.subjectIndex, record.subject, record.id);
            this.index(this.predicateIndex, record.predicate, record.id);
            this.index(this.objectIndex, record.object, record.id);
            this.index(this.subjectPredicateIndex, makePairKey(record.subject, record.predicate), record.id);
            this.index(this.objectPredicateIndex, makePairKey(record.object, record.predicate), record.id);
            if (record.ordinal > this.sequence) {
                this.sequence = record.ordinal;
            }
        }
    }
    collectCandidates(pattern) {
        const exactSubject = typeof pattern.subject === "string" && !hasWildcard(pattern.subject);
        const exactPredicate = typeof pattern.predicate === "string" && !hasWildcard(pattern.predicate);
        const exactObject = typeof pattern.object === "string" && !hasWildcard(pattern.object);
        // When the caller fixes the full triple we can leverage the primary key
        // index directly and avoid walking any of the secondary indexes.
        if (exactSubject && exactPredicate && exactObject) {
            const key = makeKey(pattern.subject, pattern.predicate, pattern.object);
            const identifier = this.keyIndex.get(key);
            return identifier ? [identifier] : [];
        }
        const sets = [];
        const addSet = (set) => {
            if (set && !sets.includes(set)) {
                sets.push(set);
            }
        };
        if (exactSubject && exactPredicate) {
            const composite = this.subjectPredicateIndex.get(makePairKey(pattern.subject, pattern.predicate));
            if (composite) {
                addSet(composite);
            }
            else {
                addSet(this.subjectIndex.get(pattern.subject));
                addSet(this.predicateIndex.get(pattern.predicate));
            }
        }
        else {
            if (exactSubject) {
                addSet(this.subjectIndex.get(pattern.subject));
            }
            if (exactPredicate) {
                addSet(this.predicateIndex.get(pattern.predicate));
            }
        }
        if (exactObject && exactPredicate) {
            const composite = this.objectPredicateIndex.get(makePairKey(pattern.object, pattern.predicate));
            if (composite) {
                addSet(composite);
            }
            else {
                addSet(this.objectIndex.get(pattern.object));
                addSet(this.predicateIndex.get(pattern.predicate));
            }
        }
        else if (exactObject) {
            addSet(this.objectIndex.get(pattern.object));
        }
        // Prefer intersecting the smallest candidate sets first so that the
        // wildcard-aware filtering has the least amount of work to do afterwards.
        if (!sets.length) {
            return Array.from(this.records.keys());
        }
        sets.sort((left, right) => left.size - right.size);
        let intersection = new Set(sets[0]);
        for (let i = 1; i < sets.length; i += 1) {
            intersection = intersect(intersection, sets[i]);
            if (intersection.size === 0) {
                break;
            }
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
function makePairKey(left, right) {
    return `${left}\u0000${right}`;
}
function cloneRecord(record) {
    return { ...record, provenance: cloneProvenanceList(record.provenance) };
}
function cloneProvenanceList(list) {
    return list.map((entry) => ({ ...entry }));
}
function intersect(left, right) {
    const [small, large] = left.size <= right.size ? [left, right] : [right, left];
    const result = new Set();
    for (const value of small) {
        if (large.has(value)) {
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
/** Clamps the caller provided confidence threshold within the inclusive [0, 1] range. */
function clampThreshold(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return 0;
    }
    if (value < 0) {
        return 0;
    }
    if (value > 1) {
        return 1;
    }
    return value;
}
/** Converts the predicate allow-list to a trimmed set while dropping blanks. */
function normalisePredicateAllowList(predicates) {
    if (!predicates || predicates.length === 0) {
        return new Set();
    }
    const allowList = new Set();
    for (const predicate of predicates) {
        const trimmed = predicate.trim();
        if (trimmed) {
            allowList.add(trimmed);
        }
    }
    return allowList;
}
/** Normalises counts expressed as numbers so that `NaN` or sub-unit values are ignored. */
function clampPositiveInteger(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
        return null;
    }
    const truncated = Math.floor(value);
    if (truncated <= 0) {
        return null;
    }
    return truncated;
}
/** Turns arbitrary strings into lowercase tags compatible with the RAG memory constraints. */
function slugifyTag(raw) {
    const lower = raw.toLowerCase();
    const replaced = lower.replace(/[^a-z0-9]+/g, "_");
    const trimmed = replaced.replace(/^_+|_+$/g, "");
    const fallback = trimmed || "value";
    return fallback.length > 64 ? fallback.slice(0, 64) : fallback;
}
/** Extends provenance lists with a synthetic `kg` entry derived from the triple source. */
function appendSourceProvenance(base, source) {
    if (!source) {
        return base;
    }
    const sourceEntry = { sourceId: source, type: "kg" };
    return mergeProvenance(base, [sourceEntry]);
}
/** Formats confidence scores with a consistent precision for textual summaries. */
function formatConfidence(value) {
    return value.toFixed(2);
}
//# sourceMappingURL=knowledgeGraph.js.map