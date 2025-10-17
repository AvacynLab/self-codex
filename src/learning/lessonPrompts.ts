import type { LessonRecord, LessonSignal } from "./lessons.js";
import { LessonsStore } from "./lessons.js";

/** Default number of recalled lessons injected into a prompt. */
const DEFAULT_LESSON_RECALL_LIMIT = 3;
/** Upper bound applied to operator provided recall limits. */
const MAX_LESSON_RECALL_LIMIT = 6;

/**
 * Resolves the maximum number of lessons that may be recalled for a prompt.
 *
 * Operators can tune the `LESSONS_MAX` environment variable when they need to
 * surface additional institutional reminders. The helper clamps invalid values
 * and enforces a conservative ceiling so prompts remain concise.
 */
export function resolveLessonRecallLimit(): number {
  const raw = process.env.LESSONS_MAX;
  if (!raw) {
    return DEFAULT_LESSON_RECALL_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LESSON_RECALL_LIMIT;
  }
  return Math.min(MAX_LESSON_RECALL_LIMIT, parsed);
}
/** Confidence floor applied when recalling lessons for a prompt. */
const LESSON_MIN_CONFIDENCE = 0.45;
/** Stopwords ignored when extracting keywords from goals or prompt segments. */
const LESSON_KEYWORD_STOPWORDS = new Set([
  "the",
  "and",
  "les",
  "des",
  "pour",
  "avec",
  "this",
  "that",
  "vous",
  "nous",
  "plan",
  "task",
  "goal",
  "steps",
  "step",
  "code",
]);

/**
 * Context describing the orchestration environment for which we recall lessons.
 * The structure mirrors the metadata typically available when preparing prompts
 * (goals, prompt blueprint, additional tags inferred from routing).
 */
export interface LessonPromptContext {
  metadata?: Record<string, unknown>;
  goals?: string[];
  prompt?: {
    system?: string | string[];
    user?: string | string[];
    assistant?: string | string[];
  };
  variables?: Record<string, unknown>;
  additionalTags?: Iterable<string>;
}

/** Result returned when recalling lessons for a given prompt context. */
export interface LessonRecallResult {
  matches: LessonRecord[];
  tags: string[];
}

function normaliseLessonTag(candidate: unknown): string | null {
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim().toLowerCase();
  if (trimmed.length < 2) {
    return null;
  }
  const collapsed = trimmed.replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (collapsed.length === 0) {
    return null;
  }
  return collapsed.slice(0, 48);
}

function addLessonTag(target: Set<string>, candidate: unknown): void {
  const tag = normaliseLessonTag(candidate);
  if (tag) {
    target.add(tag);
  }
}

function extractLessonKeywords(text: string, limit = 6): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && token.length <= 32);

  for (const token of tokens) {
    if (LESSON_KEYWORD_STOPWORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= limit) {
      break;
    }
  }

  return keywords;
}

function collectLessonTagsFromGoals(goals: string[] | undefined): string[] {
  if (!goals || goals.length === 0) {
    return [];
  }
  const tags = new Set<string>();
  for (const goal of goals) {
    for (const keyword of extractLessonKeywords(goal, 4)) {
      addLessonTag(tags, keyword);
    }
  }
  return Array.from(tags);
}

function collectLessonTagsFromPrompt(
  prompt: LessonPromptContext["prompt"],
): string[] {
  if (!prompt) {
    return [];
  }
  const segments: string[] = [];
  if (typeof prompt.system === "string") {
    segments.push(prompt.system);
  } else if (Array.isArray(prompt.system)) {
    segments.push(...prompt.system);
  }
  if (typeof prompt.user === "string") {
    segments.push(prompt.user);
  } else if (Array.isArray(prompt.user)) {
    segments.push(...prompt.user);
  }
  if (typeof prompt.assistant === "string") {
    segments.push(prompt.assistant);
  } else if (Array.isArray(prompt.assistant)) {
    segments.push(...prompt.assistant);
  }
  if (segments.length === 0) {
    return [];
  }

  const combined = segments.join(" ");
  const tags = new Set<string>();
  for (const keyword of extractLessonKeywords(combined, 5)) {
    addLessonTag(tags, keyword);
  }
  if (/\bplan|étape|roadmap|outline\b/i.test(combined)) {
    tags.add("plan");
  }
  if (/\btest|coverage|assert\b/i.test(combined)) {
    tags.add("testing");
  }
  if (/\bcode|function|class|import\b/i.test(combined)) {
    tags.add("code");
  }
  return Array.from(tags);
}

function collectLessonTagsFromVariables(
  variables: Record<string, unknown> | undefined,
): string[] {
  if (!variables) {
    return [];
  }
  const tags = new Set<string>();
  for (const value of Object.values(variables)) {
    if (typeof value === "string") {
      addLessonTag(tags, value);
    }
  }
  return Array.from(tags);
}

/**
 * Recalls the most relevant lessons for the provided context. The helper keeps
 * the scoring logic centralised so both manual child creation and planner
 * fan-out flows benefit from the same heuristics.
 */
export function recallLessons(
  store: LessonsStore,
  context: LessonPromptContext,
): LessonRecallResult {
  const tags = new Set<string>();
  const metadata = context.metadata ?? {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/tag|topic|domain|area|category/i.test(key) && typeof value === "string") {
      addLessonTag(tags, value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        addLessonTag(tags, entry);
      }
    }
  }
  for (const tag of collectLessonTagsFromGoals(context.goals)) {
    addLessonTag(tags, tag);
  }
  for (const tag of collectLessonTagsFromPrompt(context.prompt)) {
    addLessonTag(tags, tag);
  }
  for (const tag of collectLessonTagsFromVariables(context.variables)) {
    addLessonTag(tags, tag);
  }
  if (context.additionalTags) {
    for (const tag of context.additionalTags) {
      addLessonTag(tags, tag);
    }
  }

  if (tags.size === 0) {
    return { matches: [], tags: [] };
  }

  const tagList = Array.from(tags);
  const limit = resolveLessonRecallLimit();
  const matches = store.match({
    tags: tagList,
    limit,
    minConfidence: LESSON_MIN_CONFIDENCE,
  });
  return { matches, tags: tagList };
}

function truncateEvidence(text: string, limit = 160): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit - 1)}…`;
}

/**
 * Formats the recalled lessons into a compact system prompt so the downstream
 * LLM can internalise institutional guardrails without overwhelming the
 * existing blueprint.
 */
export function formatLessonsForPromptMessage(lessons: LessonRecord[]): string {
  const lines: string[] = [
    "Leçons institutionnelles pertinentes à respecter :",
  ];

  lessons.forEach((lesson, index) => {
    const importance = Math.round(lesson.importance * 100);
    const confidence = Math.round(lesson.confidence * 100);
    const tags = lesson.tags.slice(0, 4).map((tag) => `#${tag}`).join(" ");
    const updatedAt = new Date(lesson.updatedAt).toISOString().split("T")[0];
    const evidence = lesson.evidence ? truncateEvidence(lesson.evidence) : null;
    const base = `${index + 1}. [${lesson.tone ?? "reminder"}] ${lesson.summary} (importance ${importance}%, confiance ${confidence}%, maj ${updatedAt})`;
    const suffix = tags.length > 0 ? `${base} — ${tags}` : base;
    lines.push(evidence ? `${suffix}\n   Exemple: ${evidence}` : suffix);
  });

  return lines.join("\n");
}

/**
 * Builds the manifest payload describing recalled lessons. The snapshot is
 * persisted for observability so operators can audit which guardrails were
 * surfaced for each child runtime.
 */
export function buildLessonManifestContext(
  lessons: LessonRecord[],
  retrievedAt: number,
): Record<string, unknown> {
  return {
    retrieved_at: new Date(retrievedAt).toISOString(),
    matches: lessons.map((lesson) => ({
      id: lesson.id,
      topic: lesson.topic,
      summary: lesson.summary,
      tags: [...lesson.tags],
      tone: lesson.tone ?? "reminder",
      importance: Number(lesson.importance.toFixed(2)),
      confidence: Number(lesson.confidence.toFixed(2)),
      occurrences: lesson.occurrences,
      updated_at: new Date(lesson.updatedAt).toISOString(),
      score: Number(lesson.score.toFixed(3)),
    })),
  };
}

/**
 * Utility exposed for tests so they can seed deterministic lessons without
 * reaching into the runtime internals.
 */
export function seedLessons(store: LessonsStore, signals: LessonSignal[]): void {
  store.recordMany(signals, Date.now());
}
