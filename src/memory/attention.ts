import { SharedMemoryStore, MemoryEpisode, MemoryKeyValueEntry } from "./store.js";

/** Input accepted when selecting a contextual memory for a child runtime. */
export interface AttentionQuery {
  goals?: string[];
  tags?: string[];
  query?: string;
  limit?: number;
  includeKeyValues?: boolean;
  minimumScore?: number;
}

/** Structured context returned to the caller. */
export interface MemoryContextSelection {
  keyValues: MemoryKeyValueEntry[];
  episodes: MemoryEpisode[];
  diagnostics: {
    requestedTags: string[];
    evaluatedEpisodes: number;
    selectedEpisodes: number;
  };
}

/** Normalises user supplied tags/goals into a lowercase unique set. */
function normalise(inputs: string[] | undefined): string[] {
  if (!inputs) {
    return [];
  }
  const unique = new Set<string>();
  for (const value of inputs) {
    if (!value) {
      continue;
    }
    unique.add(value.toString().trim().toLowerCase());
  }
  return Array.from(unique).filter((entry) => entry.length > 0);
}

/** Canonical form used to detect duplicated or contradictory goals. */
function canonicalGoal(goal: string): string {
  return goal.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Assigns a coarse sentiment to an episode outcome so conflicting narratives
 * (e.g. "échec" vs. "succès") can be filtered out when assembling context.
 */
function classifyOutcome(outcome: string): "positive" | "negative" | "neutral" {
  const text = outcome.toLowerCase();
  const negativeHints = ["fail", "échec", "incident", "erreur", "crash", "bloqué"];
  const positiveHints = ["succès", "réussi", "passed", "résolu", "stable", "ok"];
  if (negativeHints.some((hint) => text.includes(hint))) {
    return "negative";
  }
  if (positiveHints.some((hint) => text.includes(hint))) {
    return "positive";
  }
  return "neutral";
}

interface EpisodeCandidate {
  episode: MemoryEpisode;
  score: number;
}

/**
 * Removes contradictory episodes by keeping the highest scoring outcome for a
 * given goal/sentiment. Neutral entries are always allowed as they usually
 * carry descriptive context rather than directives.
 */
function filterContradictoryEpisodes(candidates: EpisodeCandidate[], limit: number): EpisodeCandidate[] {
  const selected = new Map<string, EpisodeCandidate>();

  for (const entry of candidates) {
    if (selected.size >= limit) {
      break;
    }
    const goalKey = canonicalGoal(entry.episode.goal);
    const sentiment = classifyOutcome(entry.episode.outcome);
    const compositeKey = `${goalKey}:${sentiment}`;

    if (!selected.has(compositeKey)) {
      selected.set(compositeKey, entry);
      continue;
    }

    const existing = selected.get(compositeKey)!;
    if (entry.score > existing.score) {
      selected.set(compositeKey, entry);
    }
  }

  // Once specific sentiment slots are filled, merge them back while avoiding
  // contradictory sentiment mixes for the same goal.
  const final: EpisodeCandidate[] = [];
  const goalSentiment = new Map<string, "positive" | "negative" | "neutral">();
  for (const entry of candidates) {
    if (final.length >= limit) {
      break;
    }
    const goalKey = canonicalGoal(entry.episode.goal);
    const sentiment = classifyOutcome(entry.episode.outcome);
    const compositeKey = `${goalKey}:${sentiment}`;

    const winner = selected.get(compositeKey);
    if (!winner || winner.episode.id !== entry.episode.id) {
      continue;
    }

    const previousSentiment = goalSentiment.get(goalKey);
    if (previousSentiment && previousSentiment !== sentiment && sentiment !== "neutral" && previousSentiment !== "neutral") {
      continue;
    }

    goalSentiment.set(goalKey, sentiment);
    final.push(entry);
  }

  return final;
}

/**
 * Combines tag based and semantic searches to gather the most relevant context
 * for a new child runtime. The selection deliberately stays compact to avoid
 * overwhelming the prompt budget while keeping high-signal episodes.
 */
export function selectMemoryContext(store: SharedMemoryStore, query: AttentionQuery): MemoryContextSelection {
  const limit = Math.max(1, Math.min(query.limit ?? 5, 10));
  const tags = new Set<string>([...normalise(query.tags), ...normalise(query.goals)]);
  const tagList = Array.from(tags);
  const minimumScore = query.minimumScore ?? 0.05;

  const episodeCandidates = new Map<string, { episode: MemoryEpisode; score: number }>();

  if (tagList.length > 0) {
    const tagHits = store.searchEpisodesByTags(tagList, { limit: limit * 2, minimumScore });
    for (const hit of tagHits) {
      episodeCandidates.set(hit.episode.id, { episode: hit.episode, score: Math.max(hit.score, 0) });
    }
  }

  if (query.query && query.query.trim().length > 0) {
    const semanticHits = store.searchEpisodesBySimilarity(query.query, { limit: limit * 2, minimumScore });
    for (const hit of semanticHits) {
      const existing = episodeCandidates.get(hit.episode.id);
      if (!existing || hit.score > existing.score) {
        episodeCandidates.set(hit.episode.id, { episode: hit.episode, score: hit.score });
      }
    }
  }

  if (episodeCandidates.size === 0 && tagList.length === 0) {
    // Fallback to the most recent memories when no filters are provided.
    const recent = store.listEpisodes().slice(0, limit);
    for (const episode of recent) {
      episodeCandidates.set(episode.id, { episode, score: 0.3 });
    }
  }

  const scoredEpisodes = Array.from(episodeCandidates.values())
    .filter((entry) => entry.score >= minimumScore)
    .sort((a, b) => b.score - a.score || b.episode.createdAt - a.episode.createdAt);

  const filteredEpisodes = filterContradictoryEpisodes(scoredEpisodes, limit);
  const rankedEpisodes = filteredEpisodes.map((entry) => entry.episode);

  if (rankedEpisodes.length === 0 && episodeCandidates.size > 0) {
    // Ensure at least one episode is returned even if all scores were below the threshold.
    const [fallback] = Array.from(episodeCandidates.values()).sort(
      (a, b) => b.episode.createdAt - a.episode.createdAt,
    );
    if (fallback) {
      rankedEpisodes.push(fallback.episode);
    }
  }

  let keyValues: MemoryKeyValueEntry[] = [];
  if (query.includeKeyValues ?? true) {
    if (tagList.length > 0) {
      keyValues = store
        .searchKeyValuesByTags(tagList, { limit, minimumScore: minimumScore / 2 })
        .map((hit) => hit.entry);
    } else {
      keyValues = store.listKeyValues().slice(0, Math.max(1, Math.min(limit, 3)));
    }
  }

  return {
    keyValues,
    episodes: rankedEpisodes,
    diagnostics: {
      requestedTags: tagList,
      evaluatedEpisodes: store.listEpisodes().length,
      selectedEpisodes: rankedEpisodes.length,
    },
  };
}
