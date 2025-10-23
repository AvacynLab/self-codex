import { strict as assert } from "node:assert";

import {
  computeGraphFingerprint,
  ensureGraphIdentity,
  normaliseGraphPayload,
  serialiseNormalisedGraph,
  type GraphDescriptorPayload,
} from "../../src/tools/graph/snapshot.js";
import type { NormalisedGraph } from "../../src/graph/types.js";

/**
 * Regression suite verifying the graph snapshot helpers avoid materialising
 * optional fields with explicit `undefined` placeholders. These checks ensure
 * the module remains compatible with the global `exactOptionalPropertyTypes`
 * rollout while documenting the semantics of the normalisation helpers.
 */
describe("graph snapshot optional fields", () => {
  it("serialises graphs without attaching absent optional properties", () => {
    const descriptor: NormalisedGraph = {
      name: "serialisation",
      graphId: "", // force the helper to derive a fingerprinted identifier
      graphVersion: 0,
      nodes: [
        { id: "alpha", attributes: { priority: 1 } },
        { id: "beta", label: "Beta", attributes: { priority: 2 } },
      ],
      edges: [
        { from: "alpha", to: "beta", attributes: { weight: 1 } },
        { from: "beta", to: "alpha", label: "loop", weight: 2, attributes: { weight: 2 } },
      ],
      metadata: {},
    };

    const serialised = serialiseNormalisedGraph({ ...descriptor });

    assert.match(serialised.graph_id, /^graph-[0-9a-f]{16}$/);
    assert.strictEqual(serialised.graph_version, 1);

    const minimalNode = serialised.nodes.find((node) => node.id === "alpha");
    assert.ok(minimalNode, "alpha should be present in the serialised payload");
    assert.strictEqual(Object.hasOwn(minimalNode!, "label"), false);

    const labelledNode = serialised.nodes.find((node) => node.id === "beta");
    assert.ok(labelledNode, "beta should be present in the serialised payload");
    assert.strictEqual(labelledNode!.label, "Beta");

    const minimalEdge = serialised.edges.find(
      (edge) => edge.from === "alpha" && edge.to === "beta",
    );
    assert.ok(minimalEdge, "the alpha → beta edge should exist");
    assert.strictEqual(Object.hasOwn(minimalEdge!, "label"), false);
    assert.strictEqual(Object.hasOwn(minimalEdge!, "weight"), false);

    const labelledEdge = serialised.edges.find(
      (edge) => edge.from === "beta" && edge.to === "alpha",
    );
    assert.ok(labelledEdge, "the beta → alpha edge should exist");
    assert.strictEqual(labelledEdge!.label, "loop");
    assert.strictEqual(labelledEdge!.weight, 2);
  });

  it("normalises payloads without materialising undefined optional fields", () => {
    const payload: GraphDescriptorPayload = {
      name: "normalisation",
      nodes: [
        { id: "root", attributes: {} },
        { id: "child", label: "Child", attributes: {} },
      ],
      edges: [
        { from: "root", to: "child", attributes: {} },
      ],
      metadata: {},
    };

    const descriptor = normaliseGraphPayload(payload);

    const rootNode = descriptor.nodes.find((node) => node.id === "root");
    assert.ok(rootNode, "the root node should be present after normalisation");
    assert.strictEqual(Object.hasOwn(rootNode!, "label"), false);

    const childNode = descriptor.nodes.find((node) => node.id === "child");
    assert.ok(childNode, "the child node should be present after normalisation");
    assert.strictEqual(childNode!.label, "Child");

    const connectingEdge = descriptor.edges.find(
      (edge) => edge.from === "root" && edge.to === "child",
    );
    assert.ok(connectingEdge, "the root → child edge should exist");
    assert.strictEqual(Object.hasOwn(connectingEdge!, "label"), false);
    assert.strictEqual(Object.hasOwn(connectingEdge!, "weight"), false);

    assert.match(descriptor.graphId, /^graph-[0-9a-f]{16}$/);
    assert.strictEqual(descriptor.graphVersion, 1);
  });

  it("increments versions for mutated graphs while respecting provided identifiers", () => {
    const descriptor: NormalisedGraph = {
      name: "mutation",
      graphId: "explicit-id",
      graphVersion: 2,
      nodes: [{ id: "only", attributes: {} }],
      edges: [],
      metadata: {},
    };

    ensureGraphIdentity(descriptor, { mutated: true });

    assert.strictEqual(descriptor.graphId, "explicit-id");
    assert.strictEqual(descriptor.graphVersion, 3);

    const fingerprint = computeGraphFingerprint({ ...descriptor });
    assert.match(fingerprint, /^[0-9a-f]{16}$/);
  });
});
