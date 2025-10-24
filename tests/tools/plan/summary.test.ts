import { describe, it } from "mocha";
import { expect } from "chai";

import { summariseForCausalMemory } from "../../../src/tools/plan/summary.js";

describe("plan tools / summary", () => {
  it("truncates long strings with an ellipsis", () => {
    const long = "x".repeat(250);
    const summary = summariseForCausalMemory(long);
    expect(summary).to.equal(`${"x".repeat(200)}…`);
  });

  it("summarises arrays while preserving a window of entries", () => {
    const values = [1, 2, 3, 4, 5, 6, 7];
    const summary = summariseForCausalMemory(values);
    expect(summary).to.deep.equal([1, 2, 3, 4, 5, "…2 more"]);
  });

  it("collapses deeply nested arrays into a concise label", () => {
    const nested = [[[{ value: 1 }]]];
    const summary = summariseForCausalMemory(nested);
    expect(summary).to.equal("array(1)");
  });

  it("summarises objects and annotates truncation metadata", () => {
    const input = {
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: 7,
    };
    const summary = summariseForCausalMemory(input);
    expect(summary).to.deep.equal({
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      __truncated__: "1 more",
    });
  });

  it("returns null for undefined values to match historical behaviour", () => {
    expect(summariseForCausalMemory(undefined)).to.equal(null);
  });
});

