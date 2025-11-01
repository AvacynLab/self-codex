import { mergeProvenance, normaliseProvenanceList, type Provenance } from "../types/provenance.js";

/**
 * Fingerprint separator used when building run-scoped identifiers for
 * knowledge triples. A private separator avoids collisions when subjects,
 * predicates or objects embed user-controlled characters.
 */
const TRIPLE_FINGERPRINT_SEPARATOR = "\u001f";

/**
 * Options accepted by {@link KnowledgeGraph.exportForRag}. They control the
 * filtering performed before synthesising RAG friendly documents.
 */
export interface KnowledgeRagExportOptions {
  /** Drops triples whose confidence is lower than the provided threshold. */
  minConfidence?: number;
  /** Restricts the export to triples whose predicate is part of the allow-list. */
  includePredicates?: string[];
  /**
   * Caps the number of triples exported per subject so that extremely dense
   * nodes do not generate overly long passages.
   */
  maxTriplesPerSubject?: number;
}

/**
 * Document synthesised from knowledge graph triples so it can be ingested by
 * the RAG pipeline. The structure mirrors the expectations of the
 * `rag_ingest` tool: textual content, optional tags, metadata, and provenance.
 */
export interface KnowledgeRagDocument {
  /** Stable identifier derived from the subject the document summarises. */
  id: string;
  /** Human readable summary describing the subject and its facts. */
  text: string;
  /** Tags extracted from subjects/predicates/sources to aid domain filtering. */
  tags: string[];
  /** Structured metadata providing additional context for auditing. */
  metadata: {
    subject: string;
    triple_count: number;
    predicates: string[];
    sources: string[];
    average_confidence: number | null;
  };
  /** Aggregated provenance covering every triple contributing to the document. */
  provenance: Provenance[];
}

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
  /** Structured provenance metadata pointing to supporting artefacts. */
  provenance: Provenance[];
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
  /** Structured provenance metadata associated with the task triple. */
  provenance: Provenance[];
}

/**
 * Input payload accepted by {@link upsertTriple}.  The shape mirrors the
 * low-level `insert` contract while allowing higher level helpers to forward
 * partially specified provenance and optional metadata without leaking
 * `undefined` values once exact optional property typing is enabled.
 */
export interface KnowledgeTripleInput {
  subject: string;
  predicate: string;
  object: string;
  source?: string | null;
  confidence?: number | null;
  provenance?: ReadonlyArray<Provenance | null | undefined>;
}

/**
 * Runtime guard dedicated to a single ingestion run. The helper remembers the
 * `(subject, predicate, object)` tuples that were processed so orchestrators
 * can skip redundant writes produced by upstream heuristics.  Using the guard
 * keeps knowledge graph updates idempotent even when retries re-emit the same
 * triples multiple times during the run.
 */
export interface KnowledgeTripleRunGuard {
  /**
   * Records the provided triple fingerprint and returns `true` when the tuple
   * has not been observed during the current run.  Callers can use the return
   * value to decide whether to forward the triple to {@link upsertTriple}.
   */
  remember(triple: KnowledgeTripleInput): boolean;
  /** Clears the internal state so the guard can be reused for another run. */
  reset(): void;
  /** Exposes the number of unique triples remembered during the run. */
  size(): number;
}

/**
 * Creates a guard suitable for a single ingest run.  The implementation keeps
 * a `Set` of canonical fingerprints to guarantee O(1) membership checks and to
 * make duplicate suppression deterministic irrespective of the triple order.
 */
export function createKnowledgeTripleRunGuard(): KnowledgeTripleRunGuard {
  const seen = new Set<string>();

  return {
    remember(triple: KnowledgeTripleInput): boolean {
      const fingerprint = fingerprintTriple(triple.subject, triple.predicate, triple.object);
      if (!fingerprint) {
        return false;
      }
      if (seen.has(fingerprint)) {
        return false;
      }
      seen.add(fingerprint);
      return true;
    },
    reset(): void {
      seen.clear();
    },
    size(): number {
      return seen.size;
    },
  };
}

/**
 * Builds a deterministic fingerprint for the provided triple components. The
 * helper trims the values before concatenation so callers can forward raw
 * extractor output without worrying about stray whitespace breaking
 * idempotence guarantees.
 */
export function fingerprintTriple(subject: string, predicate: string, object: string): string | null {
  const canonicalSubject = subject.trim();
  const canonicalPredicate = predicate.trim();
  const canonicalObject = object.trim();
  if (!canonicalSubject || !canonicalPredicate || !canonicalObject) {
    return null;
  }
  return [canonicalSubject, canonicalPredicate, canonicalObject].join(TRIPLE_FINGERPRINT_SEPARATOR);
}

/**
 * Removes duplicate triples from a batch while preserving insertion order. The
 * helper keeps the first occurrence of each `(subject, predicate, object)`
 * fingerprint so ingestion pipelines can enqueue redundant entries without
 * producing duplicate writes during the same transaction.
 */
export function dedupeTripleBatch(triples: Iterable<KnowledgeTripleInput>): KnowledgeTripleInput[] {
  const seen = new Set<string>();
  const unique: KnowledgeTripleInput[] = [];

  for (const triple of triples) {
    const subject = triple.subject.trim();
    const predicate = triple.predicate.trim();
    const object = triple.object.trim();
    if (!subject || !predicate || !object) {
      continue;
    }
    const fingerprint = `${subject}\u0000${predicate}\u0000${object}`;
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    unique.push(triple);
  }

  return unique;
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
    provenance?: Provenance[];
  }): KnowledgeInsertResult {
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
      const updated: KnowledgeTripleRecord = {
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
    const record: KnowledgeTripleRecord = {
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
   * Synthesises RAG friendly documents by grouping triples per subject. Each
   * document contains a textual summary, automatically derived tags, metadata
   * describing the aggregated triples, and merged provenance entries. The
   * resulting payload can be ingested directly via `rag_ingest` to bootstrap
   * semantic recall from the knowledge graph content.
   */
  exportForRag(options: KnowledgeRagExportOptions = {}): KnowledgeRagDocument[] {
    const minConfidence = clampThreshold(options.minConfidence);
    const includePredicates = normalisePredicateAllowList(options.includePredicates);
    const maxTriplesPerSubject = clampPositiveInteger(options.maxTriplesPerSubject);

    const buckets = new Map<string, KnowledgeTripleSnapshot[]>();
    const orderedSubjects: string[] = [];

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

    const documents: KnowledgeRagDocument[] = [];

    for (const subject of orderedSubjects) {
      const triples = buckets.get(subject);
      if (!triples || triples.length === 0) {
        continue;
      }

      const tags = new Set<string>(["kg", `subject:${slugifyTag(subject)}`]);
      const predicateSet = new Set<string>();
      const sourceSet = new Set<string>();
      let provenance: Provenance[] = [];
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

        const qualifiers: string[] = [];
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
      const provenance = cloneProvenanceList(include.provenance);
      if (source) {
        sources.add(source);
      }
      confidenceSum += confidence;
      // Only materialise optional task metadata when present so downstream
      // planners never receive properties explicitly set to `undefined`.
      const taskRecord: KnowledgePlanTask = {
        id: taskId,
        dependsOn: dedupe(dependsOn),
        source: source ?? null,
        confidence,
        provenance,
      };
      if (label !== undefined) {
        taskRecord.label = label;
      }
      if (duration !== null) {
        taskRecord.duration = duration;
      }
      if (weight !== null) {
        taskRecord.weight = weight;
      }
      tasks.push(taskRecord);
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
      const provenance = normaliseProvenanceList(
        (snapshot as KnowledgeTripleSnapshot & { provenance?: Provenance[] }).provenance,
      );
      const record: KnowledgeTripleRecord = {
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
  return { ...record, provenance: cloneProvenanceList(record.provenance) };
}

function cloneProvenanceList(list: ReadonlyArray<Provenance>): Provenance[] {
  return list.map((entry) => ({ ...entry }));
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

/** Clamps the caller provided confidence threshold within the inclusive [0, 1] range. */
function clampThreshold(value: number | undefined): number {
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
function normalisePredicateAllowList(predicates: string[] | undefined): Set<string> {
  if (!predicates || predicates.length === 0) {
    return new Set();
  }
  const allowList = new Set<string>();
  for (const predicate of predicates) {
    const trimmed = predicate.trim();
    if (trimmed) {
      allowList.add(trimmed);
    }
  }
  return allowList;
}

/** Normalises counts expressed as numbers so that `NaN` or sub-unit values are ignored. */
function clampPositiveInteger(value: number | undefined): number | null {
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
function slugifyTag(raw: string): string {
  const lower = raw.toLowerCase();
  const replaced = lower.replace(/[^a-z0-9]+/g, "_");
  const trimmed = replaced.replace(/^_+|_+$/g, "");
  const fallback = trimmed || "value";
  return fallback.length > 64 ? fallback.slice(0, 64) : fallback;
}

/** Extends provenance lists with a synthetic `kg` entry derived from the triple source. */
function appendSourceProvenance(base: Provenance[], source: string | null): Provenance[] {
  if (!source) {
    return base;
  }
  const sourceEntry: Provenance = { sourceId: source, type: "kg" };
  return mergeProvenance(base, [sourceEntry]);
}

/** Formats confidence scores with a consistent precision for textual summaries. */
function formatConfidence(value: number): string {
  return value.toFixed(2);
}

/**
 * Stores or updates a triple on the provided graph while handling optional
 * metadata defensively.  The helper mirrors the low-level `insert` method but
 * avoids forwarding blank sources, `null` confidence values or empty
 * provenance arrays so that downstream dashboards keep their payloads tidy.
 */
export function upsertTriple(
  graph: KnowledgeGraph,
  triple: KnowledgeTripleInput,
): KnowledgeInsertResult {
  const payload: Parameters<KnowledgeGraph["insert"]>[0] = {
    subject: triple.subject,
    predicate: triple.predicate,
    object: triple.object,
  };

  const source = typeof triple.source === "string" ? triple.source.trim() : "";
  if (source) {
    payload.source = source;
  }

  if (typeof triple.confidence === "number") {
    payload.confidence = triple.confidence;
  }

  if (triple.provenance) {
    const provenance = normaliseProvenanceList(triple.provenance);
    if (provenance.length > 0) {
      payload.provenance = provenance;
    }
  }

  return graph.insert(payload);
}

/**
 * Merges multiple provenance batches while deduplicating entries.  Each batch
 * may contain `null` or `undefined` placeholders which are filtered out before
 * the merge so callers can forward raw extractor output without additional
 * guards.
 */
export function withProvenance(
  ...batches: ReadonlyArray<Provenance | null | undefined>[]
): Provenance[] {
  let merged: Provenance[] = [];

  for (const batch of batches) {
    const normalised = normaliseProvenanceList(batch);
    if (normalised.length === 0) {
      continue;
    }
    merged = merged.length === 0 ? [...normalised] : mergeProvenance(merged, normalised);
  }

  if (merged.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const deduped: Provenance[] = [];
  for (const entry of merged) {
    const key = `${entry.type}:${entry.sourceId}:${entry.span ? `${entry.span[0]}-${entry.span[1]}` : ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}
