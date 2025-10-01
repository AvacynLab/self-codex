import { describe, it } from "mocha";
import { expect } from "chai";

import { ModelRouter, RoutingTaskDescriptor } from "../src/router/modelRouter.js";

describe("ModelRouter", () => {
  function createRouter() {
    const router = new ModelRouter({ fallbackModel: "codex-general", acceptanceThreshold: 0.3 });
    router.registerSpecialist({
      id: "vision-pro",
      description: "Optimised for image understanding",
      kinds: ["vision"],
      tags: ["diagram", "ocr"],
      maxTokens: 2048,
      priority: 2,
    });
    router.registerSpecialist({
      id: "code-smith",
      description: "TypeScript and Python focused model",
      kinds: ["code"],
      tags: ["refactor", "lint"],
      languages: ["en"],
      maxTokens: 8192,
      priority: 1,
    });
    router.registerSpecialist({
      id: "math-guru",
      description: "Symbolic reasoning runtime",
      kinds: ["math"],
      tags: ["compute-heavy"],
      scorer: (task: RoutingTaskDescriptor) => (task.metadata?.difficulty === "hard" ? 0.2 : 0),
    });
    return router;
  }

  it("routes tasks to the specialist matching the kind and tags", () => {
    const router = createRouter();
    const decision = router.route({
      kind: "vision",
      tags: ["diagram"],
      estimatedTokens: 1024,
    });

    expect(decision.model).to.equal("vision-pro");
    expect(decision.score).to.be.greaterThan(0.3);
    expect(decision.reason).to.include("kind:vision");
    expect(decision.reason).to.include("tags:diagram");
  });

  it("falls back to the default model when no specialist qualifies", () => {
    const router = createRouter();
    const decision = router.route({ kind: "audio" });

    expect(decision.model).to.equal("codex-general");
    expect(decision.reason).to.equal("fallback");
  });

  it("takes reliability into account when choosing between specialists", () => {
    const router = createRouter();
    const failingTask: RoutingTaskDescriptor = {
      kind: "code",
      tags: ["refactor"],
      estimatedTokens: 1_000,
      language: "en",
    };

    // Record multiple failures for the code specialist so the router considers it risky.
    for (let i = 0; i < 5; i += 1) {
      const decision = router.route(failingTask);
      router.recordOutcome(decision.model, { success: false });
    }

    const recoveryDecision = router.route(failingTask);
    expect(recoveryDecision.model).to.equal("codex-general");
    expect(recoveryDecision.reason).to.equal("fallback");
  });

  it("honours custom scorer hooks for advanced scenarios", () => {
    const router = createRouter();
    const decision = router.route({
      kind: "math",
      metadata: { difficulty: "hard" },
    });

    expect(decision.model).to.equal("math-guru");
    expect(decision.reason).to.include("score:");
  });
});
