/**
 * Ces tests vérifient que les drapeaux de configuration exposés par
 * `serverOptions` peuvent être appliqués dynamiquement au serveur et récupérés
 * par les helpers d'export. Cela garantit qu'un opérateur peut activer les
 * modules optionnels puis ajuster les délais sans redémarrer.
 */
import { describe, it, afterEach, beforeEach } from "mocha";
import { expect } from "chai";

import {
  configureRuntimeFeatures,
  configureRuntimeTimings,
  getRuntimeFeatures,
  getRuntimeTimings,
} from "../src/server.js";
import type { FeatureToggles, RuntimeTimingOptions } from "../src/serverOptions.js";

describe("runtime feature flags wiring", () => {
  let originalFeatures: FeatureToggles;
  let originalTimings: RuntimeTimingOptions;

  beforeEach(() => {
    originalFeatures = getRuntimeFeatures();
    originalTimings = getRuntimeTimings();
  });

  afterEach(() => {
    configureRuntimeFeatures(originalFeatures);
    configureRuntimeTimings(originalTimings);
  });

  it("applique les toggles fournis", () => {
    const toggles: FeatureToggles = {
      ...originalFeatures,
      enableBT: !originalFeatures.enableBT,
      enableReactiveScheduler: !originalFeatures.enableReactiveScheduler,
      enableBlackboard: true,
      enableStigmergy: true,
      enableCNP: true,
      enableConsensus: true,
      enableAutoscaler: true,
      enableSupervisor: true,
      enableKnowledge: true,
      enableCausalMemory: true,
      enableValueGuard: true,
    };

    configureRuntimeFeatures(toggles);

    expect(getRuntimeFeatures()).to.deep.equal(toggles);
  });

  it("met à jour les délais runtime", () => {
    const timings: RuntimeTimingOptions = {
      btTickMs: originalTimings.btTickMs + 10,
      stigHalfLifeMs: originalTimings.stigHalfLifeMs + 5_000,
      supervisorStallTicks: originalTimings.supervisorStallTicks + 2,
    };

    configureRuntimeTimings(timings);

    expect(getRuntimeTimings()).to.deep.equal(timings);
  });
});
