import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { SharedMemoryStore } from "../src/memory/store.js";

describe("SharedMemoryStore", () => {
  const store = new SharedMemoryStore();

  beforeEach(() => {
    store.clear();
  });

  it("stores key-value pairs and retrieves them by tags", () => {
    store.upsertKeyValue(
      "deploy.notes",
      { summary: "Run regression tests before deploy" },
      { tags: ["deploy", "qa"], importance: 0.9 },
    );
    store.upsertKeyValue("ops.rotation", "Document rotation steps", { tags: ["ops"], importance: 0.4 });

    const hits = store.searchKeyValuesByTags(["deploy"], { limit: 5 });

    expect(hits).to.have.lengthOf(1);
    expect(hits[0].entry.key).to.equal("deploy.notes");
    expect(hits[0].matchedTags).to.deep.equal(["deploy"]);
    expect(hits[0].score).to.be.greaterThan(0.5);
  });

  it("records episodes with embeddings and supports tag search", () => {
    store.recordEpisode({
      goal: "Stabiliser la release",
      decision: "Exécuter la suite de tests end-to-end",
      outcome: "Tous les tests sont passés",
      tags: ["deploy", "tests"],
      importance: 0.8,
    });
    store.recordEpisode({
      goal: "Investiguer incident",
      decision: "Analyser les journaux",
      outcome: "Variable d'environnement manquante identifiée",
      tags: ["incident"],
      importance: 0.6,
    });

    const tagHits = store.searchEpisodesByTags(["tests"], { limit: 3 });
    expect(tagHits).to.have.lengthOf(1);
    expect(tagHits[0].episode.goal).to.contain("Stabiliser");
    expect(tagHits[0].score).to.be.greaterThan(0.4);

    const similarityHits = store.searchEpisodesBySimilarity("tests end to end pour deploy", { limit: 5 });
    expect(similarityHits[0].episode.decision).to.include("suite de tests");
    expect(similarityHits[0].score).to.be.greaterThan(0.4);
    expect(similarityHits[0].episode.embedding).to.have.property("tests");
  });

  it("lists episodes by recency and keeps metadata immutable", () => {
    const base = Date.now();
    const first = store.recordEpisode({
      goal: "Préparer roadmap",
      decision: "Collecter feedback utilisateurs",
      outcome: "Trois thèmes prioritaires",
      tags: ["product"],
      importance: 0.5,
      metadata: { author: "alice" },
      createdAt: base,
    });
    const second = store.recordEpisode({
      goal: "Planifier sprint",
      decision: "Découper les stories critiques",
      outcome: "Backlog prêt",
      tags: ["planning"],
      importance: 0.7,
      metadata: { author: "bob" },
      createdAt: base + 1_000,
    });

    const listed = store.listEpisodes();
    expect(listed[0].id).to.equal(second.id);
    expect(listed[1].id).to.equal(first.id);

    listed[0].metadata.author = "charlie";
    const storedAgain = store.listEpisodes()[0];
    expect(storedAgain.metadata.author).to.equal("bob");
  });

  it("evicts expired entries and caps capacity deterministically", () => {
    const ttlStore = new SharedMemoryStore({
      keyValueTTLMs: 100,
      episodeTTLMs: 100,
      maxKeyValues: 2,
      maxEpisodes: 2,
    });

    const originalNow = Date.now;
    let now = Date.now();
    Date.now = () => now;

    try {
      ttlStore.upsertKeyValue("policy.a", "keep", { tags: ["alpha"] });
      ttlStore.recordEpisode({
        goal: "Stabiliser le module",
        decision: "Exécuter tests unitaires",
        outcome: "Succès total",
        tags: ["qa"],
        importance: 0.9,
      });

      // Advance time without crossing the TTL so both entries co-exist.
      now += 40;
      ttlStore.upsertKeyValue("policy.b", "fresh", { tags: ["beta"] });
      ttlStore.recordEpisode({
        goal: "Résoudre incident",
        decision: "Analyser journaux",
        outcome: "Incident résolu",
        tags: ["incident"],
        importance: 0.8,
      });

      const keyValues = ttlStore.listKeyValues();
      expect(keyValues).to.have.lengthOf(2);
      expect(keyValues.map((entry) => entry.key)).to.deep.equal(["policy.b", "policy.a"]);

      const episodes = ttlStore.listEpisodes();
      expect(episodes).to.have.lengthOf(2);
      expect(episodes[0].goal).to.include("Résoudre incident");

      // Pushing additional entries should prune the oldest ones to honour the capacity limit.
      now += 10;
      ttlStore.upsertKeyValue("policy.c", "new", { tags: ["gamma"] });
      ttlStore.recordEpisode({
        goal: "Optimiser pipeline",
        decision: "Paralléliser jobs",
        outcome: "Succès mesuré",
        tags: ["pipeline"],
        importance: 0.7,
      });

      expect(ttlStore.listKeyValues()).to.have.lengthOf(2);
      expect(ttlStore.searchKeyValuesByTags(["alpha"])).to.have.lengthOf(0);

      const removed = ttlStore.searchEpisodesBySimilarity("tests unitaires", { limit: 2 });
      expect(
        removed.every((hit) => !hit.episode.goal.toLowerCase().includes("stabiliser le module")),
      ).to.equal(true);

      const similarity = ttlStore.searchEpisodesBySimilarity("pipeline succès", { limit: 2 });
      expect(similarity[0].episode.goal).to.include("Optimiser");
      expect(
        similarity.some((hit) => hit.episode.goal.toLowerCase().includes("optimiser pipeline")),
      ).to.equal(true);

      // Moving the clock beyond the TTL should evict the remaining stale entries.
      now += 200;
      expect(ttlStore.listKeyValues()).to.have.lengthOf(0);
      expect(ttlStore.listEpisodes()).to.have.lengthOf(0);
    } finally {
      Date.now = originalNow;
    }
  });
});
