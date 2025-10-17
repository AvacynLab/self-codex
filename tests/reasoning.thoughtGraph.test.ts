import { describe, it } from "mocha";
import { expect } from "chai";

import { ThoughtGraph } from "../src/reasoning/thoughtGraph.js";

describe("ThoughtGraph", () => {
  it("normalises provenance and returns defensive copies", () => {
    const graph = new ThoughtGraph({ maxNodes: 4 });

    const inserted = graph.upsertNode({
      id: "root",
      prompt: "initial",
      parents: [" ", "seed"],
      tool: "  search  ",
      score: 5,
      provenance: [
        { sourceId: "doc", type: "file", span: [5, 1], confidence: 2 },
        { sourceId: "doc", type: "file" },
      ],
      startedAt: 10,
    });

    expect(inserted.parents).to.deep.equal(["seed"]);
    expect(inserted.tool).to.equal("search");
    expect(inserted.score).to.equal(1);
    expect(inserted.provenance).to.deep.equal([
      { sourceId: "doc", type: "file", span: [1, 5], confidence: 1 },
      { sourceId: "doc", type: "file" },
    ]);

    const updated = graph.upsertNode({
      id: "root",
      prompt: "initial",
      provenance: [{ sourceId: "url", type: "url" }],
      startedAt: 10,
      completedAt: 20,
      status: "completed",
    });

    expect(updated.provenance).to.deep.equal([
      { sourceId: "doc", type: "file", span: [1, 5], confidence: 1 },
      { sourceId: "doc", type: "file" },
      { sourceId: "url", type: "url" },
    ]);
    expect(updated.completedAt).to.equal(20);
    expect(updated.status).to.equal("completed");

    const snapshot = graph.getNode("root");
    expect(snapshot).to.not.equal(null);
    snapshot!.provenance.push({ sourceId: "mut", type: "kg" });

    const fresh = graph.getNode("root");
    expect(fresh?.provenance).to.have.length(3);

    const pruned = graph.upsertNode({
      id: "root",
      prompt: "initial",
      status: "pruned",
      startedAt: 10,
      completedAt: 30,
    });
    expect(pruned.status).to.equal("pruned");
  });

  it("prunes the oldest nodes once the retention limit is exceeded", () => {
    const graph = new ThoughtGraph({ maxNodes: 2 });

    graph.upsertNode({ id: "alpha", prompt: "start", startedAt: 1 });
    graph.upsertNode({ id: "beta", prompt: "continue", startedAt: 2 });
    const latest = graph.upsertNode({ id: "gamma", prompt: "finish", startedAt: 3 });

    expect(latest.id).to.equal("gamma");
    expect(graph.getNode("alpha")).to.equal(null);

    const exported = graph.exportAll();
    expect(exported.map((node) => node.id)).to.deep.equal(["beta", "gamma"]);

    // Mutating the exported snapshots must not impact the graph internals.
    exported[0]!.parents.push("mutated");
    expect(graph.getNode("beta")?.parents).to.deep.equal([]);
  });

  it("merges updates while respecting the latest node metadata", () => {
    const graph = new ThoughtGraph();

    graph.upsertNode({
      id: "branch",
      prompt: "first",
      parents: ["root"],
      tool: "search",
      result: null,
      score: 0.1,
      startedAt: 10,
    });

    const updated = graph.upsertNode({
      id: "branch",
      parents: ["root", " sibling "],
      prompt: "first",
      tool: "search  ",
      result: "done",
      score: 0.75,
      startedAt: 10,
      completedAt: 20,
      status: "completed",
    });

    expect(updated.parents).to.deep.equal(["root", "sibling"]);
    expect(updated.tool).to.equal("search");
    expect(updated.result).to.equal("done");
    expect(updated.score).to.equal(0.75);
    expect(updated.completedAt).to.equal(20);
    expect(updated.status).to.equal("completed");
  });
});
