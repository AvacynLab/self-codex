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
});
