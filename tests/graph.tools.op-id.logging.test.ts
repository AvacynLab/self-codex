import { beforeEach, afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server, logJournal } from "../src/server.js";
import type { GraphDescriptorPayload } from "../src/tools/graph/snapshot.js";

/**
 * Integration checks ensuring the graph tool MCP handlers log correlation metadata (`op_id`) that matches the
 * structured results they return. The assertions rely on the shared `logJournal` to observe the JSONL entries emitted by
 * the orchestrator during a call_tool round-trip.
 */
describe("graph tools – op_id logging", () => {
  const GRAPH: GraphDescriptorPayload = {
    name: "opid-demo",
    nodes: [
      { id: "start", attributes: { duration: 1, cost: 2, risk: 0.4 } },
      { id: "mid", attributes: { duration: 2, cost: 3, risk: 0.6 } },
      { id: "goal", attributes: { duration: 1, cost: 1, risk: 0.3 } },
    ],
    edges: [
      { from: "start", to: "mid", attributes: { weight: 1 } },
      { from: "mid", to: "goal", attributes: { weight: 1 } },
    ],
  };

  beforeEach(async () => {
    logJournal.reset();
    await server.close().catch(() => {});
  });

  afterEach(async () => {
    await logJournal.flush();
    logJournal.reset();
    await server.close().catch(() => {});
  });

  async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "graph-opid-logging", version: "1.0.0-test" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await run(client);
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  }

  async function expectLogWithOpId(message: string, expectedOpId: string): Promise<void> {
    await logJournal.flush();
    const { entries } = logJournal.tail({ stream: "server" });
    const entry = entries.find((item) => item.message === message);
    expect(entry, `expected a '${message}' log entry`).to.not.be.undefined;
    expect(entry?.opId).to.equal(expectedOpId);
    const payload = (entry?.data ?? {}) as Record<string, unknown>;
    expect(payload.op_id).to.equal(expectedOpId);
  }

  it("records op_id for graph_paths_constrained logs", async () => {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "graph_paths_constrained",
        arguments: {
          graph: GRAPH,
          from: "start",
          to: "goal",
        },
      });
      expect(response.isError ?? false).to.equal(false);
      const result = response.structuredContent as { op_id: string };
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      await expectLogWithOpId("graph_paths_constrained_completed", result.op_id);
    });
  });

  it("records op_id for graph_centrality_betweenness logs", async () => {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "graph_centrality_betweenness",
        arguments: {
          graph: GRAPH,
          weighted: false,
          top_k: 2,
        },
      });
      expect(response.isError ?? false).to.equal(false);
      const result = response.structuredContent as { op_id: string };
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      await expectLogWithOpId("graph_centrality_betweenness_succeeded", result.op_id);
    });
  });

  it("records op_id for graph_partition logs", async () => {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "graph_partition",
        arguments: {
          graph: GRAPH,
          k: 2,
          objective: "community",
        },
      });
      expect(response.isError ?? false).to.equal(false);
      const result = response.structuredContent as { op_id: string };
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      await expectLogWithOpId("graph_partition_succeeded", result.op_id);
    });
  });

  it("records op_id for graph_critical_path logs", async () => {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "graph_critical_path",
        arguments: {
          graph: GRAPH,
          duration_attribute: "duration",
        },
      });
      expect(response.isError ?? false).to.equal(false);
      const result = response.structuredContent as { op_id: string };
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      await expectLogWithOpId("graph_critical_path_succeeded", result.op_id);
    });
  });

  it("records op_id for graph_simulate logs", async () => {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "graph_simulate",
        arguments: {
          graph: GRAPH,
          parallelism: 2,
        },
      });
      expect(response.isError ?? false).to.equal(false);
      const result = response.structuredContent as { op_id: string };
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      await expectLogWithOpId("graph_simulate_succeeded", result.op_id);
    });
  });

  it("records op_id for graph_optimize logs", async () => {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "graph_optimize",
        arguments: {
          graph: GRAPH,
          parallelism: 1,
          max_parallelism: 2,
          explore_parallelism: [2],
          objective: { type: "makespan" },
        },
      });
      expect(response.isError ?? false).to.equal(false);
      const result = response.structuredContent as { op_id: string };
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      await expectLogWithOpId("graph_optimize_completed", result.op_id);
    });
  });

  it("records op_id for graph_optimize_moo logs", async () => {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "graph_optimize_moo",
        arguments: {
          graph: GRAPH,
          parallelism_candidates: [1, 2],
          objectives: [
            { type: "makespan" },
            { type: "cost", attribute: "cost", default_value: 1 },
          ],
        },
      });
      expect(response.isError ?? false).to.equal(false);
      const result = response.structuredContent as { op_id: string };
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      await expectLogWithOpId("graph_optimize_moo_completed", result.op_id);
    });
  });

  it("records op_id for graph_causal_analyze logs", async () => {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "graph_causal_analyze",
        arguments: {
          graph: GRAPH,
          max_cycles: 5,
          compute_min_cut: true,
        },
      });
      expect(response.isError ?? false).to.equal(false);
      const result = response.structuredContent as { op_id: string };
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      await expectLogWithOpId("graph_causal_analyze_completed", result.op_id);
    });
  });
});
