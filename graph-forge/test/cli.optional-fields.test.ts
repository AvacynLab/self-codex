/**
 * Exercises the Graph Forge CLI helpers to ensure optional parameters are
 * omitted instead of being emitted as `undefined`, which keeps the build happy
 * under `exactOptionalPropertyTypes`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { compileSource } from "../src/compiler.js";
import { __testing } from "../src/cli.js";

const { buildAnalysisInput, buildWeightAttributeOptions, parseArgs } = __testing;

const SAMPLE_SOURCE = `
graph pipeline {
  node start
  node goal
  edge start -> goal { weight: 1 }
}
`;

test("parseArgs omits weightKey when the flag is absent", () => {
  const options = parseArgs(["pipeline.gf"]);
  assert.strictEqual(Object.hasOwn(options, "weightKey"), false, "weightKey should be omitted by default");
});

test("parseArgs retains weightKey when provided", () => {
  const options = parseArgs(["pipeline.gf", "--weight-key", "cost"]);
  assert.strictEqual(options.weightKey, "cost", "the provided weight key is forwarded when present");
});

test("buildAnalysisInput omits weightKey when it is undefined", () => {
  const compiled = compileSource(SAMPLE_SOURCE);
  type CliAnalysis = Parameters<typeof buildAnalysisInput>[0];
  const analysis: CliAnalysis = { name: "shortestPath", args: ["start", "goal"], source: "cli" };

  const withoutWeight = buildAnalysisInput(analysis, compiled, undefined);
  assert.strictEqual(
    Object.hasOwn(withoutWeight, "weightKey"),
    false,
    "the helper should not include weightKey when no CLI override is supplied"
  );

  const withWeight = buildAnalysisInput(analysis, compiled, "weight");
  assert.strictEqual(withWeight.weightKey, "weight", "explicit weight keys are preserved");
});

test("buildWeightAttributeOptions drops undefined values", () => {
  assert.strictEqual(
    buildWeightAttributeOptions(undefined),
    undefined,
    "no options are forwarded when the CLI omits the weight flag"
  );
  assert.deepStrictEqual(
    buildWeightAttributeOptions("latency"),
    { weightAttribute: "latency" },
    "defined weight keys are preserved for downstream algorithms"
  );
});
