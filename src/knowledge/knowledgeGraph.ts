/** Options accepted by the {@link KnowledgeGraph} constructor. */
export interface KnowledgeGraphOptions {
  /** Clock providing monotonic timestamps. Defaults to {@link Date.now}. */
  now?: () => number;
}

/** Representation of a triple persisted in the knowledge graph. */
export interface KnowledgeTripleSnapshot {
  /** Stable identifier assigned to the triple. */
  id: string;
  /** Subject part of the triple. */
  subject: string;
  /** Predicate part of the triple. */
  predicate: string;
  /** Object part of the triple. */
  object: string;
  /** Optional provenance string describing the data source. */
  source: string | null;
  /** Confidence score (0-1) associated with the triple. */
  confidence: number;
  /** Creation timestamp emitted by the injected clock. */
  insertedAt: number;
  /** Last update timestamp emitted by the injected clock. */
  updatedAt: number;
  /** Number of times the triple has been rewritten. */
  revision: number;
  /** Deterministic ordinal describing insertion order. */
  ordinal: number;
}

/**
 * Error raised when a caller attempts to persist a triple with blank fields.
 * The orchestration server relies on the `code` and `details` payload to emit
 * actionable MCP error responses while keeping logs informative.
 */
export class KnowledgeBadTripleError extends Error {
  public readonly code = "E-KG-BAD-TRIPLE";
  public readonly details: Record<string, string>;

  constructor(triple: { subject: string; predicate: string; object: string }) {
    super("Knowledge triples require non-empty subject, predicate and object");
    this.name = "KnowledgeBadTripleError";
    this.details = {
      subject: triple.subject,
      predicate: triple.predicate,
      object: triple.object,
    };
  }
}

/** Result returned by {@link KnowledgeGraph.insert}. */
export interface KnowledgeInsertResult {
  /** Snapshot describing the persisted triple. */
  snapshot: KnowledgeTripleSnapshot;
  /** Whether the operation created a new triple. */
  created: boolean;
  /** Whether the operation updated an existing triple. */
  updated: boolean;
}

/** Pattern accepted when querying the knowledge graph. */
export interface KnowledgeQueryPattern {
  subject?: string;
  predicate?: string;
  object?: string;
  source?: string;
  minConfidence?: number;
}

/** Additional options controlling how queries are executed. */
export interface KnowledgeQueryOptions {
  /** Maximum number of triples returned. */
  limit?: number;
  /** Sort order (ascending by ordinal by default). */
  order?: "asc" | "desc";
}

/** Metadata describing a reconstructed plan pattern. */
export interface KnowledgePlanPattern {
  /** Name of the plan used when querying the graph. */
  plan: string;
  /** Deterministic description of the tasks composing the pattern. */
  tasks: KnowledgePlanTask[];
  /** Average confidence derived from the supporting triples. */
  averageConfidence: number | null;
  /** Number of unique sources contributing to the pattern. */
  sourceCount: number;
}

/** Task descriptor derived from the knowledge graph. */
export interface KnowledgePlanTask {
  /** Identifier used by downstream planners. */
  id: string;
  /** Optional human readable label. */
  label?: string;
  /** Dependencies declared in the knowledge graph. */
  dependsOn: string[];
  /** Optional duration (arbitrary unit) extracted from the graph. */
  duration?: number;
  /** Optional weight used when balancing edges. */
  weight?: number;
  /** Provenance string if provided in the triple linking the task to the plan. */
  source: string | null;
  /** Confidence inherited from the triple linking the task to the plan. */
  confidence: number;
}

interface KnowledgeTripleRecord extends KnowledgeTripleSnapshot {
  key: string;
}

/**
 * Simple, fully in-memory knowledge graph. Triples are indexed by subject,
 * predicate and object to make motif based queries deterministic. Confidence
 * scores stay bounded between 0 and 1 to ease downstream computations.
 */
export class KnowledgeGraph {
  private readonly now: () => number;
  private readonly records = new Map<string, KnowledgeTripleRecord>();
  private readonly keyIndex = new Map<string, string>();
  private readonly subjectIndex = new Map<string, Set<string>>();
  private readonly predicateIndex = new Map<string, Set<string>>();
  private readonly objectIndex = new Map<string, Set<string>>();
  /** Index accelerating lookups constrained by both subject and predicate. */
  private readonly subjectPredicateIndex = new Map<string, Set<string>>();
  /** Index accelerating lookups constrained by both object and predicate. */
  private readonly objectPredicateIndex = new Map<string, Set<string>>();
  private sequence = 0;

  constructor(options: KnowledgeGraphOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Returns the total number of stored triples. */
  count(): number {
    return this.records.size;
  }

  /** Inserts or updates a triple and returns the resulting snapshot. */
  insert(triple: {
    subject: string;
    predicate: string;
    object: string;
    source?: string;
    confidence?: number;
  }): KnowledgeInsertResult {
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
      const updated: KnowledgeTripleRecord = {
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
    const record: KnowledgeTripleRecord = {
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
    this.index(this.subjectPredicateIndex, makePairKey(subject, predicate), id);
    this.index(this.objectPredicateIndex, makePairKey(object, predicate), id);
    return { snapshot: cloneRecord(record), created: true, updated: false };
  }

  /**
   * Retrieves triples matching the provided pattern. Wildcards (`*`) are
   * supported anywhere within the pattern fields and match any sequence.
   */
  query(
    pattern: KnowledgeQueryPattern = {},
    options: KnowledgeQueryOptions = {},
  ): KnowledgeTripleSnapshot[] {
    const candidates = this.collectCandidates(pattern);
    const ordered = candidates
      .map((id) => this.records.get(id))
      .filter((record): record is KnowledgeTripleRecord => Boolean(record))
      .filter((record) => matchesRecord(record, pattern))
      .sort((a, b) => (options.order === "desc" ? b.ordinal - a.ordinal : a.ordinal - b.ordinal));

    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, ordered.length) : ordered.length;
    const sliced = ordered.slice(0, limit);
    return sliced.map(cloneRecord);
  }

  /** Returns every triple ordered by insertion time. */
  exportAll(): KnowledgeTripleSnapshot[] {
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
  buildPlanPattern(plan: string): KnowledgePlanPattern | null {
    const includes = this.query({ subject: plan, predicate: "includes" });
    if (!includes.length) {
      return null;
    }

    const tasks: KnowledgePlanTask[] = [];
    const sources = new Set<string>();
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

  /**
   * Removes every stored triple along with the derived indexes. The internal
   * ordinal counter is reset so future insertions start from a clean slate.
   */
  clear(): void {
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
  restore(snapshots: KnowledgeTripleSnapshot[]): void {
    this.clear();

    for (const snapshot of snapshots) {
      const record: KnowledgeTripleRecord = {
        ...snapshot,
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

  private collectCandidates(pattern: KnowledgeQueryPattern): string[] {
    const exactSubject = typeof pattern.subject === "string" && !hasWildcard(pattern.subject);
    const exactPredicate = typeof pattern.predicate === "string" && !hasWildcard(pattern.predicate);
    const exactObject = typeof pattern.object === "string" && !hasWildcard(pattern.object);

    // When the caller fixes the full triple we can leverage the primary key
    // index directly and avoid walking any of the secondary indexes.
    if (exactSubject && exactPredicate && exactObject) {
      const key = makeKey(pattern.subject!, pattern.predicate!, pattern.object!);
      const identifier = this.keyIndex.get(key);
      return identifier ? [identifier] : [];
    }

    const sets: Array<Set<string>> = [];
    const addSet = (set: Set<string> | undefined) => {
      if (set && !sets.includes(set)) {
        sets.push(set);
      }
    };

    if (exactSubject && exactPredicate) {
      const composite = this.subjectPredicateIndex.get(
        makePairKey(pattern.subject!, pattern.predicate!),
      );
      if (composite) {
        addSet(composite);
      } else {
        addSet(this.subjectIndex.get(pattern.subject!));
        addSet(this.predicateIndex.get(pattern.predicate!));
      }
    } else {
      if (exactSubject) {
        addSet(this.subjectIndex.get(pattern.subject!));
      }
      if (exactPredicate) {
        addSet(this.predicateIndex.get(pattern.predicate!));
      }
    }

    if (exactObject && exactPredicate) {
      const composite = this.objectPredicateIndex.get(
        makePairKey(pattern.object!, pattern.predicate!),
      );
      if (composite) {
        addSet(composite);
      } else {
        addSet(this.objectIndex.get(pattern.object!));
        addSet(this.predicateIndex.get(pattern.predicate!));
      }
    } else if (exactObject) {
      addSet(this.objectIndex.get(pattern.object!));
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

  private index(map: Map<string, Set<string>>, key: string, id: string): void {
    const existing = map.get(key);
    if (existing) {
      existing.add(id);
      return;
    }
    map.set(key, new Set([id]));
  }
}

function makeKey(subject: string, predicate: string, object: string): string {
  return `${subject}\u0000${predicate}\u0000${object}`;
}

function makePairKey(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

function cloneRecord(record: KnowledgeTripleRecord): KnowledgeTripleSnapshot {
  return { ...record };
}

function intersect(left: Set<string>, right: Set<string>): Set<string> {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  const result = new Set<string>();
  for (const value of small) {
    if (large.has(value)) {
      result.add(value);
    }
  }
  return result;
}

function hasWildcard(value: string): boolean {
  return value.includes("*");
}

function wildcardMatch(value: string, pattern: string): boolean {
  if (!hasWildcard(pattern)) {
    return value === pattern;
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`);
  return regex.test(value);
}

function matchesRecord(record: KnowledgeTripleRecord, pattern: KnowledgeQueryPattern): boolean {
  if (pattern.subject && !wildcardMatch(record.subject, pattern.subject)) return false;
  if (pattern.predicate && !wildcardMatch(record.predicate, pattern.predicate)) return false;
  if (pattern.object && !wildcardMatch(record.object, pattern.object)) return false;
  if (pattern.source) {
    const source = record.source ?? "";
    if (!wildcardMatch(source, pattern.source)) return false;
  }
  if (pattern.minConfidence !== undefined) {
    const threshold = clampConfidence(pattern.minConfidence);
    if (record.confidence < threshold) return false;
  }
  return true;
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 1;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function taskSubject(taskId: string): string {
  return `task:${taskId}`;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
