/**
 * Enumerates the supported provenance categories for knowledge artefacts. The
 * list intentionally mirrors the sources orchestrators interact with so we can
 * derive analytics (e.g. RAG vs KG) without post-processing free-form strings.
 */
export const PROVENANCE_TYPES = ["url", "file", "db", "kg", "rag"] as const;

/** Literal union describing the supported provenance categories. */
export type ProvenanceType = (typeof PROVENANCE_TYPES)[number];

/**
 * Structured metadata attached to reasoning artefacts so we can trace their
 * origin. Consumers aggregate these entries to produce citations in final
 * responses or to compute accountability metrics in dashboards.
 */
export type Provenance = {
  /** Stable identifier for the originating artefact (URL, file path, document id...). */
  sourceId: string;
  /** High-level category describing the artefact kind. */
  type: ProvenanceType;
  /** Optional inclusive character span when the artefact is textual. */
  span?: [number, number];
  /** Optional confidence score in the range [0,1]. */
  confidence?: number;
};

/** Clamp helper keeping confidence scores in the inclusive [0, 1] range. */
function clampConfidence(value: number | undefined): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Ensures span tuples are well formed and ordered. */
function normaliseSpan(span: [number, number] | undefined): [number, number] | undefined {
  if (!span) {
    return undefined;
  }
  const [startRaw, endRaw] = span;
  if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) {
    return undefined;
  }
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }
  if (end < start) {
    return [end, start];
  }
  return [start, end];
}

/**
 * Deduplicates and normalises provenance entries while preserving insertion
 * order. Callers can feed raw user provided metadata and the helper will trim
 * identifiers, clamp confidence values and drop malformed items.
 */
export function normaliseProvenanceList(
  raw: ReadonlyArray<Provenance | null | undefined> | undefined,
): Provenance[] {
  if (!raw || raw.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const result: Provenance[] = [];

  for (const entry of raw) {
    if (!entry) {
      continue;
    }

    const sourceId = typeof entry.sourceId === "string" ? entry.sourceId.trim() : "";
    const type = typeof entry.type === "string" ? entry.type.trim().toLowerCase() : "";

    if (!sourceId || !PROVENANCE_TYPES.includes(type as ProvenanceType)) {
      continue;
    }

    const span = normaliseSpan(entry.span);
    const confidence = clampConfidence(entry.confidence);
    const key = `${type}:${sourceId}:${span ? `${span[0]}-${span[1]}` : ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const normalised: Provenance = {
      sourceId,
      type: type as ProvenanceType,
    };
    if (span) {
      normalised.span = span;
    }
    if (confidence !== undefined) {
      normalised.confidence = confidence;
    }
    result.push(normalised);
  }

  return result;
}

/**
 * Merges two provenance lists by preferring the latest confidence value for
 * duplicate entries while keeping earlier ordering for stability. When an
 * incoming entry omits the span but matches an existing type/source pair, the
 * original (more specific) span is preserved instead of creating a new entry.
 */
export function mergeProvenance(
  base: ReadonlyArray<Provenance>,
  incoming: ReadonlyArray<Provenance>,
): Provenance[] {
  if (base.length === 0) {
    return normaliseProvenanceList(incoming);
  }
  if (incoming.length === 0) {
    return normaliseProvenanceList(base);
  }

  const normalisedBase = normaliseProvenanceList(base);
  const merged: Provenance[] = [...normalisedBase];

  const keyFor = (entry: Provenance) =>
    `${entry.type}:${entry.sourceId}:${entry.span ? `${entry.span[0]}-${entry.span[1]}` : ""}`;
  const typeSourceKeyFor = (entry: { type: ProvenanceType; sourceId: string }) => `${entry.type}:${entry.sourceId}`;

  const index = new Map<string, Provenance>();
  const byTypeSource = new Map<string, Provenance[]>();

  for (const entry of merged) {
    index.set(keyFor(entry), entry);
    const typeSourceKey = typeSourceKeyFor(entry);
    const bucket = byTypeSource.get(typeSourceKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      byTypeSource.set(typeSourceKey, [entry]);
    }
  }

  const replaceEntry = (existing: Provenance, updated: Provenance) => {
    const oldKey = keyFor(existing);
    index.delete(oldKey);

    const bucketKey = typeSourceKeyFor(existing);
    const bucket = byTypeSource.get(bucketKey);
    if (bucket) {
      const bucketIndex = bucket.indexOf(existing);
      if (bucketIndex >= 0) {
        bucket[bucketIndex] = updated;
      }
    }

    const mergedIndex = merged.indexOf(existing);
    if (mergedIndex >= 0) {
      merged[mergedIndex] = updated;
    }

    index.set(keyFor(updated), updated);
  };

  const addEntry = (entry: Provenance) => {
    merged.push(entry);
    const bucketKey = typeSourceKeyFor(entry);
    const bucket = byTypeSource.get(bucketKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      byTypeSource.set(bucketKey, [entry]);
    }
    index.set(keyFor(entry), entry);
  };

  const normalisedIncoming = normaliseProvenanceList(incoming);

  for (const entry of normalisedIncoming) {
    const entryKey = keyFor(entry);
    const exactMatch = index.get(entryKey);
    if (exactMatch) {
      const nextSpan = entry.span ?? exactMatch.span;
      const nextConfidence = entry.confidence ?? exactMatch.confidence;
      const updated: Provenance = { sourceId: exactMatch.sourceId, type: exactMatch.type };
      if (nextSpan) {
        updated.span = nextSpan;
      }
      if (nextConfidence !== undefined) {
        updated.confidence = nextConfidence;
      }
      replaceEntry(exactMatch, updated);
      continue;
    }

    const bucketKey = typeSourceKeyFor(entry);
    const bucket = byTypeSource.get(bucketKey);
    if (bucket && bucket.length > 0) {
      if (!entry.span) {
        const target = bucket.find((candidate) => !candidate.span) ?? bucket[0];
        const nextSpan = target.span;
        const nextConfidence = entry.confidence ?? target.confidence;
        const updated: Provenance = { sourceId: target.sourceId, type: target.type };
        if (nextSpan) {
          updated.span = nextSpan;
        }
        if (nextConfidence !== undefined) {
          updated.confidence = nextConfidence;
        }
        replaceEntry(target, updated);
        continue;
      }

      const spanLessCandidate = bucket.find((candidate) => !candidate.span);
      if (spanLessCandidate) {
        const nextConfidence = entry.confidence ?? spanLessCandidate.confidence;
        const updated: Provenance = {
          sourceId: spanLessCandidate.sourceId,
          type: spanLessCandidate.type,
          span: entry.span,
        };
        if (nextConfidence !== undefined) {
          updated.confidence = nextConfidence;
        }
        replaceEntry(spanLessCandidate, updated);
        continue;
      }
    }

    addEntry(entry);
  }

  return merged;
}
