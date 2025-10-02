import { describe, it } from "mocha";
import { expect } from "chai";

import {
  PlanCompileBTInputSchema,
  PlanRunBTInputSchema,
} from "../src/tools/planTools.js";
import { CausalExplainInputSchema } from "../src/tools/causalTools.js";
import {
  ValuesFilterInputSchema,
  ValuesSetInputSchema,
} from "../src/tools/valueTools.js";

/**
 * Validation-focused regression tests ensuring the server-facing schemas reject
 * malformed payloads deterministically. Keeping those checks centralised avoids
 * relying on MCP integration tests to catch regressions.
 */
describe("server tool schemas", () => {
  it("rejects Behaviour Tree compilation payloads lacking a graph", () => {
    const result = PlanCompileBTInputSchema.safeParse({});
    expect(result.success).to.equal(false);
  });

  it("rejects Behaviour Tree run payloads with an invalid timeout", () => {
    const definition = {
      id: "bt-test",
      root: { type: "task", node_id: "noop", tool: "noop" },
    };
    const result = PlanRunBTInputSchema.safeParse({
      tree: definition,
      timeout_ms: 0,
    });
    expect(result.success).to.equal(false);
  });

  it("rejects causal explanations without an outcome id", () => {
    const result = CausalExplainInputSchema.safeParse({ outcome_id: "" });
    expect(result.success).to.equal(false);
  });

  it("rejects value graph updates that omit node definitions", () => {
    const result = ValuesSetInputSchema.safeParse({ nodes: [] });
    expect(result.success).to.equal(false);
  });

  it("rejects value guard evaluations without impacts", () => {
    const result = ValuesFilterInputSchema.safeParse({
      impacts: [],
    });
    expect(result.success).to.equal(false);
  });
});
