import { afterEach, describe, it } from "mocha";
import { expect } from "chai";

import { resolveToolRouterTopKLimit } from "../../src/tools/toolRouter.js";

describe("tool router env overrides", () => {
  const originalTopK = process.env.TOOLROUTER_TOPK;

  afterEach(() => {
    if (originalTopK === undefined) {
      delete process.env.TOOLROUTER_TOPK;
    } else {
      process.env.TOOLROUTER_TOPK = originalTopK;
    }
  });

  it("falls back to the default when the variable is absent", () => {
    delete process.env.TOOLROUTER_TOPK;
    expect(resolveToolRouterTopKLimit()).to.equal(5);
  });

  it("accepts positive overrides and clamps to the documented maximum", () => {
    process.env.TOOLROUTER_TOPK = "12";
    expect(resolveToolRouterTopKLimit()).to.equal(10);
  });

  it("ignores invalid overrides and preserves the default", () => {
    process.env.TOOLROUTER_TOPK = "zero";
    expect(resolveToolRouterTopKLimit()).to.equal(5);

    process.env.TOOLROUTER_TOPK = "0";
    expect(resolveToolRouterTopKLimit()).to.equal(5);
  });
});
