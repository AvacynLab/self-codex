import { z } from "zod";

import {
  EventStore,
  type EventKind,
  type EventLevel,
  type EventSource,
  type OrchestratorEvent,
} from "../eventStore.js";
import type { Provenance } from "../types/provenance.js";
import {
  LessonsPromptPayloadSchema,
  type LessonsPromptPayload,
} from "../learning/lessonPromptDiff.js";

/**
 * Structured representation of a lessons prompt event extracted from the
 * orchestrator timeline. The `operation` property surfaces the originating
 * action (child_create, plan fan-out, …).
 */
export interface LessonsPromptReplayDetails {
  operation: string;
  payload: LessonsPromptPayload;
}

/** Event returned by the replay endpoint once normalised for clients. */
export interface ReplayEvent {
  seq: number;
  ts: number;
  kind: EventKind;
  level: EventLevel;
  source: EventSource;
  jobId: string | null;
  childId: string | null;
  payload: unknown;
  provenance: Provenance[];
  lessonsPrompt: LessonsPromptReplayDetails | null;
}

/** Page of events served by the `/replay` endpoint. */
export interface ReplayPage {
  jobId: string;
  limit: number;
  cursor: number | null;
  nextCursor: number | null;
  events: ReplayEvent[];
}

/**
 * Options accepted when building replay pages. Callers can pass the last seen
 * sequence to paginate forward.
 */
export interface ReplayPageOptions {
  limit?: number;
  cursor?: number | null;
}

const LessonsPromptEventSchema = z
  .object({
    operation: z.string().trim().min(1),
    lessons_prompt: LessonsPromptPayloadSchema,
  })
  .passthrough();

function extractLessonsPromptDetails(payload: unknown): LessonsPromptReplayDetails | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const parsed = LessonsPromptEventSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  return {
    operation: parsed.data.operation,
    payload: parsed.data.lessons_prompt,
  } satisfies LessonsPromptReplayDetails;
}

function mapEventForReplay(event: OrchestratorEvent): ReplayEvent {
  return {
    seq: event.seq,
    ts: event.ts,
    kind: event.kind,
    level: event.level,
    source: event.source,
    jobId: event.jobId ?? null,
    childId: event.childId ?? null,
    payload: event.payload ?? null,
    provenance: event.provenance ?? [],
    lessonsPrompt: extractLessonsPromptDetails(event.payload),
  } satisfies ReplayEvent;
}

function clampReplayLimit(limit: number | undefined): number {
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.trunc(limit));
}

function normaliseCursor(cursor: number | undefined | null): number | undefined {
  if (cursor === undefined || cursor === null) {
    return undefined;
  }
  if (!Number.isFinite(cursor) || cursor < 0) {
    return undefined;
  }
  return Math.trunc(cursor);
}

/**
 * Builds a replay page for the provided job by fetching events from the
 * EventStore and mapping them to JSON friendly structures.
 */
export function buildReplayPage(eventStore: EventStore, jobId: string, options: ReplayPageOptions = {}): ReplayPage {
  const limit = clampReplayLimit(options.limit);
  const cursor = normaliseCursor(options.cursor);
    const events = eventStore.listForJob(jobId, {
      ...(cursor !== undefined ? { minSeq: cursor } : {}),
      limit: limit + 1,
    });
  const hasMore = events.length > limit;
  const pageEvents = hasMore ? events.slice(0, limit) : events;
  const mapped = pageEvents.map((event) => mapEventForReplay(event));
  const nextCursor = hasMore && pageEvents.length > 0 ? pageEvents[pageEvents.length - 1]!.seq : null;
  return {
    jobId,
    limit,
    cursor: cursor ?? null,
    nextCursor,
    events: mapped,
  } satisfies ReplayPage;
}
