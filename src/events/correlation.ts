/**
 * Utilities shared across the event bridges to safely merge correlation hints.
 * The helpers ensure optional resolvers cannot erase native identifiers when
 * they omit fields (returning `undefined`) while still allowing overrides with
 * explicit `null` or string values.
 */
export interface EventCorrelationHints {
  jobId?: string | null;
  runId?: string | null;
  opId?: string | null;
  graphId?: string | null;
  nodeId?: string | null;
  childId?: string | null;
}

/**
 * Shape accepted when merging correlation hints into a target envelope. Using a
 * separate alias makes the intent explicit when helpers receive hints from
 * legacy emitters that may surface sparse records.
 */
export type CorrelationLike =
  | Partial<Record<keyof EventCorrelationHints, string | null | undefined>>
  | null
  | undefined;

/**
 * Merge correlation hints into the provided target without overriding existing
 * values with `undefined`. The helper resolves the subtle case where optional
 * resolvers omit identifiers which would otherwise erase the native correlation
 * propagated through lifecycle events.
 *
 * @param target - Mutable record receiving the merged hints.
 * @param source - Optional hints provided by emitters or resolvers.
 */
export function mergeCorrelationHints(target: EventCorrelationHints, source: CorrelationLike): void {
  if (!source) {
    return;
  }
  for (const key of ["jobId", "runId", "opId", "graphId", "nodeId", "childId"] as const) {
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
export function cloneCorrelationHints(source: CorrelationLike): EventCorrelationHints {
  const target: EventCorrelationHints = {};
  mergeCorrelationHints(target, source);
  return target;
}

/** Normalise candidate values to non-empty strings when possible. */
function normaliseCorrelationValue(value: unknown): string | null {
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
export function extractCorrelationHints(source: unknown): EventCorrelationHints {
  const hints: EventCorrelationHints = {};
  if (!source || typeof source !== "object") {
    return hints;
  }

  const visited = new Set<unknown>();
  const queue: Record<string, unknown>[] = [];

  const enqueue = (value: unknown) => {
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
    queue.push(value as Record<string, unknown>);
  };

  enqueue(source);

  const readCandidate = (
    record: Record<string, unknown>,
    keys: readonly string[],
  ): string | null | undefined => {
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

  const readSingleFromArray = (
    record: Record<string, unknown>,
    keys: readonly string[],
  ): string | null | undefined => {
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
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
        if (candidates.length === 1) {
          return candidates[0]!;
        }
      }
    }
    return undefined;
  };

  while (queue.length > 0) {
    const record = queue.shift()!;

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
    } else if (hints.childId == null) {
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
      (record as Record<string, unknown>)["correlation_hints"],
      (record as Record<string, unknown>)["correlationHints"],
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
export function buildChildCorrelationHints(options: {
  /** Child identifier associated with the event. */
  childId: string;
  /** Optional job identifier inferred from the orchestrator state. */
  jobId?: string | null | undefined;
  /** Additional records inspected to derive correlation hints (metadata, payloads…). */
  sources?: Array<unknown | null | undefined>;
}): EventCorrelationHints {
  const hints: EventCorrelationHints = {};
  mergeCorrelationHints(hints, { childId: options.childId });

  if (options.jobId !== undefined) {
    if (options.jobId === null) {
      mergeCorrelationHints(hints, { jobId: null });
    } else if (typeof options.jobId === "string") {
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
export function buildJobCorrelationHints(options: {
  /** Job identifier associated with the event. */
  jobId?: string | null | undefined;
  /** Additional records inspected to derive correlation hints. */
  sources?: Array<unknown | null | undefined>;
}): EventCorrelationHints {
  const hints: EventCorrelationHints = {};

  const explicitNulls = new Set<keyof EventCorrelationHints>();
  const applyHints = (source: CorrelationLike) => {
    if (!source) {
      return;
    }
    for (const key of ["jobId", "runId", "opId", "graphId", "nodeId", "childId"] as const) {
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

  let resolvedJobId: string | null | undefined;
  let resolvedFrom: "base" | "source" | undefined;

  if (options.jobId !== undefined) {
    if (options.jobId === null) {
      resolvedJobId = null;
      resolvedFrom = "base";
      applyHints({ jobId: null });
    } else {
      const normalised = normaliseCorrelationValue(options.jobId);
      if (normalised !== null) {
        resolvedJobId = normalised;
        resolvedFrom = "base";
        applyHints({ jobId: normalised });
      } else {
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
      } else if (resolvedJobId === undefined) {
        resolvedJobId = jobId;
        resolvedFrom = "source";
        applyHints({ jobId });
      } else if (resolvedJobId !== null && resolvedJobId !== jobId) {
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
