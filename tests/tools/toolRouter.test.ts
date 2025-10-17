import { afterEach } from "mocha";
import { expect } from "chai";

import { ToolRouter } from "../../src/tools/toolRouter.js";
import type { ToolBudgets, ToolManifest } from "../../src/mcp/registry.js";

/** Utility creating a minimal tool manifest for router tests. */
function buildManifest(options: {
  name: string;
  category: "project" | "artifact" | "graph" | "plan" | "child" | "runtime" | "memory" | "admin";
  tags?: string[];
  description?: string;
  budgets?: ToolBudgets;
}): ToolManifest {
  const timestamp = new Date(2025, 0, 1).toISOString();
  return {
    name: options.name,
    title: options.name,
    description: options.description,
    kind: "dynamic",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    category: options.category,
    tags: options.tags ?? [],
    hidden: false,
    source: "runtime",
    budgets: options.budgets,
  };
}

describe("ToolRouter", () => {
  const originalTopK = process.env.TOOLROUTER_TOPK;

  afterEach(() => {
    if (originalTopK === undefined) {
      delete process.env.TOOLROUTER_TOPK;
    } else {
      process.env.TOOLROUTER_TOPK = originalTopK;
    }
  });

  it("prioritises candidates matching category and tags", () => {
    const router = new ToolRouter({ acceptanceThreshold: 0.3 });
    router.register(
      buildManifest({
        name: "graph_apply_change_set",
        category: "graph",
        tags: ["graph", "mutation"],
        description: "Appliquer un patch sur le graphe.",
      }),
    );
    router.register(
      buildManifest({
        name: "runtime_observe",
        category: "runtime",
        tags: ["metrics"],
        description: "Observer les métriques runtime.",
      }),
    );

    const decision = router.route({ goal: "modifier le graphe", category: "graph", tags: ["mutation"] });

    expect(decision.tool).to.equal("graph_apply_change_set");
    const primary = decision.candidates.find((candidate) => candidate.tool === "graph_apply_change_set");
    expect(primary).to.not.equal(undefined);
    expect(primary!.score).to.be.greaterThan(0.3);
    expect(decision.candidates.some((candidate) => candidate.tool === "runtime_observe")).to.equal(true);
  });

  it("falls back to configured candidates when no heuristic crosses the threshold", () => {
    const router = new ToolRouter({
      acceptanceThreshold: 0.9,
      fallbacks: [
        { tool: "tools_help", rationale: "documentation", score: 0.55 },
        { tool: "artifact_search", rationale: "recherche", score: 0.5 },
      ],
    });
    router.register(
      buildManifest({
        name: "artifact_read",
        category: "artifact",
        tags: ["lecture"],
      }),
    );

    const decision = router.route({ goal: "aucune idee" });

    expect(decision.reason).to.equal("fallback:tools_help");
    expect(decision.candidates.map((candidate) => candidate.tool)).to.deep.equal([
      "tools_help",
      "artifact_search",
    ]);
  });

  it("adjusts reliability based on recorded outcomes", () => {
    const router = new ToolRouter({ acceptanceThreshold: 0.3 });
    router.register(
      buildManifest({
        name: "memory_search",
        category: "memory",
        tags: ["search"],
      }),
    );

    const context = { goal: "rechercher un souvenir", category: "memory", tags: ["search"] };
    const before = router.route(context);
    expect(before.tool).to.equal("memory_search");
    const baselineScore = before.candidates[0]?.score ?? 0;

    router.recordOutcome({ tool: "memory_search", success: false });
    router.recordOutcome({ tool: "memory_search", success: false });

    const after = router.route(context);
    expect(after.tool).to.not.equal("memory_search");
    expect(after.reason).to.include("fallback");
  });

  it("leverages embedding similarity when heuristics are ambiguous", () => {
    const router = new ToolRouter({ acceptanceThreshold: 0.3 });
    router.register(
      buildManifest({
        name: "artifact_label_apply",
        category: "artifact",
        tags: ["metadata"],
        description: "Étiqueter un document avec des labels pour la classification.",
      }),
    );
    router.register(
      buildManifest({
        name: "artifact_preview",
        category: "artifact",
        tags: ["lecture"],
        description: "Afficher un aperçu rapide d'un fichier existant.",
      }),
    );

    const decision = router.route({ goal: "ajouter une étiquette au document généré", category: "artifact" });

    expect(decision.tool).to.equal("artifact_label_apply");
    const labelCandidate = decision.candidates.find((candidate) => candidate.tool === "artifact_label_apply");
    expect(labelCandidate?.rationale).to.include("embedding");
  });

  it("penalises expensive budgets when ranking candidates", () => {
    const router = new ToolRouter({ acceptanceThreshold: 0.3 });
    router.register(
      buildManifest({
        name: "runtime_observe_fast",
        category: "runtime",
        tags: ["metrics"],
        description: "Collecter rapidement des métriques runtime.",
        budgets: { time_ms: 1_000, tool_calls: 1, bytes_out: 8_192 },
      }),
    );
    router.register(
      buildManifest({
        name: "runtime_observe_deep",
        category: "runtime",
        tags: ["metrics"],
        description: "Analyse approfondie des métriques runtime avec rapports détaillés.",
        budgets: { time_ms: 20_000, tool_calls: 5, bytes_out: 64_000 },
      }),
    );

    const decision = router.route({ goal: "observer les métriques runtime", category: "runtime" });

    expect(decision.tool).to.equal("runtime_observe_fast");
    const slowCandidate = decision.candidates.find((candidate) => candidate.tool === "runtime_observe_deep");
    expect(slowCandidate?.rationale).to.include("budget");
    const fastCandidate = decision.candidates.find((candidate) => candidate.tool === "runtime_observe_fast");
    expect(slowCandidate && fastCandidate).to.not.equal(undefined);
    expect((slowCandidate!.score ?? 0)).to.be.lessThan(fastCandidate!.score);
  });

  it("applies failure streak backoff and restores reliability after success", () => {
    let now = 1_000;
    const router = new ToolRouter({ acceptanceThreshold: 0.3, now: () => now });
    router.register(
      buildManifest({
        name: "memory_search",
        category: "memory",
        tags: ["lookup"],
        description: "Rechercher une information persistée dans la mémoire vectorielle.",
      }),
    );

    const context = { goal: "retrouver une information", category: "memory", tags: ["lookup"] };
    const before = router.route(context);
    expect(before.tool).to.equal("memory_search");

    router.recordOutcome({ tool: "memory_search", success: false, latencyMs: 5000 });

    const afterFailure = router.route(context);
    expect(afterFailure.reason).to.include("fallback");

    now += 10;
    router.recordOutcome({ tool: "memory_search", success: true, latencyMs: 800 });

    const afterSuccess = router.route(context);
    expect(afterSuccess.tool).to.equal("memory_search");
  });

  it("limits surfaced candidates when TOOLROUTER_TOPK is provided", () => {
    process.env.TOOLROUTER_TOPK = "1";
    const router = new ToolRouter({ acceptanceThreshold: 0.1 });
    router.register(
      buildManifest({
        name: "artifact_label_apply",
        category: "artifact",
        tags: ["metadata"],
        description: "Étiqueter un document avec des labels pour la classification.",
      }),
    );
    router.register(
      buildManifest({
        name: "artifact_preview",
        category: "artifact",
        tags: ["lecture"],
        description: "Afficher un aperçu rapide d'un fichier existant.",
      }),
    );

    const decision = router.route({ goal: "examiner et étiqueter un document", category: "artifact" });

    expect(decision.candidates).to.have.lengthOf(1);
    expect(decision.candidates[0]?.tool).to.equal(decision.tool);
  });
});
