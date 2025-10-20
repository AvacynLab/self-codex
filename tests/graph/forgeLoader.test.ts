import { beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import {
  loadGraphForge,
  preloadGraphForge,
  getGraphForgeLoadAttemptCount,
  __resetGraphForgeLoaderForTests,
} from "../../src/graph/forgeLoader.js";

describe("graph/forgeLoader", () => {
  beforeEach(() => {
    __resetGraphForgeLoaderForTests();
  });

  it("caches the dynamic import promise", async () => {
    const first = loadGraphForge();
    const second = loadGraphForge();
    await Promise.all([first, second]);
    expect(getGraphForgeLoadAttemptCount()).to.equal(1);
  });

  it("preloads without duplicating imports", async () => {
    await preloadGraphForge();
    expect(getGraphForgeLoadAttemptCount()).to.equal(1);
    const module = await loadGraphForge();
    expect(getGraphForgeLoadAttemptCount()).to.equal(1);
    expect(module).to.have.property("GraphModel");
    expect(module).to.have.property("constrainedShortestPath").that.is.a("function");
  });
});

