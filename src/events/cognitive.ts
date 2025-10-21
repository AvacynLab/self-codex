import type { ReviewKind, ReviewResult } from "../agents/metaCritic.js";
import type { ReflectionResult } from "../agents/selfReflect.js";
import type { EventKind, EventLevel } from "../eventStore.js";

import {
  cloneCorrelationHints,
  extractCorrelationHints,
  mergeCorrelationHints,
  type EventCorrelationHints,
} from "./correlation.js";
import type {
  ChildMetaReviewEventPayload,
  ChildReflectionEventPayload,
  ChildCognitiveEventPayload,
  QualityAssessmentSnapshot,
} from "./types.js";

export type {
  ChildCognitiveEventPayload,
  ChildMetaReviewEventPayload,
  ChildReflectionEventPayload,
  QualityAssessmentSnapshot,
} from "./types.js";

/**
 * Input required to build structured cognitive events for a child collection.
 */
export interface ChildCognitiveEventOptions {
  /** Identifier of the child that produced the artefacts. */
  childId: string;
  /** Optional job identifier used when the child is associated with a plan run. */
  jobId?: string | null;
  /** Textual summary synthesised from the collected outputs. */
  summary: { text: string; tags: string[]; kind: ReviewKind };
  /** Review result returned by the meta critic heuristics. */
  review: ReviewResult;
  /** Optional reflection produced by the self-reflection heuristics. */
  reflection?: ReflectionResult | null;
  /** Optional quality assessment computed from the summary/review. */
  quality?: QualityAssessmentSnapshot | null;
  /** Number of artefacts returned by the collection. */
  artifactCount: number;
  /** Number of stdout/stderr messages returned by the collection. */
  messageCount: number;
  /** Additional records inspected to derive correlation metadata. */
  correlationSources?: Array<unknown | null | undefined>;
}

/** Structured payload returned for a cognitive event ready to be published. */
export interface CognitiveEventRecord<P extends ChildCognitiveEventPayload = ChildCognitiveEventPayload> {
  kind: Extract<EventKind, "COGNITIVE">;
  level: EventLevel;
  childId: string;
  jobId?: string | null;
  payload: P;
  correlation: EventCorrelationHints;
}

/** Pair of cognitive events derived from a single child collection. */
export interface ChildCognitiveEvents {
  review: CognitiveEventRecord<ChildMetaReviewEventPayload>;
  reflection: CognitiveEventRecord<ChildReflectionEventPayload> | null;
}

/**
 * Normalises the provided correlation sources and synthesises a single record
 * that contains the identifiers expected by the unified event bus.
 */
function buildCorrelationHints(options: {
  childId: string;
  jobId?: string | null;
  sources?: Array<unknown | null | undefined>;
}): EventCorrelationHints {
  const hints: EventCorrelationHints = {};
  mergeCorrelationHints(hints, { childId: options.childId });
  if (options.jobId !== undefined) {
    mergeCorrelationHints(hints, { jobId: options.jobId ?? null });
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
 * Build structured events describing the meta-review (and optional self
 * reflection) performed after a `child_collect` invocation. The helper keeps
 * payloads compact yet informative so downstream MCP clients can surface
 * actionable telemetry without reimplementing the orchestrator logic.
 */
export function buildChildCognitiveEvents(options: ChildCognitiveEventOptions): ChildCognitiveEvents {
  const baseCorrelation = buildCorrelationHints({
    childId: options.childId,
    jobId: options.jobId,
    sources: options.correlationSources,
  });

  const sharedEnvelope = {
    kind: "COGNITIVE" as const,
    level: "info" as const satisfies EventLevel,
    childId: options.childId,
    jobId: options.jobId ?? null,
  } satisfies Pick<CognitiveEventRecord, "kind" | "level" | "childId" | "jobId">;

  type SharedCorrelationFields = Pick<
    ChildMetaReviewEventPayload,
    "child_id" | "job_id" | "run_id" | "op_id" | "graph_id" | "node_id"
  >;

  const basePayloadFields: SharedCorrelationFields = {
    child_id: options.childId,
    job_id: options.jobId ?? null,
    run_id: baseCorrelation.runId ?? null,
    op_id: baseCorrelation.opId ?? null,
    graph_id: baseCorrelation.graphId ?? null,
    node_id: baseCorrelation.nodeId ?? null,
  };

  const reviewPayload: ChildMetaReviewEventPayload = {
    ...basePayloadFields,
    msg: "child_meta_review",
    summary: {
      kind: options.summary.kind,
      text: options.summary.text,
      tags: [...options.summary.tags],
    },
    review: {
      overall: options.review.overall,
      verdict: options.review.verdict,
      feedback: [...options.review.feedback],
      suggestions: [...options.review.suggestions],
      breakdown: options.review.breakdown.map((entry) => ({ ...entry })),
    },
    metrics: {
      artifacts: options.artifactCount,
      messages: options.messageCount,
    },
    quality_assessment: options.quality
      ? {
          kind: options.quality.kind,
          score: options.quality.score,
          rubric: { ...options.quality.rubric },
          metrics: { ...options.quality.metrics },
          gate: { ...options.quality.gate },
        }
      : null,
  };

  const reviewEvent: CognitiveEventRecord<ChildMetaReviewEventPayload> = {
    ...sharedEnvelope,
    payload: reviewPayload,
    correlation: cloneCorrelationHints(baseCorrelation),
  };

  let reflectionEvent: CognitiveEventRecord<ChildReflectionEventPayload> | null = null;
  if (options.reflection) {
    const reflectionPayload: ChildReflectionEventPayload = {
      ...basePayloadFields,
      msg: "child_reflection",
      summary: {
        kind: options.summary.kind,
        text: options.summary.text,
        tags: [...options.summary.tags],
      },
      reflection: {
        insights: [...options.reflection.insights],
        next_steps: [...options.reflection.nextSteps],
        risks: [...options.reflection.risks],
      },
    };
    reflectionEvent = {
      ...sharedEnvelope,
      payload: reflectionPayload,
      correlation: cloneCorrelationHints(baseCorrelation),
    };
  }

  return { review: reviewEvent, reflection: reflectionEvent };
}

