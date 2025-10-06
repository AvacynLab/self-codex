import { describe, it } from "mocha";
import { expect } from "chai";

import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import { suggestPlanFragments } from "../src/knowledge/assist.js";
import {
  KgSuggestPlanInputSchema,
  handleKgSuggestPlan,
  type KnowledgeToolContext,
} from "../src/tools/knowledgeTools.js";
import { StructuredLogger } from "../src/logger.js";

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

describe("knowledge graph plan suggestions", () => {
  it("builds fragments prioritising preferred sources while preserving dependencies", () => {
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

  it("reports excluded tasks and missing dependencies", () => {
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

  it("invokes the tool handler and logs the summary", () => {
    const entries: Array<{ message: string; payload?: unknown }> = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push({ message: entry.message, payload: entry.payload }) });
    const knowledgeGraph = new KnowledgeGraph({ now: () => 0 });
    seedLaunchPlan(knowledgeGraph);
    const context: KnowledgeToolContext = { knowledgeGraph, logger };

    const parsedInput = KgSuggestPlanInputSchema.parse({
      goal: "launch",
      context: { preferred_sources: ["playbook"], max_fragments: 2 },
    });

    const result = handleKgSuggestPlan(context, parsedInput);
    expect(result.goal).to.equal("launch");
    expect(result.fragments).to.have.length(2);
    expect(entries.some((entry) => entry.message === "kg_suggest_plan")).to.equal(true);
  });
});
