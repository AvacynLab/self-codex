import { expect } from "chai";
import { describe, it } from "mocha";
import { resolve } from "node:path";

import {
  loadScenarioFromFile,
  loadScenariosFromDirectory,
  parseScenario,
} from "../../src/eval/scenario.js";

/**
 * Recursively asserts that the provided value tree never materialises
 * `undefined` entries. The helper mirrors the optional-field assertions used
 * across the MCP suites so documentation fixtures remain aligned with the
 * sanitisation guarantees enforced by the scenario loader.
 */
function assertNoUndefinedValues(value: unknown, path = "scenario"): void {
  if (value === undefined) {
    throw new Error(`unexpected undefined value at ${path}`);
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNoUndefinedValues(entry, `${path}[${index}]`);
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assertNoUndefinedValues(entry, `${path}.${key}`);
  }
}

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
    const firstStep = scenario.steps[0]!;
    expect(firstStep.expect?.match).to.equal("ok");
    expect(Object.prototype.hasOwnProperty.call(firstStep.expect ?? {}, "success")).to.equal(false);

    const secondStep = scenario.steps[1]!;
    expect(secondStep.expect?.success).to.equal(false);
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
    const step = scenario.steps[0]!;
    expect(Object.prototype.hasOwnProperty.call(step, "expect")).to.equal(false);
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

    const step = scenario.steps[0]!;
    expect(Object.prototype.hasOwnProperty.call(step, "arguments")).to.equal(false);
    expect(step.expect).to.not.equal(undefined);
    expect(Object.prototype.hasOwnProperty.call(step.expect ?? {}, "success")).to.equal(false);
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

  it("omits optional fields across repository scenarios", async () => {
    const scenarios = await loadScenariosFromDirectory(resolve("scenarios"));
    const introspection = scenarios.find((entry) => entry.id === "introspection-smoke");
    if (!introspection) {
      throw new Error("expected to load the introspection smoke scenario");
    }

    assertNoUndefinedValues(introspection, "scenario[introspection-smoke]");

    const [infoStep, capabilitiesStep, resourcesStep] = introspection.steps;
    if (!infoStep || !capabilitiesStep || !resourcesStep) {
      throw new Error("expected the introspection scenario to define three steps");
    }

    // Steps using empty argument objects should omit the property after
    // sanitisation while populated payloads remain intact for downstream
    // executors.
    expect(Object.prototype.hasOwnProperty.call(infoStep, "arguments")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(capabilitiesStep, "arguments")).to.equal(false);
    expect(resourcesStep.arguments).to.deep.equal({ limit: 10 });

    // The scenario advertises the required MCP tools via constraints; ensure
    // the sanitiser keeps the populated optional field.
    expect(introspection.constraints.requiredTools).to.deep.equal([
      "mcp_info",
      "mcp_capabilities",
    ]);
  });
});
