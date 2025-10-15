import { describe, it } from "mocha";
import { expect } from "chai";
import fc from "fast-check";

import { diffGraphs } from "../../src/graph/diff.js";
import { applyGraphPatch } from "../../src/graph/patch.js";
import type { NormalisedGraph } from "../../src/graph/types.js";

/**
 * Property-based coverage ensuring the diff/patch helpers keep graph payloads
 * consistent across random scenarios.
 */
describe("graph diff + patch (property-based)", () => {
  /**
   * Generate attribute dictionaries relying on scalar values only so the diff
   * routines can leverage strict equality when producing JSON Patch entries.
   */
  const attributeRecordArb = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 6, charSet: "abcdefghijklmnopqrstuvwxyz0123456789_~/" }),
    fc.oneof(
      fc.boolean(),
      fc.integer({ min: -8, max: 12 }),
      fc.string({ minLength: 1, maxLength: 12, charSet: "abcdefghijklmnopqrstuvwxyz0123456789_-" }),
    ),
    { maxKeys: 4 },
  );

  /**
   * Build a pool of unique nodes so edges can safely reference node identifiers
   * without hitting validation errors during patch application.
   */
  const nodeRecordArb = fc.uniqueArray(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 8, charSet: "abcdefghijklmnopqrstuvwxyz0123456789" }),
      label: fc.option(fc.string({ minLength: 1, maxLength: 12, charSet: "abcdefghijklmnopqrstuvwxyz " }), {
        nil: undefined,
      }),
      attributes: attributeRecordArb,
    }),
    { maxLength: 6, selector: (node) => node.id },
  );

  /**
   * Produce edges pointing to the generated node identifiers; an empty node set
   * yields an empty array to avoid selecting non-existent vertices.
   */
  const edgesForNodes = (nodes: NormalisedGraph["nodes"]): fc.Arbitrary<NormalisedGraph["edges"]> => {
    if (nodes.length === 0) {
      return fc.constant([]);
    }
    const nodeIds = nodes.map((node) => node.id);
    return fc.array(
      fc.record({
        from: fc.constantFrom(...nodeIds),
        to: fc.constantFrom(...nodeIds),
        label: fc.option(fc.string({ minLength: 1, maxLength: 16, charSet: "abcdefghijklmnopqrstuvwxyz ->" }), {
          nil: undefined,
        }),
        weight: fc.option(fc.integer({ min: -5, max: 5 }), { nil: undefined }),
        attributes: attributeRecordArb,
      }),
      { maxLength: Math.min(8, nodeIds.length * 2) },
    );
  };

  /**
   * Assemble a complete normalised graph descriptor using the helpers above so
   * diffGraphs/applyGraphPatch receive structurally valid payloads.
   */
  const graphArb: fc.Arbitrary<NormalisedGraph> = fc
    .record({
      name: fc.string({ minLength: 1, maxLength: 18, charSet: "abcdefghijklmnopqrstuvwxyz0123456789_- " }),
      graphId: fc.string({ minLength: 1, maxLength: 12, charSet: "abcdefghijklmnopqrstuvwxyz0123456789_-" }),
      graphVersion: fc.integer({ min: 1, max: 12 }),
      metadata: attributeRecordArb,
    })
    .chain((base) =>
      nodeRecordArb.chain((nodes) =>
        edgesForNodes(nodes).map((edges) => ({
          name: base.name,
          graphId: base.graphId,
          graphVersion: base.graphVersion,
          metadata: base.metadata,
          nodes,
          edges,
        })),
      ),
    );

  it("reconstructs the target graph after diff+patch", () => {
    const pairArb = fc.tuple(graphArb, graphArb).map(([base, target]) => ({
      base,
      target: {
        ...target,
        graphId: base.graphId,
        graphVersion: base.graphVersion,
      },
    }));

    fc.assert(
      fc.property(pairArb, ({ base, target }) => {
        const diff = diffGraphs(base, target);
        const patched = applyGraphPatch(base, diff.operations);
        const residual = diffGraphs(patched, target);

        expect(diff.changed).to.equal(diff.operations.length > 0, "changed flag must track operations");
        expect(residual.changed).to.equal(false, "patched graph must match target");
        expect(residual.operations).to.have.length(0);
      }),
      { numRuns: 100 },
    );
  });

  it("restores the base graph when applying the reverse diff", () => {
    const pairArb = fc.tuple(graphArb, graphArb).map(([base, target]) => ({ base, target }));

    fc.assert(
      fc.property(pairArb, ({ base, target }) => {
        const forward = diffGraphs(base, target);
        const patched = applyGraphPatch(base, forward.operations);
        const backward = diffGraphs(target, base);
        const restored = applyGraphPatch(target, backward.operations);

        const diffBackToBase = diffGraphs(restored, base);
        expect(diffBackToBase.changed).to.equal(false, "restored graph must match the original base");
        expect(diffBackToBase.operations).to.be.empty;

        const diffPatchedVsTarget = diffGraphs(patched, target);
        expect(diffPatchedVsTarget.changed).to.equal(false, "patched graph must match forward target");
      }),
      { numRuns: 100 },
    );
  });
});
