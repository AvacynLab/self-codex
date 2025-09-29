import { describe, it } from "mocha";
import { expect } from "chai";

import {
  GraphModel,
  topologicalSort,
  CycleDetectedError,
  detectCycles,
  degreeCentrality,
  closenessCentrality,
  kShortestPaths,
  shortestPath
} from "../graph-forge/src/index.js";

function buildSampleGraph(): GraphModel {
  const nodes = [
    { id: "A", attributes: {} },
    { id: "B", attributes: {} },
    { id: "C", attributes: {} },
    { id: "D", attributes: {} }
  ];
  const edges = [
    { from: "A", to: "B", attributes: { weight: 1, time: 5 } },
    { from: "A", to: "C", attributes: { weight: 2, time: 2 } },
    { from: "B", to: "D", attributes: { weight: 3, time: 3 } },
    { from: "C", to: "D", attributes: { weight: 1, time: 1 } },
    { from: "B", to: "C", attributes: { weight: 2, time: 2 } }
  ];
  return new GraphModel("sample", nodes, edges, new Map());
}

describe("GraphForge analyses", () => {
  it("produit un tri topologique pour un DAG", () => {
    const graph = buildSampleGraph();
    const order = topologicalSort(graph);
    expect(order).to.deep.equal(["A", "B", "C", "D"]);
  });

  it("signale un cycle lors du tri topologique", () => {
    const graph = buildSampleGraph();
    const cyclicEdges = graph.listEdges().concat([{ from: "D", to: "A", attributes: {} }]);
    const cyclicGraph = new GraphModel("cyclic", graph.listNodes(), cyclicEdges, new Map());
    expect(() => topologicalSort(cyclicGraph)).to.throw(CycleDetectedError);
    const cycles = detectCycles(cyclicGraph, 5);
    expect(cycles.hasCycle).to.equal(true);
    expect(cycles.cycles.length).to.be.greaterThan(0);
  });

  it("calcule la centralité de degré et de proximité", () => {
    const graph = buildSampleGraph();
    const degrees = degreeCentrality(graph);
    const entryA = degrees.find((item) => item.node === "A");
    expect(entryA?.outDegree).to.equal(2);

    const closeness = closenessCentrality(graph);
    const closenessA = closeness.find((item) => item.node === "A");
    expect(closenessA?.reachable).to.equal(3);
    expect(closenessA?.score).to.be.greaterThan(0);
  });

  it("retourne plusieurs chemins optimisés", () => {
    const graph = buildSampleGraph();
    const paths = kShortestPaths(graph, "A", "D", 3);
    expect(paths).to.have.length(3);
    expect(paths[0].path).to.deep.equal(["A", "C", "D"]);
    expect(paths[1].path).to.deep.equal(["A", "B", "D"]);
    expect(paths[2].path).to.deep.equal(["A", "B", "C", "D"]);
  });

  it("prend en compte une fonction de coût personnalisée", () => {
    const graph = buildSampleGraph();
    const fastest = shortestPath(graph, "A", "D", { costFunction: { attribute: "time" } });
    expect(fastest.distance).to.equal(3);
    expect(fastest.path).to.deep.equal(["A", "C", "D"]);

    const weighted = shortestPath(graph, "A", "D", {
      costFunction: (edge) => Number(edge.attributes.time ?? 1) * 2
    });
    expect(weighted.distance).to.equal(6);
  });
});
