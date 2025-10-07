/**
 * Vérifie que les nouveaux flags de fonctionnalités avancées sont câblés de
 * manière déterministe et supportent les désactivations explicites.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { getMcpInfo } from "../src/mcp/info.js";
import { configureRuntimeFeatures, getRuntimeFeatures } from "../src/server.js";
import { parseOrchestratorRuntimeOptions } from "../src/serverOptions.js";
import type { FeatureToggles } from "../src/serverOptions.js";

const originalFeatures = getRuntimeFeatures();

function applyFeatureOverride(overrides: Partial<FeatureToggles>): void {
  configureRuntimeFeatures({ ...originalFeatures, ...overrides });
}

beforeEach(() => {
  configureRuntimeFeatures(originalFeatures);
});

afterEach(() => {
  configureRuntimeFeatures(originalFeatures);
});

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

describe("options runtime wiring", () => {
  it("enables resources exposure when the flag is provided", () => {
    const parsed = parseOrchestratorRuntimeOptions(["--enable-resources"]);
    applyFeatureOverride({ enableResources: parsed.features.enableResources });

    const info = getMcpInfo();
    expect(info.flags.enableResources).to.equal(true);
    expect(info.features).to.include("resources");
  });

  it("désactive l'exposition des ressources lorsque le flag est désactivé", () => {
    applyFeatureOverride({ enableResources: true });
    const parsed = parseOrchestratorRuntimeOptions(["--disable-resources"]);
    applyFeatureOverride({ enableResources: parsed.features.enableResources });

    const info = getMcpInfo();
    expect(info.flags.enableResources).to.equal(false);
    expect(info.features).to.not.include("resources");
  });
});
