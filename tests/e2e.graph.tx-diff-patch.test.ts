import { describe, it } from "mocha";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  logJournal,
} from "../src/server.js";

/**
 * End-to-end scenario verifying transaction tools combined with diff/patch helpers
 * and resource registry exposure. The flow opens a transaction, applies multiple
 * graph operations, previews the mutations via diff, commits the changes, derives
 * an additional patch for metadata adjustments, applies it, and finally reads the
 * committed version through the MCP resource URI.
 */
describe("graph transactions with diff/patch integration", function () {
  this.timeout(20_000);

  it("commits staged operations and exposes the version via resources", async () => {
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tx-diff-patch-e2e", version: "1.0.0-test" });

    const graphId = "graph-e2e-tx-diff-patch";

    const baseDescriptor = {
      name: "transaction baseline",
      graph_id: graphId,
      graph_version: 1,
      nodes: [
        { id: "ingest", label: "Ingest" },
        { id: "analyse", label: "Analyse" },
      ],
      edges: [{ from: "ingest", to: "analyse", label: "next" }],
      metadata: { owner: "baseline" },
    } as const;

    try {
      await server.close().catch(() => {});
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      logJournal.reset();
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableTx: true,
        enableDiffPatch: true,
        enableResources: true,
        enableLocks: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: graphId } });
      childProcessSupervisor.childrenIndex.restore({});

      const beginResponse = await client.callTool({
        name: "tx_begin",
        arguments: {
          graph_id: graphId,
          owner: "tx-e2e",
          note: "seed baseline",
          ttl_ms: 5_000,
          graph: baseDescriptor,
        },
      });
      expect(beginResponse.isError ?? false).to.equal(false);
      const beginResult = beginResponse.structuredContent as {
        tx_id: string;
        base_version: number;
        graph: typeof baseDescriptor;
      };
      expect(beginResult.base_version).to.equal(1);
      expect(beginResult.graph.nodes).to.have.length(2);

      const applyResponse = await client.callTool({
        name: "tx_apply",
        arguments: {
          tx_id: beginResult.tx_id,
          operations: [
            { op: "add_node", node: { id: "ship", label: "Ship", attributes: { lane: "delivery" } } },
            { op: "add_edge", edge: { from: "analyse", to: "ship", label: "next" } },
            { op: "set_node_attribute", id: "analyse", key: "phase", value: "inspection" },
          ],
        },
      });
      expect(applyResponse.isError ?? false).to.equal(false);
      const applyResult = applyResponse.structuredContent as {
        changed: boolean;
        preview_version: number;
        graph: {
          graph_version: number;
          nodes: Array<{ id: string; attributes?: Record<string, unknown> | undefined }>;
          metadata?: Record<string, unknown>;
        };
        applied: Array<{ changed: boolean }>;
      };
      expect(applyResult.changed).to.equal(true);
      expect(applyResult.preview_version).to.equal(beginResult.base_version + 1);
      expect(applyResult.applied.filter((entry) => entry.changed)).to.have.length(3);
      expect(applyResult.graph.nodes.some((node) => node.id === "ship")).to.equal(true);

      const previewDiffResponse = await client.callTool({
        name: "graph_diff",
        arguments: {
          graph_id: graphId,
          from: { graph: baseDescriptor },
          to: { graph: applyResult.graph },
        },
      });
      expect(previewDiffResponse.isError ?? false).to.equal(false);
      const previewDiff = previewDiffResponse.structuredContent as {
        changed: boolean;
        operations: Array<{ op: string; path: string }>;
      };
      expect(previewDiff.changed).to.equal(true);
      expect(previewDiff.operations.length).to.be.greaterThanOrEqual(2);

      const commitResponse = await client.callTool({ name: "tx_commit", arguments: { tx_id: beginResult.tx_id } });
      expect(commitResponse.isError ?? false).to.equal(false);
      const commitResult = commitResponse.structuredContent as {
        version: number;
        graph: {
          graph_version: number;
          nodes: Array<{ id: string; label?: string; attributes?: Record<string, unknown> }>;
          metadata?: Record<string, unknown>;
        };
      };
      expect(commitResult.version).to.equal(applyResult.preview_version);
      expect(commitResult.graph.graph_version).to.equal(commitResult.version);
      expect(commitResult.graph.nodes.some((node) => node.id === "ship")).to.equal(true);

      const enrichedDescriptor = {
        ...commitResult.graph,
        graph_id: graphId,
        metadata: { ...(commitResult.graph.metadata ?? {}), release: "2025.11" },
        nodes: commitResult.graph.nodes.map((node) =>
          node.id === "ship"
            ? {
                ...node,
                attributes: { ...(node.attributes ?? {}), lane: "delivery", status: "ready" },
              }
            : node,
        ),
      };

      const patchDiffResponse = await client.callTool({
        name: "graph_diff",
        arguments: {
          graph_id: graphId,
          from: { latest: true },
          to: { graph: enrichedDescriptor },
        },
      });
      expect(patchDiffResponse.isError ?? false).to.equal(false);
      const patchDiff = patchDiffResponse.structuredContent as {
        operations: Array<{ op: string; path: string; value?: unknown }>;
        changed: boolean;
      };
      expect(patchDiff.changed).to.equal(true);
      expect(patchDiff.operations.some((operation) => operation.path.includes("release"))).to.equal(true);

      const patchResponse = await client.callTool({
        name: "graph_patch",
        arguments: {
          graph_id: graphId,
          base_version: commitResult.version,
          owner: "tx-e2e",
          note: "apply enriched metadata",
          patch: patchDiff.operations,
        },
      });
      expect(patchResponse.isError ?? false).to.equal(false);
      const patchResult = patchResponse.structuredContent as {
        committed_version: number;
        graph: {
          metadata?: Record<string, unknown>;
          nodes: Array<{ id: string; attributes?: Record<string, unknown> }>;
        };
      };
      expect(patchResult.committed_version).to.equal(commitResult.version + 1);
      expect(patchResult.graph.metadata?.release).to.equal("2025.11");
      const shipNode = patchResult.graph.nodes.find((node) => node.id === "ship");
      expect(shipNode?.attributes?.status).to.equal("ready");

      const resourceUri = `sc://graphs/${graphId}@v${patchResult.committed_version}`;
      const resourceResponse = await client.callTool({
        name: "resources_read",
        arguments: { uri: resourceUri },
      });
      expect(resourceResponse.isError ?? false).to.equal(false);
      const resourcePayload = resourceResponse.structuredContent as {
        uri: string;
        kind: string;
        payload: { version: number; graph: { nodes: Array<{ id: string }> } };
        mime: string;
        data: { uri: string; kind: string; payload: { version: number } };
      };
      expect(resourcePayload.mime).to.equal("application/json");
      expect(resourcePayload.uri).to.equal(resourceUri);
      expect(resourcePayload.kind).to.equal("graph_version");
      expect(resourcePayload.data.uri).to.equal(resourceUri);
      expect(resourcePayload.data.kind).to.equal("graph_version");
      expect(resourcePayload.payload.version).to.equal(patchResult.committed_version);
      expect(resourcePayload.payload.graph.nodes.some((node) => node.id === "ship")).to.equal(true);
    } finally {
      await logJournal.flush().catch(() => {});
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
