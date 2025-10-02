/**
 * Deterministic in-memory causal memory tracking outcome events and their
 * dependencies. The store keeps a causal graph so explanations can be derived
 * without replaying the full execution.
 */
export interface CausalMemoryOptions {
  /** Monotonic clock returning millisecond timestamps (defaults to {@link Date.now}). */
  now?: () => number;
  /** Optional identifier prefix easing correlation when multiple stores coexist. */
  idPrefix?: string;
}

/** Payload accepted when recording a new causal event. */
export interface CausalEventInput {
  /** Machine readable type describing the event category. */
  type: string;
  /** Optional human readable label easing diagnostics. */
  label?: string;
  /** Structured payload carrying contextual attributes. */
  data?: Record<string, unknown>;
  /** Optional set of tags used to query/aggregate events. */
  tags?: string[];
}

/** Snapshot returned when inspecting a recorded causal event. */
export interface CausalEventSnapshot {
  id: string;
  type: string;
  label: string | null;
  data: Record<string, unknown>;
  tags: string[];
  causes: string[];
  effects: string[];
  createdAt: number;
  ordinal: number;
}

/** Directed edge linking a cause to its effect. */
export interface CausalEdgeSnapshot {
  from: string;
  to: string;
}

/** Result returned by {@link CausalMemory.explain}. */
export interface CausalExplanation {
  outcome: CausalEventSnapshot;
  ancestors: CausalEventSnapshot[];
  edges: CausalEdgeSnapshot[];
  depth: number;
}

/**
 * Error emitted when the store cannot reconstruct a causal chain for the
 * requested outcome. The code is propagated to MCP clients so they can handle
 * missing paths explicitly instead of treating the absence as a generic
 * failure.
 */
export class CausalPathNotFoundError extends Error {
  public readonly code = "E-CAUSAL-NO-PATH";
  public readonly details: { outcomeId: string; causeId?: string };

  constructor(message: string, details: { outcomeId: string; causeId?: string }) {
    super(message);
    this.name = "CausalPathNotFoundError";
    this.details = details;
  }
}

interface CausalEventRecord extends CausalEventSnapshot {}

/**
 * Helper performing a JSON based deep clone. The payloads we persist are
 * expected to be JSON serialisable which keeps the implementation portable
 * across runtimes while remaining deterministic.
 */
function cloneData<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** Normalises and deduplicates an array of tags. */
function normaliseTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
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
  private readonly now: () => number;
  private readonly idPrefix: string;
  private sequence = 0;
  private readonly records = new Map<string, CausalEventRecord>();

  constructor(options: CausalMemoryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idPrefix = options.idPrefix ?? "cm-";
  }

  /** Returns the total number of recorded events. */
  count(): number {
    return this.records.size;
  }

  /** Retrieve a snapshot for a given event identifier. */
  get(id: string): CausalEventSnapshot | null {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : null;
  }

  /**
   * Record a new causal event and returns the resulting snapshot. Causes are
   * optional but when provided they must refer to previously recorded events.
   */
  record(input: CausalEventInput, causes: string[] = []): CausalEventSnapshot {
    const type = input.type.trim();
    if (!type) {
      throw new Error("causal event type must not be empty");
    }
    const label = input.label?.trim() ?? null;
    const tags = normaliseTags(input.tags);
    const timestamp = this.now();

    const uniqueCauses: string[] = [];
    const seen = new Set<string>();
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

    const record: CausalEventRecord = {
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
  exportAll(): CausalEventSnapshot[] {
    return Array.from(this.records.values())
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((record) => cloneRecord(record));
  }

  /**
   * Traverse the causal graph backwards starting from the provided outcome. The
   * result enumerates ancestors (ordered by insertion) and edges that can be
   * used to reconstruct explanation paths.
   */
  explain(outcomeId: string, options: { maxDepth?: number } = {}): CausalExplanation {
    const outcome = this.records.get(outcomeId);
    if (!outcome) {
      throw new CausalPathNotFoundError(
        `No outcome recorded with id ${outcomeId}`,
        { outcomeId },
      );
    }
    const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
    const nodes = new Map<string, CausalEventRecord>();
    const edges: CausalEdgeSnapshot[] = [];

    nodes.set(outcome.id, outcome);
    let depthReached = 0;
    const queue: Array<{ target: string; source: string; depth: number }> = [];
    for (const source of outcome.causes) {
      queue.push({ target: outcome.id, source, depth: 1 });
    }

    const visited = new Set<string>();
    while (queue.length > 0) {
      const { target, source, depth } = queue.shift()!;
      edges.push({ from: source, to: target });
      depthReached = Math.max(depthReached, depth);
      if (visited.has(source)) {
        continue;
      }
      visited.add(source);
      const record = this.records.get(source);
      if (!record) {
        throw new CausalPathNotFoundError(
          `Causal link references missing event ${source}`,
          { outcomeId, causeId: source },
        );
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

function cloneRecord(record: CausalEventRecord): CausalEventSnapshot {
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
