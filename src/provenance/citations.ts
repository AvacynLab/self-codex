import { normaliseProvenanceList, type Provenance } from "../types/provenance.js";
import type { OrchestratorEvent } from "../eventStore.js";

/** Options recognised by {@link aggregateCitationsFromEvents}. */
export interface AggregateCitationsOptions {
  /** Maximum number of citations returned. Defaults to five entries. */
  readonly limit?: number;
  /**
   * Optional fallback confidence applied when the source omits an explicit
   * score. Using a slightly negative default keeps unknown confidences sorted
   * after explicit values without mutating the returned payloads.
   */
  readonly unknownConfidenceScore?: number;
}

interface AggregatedCitation {
  entry: Provenance;
  occurrences: number;
  lastSeq: number;
  bestConfidence: number | null;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_UNKNOWN_CONFIDENCE = -0.5;

/**
 * Aggregates provenance metadata observed across orchestrator events so final
 * answers can cite the most relevant sources. The helper deduplicates entries
 * by `(type, sourceId)` and surfaces the highest confidence along with the
 * latest known span.
 */
export function aggregateCitationsFromEvents(
  events: ReadonlyArray<Pick<OrchestratorEvent, "seq" | "provenance">>,
  options: AggregateCitationsOptions = {},
): Provenance[] {
  const limit = normaliseLimit(options.limit ?? DEFAULT_LIMIT);
  if (limit === 0) {
    return [];
  }

  const unknownConfidence = options.unknownConfidenceScore ?? DEFAULT_UNKNOWN_CONFIDENCE;
  const merged = new Map<string, AggregatedCitation>();

  for (const event of events) {
    const provenanceList = normaliseProvenanceList(event.provenance);
    if (provenanceList.length === 0) {
      continue;
    }

    for (const provenance of provenanceList) {
      const key = `${provenance.type}:${provenance.sourceId}`;
      const existing = merged.get(key);
      const span = provenance.span ? ([provenance.span[0], provenance.span[1]] as [number, number]) : undefined;
      const confidence = provenance.confidence ?? null;

      if (!existing) {
        const entry: Provenance = { sourceId: provenance.sourceId, type: provenance.type };
        if (span) {
          entry.span = span;
        }
        if (confidence !== null) {
          entry.confidence = confidence;
        }
        merged.set(key, {
          entry,
          occurrences: 1,
          lastSeq: event.seq,
          bestConfidence: confidence,
        });
        continue;
      }

      existing.occurrences += 1;
      if (event.seq > existing.lastSeq) {
        existing.lastSeq = event.seq;
      }

      if (confidence !== null) {
        if (existing.bestConfidence === null || confidence > existing.bestConfidence) {
          existing.bestConfidence = confidence;
          existing.entry.confidence = confidence;
        }
      }

      if (span) {
        if (!existing.entry.span) {
          existing.entry.span = span;
        } else if (confidence !== null && existing.bestConfidence !== null && confidence >= existing.bestConfidence) {
          existing.entry.span = span;
        }
      }
    }
  }

  if (merged.size === 0) {
    return [];
  }

  const ranked = Array.from(merged.values());
  ranked.sort((a, b) => {
    const confA = a.bestConfidence ?? unknownConfidence;
    const confB = b.bestConfidence ?? unknownConfidence;
    if (confA !== confB) {
      return confB - confA;
    }
    if (a.occurrences !== b.occurrences) {
      return b.occurrences - a.occurrences;
    }
    if (a.lastSeq !== b.lastSeq) {
      return b.lastSeq - a.lastSeq;
    }
    if (a.entry.type !== b.entry.type) {
      return a.entry.type.localeCompare(b.entry.type);
    }
    return a.entry.sourceId.localeCompare(b.entry.sourceId);
  });

  const slice = limit === undefined ? ranked : ranked.slice(0, limit);
  return slice.map((item) => {
    const citation: Provenance = { sourceId: item.entry.sourceId, type: item.entry.type };
    if (item.entry.span) {
      citation.span = [item.entry.span[0], item.entry.span[1]];
    }
    if (item.entry.confidence !== undefined) {
      citation.confidence = item.entry.confidence;
    }
    return citation;
  });
}

function normaliseLimit(limit: number | undefined): number | undefined {
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
