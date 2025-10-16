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
  });
});
