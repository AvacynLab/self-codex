import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChildSupervisor } from "../src/children/supervisor.js";
import { GraphState } from "../src/graph/state.js";
import { StructuredLogger } from "../src/logger.js";
import { ValueGraph } from "../src/values/valueGraph.js";
import {
  PlanFanoutInputSchema,
  PlanReduceInputSchema,
  PlanToolContext,
  ValueGuardRejectionError,
  ValueGuardRequiredError,
  handlePlanFanout,
  handlePlanReduce,
} from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { resolveFixture, runnerArgs } from "./helpers/childRunner.js";

const mockRunnerPath = resolveFixture(import.meta.url, "./fixtures/mock-runner.ts");
const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);

/**
 * Builds a plan tool context wired with a configured value guard. The helper
 * mirrors the orchestrator setup so the integration exercises the actual
 * supervisor, graph state and logger stack.
 */
function createPlanContext(options: {
  childrenRoot: string;
  supervisor: ChildSupervisor;
  graphState: GraphState;
  logger: StructuredLogger;
  events: Array<{ kind: string; payload?: unknown }>;
  valueGraph?: ValueGraph | null;
}): PlanToolContext {
  const stigmergy = new StigmergyField();
  return {
    supervisor: options.supervisor,
    graphState: options.graphState,
    logger: options.logger,
    childrenRoot: options.childrenRoot,
    defaultChildRuntime: "codex",
    emitEvent: (event) => {
      options.events.push({ kind: event.kind, payload: event.payload });
    },
    stigmergy,
    valueGuard: options.valueGraph ? { graph: options.valueGraph, registry: new Map() } : undefined,
  };
}

/**
 * Sends a prompt to a child and waits for the mock runner to echo the response.
 * Waiting guarantees that `plan_reduce` observes the final transcript message.
 */
async function sendPromptAndWait(
  supervisor: ChildSupervisor,
  childId: string,
  content: string,
): Promise<void> {
  await supervisor.send(childId, { type: "prompt", content });
  await supervisor.waitForMessage(
    childId,
    (message) => {
      const parsed = message.parsed as { type?: string; content?: unknown } | null;
      return parsed?.type === "response" && parsed.content === content;
    },
    2_000,
  );
}

/** Validates the guard integration across fan-out and reduction flows. */
describe("plan tools value guard integration", () => {
  it("refuses riskful fan-out when the value guard is disabled", async function () {
    this.timeout(10_000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-values-guard-disabled-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs(),
    });
    const graphState = new GraphState();
    const logger = new StructuredLogger({ logFile: path.join(childrenRoot, "tmp", "orchestrator.log") });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, events, valueGraph: null });

    try {
      const input = PlanFanoutInputSchema.parse({
        goal: "Dispatch network write",
        prompt_template: { system: "Clone", user: "Task" },
        children_spec: {
          list: [
            {
              name: "alpha",
              value_impacts: [
                { value: "network_write", impact: "risk", severity: 0.8 },
              ],
            },
            {
              name: "beta",
              value_impacts: [
                { value: "safety", impact: "risk", severity: 0.6 },
              ],
            },
          ],
        },
      });

      let caught: unknown;
      try {
        await handlePlanFanout(context, input);
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(ValueGuardRequiredError);
      const guardError = caught as ValueGuardRequiredError;
      // Every risky child must be reported so operators know which plans were
      // skipped until the guard is enabled again.
      expect(guardError.children).to.deep.equal(["alpha", "beta"]);
      expect(events).to.be.empty;
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("rejects a fan-out when every plan violates the guard", async function () {
    this.timeout(10_000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-values-reject-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs(),
    });
    const graphState = new GraphState();
    const logger = new StructuredLogger({ logFile: path.join(childrenRoot, "tmp", "orchestrator.log") });
    const valueGraph = new ValueGraph();
    valueGraph.set({
      defaultThreshold: 0.6,
      values: [
        { id: "privacy", weight: 1, tolerance: 0.25 },
        { id: "safety", weight: 1, tolerance: 0.3 },
      ],
      relationships: [{ from: "privacy", to: "safety", kind: "supports", weight: 0.5 }],
    });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, valueGraph, events });

    try {
      const input = PlanFanoutInputSchema.parse({
        goal: "Ship risky feature",
        prompt_template: { system: "Clone", user: "Task" },
        children_spec: {
          list: [
            {
              name: "alpha",
              value_impacts: [
                { value: "privacy", impact: "risk", severity: 0.9 },
                { value: "safety", impact: "risk", severity: 0.8 },
              ],
            },
            {
              name: "beta",
              value_impacts: [
                { value: "privacy", impact: "risk", severity: 0.8 },
                { value: "safety", impact: "risk", severity: 0.7 },
              ],
            },
          ],
        },
      });

      let caught: unknown;
      try {
        await handlePlanFanout(context, input);
      } catch (error) {
        caught = error;
      }
      expect(caught).to.be.instanceOf(ValueGuardRejectionError);
      const rejection = caught as ValueGuardRejectionError;
      expect(rejection.rejections).to.have.length(2);
      expect(events.some((event) => event.kind === "PLAN")).to.equal(false);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("records guard decisions on accepted children and surfaces them in reductions", async function () {
    this.timeout(15_000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-values-accept-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs(),
    });
    const graphState = new GraphState();
    const logger = new StructuredLogger({ logFile: path.join(childrenRoot, "tmp", "orchestrator.log") });
    const valueGraph = new ValueGraph();
    valueGraph.set({
      defaultThreshold: 0.6,
      values: [
        { id: "privacy", weight: 1, tolerance: 0.3 },
        { id: "safety", weight: 1, tolerance: 0.4 },
        { id: "compliance", weight: 0.8, tolerance: 0.6 },
      ],
      relationships: [
        { from: "privacy", to: "safety", kind: "supports", weight: 0.5 },
        { from: "safety", to: "compliance", kind: "supports", weight: 0.4 },
      ],
    });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, valueGraph, events });

    try {
      const fanout = await handlePlanFanout(
        context,
        PlanFanoutInputSchema.parse({
          goal: "Deliver guarded feature",
          prompt_template: { system: "Clone {{child_name}}", user: "Mission {{goal}}" },
          children_spec: {
            list: [
              {
                name: "gamma",
                value_impacts: [
                  { value: "privacy", impact: "support", severity: 0.8 },
                  { value: "compliance", impact: "support", severity: 0.6 },
                ],
              },
              {
                name: "delta",
                value_impacts: [
                  { value: "privacy", impact: "risk", severity: 0.3 },
                  { value: "safety", impact: "risk", severity: 0.4 },
                ],
              },
            ],
          },
        }),
      );

      expect(fanout.planned).to.have.length(1);
      expect(fanout.child_ids).to.have.length(1);
      const planned = fanout.planned[0]!;
      expect(planned.value_guard).to.not.equal(null);
      expect(planned.value_guard?.allowed).to.equal(true);
      expect(context.valueGuard?.registry.size).to.equal(1);

      await Promise.all(
        fanout.child_ids.map((childId, index) =>
          sendPromptAndWait(supervisor, childId, `response-${index + 1}`),
        ),
      );

      const reduce = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanout.child_ids,
          reducer: "concat",
        }),
      );

      expect(reduce.aggregate).to.be.a("string");
      expect(reduce.trace.per_child).to.have.length(1);
      expect(reduce.trace.details).to.have.property("value_guard");
      const guardTrace = reduce.trace.details?.value_guard as Record<string, unknown> | undefined;
      expect(guardTrace).to.not.equal(undefined);
      if (guardTrace) {
        expect(guardTrace).to.have.property(fanout.child_ids[0]!);
      }
      expect(context.valueGuard?.registry.size).to.equal(0);
      expect(events.some((event) => event.kind === "PLAN")).to.equal(true);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
