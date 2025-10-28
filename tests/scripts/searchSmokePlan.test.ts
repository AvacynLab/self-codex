import { describe, it } from "mocha";
import { expect } from "chai";

import { assessSmokeRun } from "../../scripts/lib/searchSmokePlan.js";

/** Unit tests for the smoke run assessment helper. */
describe("scripts/lib/searchSmokePlan", () => {
  it("confirms success when every signal is positive", () => {
    const result = assessSmokeRun({ documents: 3, graphTriples: 5, vectorEmbeddings: 4 });
    expect(result.ok).to.equal(true);
    expect(result.missing).to.deep.equal([]);
  });

  it("lists every missing signal when counts are zero", () => {
    const result = assessSmokeRun({ documents: 0, graphTriples: 0, vectorEmbeddings: 0 });
    expect(result.ok).to.equal(false);
    expect(result.missing).to.deep.equal([
      "structured documents",
      "knowledge graph triples",
      "vector embeddings",
    ]);
  });

  it("treats non-numeric values as missing signals", () => {
    const result = assessSmokeRun({ documents: Number.NaN, graphTriples: 2, vectorEmbeddings: -1 });
    expect(result.ok).to.equal(false);
    expect(result.missing).to.deep.equal(["structured documents", "vector embeddings"]);
  });
});
