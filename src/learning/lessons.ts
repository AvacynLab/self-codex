/**
 * ## Lessons data model
 *
 * Defines how institutional memory is represented across the orchestrator.
 * Lessons capture recurring heuristics (self reflection, meta critics, …), how
 * they decay over time, and the metadata surfaced to prompts.  Documenting the
 * shape here keeps tooling, storage adapters, and dashboards aligned whenever
 * the memory subsystem evolves.
 */
import { createHash } from "node:crypto";

/**
 * Tone carried by a {@link LessonSignal}. Anti-pattern lessons capture issues
 * detected in recent outputs whereas reminder lessons encourage good habits.
 */
export type LessonTone = "reminder" | "anti-pattern" | "practice";

/**
 * Structured signal emitted by heuristics (meta critic, self reflection, ...)
 * whenever they detect an opportunity to update institutional memory.
 */
export interface LessonSignal {
  /** Functional area covered by the lesson (e.g. testing.missing-coverage). */
  topic: string;
  /** Short human readable summary surfaced in dashboards or logs. */
  summary: string;
  /** Additional hints that help routing the lesson during matching. */
  tags: string[];
  /** Normalised importance in the `[0, 1]` range. */
  importance: number;
  /** Confidence score in the `[0, 1]` range. */
  confidence: number;
  /** Optional evidence snippet stored for auditability. */
  evidence?: string;
  /** Tone of the lesson (anti-pattern, reminder or recommended practice). */
  tone?: LessonTone;
}

/**
 * Runtime representation of a lesson stored in the local catalogue.
 */
export interface LessonRecord extends LessonSignal {
  /** Stable identifier computed from topic/tags, used as deduplication key. */
  id: string;
  /** Timestamp (ms) recording the first time the lesson was observed. */
  createdAt: number;
  /** Timestamp (ms) capturing the last reinforcement update. */
  updatedAt: number;
  /** Number of times the lesson was reinforced by heuristics. */
  occurrences: number;
  /** Dynamic score used for ranking and decay management. */
  score: number;
  /** Number of times the lesson was penalised by regression feedback. */
  regressions: number;
  /** Timestamp (ms) of the most recent regression penalty, if any. */
  lastRegressionAt: number | null;
  /** Optional operator facing reason captured for the last regression. */
  lastRegressionReason?: string | null;
}

/** Result returned when inserting or reinforcing a lesson. */
export interface LessonUpsertResult {
  record: LessonRecord;
  status: "created" | "reinforced";
}

/** Negative outcome reported by the evaluation harness for a stored lesson. */
export interface LessonRegressionSignal {
  /** Identifier returned by {@link LessonsStore.record}, if already known. */
  lessonId?: string;
  /** Topic used when the lesson identifier is not available. */
  topic?: string;
  /** Tags associated with the degraded lesson (mirrors the original signal). */
  tags?: string[];
  /** Normalised severity within `[0, 1]` quantifying the performance impact. */
  severity?: number;
  /** Harness confidence within `[0, 1]` for the regression diagnosis. */
  confidence?: number;
  /** Optional human readable reason surfaced in logs and dashboards. */
  reason?: string;
}

/** Result returned when applying regression feedback to a lesson. */
export interface LessonRegressionResult {
  record: LessonRecord | null;
  status: "ignored" | "penalised" | "removed";
  /** Severity after clamping to the `[0, 1]` range. */
  appliedSeverity: number;
  /** Score penalty applied to the lesson before clamping. */
  appliedPenalty: number;
}

/** Query accepted by {@link LessonsStore.match}. */
export interface LessonQuery {
  /** Optional topic prefix filter applied to the stored lessons. */
  topicPrefix?: string;
  /** Tags associated with the current orchestration context. */
  tags?: string[];
  /** Maximum number of lessons to return. */
  limit?: number;
  /** Minimum confidence threshold applied during ranking. */
  minConfidence?: number;
}

/** Options accepted by {@link LessonsStore}. */
export interface LessonsStoreOptions {
  /** Half-life used when decaying lesson scores (defaults to 24h). */
  decayHalfLifeMs?: number;
  /** Score below which stale lessons are pruned from the catalogue. */
  retentionScoreThreshold?: number;
}

const DEFAULT_DECAY_HALF_LIFE = 24 * 60 * 60 * 1000; // 24 hours in milliseconds.
const DEFAULT_RETENTION_THRESHOLD = 0.15;
const LN2 = Math.log(2);

/**
 * Builds a deterministic identifier for a lesson based on topic and tags.
 */
function computeLessonIdFromTopicAndTags(topic: string, tags: Iterable<string>): string {
  const hash = createHash("sha1");
  const normalisedTags = Array.from(tags, (tag) => tag.toLowerCase()).sort();
  hash.update(topic.toLowerCase());
  hash.update("::");
  for (const tag of normalisedTags) {
    hash.update(tag);
    hash.update("|");
  }
  return hash.digest("hex").slice(0, 24);
}

/**
 * Builds a deterministic identifier for a lesson using its signal payload.
 */
function fingerprint(signal: LessonSignal): string {
  return computeLessonIdFromTopicAndTags(signal.topic, signal.tags);
}

/**
 * Ensures the provided score stays within the `[0, 1]` range.
 */
function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Lightweight in-memory catalogue that stores and ranks lessons emitted by the
 * orchestrator heuristics. The structure is intentionally compact so it can be
 * persisted later without changing the consumer facing API.
 */
export class LessonsStore {
  private readonly entries = new Map<string, LessonRecord>();
  private readonly decayHalfLifeMs: number;
  private readonly retentionScoreThreshold: number;

  constructor(options: LessonsStoreOptions = {}) {
    this.decayHalfLifeMs = options.decayHalfLifeMs ?? DEFAULT_DECAY_HALF_LIFE;
    this.retentionScoreThreshold =
      options.retentionScoreThreshold ?? DEFAULT_RETENTION_THRESHOLD;
  }

  /**
   * Inserts or reinforces a lesson signal. The store keeps the strongest
   * importance/confidence observed to avoid losing signal quality over time.
   */
  record(signal: LessonSignal, timestamp = Date.now()): LessonUpsertResult {
    const now = timestamp;
    this.decay(now);
    const id = fingerprint(signal);
    const existing = this.entries.get(id);

    if (!existing) {
      const record: LessonRecord = {
        id,
        topic: signal.topic,
        summary: signal.summary,
        tags: [...signal.tags],
        importance: clampScore(signal.importance),
        confidence: clampScore(signal.confidence),
        evidence: signal.evidence,
        tone: signal.tone ?? "anti-pattern",
        createdAt: now,
        updatedAt: now,
        occurrences: 1,
        score: clampScore((signal.importance + signal.confidence) / 2),
        regressions: 0,
        lastRegressionAt: null,
        lastRegressionReason: null,
      };
      this.entries.set(id, record);
      return { record: structuredClone(record), status: "created" };
    }

    // Reinforce an existing record by increasing occurrences and maxing out the
    // score with the new signal data. Keeping the best evidence improves audits.
    existing.updatedAt = now;
    existing.occurrences += 1;
    existing.importance = Math.max(existing.importance, clampScore(signal.importance));
    existing.confidence = Math.max(existing.confidence, clampScore(signal.confidence));
    existing.score = clampScore(
      existing.score + clampScore(signal.importance * 0.4 + signal.confidence * 0.6) * 0.5,
    );
    if (signal.evidence) {
      existing.evidence = signal.evidence;
    }
    if (signal.tone) {
      existing.tone = signal.tone;
    }

    return { record: structuredClone(existing), status: "reinforced" };
  }

  /** Records multiple lesson signals at once and returns their upsert results. */
  recordMany(signals: LessonSignal[], timestamp = Date.now()): LessonUpsertResult[] {
    const results: LessonUpsertResult[] = [];
    for (const signal of signals) {
      if (!signal) {
        continue;
      }
      results.push(this.record(signal, timestamp));
    }
    return results;
  }

  /**
   * Finds the most relevant lessons for the provided query. Relevance is based
   * on tag overlap, topic prefix and decayed score.
   */
  match(query: LessonQuery, timestamp = Date.now()): LessonRecord[] {
    this.decay(timestamp);
    const tags = new Set((query.tags ?? []).map((tag) => tag.toLowerCase()));
    const minimumConfidence = query.minConfidence ?? 0;
    const matched: LessonRecord[] = [];

    for (const record of this.entries.values()) {
      if (record.score < this.retentionScoreThreshold) {
        continue;
      }
      if (record.confidence < minimumConfidence) {
        continue;
      }
      if (query.topicPrefix && !record.topic.startsWith(query.topicPrefix)) {
        continue;
      }
      const overlap = record.tags.reduce((count, tag) => (tags.has(tag.toLowerCase()) ? count + 1 : count), 0);
      const tagWeight = tags.size > 0 ? overlap / tags.size : 1;
      const rankingScore = clampScore(record.score * 0.6 + tagWeight * 0.4);
      matched.push({ ...record, score: rankingScore });
    }

    matched.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
    return matched.slice(0, Math.max(1, query.limit ?? matched.length)).map((entry) => structuredClone(entry));
  }

  /**
   * Applies regression feedback produced by the evaluation harness. When a
   * lesson is deemed harmful its score is penalised proportionally to the
   * severity so future recalls down-rank or evict the entry.
   */
  applyRegression(
    feedback: LessonRegressionSignal,
    timestamp = Date.now(),
  ): LessonRegressionResult {
    this.decay(timestamp);

    // Resolve the lesson identifier from the feedback payload. Harness
    // integrations can either provide the identifier directly or fall back to
    // the original topic/tags combination.
    let targetId: string | null = null;
    if (feedback.lessonId) {
      targetId = feedback.lessonId;
    } else if (feedback.topic) {
      targetId = computeLessonIdFromTopicAndTags(feedback.topic, feedback.tags ?? []);
    }

    if (!targetId) {
      return { status: "ignored", record: null, appliedSeverity: 0, appliedPenalty: 0 };
    }

    const record = this.entries.get(targetId);
    if (!record) {
      return { status: "ignored", record: null, appliedSeverity: 0, appliedPenalty: 0 };
    }

    const severity = clampScore(feedback.severity ?? 0.6);
    const confidence = clampScore(feedback.confidence ?? 1);
    // Baseline penalty is anchored at 0.15 so repeated regressions retire the
    // lesson even when the harness reports medium severity issues. Confidence
    // scales the penalty down when the verdict is tentative.
    const penalty = Math.min(
      1,
      Math.max(0.15, severity * 0.7 + (1 - confidence) * 0.2),
    );

    record.regressions += 1;
    record.lastRegressionAt = timestamp;
    record.lastRegressionReason = feedback.reason ?? record.lastRegressionReason ?? null;
    record.score = clampScore(record.score - penalty);
    record.importance = clampScore(record.importance * (1 - penalty * 0.4));
    record.confidence = clampScore(record.confidence * (1 - penalty * 0.5));

    if (record.score < this.retentionScoreThreshold) {
      const snapshot = structuredClone(record);
      this.entries.delete(record.id);
      return { status: "removed", record: snapshot, appliedSeverity: severity, appliedPenalty: penalty };
    }

    return {
      status: "penalised",
      record: structuredClone(record),
      appliedSeverity: severity,
      appliedPenalty: penalty,
    };
  }

  /** Applies exponential decay to every lesson based on the provided timestamp. */
  decay(timestamp = Date.now()): void {
    const now = timestamp;
    if (this.entries.size === 0) {
      return;
    }
    for (const record of this.entries.values()) {
      if (record.updatedAt >= now) {
        continue;
      }
      const elapsed = now - record.updatedAt;
      if (elapsed <= 0) {
        continue;
      }
      const decayFactor = Math.exp((-LN2 * elapsed) / this.decayHalfLifeMs);
      record.score = clampScore(record.score * decayFactor);
      if (record.score < this.retentionScoreThreshold) {
        this.entries.delete(record.id);
      }
    }
  }

  /** Returns a deep copy of all stored lessons. Primarily used in tests. */
  snapshot(): LessonRecord[] {
    return Array.from(this.entries.values()).map((entry) => structuredClone(entry));
  }

  /**
   * Clears the catalogue entirely. Primarily intended for deterministic tests
   * that need to seed specific lessons before exercising prompt injection.
   */
  clear(): void {
    this.entries.clear();
  }
}
