import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { parsePlannerPlan, PlanSpecificationError } from "../../src/planner/domain.js";
import { buildPlanSchedule, PlanSchedulingError } from "../../src/planner/schedule.js";
import { compilePlannerPlan, INPUT_VARIABLE_PREFIX, GUARD_VARIABLE_PREFIX } from "../../src/planner/compileBT.js";
import {
  handlePlanCompileExecute,
  PlanCompileExecuteInputSchema,
  type PlanCompileExecuteInput,
  type PlanToolContext,
} from "../../src/tools/planTools.js";
import { PlanLifecycleRegistry } from "../../src/executor/planLifecycle.js";
import { StigmergyField } from "../../src/coord/stigmergy.js";

/** Build a minimal context satisfying {@link PlanToolContext} requirements for tests. */
function buildContext(overrides: Partial<PlanToolContext> = {}): { context: PlanToolContext; events: sinon.SinonSpy } {
  const logger =
    overrides.logger ??
    ({
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
    } as unknown as PlanToolContext["logger"]);

  const emitEvent = overrides.emitEvent ?? sinon.spy();
  const planLifecycle = overrides.planLifecycle ?? new PlanLifecycleRegistry();

  const context: PlanToolContext = {
    supervisor: overrides.supervisor ?? ({} as PlanToolContext["supervisor"]),
    graphState: overrides.graphState ?? ({} as PlanToolContext["graphState"]),
    logger,
    childrenRoot: overrides.childrenRoot ?? "/tmp",
    defaultChildRuntime: overrides.defaultChildRuntime ?? "codex",
    emitEvent: emitEvent as PlanToolContext["emitEvent"],
    stigmergy: overrides.stigmergy ?? new StigmergyField(),
    planLifecycle,
    planLifecycleFeatureEnabled: overrides.planLifecycleFeatureEnabled ?? true,
    autoscaler: overrides.autoscaler,
    supervisorAgent: overrides.supervisorAgent,
    blackboard: overrides.blackboard,
    causalMemory: overrides.causalMemory,
    valueGuard: overrides.valueGuard,
    loopDetector: overrides.loopDetector,
    btStatusRegistry: overrides.btStatusRegistry,
    activeCancellation: overrides.activeCancellation ?? null,
    idempotency: overrides.idempotency,
  } as PlanToolContext;

  return { context, events: emitEvent as sinon.SinonSpy };
}

/** Generate a sample planner specification used by multiple tests. */
function createSamplePlan(): PlanCompileExecuteInput {
  return {
    plan: {
      id: "demo-plan",
      version: "1.0.0",
      title: "Demo",
      tasks: [
        {
          id: "prepare",
          tool: "bb_set",
          input: { key: "ready", value: true },
          postconditions: [
            { id: "prep_done", description: "Preparation complete", kind: "post" },
          ],
          estimated_duration_ms: 50,
        },
        {
          id: "execute",
          tool: "wait",
          depends_on: ["prepare"],
          preconditions: [
            {
              id: "prep_done",
              description: "Preparation acknowledged",
              kind: "pre",
            },
          ],
          timeout_ms: 5000,
          estimated_duration_ms: 75,
        },
        {
          id: "finalise",
          tool: "noop",
          depends_on: ["execute"],
          estimated_duration_ms: 25,
        },
      ],
    },
    dry_run: true,
  } satisfies PlanCompileExecuteInput;
}

/** Validate parsing support for JSON and YAML specifications. */
describe("planner specification parsing", () => {
  it("parses JSON payloads and enforces uniqueness", () => {
    const jsonPlan = {
      id: "json-plan",
      tasks: [
        { id: "a", tool: "noop" },
        { id: "b", tool: "noop", depends_on: ["a"] },
      ],
    };

    const parsed = parsePlannerPlan(JSON.stringify(jsonPlan));
    expect(parsed.id).to.equal("json-plan");
    expect(parsed.tasks).to.have.lengthOf(2);

    expect(() =>
      parsePlannerPlan(
        JSON.stringify({ id: "dup", tasks: [{ id: "a", tool: "noop" }, { id: "a", tool: "noop" }] }),
      ),
    ).to.throw(PlanSpecificationError);
  });

  it("accepts YAML payloads with nested metadata", () => {
    const yamlSpec = [
      "id: yaml-plan",
      "title: Example YAML",
      "tasks:",
      "  - id: first",
      "    tool: noop",
      "  - id: second",
      "    tool: noop",
      "    depends_on: [first]",
    ].join("\n");

    const parsed = parsePlannerPlan(yamlSpec);
    expect(parsed.id).to.equal("yaml-plan");
    expect(parsed.tasks[1].depends_on).to.deep.equal(["first"]);
  });
});

/** Exercise the critical path scheduler and error handling. */
describe("planner scheduling", () => {
  it("computes earliest/latest dates and slack", () => {
    const plan = parsePlannerPlan({
      id: "schedule",
      tasks: [
        { id: "a", tool: "noop", estimated_duration_ms: 10 },
        { id: "b", tool: "noop", depends_on: ["a"], estimated_duration_ms: 20 },
        { id: "c", tool: "noop", depends_on: ["a"], estimated_duration_ms: 5 },
        { id: "d", tool: "noop", depends_on: ["b", "c"], estimated_duration_ms: 15 },
      ],
    });

    const schedule = buildPlanSchedule(plan);
    expect(schedule.totalEstimatedDurationMs).to.equal(45);
    expect(schedule.criticalPath).to.deep.equal(["a", "b", "d"]);
    expect(schedule.tasks.c.slackMs).to.be.greaterThan(0);
    expect(schedule.phases[1].tasks).to.have.lengthOf(2);
  });

  it("throws when cycles are detected", () => {
    const plan = {
      id: "cyclic",
      tasks: [
        { id: "a", tool: "noop", depends_on: ["b"] },
        { id: "b", tool: "noop", depends_on: ["a"] },
      ],
    };

    expect(() => buildPlanSchedule(parsePlannerPlan(plan))).to.throw(PlanSchedulingError);
  });
});

/** Validate the behaviour tree compilation pipeline. */
describe("planner compilation", () => {
  it("wraps inputs, preconditions, and timeouts in the behaviour tree", () => {
    const planInput = createSamplePlan();
    const plan = parsePlannerPlan(planInput.plan);
    const compilation = compilePlannerPlan(plan);

    expect(compilation.behaviorTree.root.type).to.equal("sequence");
    const phaseOne = (compilation.behaviorTree.root as any).children[0];
    expect(phaseOne.type).to.equal("task");
    expect(phaseOne.input_key).to.equal(`${INPUT_VARIABLE_PREFIX}.prepare`);

    const phaseTwo = (compilation.behaviorTree.root as any).children[1];
    expect(phaseTwo.type).to.equal("guard");
    expect(phaseTwo.child.type).to.equal("timeout");
    expect(phaseTwo.child.child.type).to.equal("task");

    const guardKeys = Object.keys(compilation.guardConditions);
    expect(guardKeys).to.include(`${GUARD_VARIABLE_PREFIX}.execute.prep_done`);
  });

  it("compiles and registers plan lifecycle runs", () => {
    const { context, events } = buildContext();
    const input = createSamplePlan();
    const parsed = PlanCompileExecuteInputSchema.parse(input);
    const result = handlePlanCompileExecute(context, parsed);

    expect(result.plan_id).to.equal("demo-plan");
    expect(result.schedule.phases.length).to.equal(3);
    expect(result.stats.parallel_phases).to.equal(0);
    expect(result.guard_conditions).to.have.property(`${GUARD_VARIABLE_PREFIX}.execute.prep_done`);
    expect(result.variable_bindings).to.have.property(`${INPUT_VARIABLE_PREFIX}.prepare`);

    const snapshot = context.planLifecycle!.getSnapshot(result.run_id);
    expect(snapshot.state).to.equal("done");
    expect(snapshot.run_id).to.equal(result.run_id);

    sinon.assert.calledOnce(events);
    const eventPayload = events.getCall(0).args[0];
    expect(eventPayload.payload.event).to.equal("plan_compiled");
    expect(eventPayload.payload.plan_id).to.equal("demo-plan");
  });
});
