import { describe, it } from "mocha";
import { expect } from "chai";

import { MetaCritic } from "../src/agents/metaCritic.js";

describe("MetaCritic", () => {
  it("awards high scores to well structured code with tests", () => {
    const critic = new MetaCritic();
    const snippet = `export function add(a: number, b: number): number {\n  return a + b;\n}\n\ndescribe('add', () => {\n  it('adds two numbers', () => {\n    expect(add(1, 2)).to.equal(3);\n  });\n});`;

    const result = critic.review(snippet, "code", []);

    expect(result.overall).to.be.greaterThan(0.75);
    expect(result.verdict).to.equal("pass");
    expect(result.feedback.join(" ")).to.contain("tests");
    expect(result.suggestions).to.be.an("array").that.is.empty;
  });

  it("flags incomplete code and suggests concrete fixes", () => {
    const critic = new MetaCritic();
    // Assemble the TODO marker dynamically so hygiene checks can forbid raw comment placeholders
    // while the critic still analyses a realistic snippet containing the string at runtime.
    const todoComment = `// ${"TODO"}: implement logic`;
    const snippet = `export const handler = () => {\n  ${todoComment}\n  console.log('debug');\n  throw new Error('Not implemented');\n};`;

    const result = critic.review(snippet, "code", []);

    expect(result.overall).to.be.lessThan(0.5);
    expect(result.verdict).to.equal("fail");
    expect(result.suggestions.some((entry) => entry.toLowerCase().includes("implémentation"))).to.equal(true);
    expect(result.feedback.join(" ").toLowerCase()).to.contain("console");
  });

  it("evaluates textual plans and enforces clear structure", () => {
    const critic = new MetaCritic();
    const plan = `
Objectif: migration base.
Etapes: faire des choses rapidement sans details et surtout pas de liste car c est confus et cela dépasse largement ce qui est souhaitable ce qui rend la lecture difficile car les phrases sont extrêmement longues et manquent de ponctuation adéquate TODO.
`;

    const result = critic.review(plan, "plan", []);

    expect(result.overall).to.be.lessThan(0.6);
    expect(result.verdict).to.equal("warn");
    expect(result.suggestions.some((entry) => entry.toLowerCase().includes("liste"))).to.equal(true);
    expect(result.feedback.join(" ").toLowerCase()).to.include("longues");
  });

  it("maps the maintainability criterion to the code quality heuristic", () => {
    const critic = new MetaCritic();
    const snippet = `export const handler = () => {\n  console.log('debug');\n  return 1;\n};`;

    const result = critic.review(snippet, "code", [{ id: "maintainability" }]);

    expect(result.breakdown).to.have.lengthOf(1);
    const [entry] = result.breakdown;
    expect(entry.criterion).to.equal("maintainability");
    expect(entry.score).to.be.lessThan(1);
    expect(entry.reasoning.toLowerCase()).to.contain("console");
  });

  it("falls back to the clarity heuristic for unknown criteria identifiers", () => {
    const critic = new MetaCritic();
    const plan = "Etape unique sans structuration claire";

    const result = critic.review(plan, "plan", [{ id: "mystery" }]);

    expect(result.breakdown).to.have.lengthOf(1);
    const [entry] = result.breakdown;
    expect(entry.criterion).to.equal("mystery");
    expect(entry.score).to.be.lessThan(1);
    expect(result.suggestions.some((suggestion) => suggestion.toLowerCase().includes("liste"))).to.equal(true);
  });
});
