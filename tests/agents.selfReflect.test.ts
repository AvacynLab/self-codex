import { describe, it } from "mocha";
import { expect } from "chai";

import { reflect } from "../src/agents/selfReflect.js";
import {
  codeReflectionFixture,
  textReflectionFixture,
  planReflectionFixture,
  minimalReflectionFixture,
} from "../src/agents/__tests__/selfReflect.fixtures.js";

describe("agents/selfReflect", () => {
  it("produces actionable feedback for code outputs", async () => {
    const result = await reflect(codeReflectionFixture);

    expect(result.insights).to.not.be.empty;
    expect(result.insights.some((entry) => entry.toLowerCase().includes("tests"))).to.equal(true);
    expect(result.nextSteps.some((entry) => entry.toLowerCase().includes("todo"))).to.equal(true);
    expect(result.nextSteps.some((entry) => entry.toLowerCase().includes("lint"))).to.equal(true);
  });

  it("analyses textual summaries and highlights readability improvements", async () => {
    const result = await reflect(textReflectionFixture);

    expect(result.insights.some((entry) => entry.toLowerCase().includes("texte"))).to.equal(true);
    expect(result.nextSteps.some((entry) => entry.toLowerCase().includes("clarifier"))).to.equal(true);
  });

  it("identifies missing mitigation steps in plans", async () => {
    const result = await reflect(planReflectionFixture);

    expect(result.insights.some((entry) => entry.toLowerCase().includes("plan"))).to.equal(true);
    expect(result.nextSteps.some((entry) => entry.toLowerCase().includes("étapes"))).to.equal(true);
    expect(result.risks.some((entry) => entry.toLowerCase().includes("dépendances"))).to.equal(true);
  });

  it("remains robust with minimal input", async () => {
    const result = await reflect(minimalReflectionFixture);

    expect(result.insights).to.not.be.empty;
    expect(result.nextSteps).to.not.be.empty;
    expect(result.risks).to.not.be.empty;
  });
});
