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
  server,
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

type McpToolResponse = { content?: Array<{ text: string }>; isError?: boolean };

type RegisteredToolMap = Record<string, { callback: (args: unknown) => Promise<McpToolResponse> | McpToolResponse }>;

/**
 * Retrieves the internal tool callback so the test suite can trigger handlers without wiring a client transport.
 */
function getRegisteredToolCallback(name: string) {
  const registry = (server as unknown as { _registeredTools?: RegisteredToolMap })._registeredTools;
  expect(registry, "registered tools map").to.be.an("object");
  const tool = registry?.[name];
  expect(tool, `tool ${name} should be registered`).to.exist;
  return tool!.callback;
}

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
      enableRag: true,
      enableToolRouter: true,
      enableThoughtGraph: true,
    };
    configureRuntimeFeatures(toggles);

    const timings: RuntimeTimingOptions = {
      btTickMs: originalTimings.btTickMs + 5,
      stigHalfLifeMs: originalTimings.stigHalfLifeMs + 10_000,
      supervisorStallTicks: originalTimings.supervisorStallTicks + 1,
      defaultTimeoutMs: originalTimings.defaultTimeoutMs + 5_000,
      autoscaleCooldownMs: Math.max(1_000, originalTimings.autoscaleCooldownMs - 500),
      heartbeatIntervalMs: Math.max(250, originalTimings.heartbeatIntervalMs - 250),
    };
    configureRuntimeTimings(timings);

    const safety: ChildSafetyOptions = {
      maxChildren: originalSafety.maxChildren - 2,
      memoryLimitMb: originalSafety.memoryLimitMb - 64,
      cpuPercent: Math.max(10, originalSafety.cpuPercent - 20),
    };
    configureChildSafetyLimits(safety);

    updateMcpRuntimeSnapshot({
      server: { name: "introspection-test", version: "9.9.9", protocol: "1.1" },
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

    expect(info.server).to.deep.equal({ name: "introspection-test", version: "9.9.9" });
    expect(info.mcp).to.deep.equal({
      protocol: "1.1",
      transports: [
        { kind: "stdio", enabled: false },
        {
          kind: "http",
          enabled: true,
          host: "127.0.0.1",
          port: 8081,
          path: "/mcp-test",
          modes: { json: true, stateless: true },
        },
      ],
    });
    expect(info.features).to.include.members([
      "core",
      "plan-bt",
      "coord-blackboard",
      "memory-knowledge",
      "values-guard",
      "memory-rag",
      "plan-thought-graph",
      "tools-router",
    ]);
    expect(info.features).to.not.include("resources");
    expect(info.flags).to.deep.equal(toggles);
    expect(info.limits).to.deep.equal({
      maxInputBytes: 64 * 1024,
      defaultTimeoutMs: timings.defaultTimeoutMs,
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
    const namespaces = capabilities.namespaces;

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
    expect(namespaces).to.not.include("memory.rag");
    expect(namespaces).to.not.include("plan.thought-graph");
    expect(namespaces).to.not.include("tools.router");

    const toolSummaries = new Map(capabilities.tools.map((entry) => [entry.name, entry.inputSchemaSummary]));
    expect(toolSummaries.get("graph_mutate")).to.be.a("string").and.to.have.length.greaterThan(0);
    expect(toolSummaries.has("resources_list")).to.equal(false);
    expect(toolSummaries.has("plan_run_bt")).to.equal(true);
    expect(toolSummaries.has("plan_run_reactive")).to.equal(false);
    expect(toolSummaries.has("kg_insert")).to.equal(true);
    expect(toolSummaries.get("kg_insert")).to.be.a("string").and.to.have.length.greaterThan(0);
  });

  it("garde l'accès aux outils MCP derrière le flag enableMcpIntrospection", async () => {
    configureRuntimeFeatures({ ...originalFeatures, enableMcpIntrospection: false });

    const mcpInfoCallback = getRegisteredToolCallback("mcp_info");
    const mcpCapabilitiesCallback = getRegisteredToolCallback("mcp_capabilities");

    const disabledInfoResponse = await mcpInfoCallback({});
    expect(disabledInfoResponse).to.have.property("isError", true);
    const disabledInfoPayload = JSON.parse(disabledInfoResponse.content?.[0]?.text ?? "{}");
    expect(disabledInfoPayload).to.include({ error: "MCP_INTROSPECTION_DISABLED", tool: "mcp_info" });

    const disabledCapabilitiesResponse = await mcpCapabilitiesCallback({});
    expect(disabledCapabilitiesResponse).to.have.property("isError", true);
    const disabledCapabilitiesPayload = JSON.parse(disabledCapabilitiesResponse.content?.[0]?.text ?? "{}");
    expect(disabledCapabilitiesPayload).to.include({ error: "MCP_INTROSPECTION_DISABLED", tool: "mcp_capabilities" });

    const toggles: FeatureToggles = { ...originalFeatures, enableMcpIntrospection: true };
    configureRuntimeFeatures(toggles);

    const infoResponse = await mcpInfoCallback({});
    expect(infoResponse).to.not.have.property("isError", true);
    const infoPayload = JSON.parse(infoResponse.content?.[0]?.text ?? "{}");
    expect(infoPayload).to.have.nested.property("info.flags.enableMcpIntrospection", true);
    expect(infoPayload).to.have.nested.property("info.features").that.includes("mcp-introspection");

    const capabilitiesResponse = await mcpCapabilitiesCallback({});
    expect(capabilitiesResponse).to.not.have.property("isError", true);
    const capabilitiesPayload = JSON.parse(capabilitiesResponse.content?.[0]?.text ?? "{}");
    expect(capabilitiesPayload)
      .to.have.nested.property("capabilities.namespaces")
      .that.is.an("array")
      .and.includes("core.jobs");
  });

  it("protège les outils de gestion fine des enfants derrière le flag dédié", async () => {
    configureRuntimeFeatures({ ...originalFeatures, enableChildOpsFine: false });

    const childSpawnCallback = getRegisteredToolCallback("child_spawn_codex");
    const disabledResponse = await childSpawnCallback({});
    expect(disabledResponse).to.have.property("isError", true);
    const disabledPayload = JSON.parse(disabledResponse.content?.[0]?.text ?? "{}");
    expect(disabledPayload).to.include({
      error: "CHILD_OPS_FINE_DISABLED",
      tool: "child_spawn_codex",
    });

    const disabledCapabilities = getMcpCapabilities();
    const disabledToolNames = disabledCapabilities.tools.map((entry) => entry.name);
    expect(disabledToolNames).to.not.include("child_spawn_codex");
    expect(disabledToolNames).to.not.include("child_status");

    const toggles: FeatureToggles = { ...originalFeatures, enableChildOpsFine: true };
    configureRuntimeFeatures(toggles);

    const info = getMcpInfo();
    expect(info.flags.enableChildOpsFine).to.equal(true);
    expect(info.features).to.include("child-ops-fine");

    const capabilities = getMcpCapabilities();
    const enabledToolNames = capabilities.tools.map((entry) => entry.name);
    expect(enabledToolNames).to.include.members([
      "child_spawn_codex",
      "child_attach",
      "child_set_role",
      "child_set_limits",
      "child_status",
    ]);
  });

  it("désactive la façade intent_route lorsque le router contextuel est coupé", async () => {
    configureRuntimeFeatures({ ...originalFeatures, enableToolRouter: false });

    const intentRouteCallback = getRegisteredToolCallback("intent_route");
    const disabledResponse = await intentRouteCallback({
      natural_language_goal: "ouvrir un fichier",
    });
    expect(disabledResponse).to.have.property("isError", true);
    const disabledPayload = JSON.parse(disabledResponse.content?.[0]?.text ?? "{}");
    expect(disabledPayload).to.include({ error: "TOOL_ROUTER_DISABLED", tool: "intent_route" });

    const disabledCapabilities = getMcpCapabilities();
    const disabledTools = disabledCapabilities.tools.map((entry) => entry.name);
    expect(disabledTools).to.not.include("intent_route");

    const toggles: FeatureToggles = { ...originalFeatures, enableToolRouter: true };
    configureRuntimeFeatures(toggles);

    const enabledResponse = await intentRouteCallback({
      natural_language_goal: "ouvrir un fichier",
    });
    expect(enabledResponse).to.not.have.property("isError", true);

    const enabledCapabilities = getMcpCapabilities();
    const enabledTools = enabledCapabilities.tools.map((entry) => entry.name);
    expect(enabledTools).to.include("intent_route");
  });
});
