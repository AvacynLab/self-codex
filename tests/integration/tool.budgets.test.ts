import { describe, it } from "mocha";
import { expect } from "chai";

import { collectBudgetMetrics } from "../../src/infra/tracing.js";
import { handleJsonRpc } from "../../src/server.js";

function sumToolCallConsumption(method: string): number {
  return collectBudgetMetrics()
    .filter((snapshot) => snapshot.method === method && snapshot.dimension === "toolCalls")
    .reduce((total, snapshot) => total + snapshot.consumed, 0);
}

describe("JSON-RPC tool budgets", () => {
  it("consumes facade budgets when routing a request", async () => {
    const before = sumToolCallConsumption("intent_route");

    const response = await handleJsonRpc({
      jsonrpc: "2.0",
      id: "intent-budget",
      method: "intent_route",
      params: { natural_language_goal: "écrire un fichier" },
    });

    expect(response.error).to.equal(undefined);
    const result = response.result as { ok?: boolean };
    expect(result?.ok).to.equal(true);

    const after = sumToolCallConsumption("intent_route");
    expect(after).to.be.greaterThan(
      before,
      "tool budget consumption should increase after invoking intent_route",
    );
  });
});
