/**
 * Ensures the dedicated `health_check` JSON-RPC helper exposes a predictable
 * payload so automated smoke tests can detect regressions before they hit the
 * heavier orchestration endpoints.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { routeJsonRpcRequest } from "../src/server.js";

interface HealthCheckProbeSnapshot {
  name: string;
  status: string;
  detail?: unknown;
}

interface HealthCheckSnapshot {
  status: string;
  observed_at: string;
  uptime_ms: number;
  server: { name: string; version: string; protocol: string };
  probes: HealthCheckProbeSnapshot[];
}

describe("health_check RPC", () => {
  it("reports an ok status alongside the orchestrator metadata", async () => {
    const snapshot = (await routeJsonRpcRequest("health_check", {})) as HealthCheckSnapshot;

    expect(snapshot.status, "overall status").to.equal("ok");
    expect(snapshot.server, "server metadata").to.deep.equal({
      name: "mcp-self-fork-orchestrator",
      version: "1.3.0",
      protocol: "1.0",
    });
    expect(snapshot.observed_at, "timestamp format").to.match(/^\d{4}-\d{2}-\d{2}T/);
    expect(snapshot.uptime_ms, "uptime").to.be.a("number").and.to.be.at.least(0);

    // Collect the probe names to guarantee all critical subsystems are covered.
    const probeNames = snapshot.probes.map((probe) => probe.name);
    expect(probeNames).to.include.members(["mcp_info", "event_bus", "log_journal"]);
    snapshot.probes.forEach((probe) => {
      expect(probe.status, `${probe.name} status`).to.equal("ok");
    });
  });

  it("exposes probe details when include_details is requested", async () => {
    const response = (await routeJsonRpcRequest("tools/call", {
      name: "health_check",
      arguments: { include_details: true },
    })) as {
      structuredContent?: HealthCheckSnapshot;
      content?: Array<{ text?: string }>;
    };

    expect(response.structuredContent, "structured payload").to.exist;
    const snapshot = response.structuredContent!;

    const eventProbe = snapshot.probes.find((probe) => probe.name === "event_bus");
    expect(eventProbe?.detail, "event bus details").to.be.an("object");

    const logProbe = snapshot.probes.find((probe) => probe.name === "log_journal");
    expect(logProbe?.detail, "log journal details").to.be.an("object");

    expect(response.content?.[0]?.text, "text payload").to.be.a("string");
    const parsed = JSON.parse(response.content?.[0]?.text ?? "{}");
    expect(parsed).to.have.property("result");
  });
});

