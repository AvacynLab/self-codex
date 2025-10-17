/**
 * Vérifie que les nouveaux flags de fonctionnalités avancées sont câblés de
 * manière déterministe et supportent les désactivations explicites.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { getMcpInfo } from "../src/mcp/info.js";
import { configureRuntimeFeatures, getRuntimeFeatures } from "../src/server.js";
import {
  FEATURE_FLAG_DEFAULTS,
  RUNTIME_TIMING_DEFAULTS,
  parseOrchestratorRuntimeOptions,
} from "../src/serverOptions.js";
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
    const expected = { ...FEATURE_FLAG_DEFAULTS, enableResources: true };
    expect(result.features).to.deep.equal(expected);
  });

  it("honore les désactivations explicites même après un flag --enable", () => {
    const result = parseOrchestratorRuntimeOptions([
      "--enable-mcp-introspection",
      "--enable-resources",
      "--enable-events-bus",
      "--enable-assist",
      "--enable-rag",
      "--disable-resources",
      "--disable-mcp-introspection",
      "--disable-rag",
    ]);

    expect(result.features).to.include({
      enableMcpIntrospection: false,
      enableResources: false,
      enableEventsBus: true,
      enableAssist: true,
      enableRag: false,
    });
  });

  it("expose les nouveaux toggles de RAG, ThoughtGraph et ToolRouter", () => {
    const result = parseOrchestratorRuntimeOptions([
      "--enable-rag",
      "--enable-thought-graph",
      "--enable-tool-router",
      "--disable-tool-router",
    ]);

    expect(result.features).to.include({
      enableRag: true,
      enableThoughtGraph: true,
      enableToolRouter: false,
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

describe("options defaults snapshot", () => {
  it("publishes the full flag catalogue with false defaults", () => {
    const parsed = parseOrchestratorRuntimeOptions([]);

    const expectedFlags = Object.keys(FEATURE_FLAG_DEFAULTS);
    expect(Object.keys(parsed.features)).to.have.members(expectedFlags);

    for (const [flag, value] of Object.entries(parsed.features)) {
      expect(value, `flag ${flag} should remain disabled by default`).to.equal(false);
    }
  });

  it("accepts CLI overrides without mutating shared defaults", () => {
    const parsed = parseOrchestratorRuntimeOptions([
      "--enable-resources",
      "--enable-events-bus",
      "--enable-cancellation",
      "--enable-diff-patch",
      "--disable-diff-patch",
      "--enable-tx",
      "--enable-plan-lifecycle",
      "--disable-plan-lifecycle",
      "--enable-values-explain",
      "--enable-assist",
      "--bt-tick-ms=75",
      "--default-timeout-ms",
      "15000",
      "--autoscale-cooldown-ms",
      "5000",
    ]);

    expect(parsed.features.enableResources).to.equal(true);
    expect(parsed.features.enableEventsBus).to.equal(true);
    expect(parsed.features.enableCancellation).to.equal(true);
    expect(parsed.features.enableDiffPatch).to.equal(false);
    expect(parsed.features.enableTx).to.equal(true);
    expect(parsed.features.enablePlanLifecycle).to.equal(false);
    expect(parsed.features.enableValuesExplain).to.equal(true);
    expect(parsed.features.enableAssist).to.equal(true);

    expect(parsed.timings.btTickMs).to.equal(75);
    expect(parsed.timings.defaultTimeoutMs).to.equal(15_000);
    expect(parsed.timings.autoscaleCooldownMs).to.equal(5_000);
    expect(parsed.timings.stigHalfLifeMs).to.equal(
      RUNTIME_TIMING_DEFAULTS.stigHalfLifeMs,
    );

    const fresh = parseOrchestratorRuntimeOptions([]);
    for (const value of Object.values(fresh.features)) {
      expect(value).to.equal(false);
    }
    expect(fresh.timings).to.deep.equal(RUNTIME_TIMING_DEFAULTS);
  });
});
