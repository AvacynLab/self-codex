/**
 * Vérifie que les nouveaux flags de fonctionnalités avancées sont câblés de
 * manière déterministe et supportent les désactivations explicites.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { parseOrchestratorRuntimeOptions } from "../src/serverOptions.js";

describe("options avancées", () => {
  it("maintient les autres modules désactivés lorsque seul un flag est fourni", () => {
    const result = parseOrchestratorRuntimeOptions(["--enable-resources"]);

    expect(result.features).to.include({
      enableResources: true,
    });
    expect(result.features).to.include({
      enableMcpIntrospection: false,
      enableEventsBus: false,
      enableCancellation: false,
      enableTx: false,
      enableBulk: false,
      enableIdempotency: false,
      enableLocks: false,
      enableDiffPatch: false,
      enablePlanLifecycle: false,
      enableChildOpsFine: false,
      enableValuesExplain: false,
      enableAssist: false,
    });
  });

  it("honore les désactivations explicites même après un flag --enable", () => {
    const result = parseOrchestratorRuntimeOptions([
      "--enable-mcp-introspection",
      "--enable-resources",
      "--enable-events-bus",
      "--enable-assist",
      "--disable-resources",
      "--disable-mcp-introspection",
    ]);

    expect(result.features).to.include({
      enableMcpIntrospection: false,
      enableResources: false,
      enableEventsBus: true,
      enableAssist: true,
    });
  });
});
