import { describe, it } from "mocha";
import { expect } from "chai";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChildSupervisor } from "../src/childSupervisor.js";
import type {
  ChildCollectedOutputs,
  ChildRuntimeMessage,
} from "../src/childRuntime.js";
import { GraphState } from "../src/graphState.js";
import { StructuredLogger } from "../src/logger.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import {
  PlanJoinInputSchema,
  PlanReduceInputSchema,
  type PlanToolContext,
  handlePlanJoin,
  handlePlanReduce,
} from "../src/tools/planTools.js";

interface StubMessageOptions {
  type: "response" | "error";
  content: string;
  receivedAt: number;
}

function createStubOutputs(
  childId: string,
  options: StubMessageOptions,
): ChildCollectedOutputs {
  const message: ChildRuntimeMessage<{ type: string; content: string }> = {
    raw: JSON.stringify({ type: options.type, content: options.content }),
    parsed: { type: options.type, content: options.content },
    stream: "stdout",
    receivedAt: options.receivedAt,
    sequence: 1,
  };
  return {
    childId,
    manifestPath: path.join(tmpdir(), `${childId}-manifest.json`),
    logPath: path.join(tmpdir(), `${childId}-child.log`),
    messages: [message],
    artifacts: [],
  };
}

describe("plan_join consensus integration", () => {
  it("applies weighted consensus when joining and reducing results", async () => {
    const supervisorStub = {
      collect: async (childId: string) => {
        switch (childId) {
          case "childA":
            return createStubOutputs("childA", {
              type: "response",
              content: "approve",
              receivedAt: 1,
            });
          case "childB":
            return createStubOutputs("childB", {
              type: "error",
              content: "reject",
              receivedAt: 2,
            });
          case "childC":
            return createStubOutputs("childC", {
              type: "response",
              content: "approve",
              receivedAt: 3,
            });
          default:
            throw new Error(`unexpected child ${childId}`);
        }
      },
      waitForMessage: async () => {
        throw new Error("waitForMessage should not be called in this stub");
      },
    } as unknown as ChildSupervisor;

    const logger = {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      flush: async () => {},
    } as unknown as StructuredLogger;

    const events: Array<{ kind: string; payload?: unknown }> = [];
    const context: PlanToolContext = {
      supervisor: supervisorStub,
      graphState: new GraphState(),
      logger,
      childrenRoot: tmpdir(),
      defaultChildRuntime: "codex",
      emitEvent: (event) => {
        events.push({ kind: event.kind, payload: event.payload });
      },
      stigmergy: new StigmergyField(),
    };

    const joinInput = PlanJoinInputSchema.parse({
      children: ["childA", "childB", "childC"],
      join_policy: "quorum",
      quorum_count: 3,
      timeout_sec: 1,
      consensus: {
        mode: "weighted",
        quorum: 3,
        weights: { childA: 2, childB: 1, childC: 1 },
        tie_breaker: "prefer",
        prefer_value: "success",
      },
    });

    const joinResult = await handlePlanJoin(context, joinInput);
    expect(joinResult.op_id).to.match(/^plan_join_op_/);
    expect(joinResult.satisfied).to.equal(true);
    expect(joinResult.quorum_threshold).to.equal(3);
    expect(joinResult.consensus?.outcome).to.equal("success");
    expect(joinResult.consensus?.total_weight).to.equal(4);
    expect(joinResult.consensus?.tally).to.deep.equal({ success: 3, error: 1 });
    expect(joinResult.winning_child_id).to.equal("childA");
    expect(events.some((event) => event.kind === "STATUS")).to.equal(true);

    const reduceInput = PlanReduceInputSchema.parse({
      children: ["childA", "childB", "childC"],
      reducer: "vote",
      spec: {
        mode: "weighted",
        quorum: 3,
        weights: { childA: 2, childB: 1, childC: 1 },
        tie_breaker: "first",
      },
    });

    const reduceResult = await handlePlanReduce(context, reduceInput);
    expect(reduceResult.op_id).to.match(/^plan_reduce_op_/);
    expect(reduceResult.aggregate).to.deep.equal({
      mode: "weighted",
      value: "approve",
      satisfied: true,
      tie: false,
      threshold: 3,
      total_weight: 4,
      tally: { approve: 3, reject: 1 },
    });
    expect(reduceResult.trace.details?.consensus).to.deep.equal({
      mode: "weighted",
      value: "approve",
      satisfied: true,
      tie: false,
      threshold: 3,
      total_weight: 4,
      tally: { approve: 3, reject: 1 },
    });
  });
});
