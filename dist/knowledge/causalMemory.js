/**
 * Error emitted when the store cannot reconstruct a causal chain for the
 * requested outcome. The code is propagated to MCP clients so they can handle
 * missing paths explicitly instead of treating the absence as a generic
 * failure.
 */
export class CausalPathNotFoundError extends Error {
    code = "E-CAUSAL-NO-PATH";
    details;
    constructor(message, details) {
        super(message);
        this.name = "CausalPathNotFoundError";
        this.details = details;
    }
}
/**
 * Helper performing a JSON based deep clone. The payloads we persist are
 * expected to be JSON serialisable which keeps the implementation portable
 * across runtimes while remaining deterministic.
 */
function cloneData(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
/** Normalises and deduplicates an array of tags. */
function normaliseTags(tags) {
    if (!tags || tags.length === 0) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const tag of tags) {
        const cleaned = tag.trim();
        if (!cleaned.length || seen.has(cleaned)) {
            continue;
        }
        seen.add(cleaned);
        result.push(cleaned);
    }
    return result;
}
/**
 * In-memory DAG capturing how runtime events lead to observable outcomes. The
 * class is intentionally lightweight so deterministic tests can assert over the
 * causal relationships without requiring a backing database.
 */
export class CausalMemory {
    now;
    idPrefix;
    sequence = 0;
    records = new Map();
    constructor(options = {}) {
        this.now = options.now ?? (() => Date.now());
        this.idPrefix = options.idPrefix ?? "cm-";
    }
    /** Returns the total number of recorded events. */
    count() {
        return this.records.size;
    }
    /** Retrieve a snapshot for a given event identifier. */
    get(id) {
        const record = this.records.get(id);
        return record ? cloneRecord(record) : null;
    }
    /**
     * Record a new causal event and returns the resulting snapshot. Causes are
     * optional but when provided they must refer to previously recorded events.
     */
    record(input, causes = []) {
        const type = input.type.trim();
        if (!type) {
            throw new Error("causal event type must not be empty");
        }
        const label = input.label?.trim() ?? null;
        const tags = normaliseTags(input.tags);
        const timestamp = this.now();
        const uniqueCauses = [];
        const seen = new Set();
        for (const causeId of causes) {
            if (seen.has(causeId)) {
                continue;
            }
            const cause = this.records.get(causeId);
            if (!cause) {
                throw new Error(`unknown cause ${causeId}`);
            }
            seen.add(causeId);
            uniqueCauses.push(causeId);
        }
        const id = `${this.idPrefix}${++this.sequence}`;
        const ordinal = this.sequence;
        const data = cloneData(input.data ?? {});
        const record = {
            id,
            type,
            label,
            data,
            tags,
            causes: [...uniqueCauses],
            effects: [],
            createdAt: timestamp,
            ordinal,
        };
        this.records.set(id, record);
        for (const causeId of uniqueCauses) {
            const cause = this.records.get(causeId);
            if (!cause) {
                continue;
            }
            cause.effects = [...cause.effects, id];
        }
        return cloneRecord(record);
    }
    /**
     * Returns every recorded event ordered by insertion time. The snapshots are
     * clones so callers cannot mutate the internal state accidentally.
     */
    exportAll() {
        return Array.from(this.records.values())
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((record) => cloneRecord(record));
    }
    /**
     * Traverse the causal graph backwards starting from the provided outcome. The
     * result enumerates ancestors (ordered by insertion) and edges that can be
     * used to reconstruct explanation paths.
     */
    explain(outcomeId, options = {}) {
        const outcome = this.records.get(outcomeId);
        if (!outcome) {
            throw new CausalPathNotFoundError(`No outcome recorded with id ${outcomeId}`, { outcomeId });
        }
        const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
        const nodes = new Map();
        const edges = [];
        nodes.set(outcome.id, outcome);
        let depthReached = 0;
        const queue = [];
        for (const source of outcome.causes) {
            queue.push({ target: outcome.id, source, depth: 1 });
        }
        const visited = new Set();
        while (queue.length > 0) {
            const { target, source, depth } = queue.shift();
            edges.push({ from: source, to: target });
            depthReached = Math.max(depthReached, depth);
            if (visited.has(source)) {
                continue;
            }
            visited.add(source);
            const record = this.records.get(source);
            if (!record) {
                throw new CausalPathNotFoundError(`Causal link references missing event ${source}`, { outcomeId, causeId: source });
            }
            nodes.set(source, record);
            if (depth >= maxDepth) {
                continue;
            }
            for (const parent of record.causes) {
                queue.push({ target: source, source: parent, depth: depth + 1 });
            }
        }
        const ancestors = Array.from(nodes.values())
            .filter((record) => record.id !== outcome.id)
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((record) => cloneRecord(record));
        return {
            outcome: cloneRecord(outcome),
            ancestors,
            edges,
            depth: depthReached,
        };
    }
}
function cloneRecord(record) {
    return {
        id: record.id,
        type: record.type,
        label: record.label,
        data: cloneData(record.data),
        tags: [...record.tags],
        causes: [...record.causes],
        effects: [...record.effects],
        createdAt: record.createdAt,
        ordinal: record.ordinal,
    };
}
