import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { GraphDescriptorPayload } from "../src/tools/graphTools.js";
import { renderMermaidFromGraph } from "../src/viz/mermaid.js";
import { renderDotFromGraph } from "../src/viz/dot.js";
import { renderGraphmlFromGraph } from "../src/viz/graphml.js";
import { snapshotToGraphDescriptor, GraphStateSnapshot } from "../src/viz/snapshot.js";
import { server, graphState } from "../src/server.js";

describe("graph export helpers", () => {
  // Preserve the orchestrator snapshot captured when the test suite boots so we
  // can restore the global GraphState after each integration scenario.
  const baselineGraphSnapshot = graphState.serialize();

  const descriptor: GraphDescriptorPayload = {
    name: "export-demo",
    nodes: [
      { id: "node.start", label: "Start", attributes: { role: "source" } },
      { id: "node.end", label: "End", attributes: { role: "sink" } },
    ],
    edges: [
      { from: "node.start", to: "node.end", label: "transition", attributes: { weight: 2 } },
    ],
  };

  it("renders a Mermaid flowchart", () => {
    const output = renderMermaidFromGraph(descriptor, { direction: "LR", weightAttribute: "weight" });
    expect(output).to.include("graph LR");
    expect(output).to.include("node_start");
    expect(output).to.include("transition");
  });

  it("renders a DOT document", () => {
    const output = renderDotFromGraph(descriptor, { labelAttribute: "label", weightAttribute: "weight" });
    expect(output).to.include("digraph G");
    expect(output).to.include("\"node.start\" -> \"node.end\"");
    expect(output).to.include("weight=2");
  });

  it("escapes special characters in Mermaid and DOT outputs", () => {
    const escapingDescriptor: GraphDescriptorPayload = {
      name: "escape-demo",
      nodes: [
        {
          id: 'node "alpha"\n',
          label: 'Alpha "Beta"\nGamma',
          attributes: { role: "source" },
        },
        { id: "target[edge]", label: "Target ] Node", attributes: { role: "sink" } },
      ],
      edges: [
        {
          from: 'node "alpha"\n',
          to: "target[edge]",
          label: 'Edge "Label"\nNext',
          attributes: { weight: "3" },
        },
      ],
    };

    const mermaid = renderMermaidFromGraph(escapingDescriptor, { direction: "TB", weightAttribute: "weight" });
    // The first node identifier must be normalised without leaking bracket syntax
    // and the label should contain escaped quotes and newlines.
    expect(mermaid).to.include('graph TB');
    expect(mermaid).to.include('node_alpha_["Alpha \\"Beta\\"\\nGamma"]');
    expect(mermaid).to.include('node_alpha_ -- "Edge \\"Label\\"\\nNext" --> target_edge_');

    const dot = renderDotFromGraph(escapingDescriptor, { weightAttribute: "weight" });
    // DOT output keeps raw identifiers but they must be quoted and escaped for
    // readability.
    expect(dot).to.include('"node \\\"alpha\\"\\n"');
    expect(dot).to.include('"target[edge]"');
    expect(dot).to.include('label=\"Edge \\\"Label\\"\\nNext\"');
  });

  it("renders a GraphML document", () => {
    const output = renderGraphmlFromGraph(descriptor, { weightAttribute: "weight" });
    expect(output).to.include("<graphml");
    expect(output).to.include("<node id=\"node.start\"");
    expect(output).to.include("<edge source=\"node.start\" target=\"node.end\"");
  });

  it("projects orchestrator snapshots into descriptors", () => {
    const snapshot: GraphStateSnapshot = {
      nodes: [
        { id: "job:1", attributes: { label: "Job #1", state: "running" } },
        { id: "child:1", attributes: { name: "worker", weight: 3 } },
      ],
      edges: [
        { from: "job:1", to: "child:1", attributes: { type: "owns", weight: 1 } },
      ],
      directives: { graph: "orchestrator" },
    };

    const projected = snapshotToGraphDescriptor(snapshot, { labelAttribute: "name" });
    expect(projected.nodes).to.have.length(2);
    expect(projected.nodes.find((node) => node.id === "child:1")?.label).to.equal("worker");
    const json = JSON.stringify({ descriptor: projected, snapshot });
    const parsed = JSON.parse(json);
    expect(parsed.descriptor.nodes[0].id).to.equal(projected.nodes[0].id);
  });

  it("writes JSON exports to disk when inline mode is disabled", async function () {
    this.timeout(10_000);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "graph-export-inline-test", version: "1.0.0-test" });

    const relativePath = path.join("tmp", "graph-export-test", `export-${randomUUID()}.json`);
    const absolutePath = path.join(process.cwd(), relativePath);

    // Swap the global graph snapshot with a deterministic fixture that the
    // server will export through the tool invocation below.
    graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "test-export" } });
    const longGoal = "Validation de l'export multi-outils ".repeat(20).trim();
    graphState.createJob("export-job", { createdAt: 0, goal: longGoal, state: "running" });
    graphState.createChild(
      "export-job",
      "export-child",
      { name: "clone-alpha", runtime: "codex" },
      { createdAt: 0, ttlAt: null },
    );
    const expectedSnapshot = graphState.serialize();

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const truncate = 256;
      const response = await client.callTool({
        name: "graph_export",
        arguments: {
          format: "json",
          inline: false,
          path: relativePath,
          pretty: true,
          truncate,
        },
      });

      expect(response.isError ?? false).to.equal(false, "graph_export must succeed when inline is disabled");
      expect(response.structuredContent).to.not.be.undefined;

      const structured = response.structuredContent as {
        format: string;
        bytes: number;
        truncated: boolean;
        path: string | null;
        preview?: string;
      };

      expect(structured.format).to.equal("json");
      expect(structured.path).to.equal(absolutePath);
      expect(structured.truncated).to.equal(true);
      expect(structured.preview).to.be.a("string");
      expect(structured?.preview?.length).to.equal(truncate);

      // The tool should have persisted the JSON payload to disk because inline
      // mode was disabled. Validate the file contents and ensure the preview
      // mirrors the first characters of the document.
      const written = await readFile(absolutePath, "utf8");
      const parsed = JSON.parse(written) as { snapshot: GraphStateSnapshot; descriptor: unknown };

      expect(parsed.snapshot.nodes).to.have.length(2);
      expect(parsed.snapshot.nodes[0].id).to.equal("job:export-job");
      expect(parsed.snapshot).to.deep.equal(expectedSnapshot as unknown as GraphStateSnapshot);
      expect(Buffer.byteLength(written, "utf8")).to.equal(structured.bytes);
      expect(written.startsWith(structured.preview ?? "")).to.equal(true);
    } finally {
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await client.close();
      await server.close().catch(() => {});
      await rm(absolutePath, { force: true });
      await rm(path.dirname(absolutePath), { recursive: true, force: true });
    }
  });
});
