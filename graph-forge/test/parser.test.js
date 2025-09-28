import { strict as assert } from "node:assert";
import test from "node:test";
import { parse } from "../src/parser.ts";
const sample = `graph Pipeline {
  node Ingest { label: "Data" }
  node Transform
  edge Ingest -> Transform { weight: 3 }
  @analysis shortestPath Ingest Transform;
}`;
test("parser builds AST for pipeline graph", () => {
    const ast = parse(sample);
    assert.equal(ast.graphs.length, 1);
    const graph = ast.graphs[0];
    assert.equal(graph.name, "Pipeline");
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.analyses.length, 1);
    assert.equal(graph.analyses[0].name, "shortestPath");
});
