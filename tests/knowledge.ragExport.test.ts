import { describe, it } from "mocha";
import { expect } from "chai";

import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import {
  KgExportInputSchema,
  handleKgExport,
  type KnowledgeToolContext,
} from "../src/tools/knowledgeTools.js";
import { StructuredLogger } from "../src/logger.js";

function createGraphWithDeterministicClock(): KnowledgeGraph {
  let current = 0;
  return new KnowledgeGraph({ now: () => ++current });
}

describe("knowledge graph RAG export", () => {
  it("groups triples per subject into richly annotated documents", () => {
    const graph = createGraphWithDeterministicClock();

    graph.insert({
      subject: "launch",
      predicate: "includes",
      object: "design",
      source: "playbook",
      confidence: 0.92,
      provenance: [{ sourceId: "file://playbook.md", type: "file" }],
    });
    graph.insert({
      subject: "launch",
      predicate: "includes",
      object: "implement",
      source: "runbook",
      confidence: 0.83,
    });
    graph.insert({ subject: "task:design", predicate: "label", object: "Design" });
    graph.insert({
      subject: "task:design",
      predicate: "depends_on",
      object: "requirements",
      source: "analysis",
      confidence: 0.7,
    });

    const documents = graph.exportForRag();
    expect(documents).to.have.length(2);

    const planDoc = documents[0];
    expect(planDoc.id).to.equal("launch");
    expect(planDoc.text).to.equal(
      [
        "Subject: launch",
        "- includes: design (source=playbook, confidence=0.92, provenance=1)",
        "- includes: implement (source=runbook, confidence=0.83)",
      ].join("\n"),
    );
    expect(planDoc.tags).to.deep.equal([
      "kg",
      "predicate:includes",
      "source:playbook",
      "source:runbook",
      "subject:launch",
    ]);
    expect(planDoc.metadata).to.deep.equal({
      subject: "launch",
      triple_count: 2,
      predicates: ["includes"],
      sources: ["playbook", "runbook"],
      average_confidence: 0.875,
    });
    expect(planDoc.provenance).to.deep.equal([
      { sourceId: "file://playbook.md", type: "file" },
      { sourceId: "playbook", type: "kg" },
      { sourceId: "runbook", type: "kg" },
    ]);

    const taskDoc = documents[1];
    expect(taskDoc.id).to.equal("task:design");
    expect(taskDoc.text).to.equal(
      [
        "Subject: task:design",
        "- label: Design",
        "- depends_on: requirements (source=analysis, confidence=0.70)",
      ].join("\n"),
    );
    expect(taskDoc.tags).to.include.members([
      "predicate:depends_on",
      "predicate:label",
      "subject:task_design",
    ]);
    expect(taskDoc.metadata.sources).to.deep.equal(["analysis"]);
  });

  it("applies filtering directives when synthesising RAG documents", () => {
    const graph = createGraphWithDeterministicClock();
    graph.insert({ subject: "plan", predicate: "label", object: "Migration" });
    graph.insert({ subject: "plan", predicate: "notes", object: "Full dry run required", confidence: 0.95 });
    graph.insert({ subject: "plan", predicate: "includes", object: "draft", confidence: 0.4 });
    graph.insert({ subject: "plan", predicate: "label", object: "Migration Plan" });

    const documents = graph.exportForRag({
      minConfidence: 0.5,
      includePredicates: ["label"],
      maxTriplesPerSubject: 1,
    });

    expect(documents).to.have.length(1);
    expect(documents[0].id).to.equal("plan");
    expect(documents[0].text).to.equal(
      ["Subject: plan", "- label: Migration"].join("\n"),
    );
    expect(documents[0].metadata).to.deep.include({ triple_count: 1, predicates: ["label"] });
  });

  it("exposes the rag_documents format through the kg_export tool", () => {
    const graph = createGraphWithDeterministicClock();
    graph.insert({ subject: "plan", predicate: "label", object: "Launch" });
    const entries: Array<{ message: string; payload?: unknown }> = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push({ message: entry.message, payload: entry.payload }) });
    const context: KnowledgeToolContext = { knowledgeGraph: graph, logger };

    const input = KgExportInputSchema.parse({ format: "rag_documents", min_confidence: 0.5 });
    const result = handleKgExport(context, input);

    expect(result.format).to.equal("rag_documents");
    expect(result.documents).to.have.length(1);
    expect(result.documents?.[0].metadata.average_confidence).to.equal(1);
    const logEntry = entries.find((entry) => entry.message === "kg_export");
    expect(logEntry).to.not.equal(undefined);
    expect((logEntry?.payload as Record<string, unknown>)?.format).to.equal("rag_documents");
  });
});
