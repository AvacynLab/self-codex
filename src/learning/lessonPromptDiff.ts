import { z } from "zod";

/** Roles supported when recording prompt snapshots for replay and auditing. */
export type PromptMessageRole = "system" | "user" | "assistant";

/**
 * Normalised representation of a prompt message captured before/after lessons
 * injection. Storing trimmed content alongside the role keeps diffing
 * straightforward for dashboards and replay endpoints.
 */
export interface PromptMessageSnapshot {
  role: PromptMessageRole;
  content: string;
}

/**
 * Result returned when comparing prompts before and after lessons injection.
 * Consumers can highlight added/removed segments when visualising replay data.
 */
export interface PromptLessonsDiff {
  added: PromptMessageSnapshot[];
  removed: PromptMessageSnapshot[];
}

/**
 * Blueprint structure accepted by the manual child creation APIs. The shape is
 * mirrored here so helpers can normalise prompts without importing the full
 * tool schemas.
 */
export interface PromptBlueprint {
  system?: string | string[];
  user?: string | string[];
  assistant?: string | string[];
}

/**
 * Payload embedded into orchestration events when lessons alter an outgoing
 * prompt. Downstream dashboards parse the block to highlight what changed.
 */
export const LessonsPromptPayloadSchema = z
  .object({
    source: z.enum(["child_create", "plan_fanout"]),
    topics: z.array(z.string()),
    tags: z.array(z.string()),
    total_lessons: z.number().int().min(0),
    before: z.array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    ),
    after: z.array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    ),
    diff: z.object({
      added: z.array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string(),
        }),
      ),
      removed: z.array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string(),
        }),
      ),
    }),
  })
  .strict();

export type LessonsPromptPayload = z.infer<typeof LessonsPromptPayloadSchema>;

/**
 * Options accepted when constructing a {@link LessonsPromptPayload}. The caller
 * is responsible for supplying already-normalised prompt snapshots.
 */
export interface LessonsPromptPayloadOptions {
  source: LessonsPromptPayload["source"];
  before: PromptMessageSnapshot[];
  after: PromptMessageSnapshot[];
  topics: Iterable<string>;
  tags: Iterable<string>;
  totalLessons: number;
}

/** Utility returning a trimmed snapshot when the role/content are valid. */
function toSnapshot(role: unknown, content: unknown): PromptMessageSnapshot | null {
  if (typeof role !== "string" || typeof content !== "string") {
    return null;
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const loweredRole = role.toLowerCase();
  if (loweredRole !== "system" && loweredRole !== "user" && loweredRole !== "assistant") {
    return null;
  }
  return { role: loweredRole, content: trimmed };
}

/**
 * Normalises a prompt blueprint (system/user/assistant fields) into a flat
 * array of message snapshots. Empty segments are skipped.
 */
export function normalisePromptBlueprint(prompt: PromptBlueprint | null | undefined): PromptMessageSnapshot[] {
  if (!prompt) {
    return [];
  }
  const snapshots: PromptMessageSnapshot[] = [];
  const append = (role: PromptMessageRole, segment: string | string[] | undefined) => {
    if (!segment) {
      return;
    }
    if (typeof segment === "string") {
      const snapshot = toSnapshot(role, segment);
      if (snapshot) {
        snapshots.push(snapshot);
      }
      return;
    }
    for (const entry of segment) {
      const snapshot = toSnapshot(role, entry);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
  };
  append("system", prompt.system);
  append("user", prompt.user);
  append("assistant", prompt.assistant);
  return snapshots;
}

/**
 * Normalises a list of prompt-like messages into trimmed snapshots. The helper
 * accepts any iterable exposing `role` and `content` fields.
 */
export function normalisePromptMessages(messages: Iterable<{ role: unknown; content: unknown }>): PromptMessageSnapshot[] {
  const snapshots: PromptMessageSnapshot[] = [];
  for (const message of messages) {
    const snapshot = toSnapshot((message as { role?: unknown }).role, (message as { content?: unknown }).content);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

/**
 * Computes the added/removed segments between two prompt snapshots. Multisets
 * are honoured so duplicate lines are diffed accurately.
 */
export function computePromptDiff(before: PromptMessageSnapshot[], after: PromptMessageSnapshot[]): PromptLessonsDiff {
  const addMap = new Map<string, { count: number; sample: PromptMessageSnapshot }>();
  const removeMap = new Map<string, { count: number; sample: PromptMessageSnapshot }>();

  const keyOf = (snapshot: PromptMessageSnapshot): string => `${snapshot.role}:${snapshot.content}`;

  for (const snapshot of before) {
    const key = keyOf(snapshot);
    const entry = removeMap.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      removeMap.set(key, { count: 1, sample: snapshot });
    }
  }

  for (const snapshot of after) {
    const key = keyOf(snapshot);
    const removeEntry = removeMap.get(key);
    if (removeEntry) {
      removeEntry.count -= 1;
      if (removeEntry.count <= 0) {
        removeMap.delete(key);
      }
    } else {
      const addEntry = addMap.get(key);
      if (addEntry) {
        addEntry.count += 1;
      } else {
        addMap.set(key, { count: 1, sample: snapshot });
      }
    }
  }

  const added: PromptMessageSnapshot[] = [];
  for (const entry of addMap.values()) {
    for (let i = 0; i < entry.count; i += 1) {
      added.push(entry.sample);
    }
  }

  const removed: PromptMessageSnapshot[] = [];
  for (const entry of removeMap.values()) {
    if (entry.count <= 0) {
      continue;
    }
    for (let i = 0; i < entry.count; i += 1) {
      removed.push(entry.sample);
    }
  }

  return { added, removed };
}

/** Deduplicates and trims arbitrary string iterables. */
function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    seen.add(trimmed);
  }
  return Array.from(seen);
}

/**
 * Builds the structured payload embedded into orchestration events when
 * lessons alter an outgoing prompt.
 */
export function buildLessonsPromptPayload(options: LessonsPromptPayloadOptions): LessonsPromptPayload {
  const before = options.before.map((entry) => ({ ...entry }));
  const after = options.after.map((entry) => ({ ...entry }));
  const diff = computePromptDiff(before, after);
  const payload: LessonsPromptPayload = {
    source: options.source,
    topics: uniqueStrings(options.topics),
    tags: uniqueStrings(options.tags),
    total_lessons: Math.max(0, Math.trunc(options.totalLessons)),
    before,
    after,
    diff: {
      added: diff.added.map((entry) => ({ ...entry })),
      removed: diff.removed.map((entry) => ({ ...entry })),
    },
  };
  return payload;
}
