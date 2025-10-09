/**
 * Merge correlation hints into the provided target without overriding existing
 * values with `undefined`. The helper resolves the subtle case where optional
 * resolvers omit identifiers which would otherwise erase the native correlation
 * propagated through lifecycle events.
 *
 * @param target - Mutable record receiving the merged hints.
 * @param source - Optional hints provided by emitters or resolvers.
 */
export function mergeCorrelationHints(target, source) {
    if (!source) {
        return;
    }
    for (const key of ["jobId", "runId", "opId", "graphId", "nodeId", "childId"]) {
        const value = source[key];
        if (value !== undefined) {
            target[key] = value;
        }
    }
}
/**
 * Clone correlation hints into a new plain object. Callers can rely on the
 * helper when they need to publish snapshots without mutating the original
 * record.
 */
export function cloneCorrelationHints(source) {
    const target = {};
    mergeCorrelationHints(target, source);
    return target;
}
/** Normalise candidate values to non-empty strings when possible. */
function normaliseCorrelationValue(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
    }
    return null;
}
/**
 * Extract correlation hints from arbitrary records, accepting both snake_case
 * and camelCase identifiers. Nested `correlation` blocks (objects or single
 * element arrays) are merged recursively, while ambiguous arrays are ignored
 * to avoid guessing the intended identifier.
 */
export function extractCorrelationHints(source) {
    const hints = {};
    if (!source || typeof source !== "object") {
        return hints;
    }
    const visited = new Set();
    const queue = [];
    const enqueue = (value) => {
        if (!value || typeof value !== "object" || visited.has(value)) {
            return;
        }
        visited.add(value);
        if (Array.isArray(value)) {
            for (const entry of value) {
                if (entry && typeof entry === "object") {
                    // Arrays occasionally surface multiple partial correlation records;
                    // enqueue each object so hints like run/op identifiers can be merged.
                    enqueue(entry);
                }
            }
            return;
        }
        queue.push(value);
    };
    enqueue(source);
    const readCandidate = (record, keys) => {
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(record, key)) {
                continue;
            }
            const value = record[key];
            if (value === null) {
                return null;
            }
            const candidate = normaliseCorrelationValue(value);
            if (candidate) {
                return candidate;
            }
        }
        return undefined;
    };
    const readSingleFromArray = (record, keys) => {
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(record, key)) {
                continue;
            }
            const value = record[key];
            if (value === null) {
                return null;
            }
            if (Array.isArray(value)) {
                const candidates = value
                    .map((entry) => normaliseCorrelationValue(entry))
                    .filter((entry) => typeof entry === "string" && entry.length > 0);
                if (candidates.length === 1) {
                    return candidates[0];
                }
            }
        }
        return undefined;
    };
    while (queue.length > 0) {
        const record = queue.shift();
        const runId = readCandidate(record, ["run_id", "runId"]);
        if (runId !== undefined && hints.runId == null) {
            hints.runId = runId;
        }
        const opId = readCandidate(record, ["op_id", "opId", "operation_id", "operationId"]);
        if (opId !== undefined && hints.opId == null) {
            hints.opId = opId;
        }
        const jobId = readCandidate(record, ["job_id", "jobId"]);
        if (jobId !== undefined && hints.jobId == null) {
            hints.jobId = jobId;
        }
        const graphId = readCandidate(record, ["graph_id", "graphId"]);
        if (graphId !== undefined && hints.graphId == null) {
            hints.graphId = graphId;
        }
        const nodeId = readCandidate(record, ["node_id", "nodeId"]);
        if (nodeId !== undefined && hints.nodeId == null) {
            hints.nodeId = nodeId;
        }
        const directChildId = readCandidate(record, ["child_id", "childId", "participant", "participant_id"]);
        if (directChildId !== undefined && hints.childId == null) {
            hints.childId = directChildId;
        }
        else if (hints.childId == null) {
            const arrayChildId = readSingleFromArray(record, [
                "child_ids",
                "childIds",
                "idle_children",
                "participants",
                "participant_ids",
            ]);
            if (arrayChildId !== undefined) {
                hints.childId = arrayChildId;
            }
        }
        const correlationCandidates = [
            record.correlation,
            record["correlation_hints"],
            record["correlationHints"],
        ];
        for (const candidate of correlationCandidates) {
            enqueue(candidate);
        }
    }
    return hints;
}
/**
 * Builds correlation hints for child-centric events by combining the runtime
 * identifier with optional job identifiers and additional metadata records.
 * The helper accepts heterogeneous sources (plain objects, nested correlation
 * blocks, arrays with a single entry) and reuses {@link extractCorrelationHints}
 * to keep the merge logic consistent with the rest of the event pipeline.
 */
export function buildChildCorrelationHints(options) {
    const hints = {};
    mergeCorrelationHints(hints, { childId: options.childId });
    if (options.jobId !== undefined) {
        if (options.jobId === null) {
            mergeCorrelationHints(hints, { jobId: null });
        }
        else if (typeof options.jobId === "string") {
            const trimmed = options.jobId.trim();
            mergeCorrelationHints(hints, { jobId: trimmed.length > 0 ? trimmed : null });
        }
    }
    for (const source of options.sources ?? []) {
        if (!source) {
            continue;
        }
        mergeCorrelationHints(hints, extractCorrelationHints(source));
    }
    return hints;
}
/**
 * Builds correlation hints for job-centric events by combining the job identifier
 * with optional auxiliary metadata. The helper mirrors
 * {@link buildChildCorrelationHints} so callers can derive `runId`/`opId`
 * information from job-related records (children snapshots, supervisor
 * metadata, payloads) without reimplementing the merge semantics.
 */
export function buildJobCorrelationHints(options) {
    const hints = {};
    const explicitNulls = new Set();
    const applyHints = (source) => {
        if (!source) {
            return;
        }
        for (const key of ["jobId", "runId", "opId", "graphId", "nodeId", "childId"]) {
            const value = source[key];
            if (value === undefined) {
                continue;
            }
            if (value === null) {
                hints[key] = null;
                explicitNulls.add(key);
                continue;
            }
            if (!explicitNulls.has(key)) {
                hints[key] = value;
            }
        }
    };
    let resolvedJobId;
    let resolvedFrom;
    if (options.jobId !== undefined) {
        if (options.jobId === null) {
            resolvedJobId = null;
            resolvedFrom = "base";
            applyHints({ jobId: null });
        }
        else {
            const normalised = normaliseCorrelationValue(options.jobId);
            if (normalised !== null) {
                resolvedJobId = normalised;
                resolvedFrom = "base";
                applyHints({ jobId: normalised });
            }
            else {
                resolvedJobId = null;
                resolvedFrom = "base";
                applyHints({ jobId: null });
            }
        }
    }
    for (const source of options.sources ?? []) {
        if (!source) {
            continue;
        }
        const extracted = extractCorrelationHints(source);
        const { jobId, ...rest } = extracted;
        if (jobId !== undefined) {
            if (jobId === null) {
                resolvedJobId = null;
                resolvedFrom = resolvedFrom ?? "source";
                applyHints({ jobId: null });
            }
            else if (resolvedJobId === undefined) {
                resolvedJobId = jobId;
                resolvedFrom = "source";
                applyHints({ jobId });
            }
            else if (resolvedJobId !== null && resolvedJobId !== jobId) {
                if (resolvedFrom !== "base") {
                    resolvedJobId = null;
                    resolvedFrom = "source";
                    applyHints({ jobId: null });
                }
            }
        }
        applyHints(rest);
    }
    return hints;
}
//# sourceMappingURL=correlation.js.map