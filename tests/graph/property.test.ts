import { describe, it } from "mocha";
import { expect } from "chai";
import * as fc from "fast-check";

import type { NormalisedGraph } from "../../src/graph/types.js";
import { validateGraph } from "../../src/graph/validate.js";

describe("graph validation properties", () => {
  it("accepts acyclic chains built from arbitrary node identifiers", async () => {
    const letters = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
    const restAlphabet = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-");
    const firstChar = fc.constantFrom(...letters);
    const restChar = fc.constantFrom(...restAlphabet);
    const identifier = fc
      .tuple(firstChar, fc.array(restChar, { maxLength: 7 }))
      .map(([head, tail]) => `${head}${tail.join("")}`);
    const graphArb = fc
      .uniqueArray(identifier, {
        minLength: 2,
        maxLength: 6,
      })
      .map<NormalisedGraph>((nodes) => {
        const edges = nodes.slice(1).map((nodeId, edgeIndex) => ({
          from: nodes[edgeIndex]!,
          to: nodeId,
          label: `${nodes[edgeIndex]}->${nodeId}`,
          attributes: {},
        }));
        return {
          name: "property-graph",
          graphId: `graph-${nodes.length}`,
          graphVersion: 1,
          metadata: {},
          nodes: nodes.map((id) => ({ id, label: id, attributes: {} })),
          edges,
      } satisfies NormalisedGraph;
      });

    await fc.assert(
      fc.asyncProperty(graphArb, async (graph) => {
        const result = validateGraph(graph);
        expect(result.ok).to.equal(true);
      }),
      { numRuns: 50 },
    );
  });
});
