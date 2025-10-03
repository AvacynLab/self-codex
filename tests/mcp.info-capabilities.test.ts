/**
 * Tests ensuring the MCP introspection helpers surface consistent metadata with
 * the server runtime configuration. By exercising both info and capabilities we
 * guarantee future agents receive coherent handshake data before triggering
 * long running operations.
 */
import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";

import {
  configureChildSafetyLimits,
  configureRuntimeFeatures,
  configureRuntimeTimings,
  getChildSafetyLimits,
  getRuntimeFeatures,
  getRuntimeTimings,
} from "../src/server.js";
import {
  getMcpCapabilities,
  getMcpInfo,
  getMcpRuntimeSnapshot,
  setMcpRuntimeSnapshot,
  updateMcpRuntimeSnapshot,
} from "../src/mcp/info.js";
import type {
  ChildSafetyOptions,
  FeatureToggles,
  RuntimeTimingOptions,
} from "../src/serverOptions.js";

describe("mcp introspection helpers", () => {
  let originalFeatures: FeatureToggles;
  let originalTimings: RuntimeTimingOptions;
  let originalSafety: ChildSafetyOptions;
  let originalSnapshot = getMcpRuntimeSnapshot();

  beforeEach(() => {
    originalFeatures = getRuntimeFeatures();
    originalTimings = getRuntimeTimings();
    originalSafety = getChildSafetyLimits();
    originalSnapshot = getMcpRuntimeSnapshot();
  });

  afterEach(() => {
    configureRuntimeFeatures(originalFeatures);
    configureRuntimeTimings(originalTimings);
    configureChildSafetyLimits(originalSafety);
    setMcpRuntimeSnapshot(originalSnapshot);
  });

  it("expose des transports et limites cohérents avec la configuration runtime", () => {
    const toggles: FeatureToggles = {
      ...originalFeatures,
      enableBT: true,
      enableBlackboard: true,
      enableKnowledge: true,
      enableValueGuard: true,
    };
    configureRuntimeFeatures(toggles);

    const timings: RuntimeTimingOptions = {
      btTickMs: originalTimings.btTickMs + 5,
      stigHalfLifeMs: originalTimings.stigHalfLifeMs + 10_000,
      supervisorStallTicks: originalTimings.supervisorStallTicks + 1,
    };
    configureRuntimeTimings(timings);

    const safety: ChildSafetyOptions = {
      maxChildren: originalSafety.maxChildren - 2,
      memoryLimitMb: originalSafety.memoryLimitMb - 64,
      cpuPercent: Math.max(10, originalSafety.cpuPercent - 20),
    };
    configureChildSafetyLimits(safety);

    updateMcpRuntimeSnapshot({
      server: { name: "introspection-test", version: "9.9.9", mcpVersion: "1.1" },
      transports: {
        stdio: { enabled: false },
        http: {
          enabled: true,
          host: "127.0.0.1",
          port: 8081,
          path: "/mcp-test",
          enableJson: true,
          stateless: true,
        },
      },
      limits: {
        maxInputBytes: 64 * 1024,
        defaultTimeoutMs: 12_000,
        maxEventHistory: 42,
      },
    });

    const info = getMcpInfo();

    expect(info.server).to.deep.equal({ name: "introspection-test", version: "9.9.9", mcpVersion: "1.1" });
    expect(info.transports.stdio.enabled).to.equal(false);
    expect(info.transports.http).to.deep.equal({
      enabled: true,
      host: "127.0.0.1",
      port: 8081,
      path: "/mcp-test",
      enableJson: true,
      stateless: true,
    });
    expect(info.features).to.deep.equal(toggles);
    expect(info.timings).to.deep.equal(timings);
    expect(info.safety).to.deep.equal(safety);
    expect(info.limits).to.deep.equal({
      maxInputBytes: 64 * 1024,
      defaultTimeoutMs: 12_000,
      maxEventHistory: 42,
    });
  });

  it("filtre les namespaces exposés selon les toggles actifs", () => {
    const toggles: FeatureToggles = {
      ...originalFeatures,
      enableBT: true,
      enableReactiveScheduler: false,
      enableBlackboard: true,
      enableStigmergy: false,
      enableCNP: true,
      enableConsensus: false,
      enableAutoscaler: true,
      enableSupervisor: false,
      enableKnowledge: true,
      enableCausalMemory: false,
      enableValueGuard: true,
    };
    configureRuntimeFeatures(toggles);
    updateMcpRuntimeSnapshot({ limits: { maxEventHistory: 128 } });

    const capabilities = getMcpCapabilities();
    const namespaces = capabilities.namespaces.map((entry) => entry.name);

    expect(namespaces).to.include("core.jobs");
    expect(namespaces).to.include("graph.core");
    expect(namespaces).to.include("plan.bt");
    expect(namespaces).to.include("coord.blackboard");
    expect(namespaces).to.include("coord.contract-net");
    expect(namespaces).to.include("agents.autoscaler");
    expect(namespaces).to.include("memory.knowledge");
    expect(namespaces).to.include("values.guard");

    expect(namespaces).to.not.include("plan.reactive");
    expect(namespaces).to.not.include("coord.stigmergy");
    expect(namespaces).to.not.include("coord.consensus");
    expect(namespaces).to.not.include("agents.supervisor");
    expect(namespaces).to.not.include("memory.causal");

    for (const entry of capabilities.namespaces) {
      expect(entry.description).to.be.a("string").and.to.have.length.greaterThan(0);
      expect(capabilities.schemas[entry.name]).to.deep.equal({
        namespace: entry.name,
        summary: entry.description,
      });
    }

    expect(capabilities.limits).to.deep.equal({ maxEventHistory: 128 });
  });
});
