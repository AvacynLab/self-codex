import { describe, it } from "mocha";
import { expect } from "chai";

import { levenshteinDistance } from "../../src/memory/levenshtein.js";

/**
 * Unit tests covering the in-repo Levenshtein implementation used by the hybrid
 * retriever when lexical scoring RAG candidates.
 */
describe("levenshteinDistance", () => {
  it("returns zero for identical strings", () => {
    expect(levenshteinDistance("rag", "rag")).to.equal(0);
  });

  it("handles insertions and deletions symmetrically", () => {
    expect(levenshteinDistance("graph", "graphs")).to.equal(1);
    expect(levenshteinDistance("graphs", "graph")).to.equal(1);
  });

  it("counts substitutions when characters differ", () => {
    expect(levenshteinDistance("retriever", "receiver")).to.equal(3);
  });

  it("supports completely different strings", () => {
    expect(levenshteinDistance("", "knowledge")).to.equal(9);
    expect(levenshteinDistance("vector", "rag")).to.equal(6);
  });
});
