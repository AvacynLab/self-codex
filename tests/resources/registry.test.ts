/**
 * Validates the strongly typed read helpers exposed by the resource registry.
 * The suite focuses on error signalling for missing URIs and verifies that the
 * payloads returned by `read` and `watch` are defensive clones, guaranteeing
 * callers cannot mutate the underlying state accidentally.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import type { NormalisedGraph } from "../../src/graph/types.js";
import {
  ResourceNotFoundError,
  ResourceRegistry,
  type ResourceChildLogsPayload,
  type ResourceReadResult,
  type ResourceRunEventsPayload,
} from "../../src/resources/registry.js";

/** Creates a minimal graph structure with deterministic metadata for tests. */
function createGraph(graphId: string, version: number): NormalisedGraph {
  return {
    name: "workflow",
    graphId,
    graphVersion: version,
    nodes: [
      {
        id: "root",
        label: "root",
        attributes: { version },
      },
    ],
    edges: [],
    metadata: { revision: version },
  };
}

describe("ResourceRegistry type safety", () => {
  it("throws ResourceNotFoundError for unknown URIs", () => {
    const registry = new ResourceRegistry();

    // Unknown run, child and validation URIs should surface the dedicated error type.
    expect(() => registry.read("sc://runs/missing/events")).to.throw(ResourceNotFoundError);
    expect(() => registry.watch("sc://runs/missing/events")).to.throw(ResourceNotFoundError);
    expect(() => registry.watchStream("sc://runs/missing/events")).to.throw(ResourceNotFoundError);

    expect(() => registry.read("sc://children/ghost/logs")).to.throw(ResourceNotFoundError);
    expect(() => registry.watch("sc://children/ghost/logs")).to.throw(ResourceNotFoundError);

    expect(() => registry.read("sc://validation/session/input/nope")).to.throw(ResourceNotFoundError);
  });

  it("returns defensive clones when reading or watching resources", () => {
    const registry = new ResourceRegistry({ runHistoryLimit: 10, childLogHistoryLimit: 10 });

    // Seed a graph version so read operations can be exercised.
    registry.recordGraphVersion({
      graphId: "demo",
      version: 1,
      committedAt: 100,
      graph: createGraph("demo", 1),
    });

    // Seed a run event and a child log entry to validate cloning.
    registry.recordRunEvent("run-1", {
      seq: 1,
      ts: 200,
      kind: "PLAN",
      level: "info",
      payload: { step: "start" },
    });
    registry.recordChildLogEntry("child-1", {
      ts: 210,
      stream: "stdout",
      message: "ready",
    });

    const graphRead = registry.read("sc://graphs/demo");
    expect(graphRead.kind).to.equal("graph");
    graphRead.payload.graph.nodes[0]!.label = "mutated";

    const runRead = registry.read("sc://runs/run-1/events");
    expect(runRead.kind).to.equal("run_events");
    const runPayload: ResourceRunEventsPayload = runRead.payload;
    runPayload.events[0]!.payload = { step: "mutated" };

    const childRead = registry.read("sc://children/child-1/logs");
    expect(childRead.kind).to.equal("child_logs");
    const childPayload: ResourceChildLogsPayload = childRead.payload;
    childPayload.logs[0]!.message = "mutated";

    // Subsequent reads must return the pristine snapshots captured in the registry.
    const freshGraph = registry.read("sc://graphs/demo");
    expect(freshGraph.kind).to.equal("graph");
    expect(freshGraph.payload.graph.nodes[0]!.label).to.equal("root");

    const freshRun = registry.read("sc://runs/run-1/events");
    expect(freshRun.kind).to.equal("run_events");
    expect(freshRun.payload.events[0]!.payload).to.deep.equal({ step: "start" });

    const freshChild = registry.read("sc://children/child-1/logs");
    expect(freshChild.kind).to.equal("child_logs");
    expect(freshChild.payload.logs[0]!.message).to.equal("ready");

    const watchPage = registry.watch("sc://runs/run-1/events");
    expect(watchPage.kind).to.equal("run_events");
    watchPage.events[0]!.payload = { step: "changed" };

    const freshPage = registry.watch("sc://runs/run-1/events");
    expect(freshPage.kind).to.equal("run_events");
    expect(freshPage.events[0]!.payload).to.deep.equal({ step: "start" });
  });

  it("exposes discriminated read results", () => {
    const registry = new ResourceRegistry();
    registry.recordGraphVersion({
      graphId: "demo",
      version: 1,
      committedAt: 100,
      graph: createGraph("demo", 1),
    });

    const result: ResourceReadResult = registry.read("sc://graphs/demo");
    if (result.kind !== "graph") {
      throw new Error(`unexpected kind: ${result.kind}`);
    }

    // TypeScript narrows the payload to ResourceGraphPayload, so graph-specific
    // fields can be accessed without extra casting.
    expect(result.payload.version).to.equal(1);
    expect(result.payload.graph.graphId).to.equal("demo");
  });
});
