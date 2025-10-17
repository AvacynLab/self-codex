import { describe, it } from "mocha";
import { expect } from "chai";

import { collectBudgetMetrics } from "../../src/infra/tracing.js";
import { handleJsonRpc } from "../../src/server.js";
import { configureRuntimeFeatures, getRuntimeFeatures } from "../../src/orchestrator/runtime.js";

declare module "mocha" {
  interface Context {
    runtimeFeaturesBackup?: ReturnType<typeof getRuntimeFeatures>;
  }
}

function sumToolCallConsumption(method: string): number {
  return collectBudgetMetrics()
    .filter((snapshot) => snapshot.method === method && snapshot.dimension === "toolCalls")
    .reduce((total, snapshot) => total + snapshot.consumed, 0);
}

describe("JSON-RPC tool budgets", () => {
  it("consumes facade budgets when routing a request", async function () {
    // Capture the snapshot lazily inside the test so concurrent suites that
    // tweak runtime features cannot reset the flag between the hook and the
    // assertion. Restoring happens in a `finally` block to keep the runtime in
    // a consistent state even when the test fails midway.
    this.runtimeFeaturesBackup = getRuntimeFeatures();
    configureRuntimeFeatures({
      ...this.runtimeFeaturesBackup,
      enableToolRouter: true,
    });

    const before = sumToolCallConsumption("intent_route");

    try {
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
    } finally {
      if (this.runtimeFeaturesBackup) {
        configureRuntimeFeatures(this.runtimeFeaturesBackup);
      }
    }
  });
});
