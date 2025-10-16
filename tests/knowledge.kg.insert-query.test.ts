import { describe, it } from "mocha";
import { expect } from "chai";

import { KnowledgeGraph } from "../src/knowledge/knowledgeGraph.js";
import {
  handleKgExport,
  handleKgInsert,
  handleKgQuery,
  type KnowledgeToolContext,
} from "../src/tools/knowledgeTools.js";
import { StructuredLogger } from "../src/logger.js";

/** Deterministic manual clock to control knowledge graph timestamps. */
class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * Validates that the knowledge graph deterministically stores, updates and
 * queries triples via the dedicated tool handlers.
 */
describe("knowledge graph storage and queries", () => {
  it("inserts, updates, filters and exports triples deterministically", () => {
    const clock = new ManualClock();
    const graph = new KnowledgeGraph({ now: () => clock.now() });
    const logger = new StructuredLogger();
    const context: KnowledgeToolContext = { knowledgeGraph: graph, logger };

    const initial = handleKgInsert(context, {
      triples: [
        { subject: "incident", predicate: "includes", object: "detect", source: "playbook", confidence: 0.9 },
        { subject: "incident", predicate: "includes", object: "contain", source: "playbook", confidence: 0.8 },
        { subject: "task:contain", predicate: "depends_on", object: "detect" },
      ],
    });

    expect(initial.created).to.equal(3);
    expect(initial.updated).to.equal(0);
    expect(initial.total).to.equal(3);
    expect(initial.inserted.map((triple) => triple.ordinal)).to.deep.equal([1, 2, 3]);

    clock.advance(100);

    const second = handleKgInsert(context, {
      triples: [
        { subject: "incident", predicate: "includes", object: "detect", source: "library", confidence: 0.95 },
        { subject: "task:contain", predicate: "label", object: "Contain incident" },
      ],
    });

    expect(second.created).to.equal(1);
    expect(second.updated).to.equal(1);
    expect(second.total).to.equal(4);

    const updatedTriple = second.inserted.find((triple) => triple.object === "detect");
    expect(updatedTriple?.revision).to.equal(1);
    expect(updatedTriple?.confidence).to.equal(0.95);

    const queryAll = handleKgQuery(context, {
      subject: "incident",
      predicate: "includes",
      limit: 10,
      order: "asc",
    });

    expect(queryAll.triples).to.have.length(2);
    expect(queryAll.next_cursor).to.equal(queryAll.triples[1].ordinal);
    expect(queryAll.triples.map((triple) => triple.source)).to.deep.equal(["library", "playbook"]);

    const confident = handleKgQuery(context, {
      subject: "incident",
      predicate: "includes",
      min_confidence: 0.9,
      limit: 10,
      order: "asc",
    });

    expect(confident.triples).to.have.length(1);
    expect(confident.triples[0].object).to.equal("detect");

    const wildcard = handleKgQuery(context, {
      object: "cont*",
      limit: 10,
      order: "asc",
    });

    expect(wildcard.triples).to.have.length(1);
    expect(wildcard.triples[0].object).to.equal("contain");

    const exported = handleKgExport(context, {});
    expect(exported.total).to.equal(4);
    expect(exported.triples.map((triple) => triple.ordinal)).to.deep.equal([1, 2, 3, 4]);
  });

  it("preserves and merges provenance metadata for triples", () => {
    const graph = new KnowledgeGraph({ now: () => 0 });
    const logger = new StructuredLogger();
    const context: KnowledgeToolContext = { knowledgeGraph: graph, logger };

    const initial = handleKgInsert(context, {
      triples: [
        {
          subject: "incident",
          predicate: "includes",
          object: "detect",
          source: "playbook",
          provenance: [
            { sourceId: "docs/incident.md", type: "file", span: [10, 40], confidence: 0.6 },
            { sourceId: "https://kb.local/incidents", type: "url" },
          ],
        },
      ],
    });

    expect(initial.inserted[0].provenance).to.deep.equal([
      { sourceId: "docs/incident.md", type: "file", span: [10, 40], confidence: 0.6 },
      { sourceId: "https://kb.local/incidents", type: "url" },
    ]);

    const updated = handleKgInsert(context, {
      triples: [
        {
          subject: "incident",
          predicate: "includes",
          object: "detect",
          provenance: [
            { sourceId: "docs/incident.md", type: "file", confidence: 0.9 },
            { sourceId: "runbooks/detect.pdf", type: "file", span: [5, 25], confidence: 0.8 },
          ],
        },
      ],
    });

    expect(updated.updated).to.equal(1);
    expect(updated.inserted[0].provenance).to.deep.equal([
      { sourceId: "docs/incident.md", type: "file", span: [10, 40], confidence: 0.9 },
      { sourceId: "https://kb.local/incidents", type: "url" },
      { sourceId: "runbooks/detect.pdf", type: "file", span: [5, 25], confidence: 0.8 },
    ]);

    const query = handleKgQuery(context, {
      subject: "incident",
      predicate: "includes",
      limit: 1,
      order: "asc",
    });

    expect(query.triples[0].provenance).to.deep.equal([
      { sourceId: "docs/incident.md", type: "file", span: [10, 40], confidence: 0.9 },
      { sourceId: "https://kb.local/incidents", type: "url" },
      { sourceId: "runbooks/detect.pdf", type: "file", span: [5, 25], confidence: 0.8 },
    ]);

    // Mutating the serialised provenance must not leak back into the store.
    query.triples[0].provenance.push({ sourceId: "temp", type: "kg" });
    const fresh = handleKgQuery(context, {
      subject: "incident",
      predicate: "includes",
      limit: 1,
      order: "asc",
    });

    expect(fresh.triples[0].provenance).to.have.length(3);
  });

  it("filters efficiently when both the predicate and subject/object are fixed", () => {
    const graph = new KnowledgeGraph({ now: () => 0 });

    // Populate the graph with multiple predicates to ensure the composite
    // indexes correctly narrow down the search space to the matching triples.
    graph.insert({ subject: "incident", predicate: "includes", object: "detect" });
    graph.insert({ subject: "incident", predicate: "includes", object: "contain" });
    graph.insert({ subject: "incident", predicate: "owner", object: "alice" });
    graph.insert({ subject: "playbook", predicate: "includes", object: "detect" });
    graph.insert({ subject: "playbook", predicate: "includes", object: "recover" });

    const subjectPredicate = graph.query({ subject: "incident", predicate: "includes" });
    expect(subjectPredicate.map((triple) => triple.object)).to.deep.equal(["detect", "contain"]);

    const objectPredicate = graph.query({ object: "detect", predicate: "includes" });
    expect(objectPredicate.map((triple) => triple.subject)).to.deep.equal(["incident", "playbook"]);
  });

  it("uses the primary key when every part of the triple is constrained", () => {
    const graph = new KnowledgeGraph({ now: () => 0 });

    graph.insert({ subject: "incident", predicate: "includes", object: "detect" });
    graph.insert({ subject: "incident", predicate: "includes", object: "contain" });

    const exact = graph.query({
      subject: "incident",
      predicate: "includes",
      object: "detect",
    });

    expect(exact).to.have.length(1);
    expect(exact[0].object).to.equal("detect");
  });

  it("clears and restores triples using exported snapshots", () => {
    const graph = new KnowledgeGraph({ now: () => 0 });

    graph.insert({ subject: "plan", predicate: "includes", object: "ingest" });
    graph.insert({ subject: "plan", predicate: "includes", object: "review" });

    const baseline = graph.exportAll();
    graph.insert({ subject: "plan", predicate: "owner", object: "alice" });
    expect(graph.count()).to.equal(3);

    graph.restore(baseline);
    const restored = graph.query({ subject: "plan", predicate: "includes" });
    expect(restored.map((triple) => triple.object)).to.deep.equal(["ingest", "review"]);
    expect(restored.map((triple) => triple.ordinal)).to.deep.equal([1, 2]);

    graph.clear();
    expect(graph.count()).to.equal(0);
    const fresh = graph.insert({ subject: "plan", predicate: "includes", object: "deploy" });
    expect(fresh.snapshot.ordinal).to.equal(1);
  });
});
