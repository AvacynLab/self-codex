import { describe, it } from "mocha";
import { expect } from "chai";

import { projectHyperGraph, type HyperGraph } from "../src/graph/hypergraph.js";
import { renderMermaidFromGraph } from "../src/viz/mermaid.js";
import { renderDotFromGraph } from "../src/viz/dot.js";

// The export suite focuses on the textual annotations ensuring that visual
// renderers keep the link with the original hyper-edge definition.
describe("graph export - hyper-edge annotations", () => {
  it("embeds hyper-edge information in Mermaid exports", () => {
    const hyperGraph: HyperGraph = {
      id: "fanout",
      nodes: [
        { id: "source", label: "Source", attributes: {} },
        { id: "left", label: "Left", attributes: {} },
        { id: "right", label: "Right", attributes: {} },
      ],
      hyperEdges: [
        {
          id: "split",
          sources: ["source"],
          targets: ["left", "right"],
          label: "dispatch",
        },
      ],
    };

    const projected = projectHyperGraph(hyperGraph);
    const descriptor = {
      name: projected.name,
      nodes: projected.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        attributes: node.attributes,
      })),
      edges: projected.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        weight: edge.weight,
        attributes: edge.attributes,
      })),
      metadata: projected.metadata,
      graph_id: projected.graphId,
      graph_version: projected.graphVersion,
    };

    const mermaid = renderMermaidFromGraph(descriptor);
    expect(mermaid).to.include('source -- "dispatch \\[H:split#0 1->2\\]" --> left');
    expect(mermaid).to.include('source -- "dispatch \\[H:split#1 1->2\\]" --> right');
  });

  it("embeds hyper-edge information in DOT exports", () => {
    const hyperGraph: HyperGraph = {
      id: "fanout",
      nodes: [
        { id: "source", label: "Source", attributes: {} },
        { id: "left", label: "Left", attributes: {} },
        { id: "right", label: "Right", attributes: {} },
      ],
      hyperEdges: [
        {
          id: "split",
          sources: ["source"],
          targets: ["left", "right"],
          label: "dispatch",
        },
      ],
    };

    const projected = projectHyperGraph(hyperGraph);
    const descriptor = {
      name: projected.name,
      nodes: projected.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        attributes: node.attributes,
      })),
      edges: projected.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        weight: edge.weight,
        attributes: edge.attributes,
      })),
      metadata: projected.metadata,
      graph_id: projected.graphId,
      graph_version: projected.graphVersion,
    };

    const dot = renderDotFromGraph(descriptor);
    expect(dot).to.include('"source" -> "left" [label="dispatch [H:split#0 1->2]"]');
    expect(dot).to.include('"source" -> "right" [label="dispatch [H:split#1 1->2]"]');
  });
});
