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
import { GraphState } from "../../src/graph/state.js";
import {
  createPlanToolContext,
  type PlanToolContextOverrides,
} from "../helpers/planContext.js";

/**
 * Builds a deterministic {@link PlanToolContext} for compilation tests while
 * keeping every dependency swappable. The helper records emitted events via a
 * Sinon spy so assertions can observe the payload without reaching into
 * internals or resorting to unsafe casts.
 */
function buildContext(
  overrides: PlanToolContextOverrides = {},
): { context: PlanToolContext; events: sinon.SinonSpy<[Parameters<PlanToolContext["emitEvent"]>[0]], void> } {
  const eventSpy = sinon.spy((event: Parameters<PlanToolContext["emitEvent"]>[0]) => {
    // The spy captures the structured telemetry emitted by plan compilation.
  });

  const emitEvent: PlanToolContext["emitEvent"] =
    overrides.emitEvent ?? ((event) => {
      eventSpy(event);
    });

  const planLifecycle = overrides.planLifecycle ?? new PlanLifecycleRegistry();

  const context = createPlanToolContext({
    ...overrides,
    emitEvent,
    planLifecycle,
    planLifecycleFeatureEnabled: overrides.planLifecycleFeatureEnabled ?? true,
    graphState: overrides.graphState ?? new GraphState(),
    stigmergy: overrides.stigmergy ?? new StigmergyField(),
  });

  return { context, events: eventSpy };
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

  it("omits optional planner fields that were not provided", () => {
    const parsed = parsePlannerPlan({
      id: "sanitised-plan",
      tasks: [
        {
          id: "alpha",
          tool: "noop",
          preconditions: [
            {
              description: "alpha must be ready",
              kind: "pre",
            },
          ],
          resources: [
            {
              name: "cpu",
            },
          ],
        },
      ],
    });

    // Parsing must strip optional keys outright so downstream TypeScript models
    // never observe `{ key: undefined }` placeholders once strict optional typing
    // is enabled.
    expect(Object.prototype.hasOwnProperty.call(parsed, "version")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "title")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "description")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "metadata")).to.equal(false);

    const [task] = parsed.tasks;
    expect(Object.prototype.hasOwnProperty.call(task, "name")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(task, "description")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(task, "input")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(task, "estimated_duration_ms")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(task, "timeout_ms")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(task, "metadata")).to.equal(false);

    const [precondition] = task.preconditions;
    expect(Object.prototype.hasOwnProperty.call(precondition, "id")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(precondition, "expression")).to.equal(false);

    const [resource] = task.resources;
    expect(Object.prototype.hasOwnProperty.call(resource, "quantity")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(resource, "unit")).to.equal(false);
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

  it("omits optional metadata when the planner specification leaves it blank", () => {
    const plan = parsePlannerPlan({
      id: "metadata-sanitised",
      tasks: [
        { id: "root", tool: "noop" },
        { id: "child", tool: "noop", depends_on: ["root"] },
      ],
    });

    const schedule = buildPlanSchedule(plan);
    const rootTask = schedule.tasks.root;
    const childTask = schedule.tasks.child;

    // The scheduler must not expose placeholder keys because strict optional
    // typing treats `undefined` assignments as observable payload changes.
    expect(Object.prototype.hasOwnProperty.call(rootTask, "name")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(rootTask, "description")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(childTask, "name")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(childTask, "description")).to.equal(false);

    // Phase groupings reuse the same objects; ensure the omission propagates.
    const phaseTasks = schedule.phases.flatMap((phase) => phase.tasks);
    for (const task of phaseTasks) {
      expect(Object.prototype.hasOwnProperty.call(task, "name")).to.equal(false);
      expect(Object.prototype.hasOwnProperty.call(task, "description")).to.equal(false);
    }
  });
});

/** Validate the behaviour tree compilation pipeline. */
describe("planner compilation", () => {
  it("wraps inputs, preconditions, and timeouts in the behaviour tree", () => {
    const planInput = createSamplePlan();
    const plan = parsePlannerPlan(planInput.plan);
    const compilation = compilePlannerPlan(plan);

    const rootNode = compilation.behaviorTree.root;
    expect(rootNode.type).to.equal("sequence");
    if (rootNode.type !== "sequence") {
      throw new Error("expected planner compilation to produce a sequence root node");
    }

    const [phaseOne, phaseTwo] = rootNode.children;
    if (!phaseOne || !phaseTwo) {
      throw new Error("expected planner sequence to contain at least two phases");
    }

    expect(phaseOne.type).to.equal("task");
    if (phaseOne.type !== "task") {
      throw new Error("expected first phase to be a task node");
    }
    expect(phaseOne.input_key).to.equal(`${INPUT_VARIABLE_PREFIX}.prepare`);

    expect(phaseTwo.type).to.equal("guard");
    if (phaseTwo.type !== "guard") {
      throw new Error("expected second phase to be a guard node");
    }
    expect(phaseTwo.child.type).to.equal("timeout");
    if (phaseTwo.child.type !== "timeout") {
      throw new Error("expected guard child to wrap a timeout node");
    }
    expect(phaseTwo.child.child.type).to.equal("task");

    const guardKeys = Object.keys(compilation.guardConditions);
    expect(guardKeys).to.include(`${GUARD_VARIABLE_PREFIX}.execute.prep_done`);
  });

  it("omits behaviour-tree input bindings when the planner task has no payload", () => {
    const plan = parsePlannerPlan({
      id: "optional-input",
      tasks: [
        {
          id: "noop-task",
          tool: "noop",
          // Intentionally omit `input` so the compiled node should not expose an
          // `input_key` field once optional properties are enforced.
        },
      ],
    });

    const compilation = compilePlannerPlan(plan);
    const rootNode = compilation.behaviorTree.root;

    expect(rootNode.type).to.equal("task");
    if (rootNode.type !== "task") {
      throw new Error("expected a single task node when compiling a trivial plan");
    }

    expect(Object.prototype.hasOwnProperty.call(rootNode, "input_key"))
      .to.equal(false, "input_key should be omitted when the planner task has no payload");
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
