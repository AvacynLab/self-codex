import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { evaluateToolDeprecation } from "../../src/mcp/deprecations.js";
import { ToolRegistry, ToolDeprecatedError } from "../../src/mcp/registry.js";
import type { StructuredLogger } from "../../src/logger.js";

function createLoggerStub() {
  const warnSpy = sinon.spy<(event: string, payload: unknown) => void>();
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: warnSpy,
    error: () => undefined,
  } as unknown as StructuredLogger;
  return { logger, warnSpy };
}

describe("tool deprecations", () => {
  afterEach(async () => {
    sinon.restore();
  });

  it("computes enforcement phases based on age", () => {
    const meta = { since: "2025-10-01T00:00:00Z", replace_with: "graph_apply_change_set" } as const;
    const early = evaluateToolDeprecation("graph_patch", meta, new Date("2025-10-15T00:00:00Z"));
    expect(early.forceHidden, "pre J+30 should remain visible").to.equal(false);
    expect(early.forceRemoval, "pre J+60 should remain callable").to.equal(false);

    const mid = evaluateToolDeprecation("graph_patch", meta, new Date("2025-11-05T00:00:00Z"));
    expect(mid.forceHidden, "post J+30 should hide from discovery").to.equal(true);
    expect(mid.forceRemoval, "post J+30 should still allow fallback calls").to.equal(false);

    const late = evaluateToolDeprecation("graph_patch", meta, new Date("2025-12-10T00:00:00Z"));
    expect(late.forceHidden, "post J+60 stays hidden").to.equal(true);
    expect(late.forceRemoval, "post J+60 should reject invocations").to.equal(true);
  });

  it("warns on legacy invocations and blocks once retired", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "registry-deprecation-"));
    const { logger, warnSpy } = createLoggerStub();
    const server = new McpServer({ name: "test-registry", version: "1.0.0" });
    const registry = await ToolRegistry.create({
      server,
      logger,
      runsRoot: tempRoot,
      clock: () => new Date("2025-11-05T12:00:00Z"),
      invokeTool: async () => ({ content: [] }),
    });

    await registry.register(
      {
        name: "graph_patch",
        title: "Graph patch",
        kind: "dynamic",
      },
      async () => ({ content: [], structuredContent: { ok: true }, isError: false }),
    );

    const manifests = registry.listVisible("pro", "all");
    expect(manifests.some((manifest) => manifest.name === "graph_patch"), "legacy tool should be hidden").to.equal(false);

    const result = await registry.call("graph_patch", {}, {} as never);
    expect(result.isError, "legacy replay should still succeed before removal").to.equal(false);
    expect(
      warnSpy.calledWithMatch("tool_deprecated_invoked", sinon.match.object),
      "deprecated usage should emit a warning",
    ).to.equal(true);

    registry.close();
    sinon.restore();
    const { logger: removalLogger, warnSpy: removalWarn } = createLoggerStub();
    const removalRegistry = await ToolRegistry.create({
      server: new McpServer({ name: "test-registry", version: "1.0.0" }),
      logger: removalLogger,
      runsRoot: tempRoot,
      clock: () => new Date("2025-12-10T00:00:00Z"),
      invokeTool: async () => ({ content: [] }),
    });

    await removalRegistry.register(
      {
        name: "graph_patch",
        title: "Graph patch",
        kind: "dynamic",
      },
      async () => ({ content: [], structuredContent: { ok: true }, isError: false }),
    );

    try {
      await removalRegistry.call("graph_patch", {}, {} as never);
      expect.fail("deprecated tool should not be callable after J+60");
    } catch (error) {
      expect(error).to.be.instanceOf(ToolDeprecatedError);
    }
    expect(
      removalWarn.calledWithMatch("tool_deprecated_blocked", sinon.match.object),
      "blocking should emit an explicit warning",
    ).to.equal(true);

    removalRegistry.close();
    await rm(tempRoot, { recursive: true, force: true });
  });
});
