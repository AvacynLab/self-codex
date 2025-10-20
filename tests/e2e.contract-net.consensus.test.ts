import { describe, it } from "mocha";
import { expect } from "chai";
import { tmpdir } from "node:os";
import path from "node:path";

import { BlackboardStore } from "../src/coord/blackboard.js";
import { ContractNetCoordinator } from "../src/coord/contractNet.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { StructuredLogger } from "../src/logger.js";
import { GraphState } from "../src/graph/state.js";
import type { ChildCollectedOutputs, ChildRuntimeMessage } from "../src/childRuntime.js";
import type { ChildSupervisor } from "../src/children/supervisor.js";
import type { CoordinationToolContext } from "../src/tools/coordTools.js";
import {
  CnpAnnounceInputSchema,
  handleCnpAnnounce,
} from "../src/tools/coordTools.js";
import {
  PlanJoinInputSchema,
  PlanReduceInputSchema,
  type PlanToolContext,
  handlePlanJoin,
  handlePlanReduce,
} from "../src/tools/planTools.js";

interface StubMessageOptions {
  /** Terminal message type emitted by the stub child. */
  type: "response" | "error";
  /** Simplified content recorded in the log snapshot. */
  content: string;
  /** Timestamp used to order join observations. */
  receivedAt: number;
}

/**
 * Builds a deterministic child output snapshot so join/reduce steps can consume
 * consistent artefacts without depending on real child processes.
 */
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
    logPath: path.join(tmpdir(), `${childId}-log.txt`),
    messages: [message],
    artifacts: [],
  };
}

/**
 * Provides a shallow clone of the collected outputs so multiple assertions can
 * reuse the same baseline without mutating the shared fixtures.
 */
function cloneOutputs(snapshot: ChildCollectedOutputs): ChildCollectedOutputs {
  return {
    childId: snapshot.childId,
    manifestPath: snapshot.manifestPath,
    logPath: snapshot.logPath,
    artifacts: [...snapshot.artifacts],
    messages: snapshot.messages.map((message) => ({
      ...message,
      parsed: message.parsed ? JSON.parse(JSON.stringify(message.parsed)) : null,
    })),
  };
}

/**
 * Exercises the Contract-Net auction followed by a quorum-based join/reduce
 * workflow so the E2E checklist covers the contract-net + consensus pipeline.
 */
describe("contract-net to consensus end-to-end flow", function () {
  this.timeout(5000);

  it("awards the best bid then reaches quorum consensus across child outputs", async () => {
    const coordinator = new ContractNetCoordinator({
      now: (() => {
        let tick = 0;
        return () => ++tick;
      })(),
    });

    // Register three prospective children with distinct cost/reliability hints
    // so the contract-net heuristics can discriminate between their bids.
    coordinator.registerAgent("childA", { baseCost: 60, reliability: 0.9, tags: ["triage"] });
    coordinator.registerAgent("childB", { baseCost: 45, reliability: 0.95, tags: ["triage", "fast-track"] });
    coordinator.registerAgent("childC", { baseCost: 70, reliability: 0.85, tags: ["triage"] });

    const coordinationContext: CoordinationToolContext = {
      blackboard: new BlackboardStore(),
      stigmergy: new StigmergyField(),
      contractNet: coordinator,
      logger: new StructuredLogger(),
    };

    const announceInput = CnpAnnounceInputSchema.parse({
      task_id: "triage-incident",
      payload: { severity: "high" },
      auto_bid: false,
      heuristics: {
        prefer_agents: ["childB"],
        preference_bonus: 5,
        busy_penalty: 10,
      },
      manual_bids: [
        { agent_id: "childA", cost: 62 },
        { agent_id: "childB", cost: 48 },
        { agent_id: "childC", cost: 55 },
      ],
      run_id: "run-triage",
      op_id: "op-triage-auction",
      job_id: "job-triage",
    });

    const announcement = handleCnpAnnounce(coordinationContext, announceInput);
    expect(announcement.awarded_agent_id).to.equal("childB");
    expect(announcement.bids).to.have.length(3);
    expect(announcement.tags).to.deep.equal([]);
    expect(announcement.correlation).to.deep.equal({
      runId: "run-triage",
      opId: "op-triage-auction",
      jobId: "job-triage",
      graphId: null,
      nodeId: null,
      childId: null,
    });

    // Prepare deterministic child outputs where the awarded child responds
    // first with a success while a different child returns an error.
    const outputs = new Map<string, ChildCollectedOutputs>([
      [
        "childA",
        createStubOutputs("childA", { type: "response", content: "{\"vote\":\"approve\"}", receivedAt: 3 }),
      ],
      [
        "childB",
        createStubOutputs("childB", { type: "response", content: "{\"vote\":\"approve\"}", receivedAt: 1 }),
      ],
      [
        "childC",
        // The failing child emits an empty payload so the reduce vote ignores it
        // while the join step still records the error status.
        createStubOutputs("childC", { type: "error", content: " ", receivedAt: 2 }),
      ],
    ]);

    const supervisorStub = {
      collect: async (childId: string) => {
        const snapshot = outputs.get(childId);
        if (!snapshot) {
          throw new Error(`unexpected child ${childId}`);
        }
        return cloneOutputs(snapshot);
      },
      waitForMessage: async () => {
        throw new Error("waitForMessage should not be invoked for pre-collected outputs");
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
    const planContext: PlanToolContext = {
      supervisor: supervisorStub,
      graphState: new GraphState(),
      logger,
      childrenRoot: tmpdir(),
      defaultChildRuntime: "codex",
      emitEvent: (event) => events.push({ kind: event.kind, payload: event.payload }),
      stigmergy: new StigmergyField(),
    };

    const joinInput = PlanJoinInputSchema.parse({
      children: ["childA", "childB", "childC"],
      join_policy: "quorum",
      quorum_count: 2,
      timeout_sec: 1,
      consensus: {
        mode: "quorum",
        quorum: 2,
        tie_breaker: "prefer",
        prefer_value: "success",
      },
    });

    const joinResult = await handlePlanJoin(planContext, joinInput);
    expect(joinResult.satisfied).to.equal(true);
    expect(joinResult.winning_child_id).to.equal(announcement.awarded_agent_id);
    expect(joinResult.consensus?.outcome).to.equal("success");
    expect(joinResult.success_count).to.equal(2);
    expect(events.some((event) => event.kind === "STATUS")).to.equal(true);

    const reduceInput = PlanReduceInputSchema.parse({
      children: ["childA", "childB", "childC"],
      reducer: "vote",
      spec: {
        mode: "quorum",
        quorum: 2,
        tie_breaker: "prefer",
        prefer_value: "approve",
      },
    });

    const reduceResult = await handlePlanReduce(planContext, reduceInput);
    expect(reduceResult.aggregate).to.deep.equal({
      mode: "quorum",
      value: "approve",
      satisfied: true,
      tie: false,
      threshold: 2,
      total_weight: 2,
      tally: { approve: 2 },
    });
    expect(reduceResult.trace.details?.consensus).to.deep.equal(reduceResult.aggregate);
  });
});
