import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import { assistKnowledgeQuery, suggestPlanFragments } from "../src/knowledge/assist.js";
import {
  KgSuggestPlanInputSchema,
  handleKgSuggestPlan,
  type KnowledgeToolContext,
} from "../src/tools/knowledgeTools.js";
import { StructuredLogger } from "../src/logger.js";
import type {
  VectorMemory,
  VectorMemoryDocument,
  VectorMemorySearchHit,
  VectorMemorySearchOptions,
} from "../src/memory/vectorMemory.js";
import { LocalVectorMemory } from "../src/memory/vectorMemory.js";
import { HybridRetriever, type HybridRetrieverHit, type HybridRetrieverSearchOptions } from "../src/memory/retriever.js";

function seedLaunchPlan(graph: KnowledgeGraph): void {
  graph.insert({
    subject: "launch",
    predicate: "includes",
    object: "design",
    source: "playbook",
    confidence: 0.92,
  });
  graph.insert({
    subject: "launch",
    predicate: "includes",
    object: "implement",
    source: "playbook",
    confidence: 0.87,
  });
  graph.insert({
    subject: "launch",
    predicate: "includes",
    object: "review",
    source: "qa",
    confidence: 0.78,
  });
  graph.insert({ subject: "task:design", predicate: "label", object: "Design" });
  graph.insert({ subject: "task:implement", predicate: "label", object: "Implémentation" });
  graph.insert({ subject: "task:review", predicate: "label", object: "Revue" });
  graph.insert({ subject: "task:implement", predicate: "depends_on", object: "design" });
  graph.insert({ subject: "task:review", predicate: "depends_on", object: "implement" });
  graph.insert({ subject: "task:review", predicate: "duration", object: "3" });
}

/** Creates a logger that records every entry for assertions without printing output. */
function createCapturingLogger(entries: Array<{ message: string; payload?: unknown }>): StructuredLogger {
  return new StructuredLogger({ onEntry: (entry) => entries.push({ message: entry.message, payload: entry.payload }) });
}

/**
 * Minimal vector memory satisfying the {@link HybridRetriever} constructor
 * contract. The implementation never stores documents because tests override
 * {@link HybridRetriever.search} directly to intercept the options forwarded by
 * `assistKnowledgeQuery`.
 */
class StubVectorMemory implements VectorMemory {
  async upsert(): Promise<VectorMemoryDocument[]> {
    return [];
  }

  async search(_query: string, _options?: VectorMemorySearchOptions): Promise<VectorMemorySearchHit[]> {
    return [];
  }

  async delete(): Promise<number> {
    return 0;
  }

  async clear(): Promise<void> {}

  size(): number {
    return 0;
  }
}

/**
 * Retriever capturing the latest search invocation so tests can assert that the
 * helper omits undefined overrides once strict optional typing is enforced.
 */
class CapturingHybridRetriever extends HybridRetriever {
  public capturedQuery: string | undefined;
  public capturedOptions: HybridRetrieverSearchOptions | undefined;

  constructor() {
    super(new StubVectorMemory(), new StructuredLogger({ logFile: null }));
  }

  override async search(
    query: string,
    options: HybridRetrieverSearchOptions = {},
  ): Promise<HybridRetrieverHit[]> {
    this.capturedQuery = query;
    this.capturedOptions = options;
    return [
      {
        id: "stub-hit",
        text: "relevant passage",
        score: 0.88,
        vectorScore: 0.88,
        lexicalScore: 0.44,
        tags: options.requiredTags ?? [],
        matchedTags: options.requiredTags ? [...options.requiredTags] : [],
        provenance: [],
        metadata: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ];
  }
}

describe("knowledge graph plan suggestions", () => {
  it("builds fragments prioritising preferred sources while preserving dependencies", async () => {
    const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
    seedLaunchPlan(knowledgeGraph);

    const suggestion = suggestPlanFragments(knowledgeGraph, {
      goal: "launch",
      context: { preferredSources: ["playbook"], maxFragments: 2 },
    });

    expect(suggestion.goal).to.equal("launch");
    expect(suggestion.fragments).to.have.length(2);
    expect(suggestion.coverage.total_tasks).to.equal(3);
    expect(suggestion.coverage.suggested_tasks).to.deep.equal(["design", "implement", "review"]);
    expect(suggestion.sources).to.deep.equal([
      { source: "playbook", tasks: 2 },
      { source: "qa", tasks: 1 },
    ]);
    expect(suggestion.preferred_sources_applied).to.deep.equal(["playbook"]);
    expect(suggestion.preferred_sources_ignored).to.deep.equal([]);
    expect(suggestion.coverage.rag_hits).to.equal(0);
    expect(suggestion.rationale[0]).to.match(/Plan 'launch'/);

    const preferredFragment = suggestion.fragments[0];
    expect(preferredFragment.id).to.equal("launch-fragment-1");
    expect(preferredFragment.nodes.map((node) => node.id)).to.deep.equal(["design", "implement"]);
    expect(preferredFragment.edges).to.have.length(1);
    expect(preferredFragment.edges[0]).to.deep.include({
      from: { nodeId: "design" },
      to: { nodeId: "implement" },
      label: "depends_on",
    });
    const designNode = preferredFragment.nodes.find((node) => node.id === "design");
    expect(designNode?.attributes).to.include({ kg_seed: true, kg_group: "source playbook" });

    const remainderFragment = suggestion.fragments[1];
    expect(remainderFragment.id).to.equal("launch-fragment-2");
    expect(remainderFragment.nodes.map((node) => node.id)).to.deep.equal(["design", "implement", "review"]);
    expect(remainderFragment.edges.map((edge) => `${edge.from.nodeId}->${edge.to.nodeId}`)).to.deep.equal([
      "design->implement",
      "implement->review",
    ]);
    const reviewNode = remainderFragment.nodes.find((node) => node.id === "review");
    expect(reviewNode?.attributes).to.include({ kg_seed: true, kg_group: "sources complémentaires" });
  });

  it("reports excluded tasks and missing dependencies", async () => {
    const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
    seedLaunchPlan(knowledgeGraph);

    const suggestion = suggestPlanFragments(knowledgeGraph, {
      goal: "launch",
      context: { excludeTasks: ["design"] },
    });

    expect(suggestion.coverage.excluded_tasks).to.deep.equal(["design"]);
    expect(suggestion.coverage.missing_dependencies).to.deep.equal([
      { task: "implement", dependencies: ["design"] },
    ]);
    expect(suggestion.coverage.unknown_dependencies).to.deep.equal([]);
    expect(suggestion.rationale.some((line) => /Exclus par le contexte/.test(line))).to.equal(true);
    expect(
      suggestion.rationale.some((line) => /Dépendances ignorées \(présentes mais exclues\)/.test(line)),
    ).to.equal(true);
    const fragment = suggestion.fragments[0];
    expect(fragment.nodes.map((node) => node.id)).to.deep.equal(["implement", "review"]);
  });

  it("invokes the tool handler and logs the summary", async () => {
    const entries: Array<{ message: string; payload?: unknown }> = [];
    const logger = createCapturingLogger(entries);
    const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
    seedLaunchPlan(knowledgeGraph);
    const context: KnowledgeToolContext = { knowledgeGraph, logger };

    const parsedInput = KgSuggestPlanInputSchema.parse({
      goal: "launch",
      context: { preferred_sources: ["playbook"], max_fragments: 2 },
    });

    const result = await handleKgSuggestPlan(context, parsedInput);
    expect(result.goal).to.equal("launch");
    expect(result.fragments).to.have.length(2);
    const logEntry = entries.find((entry) => entry.message === "kg_suggest_plan");
    expect(logEntry).to.not.equal(undefined);
    expect((logEntry?.payload as Record<string, unknown>)?.rag_hits).to.equal(0);
  });

  it("falls back to RAG passages when the graph lacks coverage", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "plan-rag-"));
    try {
      const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
      const ragMemory = await LocalVectorMemory.create({ directory: tmpDir, now: (() => {
        let current = 0;
        return () => (current += 1);
      })() });
      await ragMemory.upsert([
        {
          id: "incident-plan",
          text: "Incident response plan détaillé : identifier, contenir, éradiquer puis récupérer. Inclure communication et revue.",
          tags: ["security", "incident"],
          provenance: [{ sourceId: "https://kb.example.org/ir", type: "url" }],
        },
      ]);

      const retriever = new HybridRetriever(ragMemory, new StructuredLogger());
      const entries: Array<{ message: string; payload?: unknown }> = [];
      const logger = createCapturingLogger(entries);

      const context: KnowledgeToolContext = {
        knowledgeGraph,
        logger,
        rag: {
          getRetriever: async () => retriever,
          defaultDomainTags: ["security"],
          minScore: 0.1,
        },
      };

      const result = await handleKgSuggestPlan(
        context,
        KgSuggestPlanInputSchema.parse({ goal: "incident response" }),
      );

      expect(result.fragments).to.deep.equal([]);
      expect(result.coverage.rag_hits).to.equal(1);
      expect(result.rag_evidence).to.have.length(1);
      expect(result.rag_evidence?.[0].matched_terms).to.include("incident");
      expect(result.rag_domain_tags).to.deep.equal(["security"]);
      expect(result.rag_min_score).to.equal(0.1);
      expect(result.rag_query).to.be.a("string").and.to.contain("Plan recherché");

      const logEntry = entries.find((entry) => entry.message === "kg_suggest_plan");
      expect((logEntry?.payload as Record<string, unknown>)?.rag_hits).to.equal(1);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("omits undefined domain tags when invoking the RAG retriever", async () => {
    const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
    const retriever = new CapturingHybridRetriever();

    const result = await assistKnowledgeQuery(knowledgeGraph, {
      query: "How to secure a deployment?",
      limit: 1,
      ragRetriever: retriever,
      ragLimit: 2,
      ragMinScore: 0.42,
    });

    expect(result.rag_evidence).to.have.length(1);
    expect(retriever.capturedQuery).to.equal("How to secure a deployment?");
    expect(retriever.capturedOptions?.limit).to.equal(2);
    expect(retriever.capturedOptions?.minScore).to.equal(0.42);
    expect("requiredTags" in (retriever.capturedOptions ?? {})).to.equal(false);
  });

  it("forwards normalised domain tags to the RAG retriever", async () => {
    const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
    const retriever = new CapturingHybridRetriever();

    await assistKnowledgeQuery(knowledgeGraph, {
      query: "Provide security steps",
      ragRetriever: retriever,
      domainTags: [" Security ", "", "Infra"],
    });

    expect(retriever.capturedOptions?.requiredTags).to.deep.equal(["security", "infra"]);
  });
});
