import { randomUUID } from "crypto";
/** Utility converting arbitrary tags into a deduplicated lowercase list. */
function normaliseTags(tags) {
    if (!tags || tags.length === 0) {
        return [];
    }
    const unique = new Set();
    for (const tag of tags) {
        if (!tag) {
            continue;
        }
        unique.add(tag.toString().trim().toLowerCase());
    }
    return Array.from(unique).filter((tag) => tag.length > 0);
}
/** Tokenises arbitrary text for TF-IDF embedding construction. */
function tokenise(text) {
    return text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 1);
}
/** Small helper keeping numeric scores in a sane range. */
function clamp(value) {
    if (Number.isNaN(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}
/** Recency boost used when ranking entries (fresh memories are prioritised). */
function recencyBoost(timestamp) {
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
    keyValues = new Map();
    episodes = [];
    documentCount = 0;
    termDocumentFrequency = new Map();
    options;
    constructor(options = {}) {
        this.options = {
            keyValueTTLMs: options.keyValueTTLMs === undefined ? 1000 * 60 * 60 * 24 * 30 : options.keyValueTTLMs,
            episodeTTLMs: options.episodeTTLMs === undefined ? 1000 * 60 * 60 * 24 * 30 : options.episodeTTLMs,
            maxKeyValues: options.maxKeyValues ?? 200,
            maxEpisodes: options.maxEpisodes ?? 500,
        };
    }
    /**
     * Resets the store. Mainly used by tests to obtain a clean slate.
     */
    clear() {
        this.keyValues.clear();
        this.episodes.length = 0;
        this.termDocumentFrequency.clear();
        this.documentCount = 0;
    }
    /**
     * Stores a key-value pair describing persistent context (configuration,
     * objectives, environment notes, ...).
     */
    upsertKeyValue(key, value, options = {}) {
        const now = Date.now();
        this.pruneExpiredEntries(now);
        const entry = {
            key,
            value,
            tags: normaliseTags(options.tags),
            importance: clamp(options.importance ?? 0.5),
            updatedAt: now,
            metadata: { ...(options.metadata ?? {}) },
        };
        this.keyValues.set(key, entry);
        this.enforceKeyValueCapacity();
        return { ...entry };
    }
    /** Retrieves a stored key-value entry. */
    getKeyValue(key) {
        this.pruneExpiredEntries(Date.now());
        const entry = this.keyValues.get(key);
        return entry ? { ...entry, metadata: { ...entry.metadata } } : undefined;
    }
    /** Returns all key-value entries ordered by recency. */
    listKeyValues() {
        this.pruneExpiredEntries(Date.now());
        return Array.from(this.keyValues.values())
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((entry) => ({ ...entry, metadata: { ...entry.metadata } }));
    }
    /**
     * Records a contextual episode (goal → decision → outcome). TF-IDF embeddings
     * are generated lazily to enable similarity search without external models.
     */
    recordEpisode(input) {
        const now = Date.now();
        this.pruneExpiredEntries(now);
        const id = input.id ?? randomUUID();
        const createdAt = input.createdAt ?? now;
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
        const uniqueTokens = new Set(tokens);
        this.documentCount += 1;
        for (const token of uniqueTokens) {
            this.termDocumentFrequency.set(token, (this.termDocumentFrequency.get(token) ?? 0) + 1);
        }
        const record = this.createEpisodeRecord({
            id,
            goal: input.goal,
            decision: input.decision,
            outcome: input.outcome,
            tags,
            importance,
            createdAt,
            metadata: { ...(input.metadata ?? {}) },
            tokens,
        });
        this.episodes.push(record);
        this.enforceEpisodeCapacity();
        return this.cloneEpisode(record);
    }
    /** Lists recorded episodes sorted by recency. */
    listEpisodes() {
        this.pruneExpiredEntries(Date.now());
        return this.episodes
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((episode) => this.cloneEpisode(episode));
    }
    /**
     * Searches episodes by tag overlap. Higher tag density and importance boost
     * the score so the orchestrator receives the most relevant memories first.
     */
    searchEpisodesByTags(tags, options = {}) {
        this.pruneExpiredEntries(Date.now());
        const targetTags = normaliseTags(tags);
        if (targetTags.length === 0) {
            return [];
        }
        const minimumScore = options.minimumScore ?? 0.05;
        const hits = [];
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
    searchKeyValuesByTags(tags, options = {}) {
        this.pruneExpiredEntries(Date.now());
        const targetTags = normaliseTags(tags);
        if (targetTags.length === 0) {
            return [];
        }
        const minimumScore = options.minimumScore ?? 0.05;
        const hits = [];
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
    searchEpisodesBySimilarity(query, options = {}) {
        this.pruneExpiredEntries(Date.now());
        const tokens = tokenise(query);
        if (tokens.length === 0 || this.episodes.length === 0) {
            return [];
        }
        const tfCounts = new Map();
        for (const token of tokens) {
            tfCounts.set(token, (tfCounts.get(token) ?? 0) + 1);
        }
        const queryEmbedding = {};
        let squaredSum = 0;
        for (const [token, count] of tfCounts.entries()) {
            const tf = count / tokens.length;
            const df = this.termDocumentFrequency.get(token) ?? 1;
            const idf = Math.log((this.documentCount + 1) / (df + 1)) + 1;
            const weight = tf * idf;
            queryEmbedding[token] = weight;
            squaredSum += weight * weight;
        }
        const queryNorm = Math.sqrt(Math.max(squaredSum, 1e-12));
        const minimumScore = options.minimumScore ?? 0.05;
        const hits = [];
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
    cloneEpisode(record) {
        const { embeddingNorm, tokens, ...rest } = record;
        return {
            ...rest,
            tags: [...rest.tags],
            metadata: { ...rest.metadata },
            embedding: { ...rest.embedding },
        };
    }
    /**
     * Builds an internal episode record with fresh TF-IDF embeddings. Keeping the
     * logic inside a helper allows us to rebuild embeddings when garbage
     * collection removes entries.
     */
    createEpisodeRecord(input) {
        const tfCounts = new Map();
        for (const token of input.tokens) {
            tfCounts.set(token, (tfCounts.get(token) ?? 0) + 1);
        }
        const embedding = {};
        let squaredSum = 0;
        for (const [token, count] of tfCounts.entries()) {
            const tf = count / input.tokens.length;
            const df = this.termDocumentFrequency.get(token) ?? 0;
            const idf = Math.log((this.documentCount + 1) / (df + 1)) + 1;
            const weight = tf * idf;
            embedding[token] = weight;
            squaredSum += weight * weight;
        }
        return {
            id: input.id,
            goal: input.goal,
            decision: input.decision,
            outcome: input.outcome,
            tags: input.tags,
            importance: input.importance,
            createdAt: input.createdAt,
            metadata: input.metadata,
            embedding,
            embeddingNorm: Math.sqrt(Math.max(squaredSum, 1e-12)),
            tokens: [...input.tokens],
        };
    }
    /** Removes entries whose TTL has elapsed and enforces the configured bounds. */
    pruneExpiredEntries(now) {
        let removedEpisodes = false;
        if (this.options.keyValueTTLMs !== null) {
            for (const [key, entry] of Array.from(this.keyValues.entries())) {
                if (now - entry.updatedAt > this.options.keyValueTTLMs) {
                    this.keyValues.delete(key);
                }
            }
        }
        if (this.options.episodeTTLMs !== null) {
            const ttl = this.options.episodeTTLMs;
            for (let index = this.episodes.length - 1; index >= 0; index -= 1) {
                const episode = this.episodes[index];
                if (now - episode.createdAt > ttl) {
                    this.episodes.splice(index, 1);
                    removedEpisodes = true;
                }
            }
        }
        if (removedEpisodes) {
            this.rebuildEpisodeStatistics();
        }
        this.enforceKeyValueCapacity();
        this.enforceEpisodeCapacity();
    }
    /** Ensures the key-value cache never exceeds the configured capacity. */
    enforceKeyValueCapacity() {
        const { maxKeyValues } = this.options;
        if (this.keyValues.size <= maxKeyValues) {
            return;
        }
        const excess = this.keyValues.size - maxKeyValues;
        const ordered = Array.from(this.keyValues.values()).sort((a, b) => a.updatedAt - b.updatedAt);
        for (let index = 0; index < excess; index += 1) {
            this.keyValues.delete(ordered[index].key);
        }
    }
    /** Ensures episodic memories stay capped and statistics remain consistent. */
    enforceEpisodeCapacity() {
        const { maxEpisodes } = this.options;
        if (this.episodes.length <= maxEpisodes) {
            return;
        }
        const excess = this.episodes.length - maxEpisodes;
        this.episodes.sort((a, b) => a.createdAt - b.createdAt);
        this.episodes.splice(0, excess);
        this.rebuildEpisodeStatistics();
    }
    /**
     * Recomputes global statistics (document counts and embeddings) after a
     * garbage collection pass removed one or more episodes.
     */
    rebuildEpisodeStatistics() {
        this.termDocumentFrequency.clear();
        this.documentCount = this.episodes.length;
        for (const episode of this.episodes) {
            const uniqueTokens = new Set(episode.tokens);
            for (const token of uniqueTokens) {
                this.termDocumentFrequency.set(token, (this.termDocumentFrequency.get(token) ?? 0) + 1);
            }
        }
        // Rebuild embeddings using the refreshed document frequencies so cosine
        // similarity remains numerically stable.
        for (let index = 0; index < this.episodes.length; index += 1) {
            const original = this.episodes[index];
            const rebuilt = this.createEpisodeRecord({
                id: original.id,
                goal: original.goal,
                decision: original.decision,
                outcome: original.outcome,
                tags: original.tags,
                importance: original.importance,
                createdAt: original.createdAt,
                metadata: { ...original.metadata },
                tokens: original.tokens,
            });
            this.episodes[index] = rebuilt;
        }
    }
}
