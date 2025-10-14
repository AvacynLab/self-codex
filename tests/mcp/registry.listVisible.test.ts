import { describe, it } from "mocha";
import { expect } from "chai";

import {
  listVisible,
  listVisibleFromEnv,
  resolveToolPackFromEnv,
  resolveToolVisibilityModeFromEnv,
  type ToolManifest,
} from "../../src/mcp/registry.js";

/** Builds a manifest fixture with reasonable defaults for the filtering tests. */
function createManifest(name: string, overrides: Partial<ToolManifest> = {}): ToolManifest {
  const base: ToolManifest = {
    name,
    title: `${name} title`,
    kind: "dynamic",
    version: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    category: "runtime",
    tags: [],
    hidden: false,
    steps: undefined,
    inputs: undefined,
    source: "runtime",
  };
  const mergedTags = Array.isArray(overrides.tags) ? [...overrides.tags] : [...base.tags];
  return { ...base, ...overrides, tags: mergedTags };
}

describe("mcp/registry listVisible", () => {
  it("respects the visibility mode when filtering manifests", () => {
    const manifests: ToolManifest[] = [
      createManifest("facade", { tags: ["facade"] }),
      createManifest("hidden-primitive", { tags: ["internal"], hidden: true }),
      createManifest("hidden-facade", { tags: ["facade"], hidden: true }),
    ];

    const pro = listVisible(manifests, "pro", "all");
    expect(pro.map((manifest) => manifest.name)).to.deep.equal([
      "facade",
      "hidden-primitive",
      "hidden-facade",
    ]);

    const basic = listVisible(manifests, "basic", "all");
    expect(basic.map((manifest) => manifest.name)).to.deep.equal(["facade", "hidden-facade"]);
  });

  it("filters manifests according to the requested pack", () => {
    const manifests: ToolManifest[] = [
      createManifest("core-facade", { tags: ["facade"] }),
      createManifest("authoring-tool", { tags: ["authoring"] }),
      createManifest("ops-tool", { tags: ["ops"] }),
      createManifest("multi", { tags: ["facade", "authoring", "ops"] }),
    ];

    expect(listVisible(manifests, "pro", "basic").map((tool) => tool.name)).to.deep.equal([
      "core-facade",
      "multi",
    ]);
    expect(listVisible(manifests, "pro", "authoring").map((tool) => tool.name)).to.deep.equal([
      "core-facade",
      "authoring-tool",
      "multi",
    ]);
    expect(listVisible(manifests, "pro", "ops").map((tool) => tool.name)).to.deep.equal([
      "core-facade",
      "ops-tool",
      "multi",
    ]);
    expect(listVisible(manifests, "pro", "all").map((tool) => tool.name)).to.deep.equal([
      "core-facade",
      "authoring-tool",
      "ops-tool",
      "multi",
    ]);
  });

  it("derives visibility parameters from environment variables", () => {
    const env = { MCP_TOOLS_MODE: "basic", MCP_TOOL_PACK: "authoring" } as NodeJS.ProcessEnv;
    expect(resolveToolVisibilityModeFromEnv(env)).to.equal("basic");
    expect(resolveToolPackFromEnv(env)).to.equal("authoring");

    const manifests: ToolManifest[] = [
      createManifest("facade", { tags: ["facade"] }),
      createManifest("authoring", { tags: ["authoring"] }),
      createManifest("hidden", { tags: ["internal"], hidden: true }),
    ];
    const filtered = listVisibleFromEnv(manifests, env);
    expect(filtered.map((manifest) => manifest.name)).to.deep.equal(["facade", "authoring"]);
  });
});
