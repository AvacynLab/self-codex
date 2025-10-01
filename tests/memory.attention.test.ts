import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { SharedMemoryStore } from "../src/memory/store.js";
import { selectMemoryContext } from "../src/memory/attention.js";

describe("Memory attention", () => {
  const store = new SharedMemoryStore();

  beforeEach(() => {
    store.clear();
    store.upsertKeyValue("workflow.policy", "Toujours lancer npm test", {
      tags: ["tests", "quality"],
      importance: 0.7,
    });
    const base = Date.now();
    store.recordEpisode({
      goal: "Automatiser les vérifications",
      decision: "Mettre en place un plan fan-out",
      outcome: "Trois clones exécutent les validations en parallèle",
      tags: ["plan", "tests"],
      importance: 0.9,
      createdAt: base,
    });
    store.recordEpisode({
      goal: "Explorer alternative",
      decision: "Créer un graphe alternatif",
      outcome: "Version optimisée identifiée",
      tags: ["graph", "exploration"],
      importance: 0.6,
      createdAt: base + 1_000,
    });
  });

  it("prioritises episodes matching the provided tags", () => {
    const context = selectMemoryContext(store, {
      tags: ["tests"],
      goals: ["Automatiser"],
      limit: 2,
    });

    expect(context.episodes).to.have.lengthOf(1);
    expect(context.episodes[0].decision).to.include("fan-out");
    expect(context.keyValues[0].key).to.equal("workflow.policy");
    expect(context.diagnostics.requestedTags).to.include("tests");
  });

  it("falls back to recent memories when no filters are provided", () => {
    const context = selectMemoryContext(store, { limit: 1, includeKeyValues: false });
    expect(context.episodes).to.have.lengthOf(1);
    expect(context.episodes[0].goal).to.include("Explorer alternative");
    expect(context.keyValues).to.have.lengthOf(0);
  });

  it("mixes semantic similarity with tag results", () => {
    const context = selectMemoryContext(store, {
      query: "plan clones validations parallèles",
      limit: 3,
      minimumScore: 0.01,
    });

    expect(context.episodes.length).to.be.greaterThan(0);
    expect(context.episodes[0].goal.toLowerCase()).to.include("automatiser");
  });

  it("filters contradictory outcomes for the same goal", () => {
    const base = Date.now();
    store.recordEpisode({
      goal: "Réparer pipeline QA",
      decision: "Relancer la build",
      outcome: "Succès stabilisé",
      tags: ["qa", "rollback"],
      importance: 0.85,
      createdAt: base + 2_000,
    });
    store.recordEpisode({
      goal: "Réparer pipeline QA",
      decision: "Relancer la build",
      outcome: "Échec persistant malgré relance",
      tags: ["qa", "rollback"],
      importance: 0.4,
      createdAt: base + 3_000,
    });

    const context = selectMemoryContext(store, {
      tags: ["rollback", "qa"],
      limit: 2,
      minimumScore: 0.01,
    });

    expect(context.episodes).to.have.lengthOf(1);
    const rollbackEpisodes = context.episodes.filter((episode) =>
      episode.goal.toLowerCase().includes("pipeline qa"),
    );
    expect(rollbackEpisodes).to.have.lengthOf(1);
    expect(rollbackEpisodes[0].outcome.toLowerCase()).to.include("succès");
  });
});
