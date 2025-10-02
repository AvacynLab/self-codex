import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor } from "../src/childSupervisor.js";
import { GraphState } from "../src/graphState.js";
import { StructuredLogger } from "../src/logger.js";
import { ValueGraph } from "../src/values/valueGraph.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import type { PlanToolContext } from "../src/tools/planTools.js";
import {
  PlanFanoutInputSchema,
  PlanJoinInputSchema,
  PlanReduceInputSchema,
  handlePlanFanout,
  handlePlanJoin,
  handlePlanReduce,
} from "../src/tools/planTools.js";

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));

/**
 * Sends a prompt to a spawned child and waits for the scripted mock runtime to
 * emit the mirrored response. The helper guarantees the orchestration tools see
 * a terminal message when collecting transcripts.
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

describe("end-to-end value guard enforcement", function () {
  this.timeout(20_000);

  it("filters the privacy violating plan and reduces the safe alternative", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "e2e-values-guard-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath],
    });
    const graphState = new GraphState();
    const logger = new StructuredLogger({ logFile: path.join(childrenRoot, "tmp", "orchestrator.log") });
    const valueGraph = new ValueGraph();
    // Configure the guard so that privacy risks above 0.2 are rejected while
    // usability still contributes slightly to the final score.
    valueGraph.set({
      defaultThreshold: 0.7,
      values: [
        { id: "privacy", weight: 1, tolerance: 0.2 },
        { id: "usability", weight: 0.4, tolerance: 0.5 },
      ],
      relationships: [{ from: "privacy", to: "usability", kind: "supports", weight: 0.4 }],
    });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context: PlanToolContext = {
      supervisor,
      graphState,
      logger,
      childrenRoot,
      defaultChildRuntime: "codex",
      emitEvent: (event) => {
        events.push({ kind: event.kind, payload: event.payload });
      },
      stigmergy: new StigmergyField(),
      valueGuard: { graph: valueGraph, registry: new Map() },
    };

    try {
      // Build a plan run with two candidates where only "privacy-first" complies
      // with the configured principles.
      const fanoutInput = PlanFanoutInputSchema.parse({
        goal: "Choose the safest rollout plan",
        run_label: "values-guard-e2e",
        prompt_template: { system: "You are {{child_name}}", user: "Plan for {{goal}}" },
        children_spec: {
          list: [
            {
              name: "privacy-first",
              value_impacts: [
                { value: "privacy", impact: "support", severity: 0.9 },
                { value: "usability", impact: "support", severity: 0.5 },
              ],
            },
            {
              name: "tracking-heavy",
              value_impacts: [
                { value: "privacy", impact: "risk", severity: 0.95 },
                { value: "usability", impact: "support", severity: 0.1 },
              ],
            },
          ],
        },
      });

      const fanoutResult = await handlePlanFanout(context, fanoutInput);

      // Only the privacy preserving plan should survive the guard.
      expect(fanoutResult.child_ids).to.have.length(1);
      expect(fanoutResult.planned).to.have.length(1);
      expect(fanoutResult.planned[0]?.name).to.equal("privacy-first");
      expect(fanoutResult.rejected_plans).to.have.length(1);
      const rejected = fanoutResult.rejected_plans[0];
      expect(rejected?.name).to.equal("tracking-heavy");
      expect(rejected?.value_guard?.allowed).to.equal(false);
      expect(rejected?.value_guard?.violations?.some((entry) => entry.value === "privacy")).to.equal(true);

      const planEvent = events.find((event) => event.kind === "PLAN");
      const planPayload = planEvent?.payload as { rejected?: string[] } | undefined;
      expect(planPayload?.rejected).to.deep.equal(["tracking-heavy"]);

      const survivingChild = fanoutResult.child_ids[0]!;
      // The surviving child replies with a deterministic payload consumed by
      // join/reduce.
      await sendPromptAndWait(supervisor, survivingChild, "SAFE_PLAN_READY");

      const joinResult = await handlePlanJoin(
        context,
        PlanJoinInputSchema.parse({
          children: fanoutResult.child_ids,
          join_policy: "first_success",
          timeout_sec: 2,
        }),
      );

      expect(joinResult.satisfied).to.equal(true);
      expect(joinResult.winning_child_id).to.equal(survivingChild);
      expect(joinResult.results).to.have.length(1);
      expect(joinResult.results[0]?.status).to.equal("success");

      const reduceResult = await handlePlanReduce(
        context,
        PlanReduceInputSchema.parse({
          children: fanoutResult.child_ids,
          reducer: "concat",
        }),
      );

      expect(reduceResult.reducer).to.equal("concat");
      expect(reduceResult.aggregate).to.contain("SAFE_PLAN_READY");
      expect(reduceResult.trace.per_child).to.have.length(1);
      expect(reduceResult.trace.per_child[0]?.value_guard?.allowed).to.equal(true);
      expect(context.valueGuard?.registry.size).to.equal(0);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
