import { expect } from "chai";
import { describe, it } from "mocha";
import { resolve } from "node:path";

import {
  loadScenarioFromFile,
  parseScenario,
} from "../../src/eval/scenario.js";

/**
 * Unit coverage for the scenario loader to guarantee the CLI parses YAML/JSON
 * definitions as expected. The tests intentionally cover default inference and
 * validation errors so future schema changes remain backwards compatible.
 */
describe("evaluation scenarios", () => {
  it("parses a YAML definition with defaults", async () => {
    const scenario = await loadScenarioFromFile(resolve("tests/fixtures/eval/sampleScenario.yaml"));
    expect(scenario.id).to.equal("sample");
    expect(scenario.steps).to.have.length(2);
    expect(scenario.steps[0].expect?.success).to.equal(true);
    expect(scenario.steps[1].expect?.success).to.equal(false);
    expect(scenario.constraints.maxToolCalls).to.equal(2);
    expect(scenario.oracles).to.have.length(2);
  });

  it("enforces schema validation", () => {
    expect(() => parseScenario({ objective: "missing id", steps: [], oracles: [] })).to.throw(
      /Failed to parse scenario/,
    );
  });

  it("applies default expectations when omitted", () => {
    const scenario = parseScenario({
      id: "inline",
      objective: "defaults",
      steps: [{ id: "step", tool: "alpha" }],
      oracles: [{ type: "regex", pattern: "ok" }],
    });
    expect(scenario.steps[0].expect?.success).to.equal(true);
    expect(scenario.tags).to.deep.equal([]);
  });

  it("omits optional scenario fields when callers provide undefined placeholders", () => {
    const scenario = parseScenario({
      id: "inline-optional",
      objective: "omit undefined",
      tags: [],
      featureOverrides: {},
      constraints: { maxDurationMs: undefined },
      steps: [
        {
          id: "step",
          tool: "alpha",
          arguments: {},
          expect: {
            success: true,
            match: { pattern: "alpha" },
            notMatch: { pattern: "beta", flags: undefined },
          },
        },
      ],
      oracles: [
        { type: "regex", pattern: "ok" },
        { type: "script", module: "./validate", exportName: undefined },
      ],
    });

    expect(Object.prototype.hasOwnProperty.call(scenario, "featureOverrides")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(scenario.constraints, "maxDurationMs")).to.equal(false);

    const step = scenario.steps[0];
    expect(Object.prototype.hasOwnProperty.call(step, "arguments")).to.equal(false);
    expect(step.expect).to.not.equal(undefined);
    expect(step.expect?.notMatch).to.deep.equal({ pattern: "beta" });

    const regexOracle = scenario.oracles[0];
    if (regexOracle.type !== "regex") {
      throw new Error("expected regex oracle");
    }
    expect(Object.prototype.hasOwnProperty.call(regexOracle, "flags")).to.equal(false);

    const scriptOracle = scenario.oracles[1];
    if (scriptOracle.type !== "script") {
      throw new Error("expected script oracle");
    }
    expect(Object.prototype.hasOwnProperty.call(scriptOracle, "exportName")).to.equal(false);
  });
});
