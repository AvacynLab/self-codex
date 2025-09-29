import { describe, it } from "mocha";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server } from "../src/server.js";

/**
 * Validates that the orchestrator honours the JSON-RPC contract expected by
 * Codex CLI clients when operating purely over STDIO transports. The
 * in-memory transport offered by the SDK is used to keep the test completely
 * offline and deterministic.
 */
describe("STDIO JSON-RPC contract", () => {
  it("lists tools and executes graph_simulate over an in-memory transport", async () => {
    // Create the paired transport and a lightweight MCP client to exercise the server.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "stdio-contract-test", version: "1.0.0-test" });

    // Ensure the shared server instance is disconnected before starting a new session.
    await server.close().catch(() => {
      // Swallow errors triggered when the server was never connected in the
      // current process. This keeps the test idempotent across repeated runs.
    });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // Round-trip the listTools request to verify JSON-RPC framing and schema handling.
      const listed = await client.listTools({});
      const graphSimulateTool = listed.tools.find((tool) => tool.name === "graph_simulate");
      expect(graphSimulateTool, "graph_simulate tool must be advertised").to.not.be.undefined;

      // Submit a minimal DAG with deterministic durations to validate the call_tool flow.
      const response = await client.callTool({
        name: "graph_simulate",
        arguments: {
          graph: {
            name: "stdio-demo",
            nodes: [
              { id: "ingest", attributes: { duration: 1 } },
              { id: "process", attributes: { duration: 2 } },
              { id: "publish", attributes: { duration: 1 } },
            ],
            edges: [
              { from: "ingest", to: "process" },
              { from: "process", to: "publish" },
            ],
          },
          parallelism: 2,
        },
      });

      expect(response.isError ?? false).to.equal(false, "graph_simulate should succeed");
      expect(response.structuredContent).to.not.be.undefined;

      const structured = response.structuredContent as {
        metrics: { makespan: number };
        schedule: Array<{ node_id: string }>;
      };
      expect(structured.metrics.makespan).to.equal(4);
      expect(structured.schedule.map((entry) => entry.node_id)).to.deep.equal([
        "ingest",
        "process",
        "publish",
      ]);

      // The textual payload mirrors the structured content for CLI-only consumers.
      expect(Array.isArray(response.content)).to.equal(true);
      const first = Array.isArray(response.content)
        ? (response.content[0] as { type?: string; text?: string } | undefined)
        : undefined;
      expect(first?.type).to.equal("text");
      expect((first?.text ?? "")).to.include('"tool": "graph_simulate"');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
