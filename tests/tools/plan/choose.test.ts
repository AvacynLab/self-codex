import { describe, it } from "mocha";
import { expect } from "chai";

import { resolveChildrenPlans } from "../../../src/tools/plan/choose.js";
import type { PlanFanoutInput } from "../../../src/tools/planTools.js";

describe("plan tools / choose", () => {
  it("resolves explicit child list specifications without mutating the source", () => {
    const input: PlanFanoutInput = {
      prompt_template: { system: "system" },
      children_spec: {
        list: [
          {
            name: "alpha",
            runtime: "default",
            prompt_variables: { role: "analysis" },
            value_impacts: [
              { value: "ethics", impact: "support", rationale: "explicit" },
            ],
          },
        ],
      },
    };

    const resolved = resolveChildrenPlans(input, "agent-runtime");

    expect(resolved).to.have.lengthOf(1);
    const [child] = resolved;
    expect(child.runtime).to.equal("default");
    expect(child.promptVariables).to.deep.equal({ role: "analysis" });
    expect(child.valueImpacts).to.deep.equal([
      { value: "ethics", impact: "support", rationale: "explicit" },
    ]);

    // Ensure the helper clones value impacts so downstream callers can mutate safely.
    expect(input.children_spec?.list?.[0]?.value_impacts?.[0]).to.deep.equal({
      value: "ethics",
      impact: "support",
      rationale: "explicit",
    });
    expect(input.children_spec?.list?.[0]?.value_impacts?.[0]).to.not.equal(
      child.valueImpacts?.[0],
    );
  });

  it("expands template specifications and injects child indexes", () => {
    const input: PlanFanoutInput = {
      prompt_template: { system: "system" },
      children_spec: {
        count: 2,
        name_prefix: "clone",
        prompt_variables: { shared: "value" },
      },
    };

    const resolved = resolveChildrenPlans(input, "agent-runtime");

    expect(resolved.map((child) => child.name)).to.deep.equal(["clone-1", "clone-2"]);
    expect(resolved.every((child) => child.runtime === "agent-runtime")).to.equal(true);
    expect(resolved.map((child) => child.promptVariables.child_index)).to.deep.equal([1, 2]);
    expect(resolved.map((child) => child.promptVariables.shared)).to.deep.equal([
      "value",
      "value",
    ]);
  });

  it("falls back to the legacy children array when no spec is provided", () => {
    const input: PlanFanoutInput = {
      prompt_template: { system: "system" },
      children: [
        { name: "manual", prompt_variables: { injected: true } },
      ],
    };

    const resolved = resolveChildrenPlans(input, "runtime-default");

    expect(resolved).to.have.lengthOf(1);
    const [child] = resolved;
    expect(child.name).to.equal("manual");
    expect(child.runtime).to.equal("runtime-default");
    expect(child.promptVariables).to.deep.equal({ injected: true });
  });
});
