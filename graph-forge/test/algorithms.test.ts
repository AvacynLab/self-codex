import { strict as assert } from "node:assert";
import test from "node:test";
import { compileSource } from "../src/compiler.ts";
import { shortestPath } from "../src/algorithms/dijkstra.ts";
import { tarjanScc } from "../src/algorithms/tarjan.ts";
import { criticalPath } from "../src/algorithms/criticalPath.ts";

const sample = `graph Flow {
  node Start
  node Middle
  node End

  edge Start -> Middle { weight: 2 }
  edge Middle -> End { weight: 3 }
  edge Start -> End { weight: 10 }
}`;

test("shortestPath finds optimal route", () => {
  const { graph } = compileSource(sample);
  const result = shortestPath(graph, "Start", "End");
  assert.equal(result.distance, 5);
  assert.deepEqual(result.path, ["Start", "Middle", "End"]);
});

test("tarjanScc identifies components", () => {
  const { graph } = compileSource(sample);
  const scc = tarjanScc(graph);
  assert.ok(scc.some((component) => component.length === 1 && component[0] === "Start"));
});

test("criticalPath computes longest chain", () => {
  const { graph } = compileSource(sample);
  const result = criticalPath(graph);
  assert.equal(result.length, 5);
  assert.deepEqual(result.path, ["Start", "Middle", "End"]);
});
