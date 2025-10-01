import { randomUUID } from "crypto";

/** Entry stored in the shared key-value memory. */
export interface MemoryKeyValueEntry {
  key: string;
  value: unknown;
  tags: string[];
  updatedAt: number;
  importance: number;
  metadata: Record<string, unknown>;
}

/** Options accepted when storing a key-value memory. */
export interface KeyValueUpsertOptions {
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
}

/** Input payload describing a contextual episode. */
export interface MemoryEpisodeInput {
  id?: string;
  goal: string;
  decision: string;
  outcome: string;
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

/** Episode persisted in the memory store. */
export interface MemoryEpisode {
  id: string;
  goal: string;
  decision: string;
  outcome: string;
  tags: string[];
  importance: number;
  createdAt: number;
  metadata: Record<string, unknown>;
  embedding: Record<string, number>;
}

/** Hit returned when searching for key-value memories. */
export interface MemoryKeyValueHit {
  entry: MemoryKeyValueEntry;
  score: number;
  matchedTags: string[];
}

/** Hit returned when searching for contextual episodes. */
export interface MemoryEpisodeHit {
  episode: MemoryEpisode;
  score: number;
  matchedTags: string[];
}

/** Options accepted by search helpers. */
export interface MemorySearchOptions {
  limit?: number;
  minimumScore?: number;
}

interface EpisodeRecord extends MemoryEpisode {
  embeddingNorm: number;
}

/** Utility converting arbitrary tags into a deduplicated lowercase list. */
function normaliseTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }

  const unique = new Set<string>();
  for (const tag of tags) {
    if (!tag) {
      continue;
    }
    unique.add(tag.toString().trim().toLowerCase());
  }

  return Array.from(unique).filter((tag) => tag.length > 0);
}

/** Tokenises arbitrary text for TF-IDF embedding construction. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

/** Small helper keeping numeric scores in a sane range. */
function clamp(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Recency boost used when ranking entries (fresh memories are prioritised). */
function recencyBoost(timestamp: number): number {
  const ageMs = Date.now() - timestamp;
  const days = ageMs / (1000 * 60 * 60 * 24);
  return clamp(Math.exp(-Math.max(0, days) / 7));
}

/**
 * In-memory store backing the shared orchestrator memory. The implementation is
 * intentionally deterministic: the TF-IDF embedding relies purely on
 * tokenisation so the entire module can run offline within tests.
 */
export class SharedMemoryStore {
  private readonly keyValues = new Map<string, MemoryKeyValueEntry>();
  private readonly episodes: EpisodeRecord[] = [];
  private documentCount = 0;
  private readonly termDocumentFrequency = new Map<string, number>();

  /**
   * Resets the store. Mainly used by tests to obtain a clean slate.
   */
  clear(): void {
    this.keyValues.clear();
    this.episodes.length = 0;
    this.termDocumentFrequency.clear();
    this.documentCount = 0;
  }

  /**
   * Stores a key-value pair describing persistent context (configuration,
   * objectives, environment notes, ...).
   */
  upsertKeyValue(key: string, value: unknown, options: KeyValueUpsertOptions = {}): MemoryKeyValueEntry {
    const entry: MemoryKeyValueEntry = {
      key,
      value,
      tags: normaliseTags(options.tags),
      importance: clamp(options.importance ?? 0.5),
      updatedAt: Date.now(),
      metadata: { ...(options.metadata ?? {}) },
    };

    this.keyValues.set(key, entry);
    return { ...entry };
  }

  /** Retrieves a stored key-value entry. */
  getKeyValue(key: string): MemoryKeyValueEntry | undefined {
    const entry = this.keyValues.get(key);
    return entry ? { ...entry, metadata: { ...entry.metadata } } : undefined;
  }

  /** Returns all key-value entries ordered by recency. */
  listKeyValues(): MemoryKeyValueEntry[] {
    return Array.from(this.keyValues.values())
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({ ...entry, metadata: { ...entry.metadata } }));
  }

  /**
   * Records a contextual episode (goal → decision → outcome). TF-IDF embeddings
   * are generated lazily to enable similarity search without external models.
   */
  recordEpisode(input: MemoryEpisodeInput): MemoryEpisode {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    const tags = normaliseTags(input.tags);
    const importance = clamp(input.importance ?? 0.5);

    const combinedText = [input.goal, input.decision, input.outcome, ...tags].join(" ");
    let tokens = tokenise(combinedText);
    if (tokens.length === 0) {
      tokens = tokenise(`${input.goal} ${input.decision}`);
    }
    if (tokens.length === 0) {
      tokens = ["context"];
    }

    this.documentCount += 1;

    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      this.termDocumentFrequency.set(token, (this.termDocumentFrequency.get(token) ?? 0) + 1);
    }

    const tfCounts = new Map<string, number>();
    for (const token of tokens) {
      tfCounts.set(token, (tfCounts.get(token) ?? 0) + 1);
    }

    const embedding: Record<string, number> = {};
    let squaredSum = 0;
    for (const [token, count] of tfCounts.entries()) {
      const tf = count / tokens.length;
      const df = this.termDocumentFrequency.get(token) ?? 1;
      const idf = Math.log((this.documentCount + 1) / (df + 1)) + 1;
      const weight = tf * idf;
      embedding[token] = weight;
      squaredSum += weight * weight;
    }

    const record: EpisodeRecord = {
      id,
      goal: input.goal,
      decision: input.decision,
      outcome: input.outcome,
      tags,
      importance,
      createdAt,
      metadata: { ...(input.metadata ?? {}) },
      embedding,
      embeddingNorm: Math.sqrt(Math.max(squaredSum, 1e-12)),
    };

    this.episodes.push(record);
    return this.cloneEpisode(record);
  }

  /** Lists recorded episodes sorted by recency. */
  listEpisodes(): MemoryEpisode[] {
    return this.episodes
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((episode) => this.cloneEpisode(episode));
  }

  /**
   * Searches episodes by tag overlap. Higher tag density and importance boost
   * the score so the orchestrator receives the most relevant memories first.
   */
  searchEpisodesByTags(tags: string[], options: MemorySearchOptions = {}): MemoryEpisodeHit[] {
    const targetTags = normaliseTags(tags);
    if (targetTags.length === 0) {
      return [];
    }

    const minimumScore = options.minimumScore ?? 0.05;
    const hits: MemoryEpisodeHit[] = [];
    for (const episode of this.episodes) {
      const matched = episode.tags.filter((tag) => targetTags.includes(tag));
      if (matched.length === 0) {
        continue;
      }
      const overlapScore = matched.length / targetTags.length;
      const recency = recencyBoost(episode.createdAt) * 0.2;
      const score = clamp(overlapScore * 0.7 + episode.importance * 0.2 + recency);
      if (score < minimumScore) {
        continue;
      }
      hits.push({ episode: this.cloneEpisode(episode), score, matchedTags: matched });
    }

    hits.sort((a, b) => b.score - a.score || b.episode.createdAt - a.episode.createdAt);
    return options.limit ? hits.slice(0, options.limit) : hits;
  }

  /**
   * Searches key-value memories using tag overlap and recency.
   */
  searchKeyValuesByTags(tags: string[], options: MemorySearchOptions = {}): MemoryKeyValueHit[] {
    const targetTags = normaliseTags(tags);
    if (targetTags.length === 0) {
      return [];
    }

    const minimumScore = options.minimumScore ?? 0.05;
    const hits: MemoryKeyValueHit[] = [];
    for (const entry of this.keyValues.values()) {
      const matched = entry.tags.filter((tag) => targetTags.includes(tag));
      if (matched.length === 0) {
        continue;
      }
      const overlapScore = matched.length / targetTags.length;
      const recency = recencyBoost(entry.updatedAt) * 0.2;
      const score = clamp(overlapScore * 0.6 + entry.importance * 0.2 + recency);
      if (score < minimumScore) {
        continue;
      }
      hits.push({
        entry: { ...entry, metadata: { ...entry.metadata } },
        score,
        matchedTags: matched,
      });
    }

    hits.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
    return options.limit ? hits.slice(0, options.limit) : hits;
  }

  /**
   * Performs a cosine similarity search between the query and recorded episodes.
   */
  searchEpisodesBySimilarity(query: string, options: MemorySearchOptions = {}): MemoryEpisodeHit[] {
    const tokens = tokenise(query);
    if (tokens.length === 0 || this.episodes.length === 0) {
      return [];
    }

    const tfCounts = new Map<string, number>();
    for (const token of tokens) {
      tfCounts.set(token, (tfCounts.get(token) ?? 0) + 1);
    }

    const queryEmbedding: Record<string, number> = {};
    let squaredSum = 0;
    for (const [token, count] of tfCounts.entries()) {
      const tf = count / tokens.length;
      const df = this.termDocumentFrequency.get(token) ?? 0;
      const idf = Math.log((this.documentCount + 1) / (df + 1)) + 1;
      const weight = tf * idf;
      queryEmbedding[token] = weight;
      squaredSum += weight * weight;
    }

    const queryNorm = Math.sqrt(Math.max(squaredSum, 1e-12));
    const minimumScore = options.minimumScore ?? 0.05;

    const hits: MemoryEpisodeHit[] = [];
    for (const episode of this.episodes) {
      let dot = 0;
      for (const [token, weight] of Object.entries(queryEmbedding)) {
        const other = episode.embedding[token];
        if (other !== undefined) {
          dot += weight * other;
        }
      }
      const similarity = dot / (queryNorm * episode.embeddingNorm);
      const recency = recencyBoost(episode.createdAt) * 0.15;
      const score = clamp(similarity * 0.85 + episode.importance * 0.1 + recency);
      if (score < minimumScore) {
        continue;
      }
      hits.push({ episode: this.cloneEpisode(episode), score, matchedTags: [] });
    }

    hits.sort((a, b) => b.score - a.score || b.episode.createdAt - a.episode.createdAt);
    return options.limit ? hits.slice(0, options.limit) : hits;
  }

  /** Helper cloning internal episode records to avoid accidental mutation. */
  private cloneEpisode(record: EpisodeRecord): MemoryEpisode {
    const { embeddingNorm, ...rest } = record;
    return {
      ...rest,
      tags: [...rest.tags],
      metadata: { ...rest.metadata },
      embedding: { ...rest.embedding },
    };
  }
}
