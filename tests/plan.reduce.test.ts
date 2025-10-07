import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor } from "../src/childSupervisor.js";
import { GraphState } from "../src/graphState.js";
import { StructuredLogger } from "../src/logger.js";
import {
  PlanFanoutInputSchema,
  PlanReduceInputSchema,
  PlanToolContext,
  handlePlanFanout,
  handlePlanReduce,
} from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));

/**
 * Builds a minimal plan tool context for the tests. The context mirrors the
 * orchestrator wiring so reducers exercise the real supervisor/graph/log stack.
 */
function createPlanContext(options: {
  childrenRoot: string;
  supervisor: ChildSupervisor;
  graphState: GraphState;
  logger: StructuredLogger;
  events: Array<{ kind: string; payload?: unknown }>;
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
  };
}

/**
 * Sends a prompt to a child and waits for the runner to acknowledge it with a
 * final `response` message. Waiting guarantees `plan_reduce` observes the
 * expected terminal message when collecting outputs.
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

describe("plan_reduce tool", () => {
  it("concatenates child summaries in call order", async function () {
    this.timeout(10_000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-reduce-concat-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath],
    });
    const graphState = new GraphState();
    const logger = new StructuredLogger({ logFile: path.join(childrenRoot, "tmp", "orchestrator.log") });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, events });

    try {
      const fanout = await handlePlanFanout(
        context,
        PlanFanoutInputSchema.parse({
          goal: "Comparer des options",
          prompt_template: {
            system: "Clone {{child_name}}",
            user: "Analyse {{goal}}",
          },
          children_spec: { count: 3, name_prefix: "concat" },
        }),
      );

      const expected = ["option-A", "option-B", "option-C"];
      await Promise.all(
        fanout.child_ids.map((childId, index) => sendPromptAndWait(supervisor, childId, expected[index]!)),
      );

      const reduceResult = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanout.child_ids,
          reducer: "concat",
        }),
      );
      expect(reduceResult.op_id).to.match(/^plan_reduce_op_/);

      expect(reduceResult.aggregate).to.equal(expected.join("\n\n"));
      expect(reduceResult.trace.per_child).to.have.length(expected.length);
      // Order must remain stable so we can rely on positional concatenation.
      expect(
        reduceResult.trace.per_child.map((entry) => entry.summary),
      ).to.deep.equal(expected);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("merges JSON objects while reporting malformed summaries", async function () {
    this.timeout(10_000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-reduce-merge-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath],
    });
    const graphState = new GraphState();
    const logger = new StructuredLogger({ logFile: path.join(childrenRoot, "tmp", "orchestrator.log") });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, events });

    try {
      const fanout = await handlePlanFanout(
        context,
        PlanFanoutInputSchema.parse({
          goal: "Fusionner des hypotheses",
          prompt_template: {
            system: "Clone {{child_name}}",
            user: "But {{goal}}",
          },
          children_spec: { count: 3, name_prefix: "merge" },
        }),
      );

      const summaries = [
        '{"feature":"alpha","score":1}',
        '{"feature":"beta"}',
        "pas-json",
      ];
      await Promise.all(
        fanout.child_ids.map((childId, index) => sendPromptAndWait(supervisor, childId, summaries[index]!)),
      );

      const reduceResult = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanout.child_ids,
          reducer: "merge_json",
        }),
      );
      expect(reduceResult.op_id).to.match(/^plan_reduce_op_/);

      expect(reduceResult.aggregate).to.deep.equal({ feature: "beta", score: 1 });
      expect(reduceResult.trace.per_child).to.have.length(3);
      const details = reduceResult.trace.details as
        | { errors?: Record<string, string> }
        | undefined;
      expect(details?.errors).to.not.equal(undefined);
      const errorMessage = details?.errors?.[fanout.child_ids[2]!];
      expect(errorMessage).to.be.a("string");
      expect(errorMessage).to.contain("Unexpected token");
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("selects the majority answer when voting", async function () {
    this.timeout(10_000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "plan-reduce-vote-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath],
    });
    const graphState = new GraphState();
    const logger = new StructuredLogger({ logFile: path.join(childrenRoot, "tmp", "orchestrator.log") });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context = createPlanContext({ childrenRoot, supervisor, graphState, logger, events });

    try {
      const fanout = await handlePlanFanout(
        context,
        PlanFanoutInputSchema.parse({
          goal: "Trouver une decision",
          prompt_template: {
            system: "Clone {{child_name}}",
            user: "Analyse {{goal}}",
          },
          children_spec: { count: 3, name_prefix: "vote" },
        }),
      );

      const ballots = ["choix-A", "choix-A", "choix-B"];
      await Promise.all(
        fanout.child_ids.map((childId, index) => sendPromptAndWait(supervisor, childId, ballots[index]!)),
      );

      const reduceResult = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanout.child_ids,
          reducer: "vote",
        }),
      );
      expect(reduceResult.op_id).to.match(/^plan_reduce_op_/);

      expect(reduceResult.aggregate).to.deep.equal({
        mode: "majority",
        value: "choix-A",
        satisfied: true,
        tie: false,
        threshold: 2,
        total_weight: 3,
        tally: {
          "choix-A": 2,
          "choix-B": 1,
        },
      });
      expect(reduceResult.trace.details?.consensus).to.deep.equal({
        mode: "majority",
        value: "choix-A",
        satisfied: true,
        tie: false,
        threshold: 2,
        total_weight: 3,
        tally: {
          "choix-A": 2,
          "choix-B": 1,
        },
      });
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
