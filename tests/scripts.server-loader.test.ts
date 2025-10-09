import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";

import {
  loadServerModule,
  getLoadedServerModuleInfo,
  resetServerModuleCacheForTests,
} from "../scripts/lib/validation/server-loader.mjs";

describe("server module loader", () => {
  beforeEach(() => {
    delete process.env.CODEX_VALIDATION_FORCE_DIST;
    delete process.env.CODEX_VALIDATION_FORCE_SRC;
    resetServerModuleCacheForTests();
  });

  afterEach(() => {
    delete process.env.CODEX_VALIDATION_FORCE_DIST;
    delete process.env.CODEX_VALIDATION_FORCE_SRC;
    resetServerModuleCacheForTests();
  });

  it("exposes the orchestrator module with the expected exports", async () => {
    const module = await loadServerModule();
    expect(module).to.have.property("server");
    expect(module).to.have.property("configureRuntimeFeatures");
    expect(module).to.have.property("resources");

    const info = getLoadedServerModuleInfo();
    expect(info).to.not.equal(null);
    expect(info?.source).to.be.oneOf(["src", "dist"]);
  });

  it("falls back to the compiled output when forced", async () => {
    process.env.CODEX_VALIDATION_FORCE_DIST = "1";
    const module = await loadServerModule();
    expect(module).to.have.property("server");

    const info = getLoadedServerModuleInfo();
    expect(info?.source).to.equal("dist");
  });
});
