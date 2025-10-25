import { describe, it } from "mocha";
import { expect } from "chai";

import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import { handleGraphGenerate } from "../src/tools/graph/mutate.js";

/**
 * Ensures that graph generation can leverage knowledge graph patterns when no
 * preset or explicit tasks are provided.
 */
describe("graph generate knowledge integration", () => {
  it("derives tasks and notes from knowledge graph patterns", () => {
    const knowledge = new KnowledgeGraph({ now: () => 0 });

    knowledge.insert({ subject: "incident_response", predicate: "includes", object: "detect", source: "kb", confidence: 0.92 });
    knowledge.insert({ subject: "incident_response", predicate: "includes", object: "contain", source: "kb", confidence: 0.84 });
    knowledge.insert({ subject: "task:detect", predicate: "label", object: "Detect incident" });
    knowledge.insert({ subject: "task:contain", predicate: "label", object: "Contain incident" });
    knowledge.insert({ subject: "task:contain", predicate: "depends_on", object: "detect" });
    knowledge.insert({ subject: "task:contain", predicate: "weight", object: "3" });
    knowledge.insert({ subject: "task:contain", predicate: "duration", object: "5" });

    const result = handleGraphGenerate(
      { name: "incident_response" },
      { knowledgeGraph: knowledge, knowledgeEnabled: true },
    );

    expect(result.task_count).to.equal(2);
    expect(result.edge_count).to.equal(1);
    expect(result.notes[0]).to.contain("knowledge pattern 'incident_response' applied");
    expect(result.notes[0]).to.contain("avg_confidence=0.88");
    expect(result.notes[1]).to.equal("knowledge sources=1");

    const detect = result.graph.nodes.find((node) => node.id === "detect");
    const contain = result.graph.nodes.find((node) => node.id === "contain");
    expect(detect?.attributes?.knowledge_source).to.equal("kb");
    expect(contain?.attributes?.knowledge_confidence).to.equal(0.84);
    expect(contain?.attributes?.duration).to.equal(5);
    expect(contain?.attributes?.weight).to.equal(3);

    const edge = result.graph.edges.find((item) => item.from === "detect" && item.to === "contain");
    expect(edge?.weight).to.equal(3);
  });
});
