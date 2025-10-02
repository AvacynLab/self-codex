import { describe, it } from "mocha";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server } from "../src/server.js";

/**
 * Returns deliberately invalid arguments tailored for the provided tool name.
 * The goal is to trigger fast schema validation failures so the call exercises
 * the registration and contract without spawning heavy workflows.
 */
function buildInvalidArgs(toolName: string): Record<string, unknown> {
  if (toolName === "job_view" || toolName === "start" || toolName === "aggregate" || toolName === "status") {
    return { job_id: 123 };
  }
  if (toolName === "conversation_view") {
    return { child_id: 123 };
  }
  if (toolName === "graph_export") {
    return { format: "invalid" };
  }
  if (toolName === "graph_state_save" || toolName === "graph_state_load") {
    return { path: 123 };
  }
  if (toolName === "graph_state_autosave") {
    return { action: "invalid" };
  }
  if (toolName === "graph_config_retention") {
    return { max_transcript_per_child: "ten" };
  }
  if (toolName === "graph_prune") {
    return { action: "transcript", keep_last: "ten" };
  }
  if (toolName === "graph_config_runtime") {
    return { runtime: 123 };
  }
  if (toolName === "graph_state_inactivity") {
    return { limit: "ten" };
  }
  if (toolName === "graph_query") {
    return { kind: "invalid" };
  }
  if (toolName === "graph_generate") {
    return { preset: 123 };
  }
  if (toolName === "graph_state_metrics" || toolName === "graph_state_stats") {
    return { unexpected: "ci" };
  }
  if (toolName.startsWith("graph_")) {
    return { graph: { name: 123 } };
  }
  if (toolName.startsWith("kg_")) {
    return { triples: {} };
  }
  if (toolName.startsWith("values_")) {
    return { nodes: {} };
  }
  if (toolName.startsWith("causal_")) {
    return { events: {} };
  }
  if (toolName.startsWith("plan_")) {
    return { tree: 123 };
  }
  if (toolName.startsWith("bb_")) {
    return { key: 123 };
  }
  if (toolName.startsWith("stig_")) {
    return { node_id: 123 };
  }
  if (toolName.startsWith("cnp_")) {
    return { task: 123 };
  }
  if (toolName.startsWith("consensus")) {
    return { votes: {} };
  }
  if (toolName.startsWith("agent_autoscale")) {
    return { min_children: "zero" };
  }
  if (toolName.startsWith("child_")) {
    return { child_id: 123 };
  }
  if (toolName.startsWith("events_")) {
    return { subscription_id: 123 };
  }
  if (toolName === "graph_forge_analyze") {
    return { source: 123 };
  }
  if (toolName === "kill") {
    return { child_id: 123 };
  }
  return { unexpected: "ci" };
}

/**
 * The CI smoke test instantiates an in-memory MCP session and calls every tool
 * with the intentionally invalid payload produced above. The objective is to
 * ensure each registration responds deterministically (typically by rejecting
 * the malformed payload) without exercising expensive runtime behaviours.
 */
describe("ci smoke all tools", () => {
  it("invokes every registered tool over an in-memory transport", async function () {
    this.timeout(20000);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.close().catch(() => {
      // The shared singleton may not be connected yet. Swallow errors so the
      // smoke test remains idempotent across repeated executions.
    });
    await server.connect(serverTransport);

    const client = new Client({ name: "ci-smoke", version: "1.0.0-ci" });
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools({});
      expect(listed.tools.length).to.be.greaterThan(0, "the server must expose tools");

      for (const tool of listed.tools) {
        const args = buildInvalidArgs(tool.name);
        try {
          const response = await client.callTool({ name: tool.name, arguments: args });
          expect(response, `tool ${tool.name} should respond`).to.be.an("object");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          expect(
            message,
            `tool ${tool.name} should either accept the payload or reject it deterministically`,
          ).to.match(/invalid arguments|MCP error/i);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
