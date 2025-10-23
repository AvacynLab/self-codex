import { beforeEach, afterEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphDescriptorPayload } from "../../src/tools/graph/snapshot.js";

import {
  server,
  graphState,
  __graphHandlerInternals,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../../src/server.js";

const {
  buildGraphConfigRetentionOptions,
  normaliseGraphQueryFilterInput,
  buildGraphSubgraphExtractOptions,
} = __graphHandlerInternals;

/**
 * Runtime assertion ensuring JSON payloads produced by graph handlers never leak
 * `undefined` placeholders once strict optional property typing is enabled. The
 * check walks objects and arrays recursively so deeply nested result fragments
 * stay compliant with future `exactOptionalPropertyTypes` enforcement.
 */
function assertNoUndefinedValues(value: unknown, path = "payload"): void {
  if (value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNoUndefinedValues(entry, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      expect(entry, `expected '${path}.${key}' to be defined`).to.not.equal(undefined);
      assertNoUndefinedValues(entry, `${path}.${key}`);
    }
  }
}

/**
 * Extracts and parses the JSON text payload emitted by a tool invocation result.
 * The helper mirrors the CLI helpers used in end-to-end tests while keeping this
 * regression self-contained.
 */
function parseTextPayload(result: CallToolResult): Record<string, unknown> {
  const [firstEntry] = result.content ?? [];
  if (!firstEntry || firstEntry.type !== "text" || typeof firstEntry.text !== "string") {
    throw new Error("tool payload must be a textual JSON document");
  }
  const parsed = JSON.parse(firstEntry.text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("tool payload must serialise to a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function createMinimalDescriptor(): GraphDescriptorPayload {
  return {
    name: "workflow",
    nodes: [],
    edges: [],
    graph_id: "graph-1",
    graph_version: 1,
  };
}

let baselineFeatures: ReturnType<typeof getRuntimeFeatures>;

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "graph-handlers-optional-fields", version: "1.0.0-test" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close().catch(() => {});
  }
}

describe("graph handler sanitisation helpers", () => {
  beforeEach(async () => {
    sinon.restore();
    await server.close().catch(() => {});
  });

  afterEach(() => {
    sinon.restore();
  });

  it("drops undefined retention overrides", () => {
    const options = buildGraphConfigRetentionOptions({ max_transcript_per_child: 150 });
    expect(options).to.deep.equal({ maxTranscriptPerChild: 150 });
  });

  it("normalises graph_query defaults without materialising undefined keys", () => {
    const filter = normaliseGraphQueryFilterInput({ kind: "filter" });
    expect(filter.select).to.equal("nodes");
    expect(filter.where).to.deep.equal({});
    expect("limit" in filter).to.equal(false);
  });

  it("omits directory hints when the caller relies on the default subgraph folder", () => {
    const options = buildGraphSubgraphExtractOptions({
      graph: createMinimalDescriptor(),
      node_id: "node-1",
      run_id: "run-1",
    });
    expect(options).to.have.property("childrenRoot");
    expect(options).to.not.have.property("directoryName");
  });

  it("preserves the directory override when provided", () => {
    const options = buildGraphSubgraphExtractOptions({
      graph: createMinimalDescriptor(),
      node_id: "node-2",
      run_id: "run-2",
      directory: "custom",
    });
    expect(options).to.include({ directoryName: "custom" });
  });
});

describe("graph handler optional field sanitisation", () => {
  beforeEach(async () => {
    sinon.restore();
    await server.close().catch(() => {});
    baselineFeatures = getRuntimeFeatures();
    configureRuntimeFeatures(baselineFeatures);
  });

  afterEach(() => {
    configureRuntimeFeatures(baselineFeatures);
    sinon.restore();
  });

  it("sanitises graph_config_retention overrides before mutating the graph state", async () => {
    const configureStub = sinon.stub(graphState, "configureRetention");
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "graph_config_retention",
        arguments: { max_transcript_per_child: 250 },
      });
      expect(result.isError ?? false).to.equal(false);
      const payload = parseTextPayload(result);
      assertNoUndefinedValues(payload);
      expect(payload.ok).to.equal(true);
    });
    sinon.assert.calledOnceWithExactly(configureStub, { maxTranscriptPerChild: 250 });
  });

  it("forwards graph_query filter payloads without reintroducing undefined fields", async () => {
    const filterNodes = sinon
      .stub(graphState, "filterNodes")
      .returns([{ id: "job-1", attributes: { type: "job" } }] as ReturnType<typeof graphState.filterNodes>);
    const filterEdges = sinon
      .stub(graphState, "filterEdges")
      .returns([] as ReturnType<typeof graphState.filterEdges>);

    await withClient(async (client) => {
      const result = await client.callTool({
        name: "graph_query",
        arguments: { kind: "filter", where: { type: "job" }, limit: 5 },
      });
      expect(result.isError ?? false).to.equal(false);
      sinon.assert.calledOnceWithExactly(filterNodes, { type: "job" }, 5);
      sinon.assert.notCalled(filterEdges);
      const payload = parseTextPayload(result);
      assertNoUndefinedValues(payload);
      expect(payload.nodes).to.be.an("array").with.lengthOf(1);
      expect(payload).to.not.have.property("edges");
    });
  });

  it("sanitises graph_batch_mutate result payloads", async () => {
    configureRuntimeFeatures({ ...baselineFeatures, enableBulk: true, enableTx: true, enableLocks: true });

    const seedGraph = {
      name: "workflow",
      graph_id: "graph-batch",
      graph_version: 1,
      nodes: [{ id: "root", attributes: { kind: "task" } }],
      edges: [],
      metadata: {},
    };

    await withClient(async (client) => {
      const seedResult = await client.callTool({
        name: "graph_mutate",
        arguments: {
          graph: seedGraph,
          operations: [
            { op: "add_node", node: { id: "child", attributes: { kind: "task" } } },
            {
              op: "add_edge",
              edge: {
                from: "root",
                to: "child",
                weight: 1,
                attributes: { kind: "dependency" },
              },
            },
          ],
        },
      });
      expect(seedResult.isError ?? false).to.equal(false);

      const result = await client.callTool({
        name: "graph_batch_mutate",
        arguments: {
          graph_id: "graph-batch",
          operations: [
            { op: "set_node_attribute", id: "child", key: "status", value: "ready" },
            {
              op: "add_edge",
              edge: {
                from: "child",
                to: "root",
                weight: 1,
                attributes: { kind: "dependency" },
              },
            },
          ],
          note: "ready-check",
        },
      });

      expect(result.isError ?? false).to.equal(false);
      const payload = parseTextPayload(result);
      assertNoUndefinedValues(payload);
      const typedPayload = payload as { tool: string; result: Record<string, unknown> };
      expect(typedPayload.tool).to.equal("graph_batch_mutate");
      expect(typedPayload.result.note).to.equal("ready-check");
      expect(typedPayload.result.owner).to.equal(null);
      expect(typedPayload.result.idempotency_key).to.equal(null);
    });
  });

  it("omits optional fields when graph_mutate commits a transaction", async () => {
    configureRuntimeFeatures({ ...baselineFeatures, enableTx: true, enableLocks: true });

    const baseGraph = {
      name: "workflow",
      graph_id: "graph-source",
      graph_version: 1,
      nodes: [{ id: "root", attributes: { kind: "task" } }],
      edges: [],
      metadata: {},
    };

    await withClient(async (client) => {
      const result = await client.callTool({
        name: "graph_mutate",
        arguments: {
          graph: baseGraph,
          operations: [
            { op: "add_node", node: { id: "child", attributes: { kind: "task" } } },
            {
              op: "add_edge",
              edge: {
                from: "root",
                to: "child",
                weight: 1,
                attributes: { kind: "dependency" },
              },
            },
            { op: "set_node_attribute", id: "child", key: "owner", value: "quality" },
          ],
        },
      });

      expect(result.isError ?? false).to.equal(false);
      const payload = parseTextPayload(result);
      assertNoUndefinedValues(payload);
      const typedPayload = payload as { result: Record<string, unknown> };
      expect(typedPayload.result.subgraph_refs).to.be.an("array").that.is.empty;
      expect(typedPayload.result).to.not.have.property("missing_subgraph_descriptors");
    });
  });

  it("returns graph_generate payloads without undefined placeholders", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "graph_generate",
        arguments: {
          name: "pipeline",
          tasks: [
            { id: "lint", label: "Lint stage" },
            { id: "test", depends_on: ["lint"], duration: 5 },
          ],
          default_weight: 1.5,
        },
      });

      expect(result.isError ?? false).to.equal(false);
      const payload = parseTextPayload(result);
      assertNoUndefinedValues(payload);
      const typedPayload = payload as { tool: string; result: Record<string, unknown> };
      expect(typedPayload.tool).to.equal("graph_generate");
      expect(typedPayload.result.graph).to.be.an("object");
      expect(typedPayload.result.notes).to.be.an("array");
    });
  });

  it("normalises graph_export inline responses", async () => {
    const serializeStub = sinon.stub(graphState, "serialize").returns({
      nodes: [
        { id: "job:alpha", attributes: { type: "job", goal: "Ship" } },
        { id: "child:alpha:1", attributes: { type: "child", job_id: "alpha" } },
      ],
      edges: [{ from: "job:alpha", to: "child:alpha:1", attributes: { type: "owns" } }],
      directives: { theme: "dark" },
    });

    await withClient(async (client) => {
      const result = await client.callTool({
        name: "graph_export",
        arguments: { format: "json", pretty: true, inline: true },
      });

      expect(result.isError ?? false).to.equal(false);
      const payload = parseTextPayload(result);
      assertNoUndefinedValues(payload);
      const typedPayload = payload as { tool: string; result: Record<string, unknown> };
      expect(typedPayload.tool).to.equal("graph_export");
      expect(typedPayload.result.inline).to.equal(true);
      expect(typedPayload.result.path).to.equal(null);
      expect(typedPayload.result).to.have.property("payload");
    });

    serializeStub.restore();
  });
});
