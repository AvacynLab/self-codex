import { describe, it } from "mocha";
import { expect } from "chai";

/**
 * Regression tests covering the validation CLI wrappers to ensure every stage
 * clones the host environment and drops `undefined` placeholders before invoking
 * the underlying workflows. The suite keeps the sanitisation logic aligned with
 * the strict optional property checks enforced across the codebase.
 */
describe("validation scripts omit undefined environment entries", () => {
  function assertSanitisedEnv(
    rawEnv: NodeJS.ProcessEnv,
    sanitised: NodeJS.ProcessEnv,
  ) {
    expect(sanitised).to.not.equal(rawEnv);
    expect(sanitised).to.have.property("KEEP", "value");
    expect(sanitised).to.have.property("EMPTY", "");
    expect(Object.prototype.hasOwnProperty.call(sanitised, "OMIT")).to.equal(false);
    expect(rawEnv.OMIT).to.equal(undefined);
  }

  it("sanitises the children validation runner", async () => {
    const { prepareChildrenCliInvocation } = await import("../scripts/runChildrenPhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareChildrenCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the coordination validation runner", async () => {
    const { prepareCoordinationCliInvocation } = await import("../scripts/runCoordinationPhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareCoordinationCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the graph forge validation runner", async () => {
    const { prepareGraphForgeCliInvocation } = await import("../scripts/runGraphForgePhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareGraphForgeCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the introspection validation runner", async () => {
    const { prepareIntrospectionCliInvocation } = await import("../scripts/runIntrospectionPhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareIntrospectionCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the knowledge validation runner", async () => {
    const { prepareKnowledgeCliInvocation } = await import("../scripts/runKnowledgePhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareKnowledgeCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the performance validation runner", async () => {
    const { preparePerformanceCliInvocation } = await import("../scripts/runPerformancePhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = preparePerformanceCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the planning validation runner", async () => {
    const { preparePlanPhaseEnvironment } = await import("../scripts/runPlanPhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const env = preparePlanPhaseEnvironment(rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the robustness validation runner", async () => {
    const { prepareRobustnessCliInvocation } = await import("../scripts/runRobustnessPhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareRobustnessCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the security validation runner", async () => {
    const { prepareSecurityCliInvocation } = await import("../scripts/runSecurityPhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareSecurityCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the transactions validation runner", async () => {
    const { prepareTransactionsCliInvocation } = await import("../scripts/runTransactionsPhase.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareTransactionsCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });

  it("sanitises the final report stage", async () => {
    const { prepareFinalReportCliInvocation } = await import("../scripts/runFinalReportStage.ts");
    const rawEnv: NodeJS.ProcessEnv = { KEEP: "value", EMPTY: "", OMIT: undefined };
    const { env } = prepareFinalReportCliInvocation([], rawEnv);
    assertSanitisedEnv(rawEnv, env);
  });
});
