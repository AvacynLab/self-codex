import { describe, it } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";

import { z } from "zod";

import { StructuredLogger } from "../src/logger.js";
import { KnowledgeGraph, KnowledgeBadTripleError } from "../src/knowledge/knowledgeGraph.js";
import { handleKgInsert } from "../src/tools/knowledgeTools.js";
import { CausalMemory, CausalPathNotFoundError } from "../src/knowledge/causalMemory.js";
import { handleCausalExplain } from "../src/tools/causalTools.js";
import { BlackboardStore } from "../src/coord/blackboard.js";
import {
  BlackboardEntryNotFoundError,
  CoordinationToolContext,
  handleBbGet,
  handleStigMark,
  handleCnpAnnounce,
} from "../src/tools/coordTools.js";
import { StigmergyField, StigmergyInvalidTypeError } from "../src/coord/stigmergy.js";
import { ContractNetCoordinator, ContractNetNoBidsError } from "../src/coord/contractNet.js";
import { handlePlanReduce, handlePlanRunBT, PlanFanoutInputSchema, PlanReduceInputSchema } from "../src/tools/planTools.js";
import { GraphState } from "../src/graph/state.js";
import { ConsensusNoQuorumError, BehaviorTreeRunTimeoutError } from "../src/tools/planTools.js";
import type { PlanToolContext } from "../src/tools/planTools.js";
import type { ChildCollectedOutputs } from "../src/childRuntime.js";
import { UnknownChildError } from "../src/state/childrenIndex.js";
import {
  childToolError as formatChildToolError,
  planToolError as formatPlanToolError,
  graphToolError as formatGraphToolError,
  valueToolError as formatValueToolError,
  resourceToolError as formatResourceToolError,
} from "../src/server/toolErrors.js";

/** Creates a no-op structured logger for test contexts. */
function createLogger(): StructuredLogger {
  return new StructuredLogger();
}

/** Builds a coordination context backed by fresh in-memory stores. */
function createCoordinationContext(): CoordinationToolContext {
  return {
    blackboard: new BlackboardStore(),
    stigmergy: new StigmergyField(),
    contractNet: new ContractNetCoordinator(),
    logger: createLogger(),
  };
}

describe("server tool error codes", () => {
  it("surfaced knowledge graph validation errors with E-KG-BAD-TRIPLE", () => {
    const context = { knowledgeGraph: new KnowledgeGraph(), logger: createLogger() };
    expect(() =>
      handleKgInsert(context, {
        triples: [
          { subject: "   ", predicate: "related_to", object: "task" },
        ],
      }),
    ).to.throw(KnowledgeBadTripleError).that.has.property("code", "E-KG-BAD-TRIPLE");
  });

  it("surfaces causal path misses with E-CAUSAL-NO-PATH", () => {
    const memory = new CausalMemory();
    const context = { causalMemory: memory, logger: createLogger() };
    expect(() => handleCausalExplain(context, { outcome_id: "missing" })).to.throw(
      CausalPathNotFoundError,
    ).that.has.property("code", "E-CAUSAL-NO-PATH");
  });

  it("surfaces blackboard misses with E-BB-NOTFOUND", () => {
    const context = createCoordinationContext();
    expect(() => handleBbGet(context, { key: "absent" })).to.throw(
      BlackboardEntryNotFoundError,
    ).that.has.property("code", "E-BB-NOTFOUND");
  });

  it("surfaces stigmergy type errors with E-STIG-TYPE", () => {
    const context = createCoordinationContext();
    expect(() =>
      handleStigMark(context, { node_id: "n", type: "   ", intensity: 1 }),
    ).to.throw(StigmergyInvalidTypeError).that.has.property("code", "E-STIG-TYPE");
  });

  it("surfaces contract-net award errors with E-CNP-NO-BIDS", () => {
    const context = createCoordinationContext();
    expect(() =>
      handleCnpAnnounce(context, { task_id: "alpha", auto_bid: false, tags: [] }),
    ).to.throw(ContractNetNoBidsError).that.has.property("code", "E-CNP-NO-BIDS");
  });

  it("surfaces consensus quorum failures with E-CONSENSUS-NO-QUORUM", async () => {
    const votes: Record<string, string> = {
      "child-a": "approve",
      "child-b": "reject",
    };
    const planContext: PlanToolContext = {
      supervisor: {
        async collect(childId: string): Promise<ChildCollectedOutputs> {
          return {
            childId,
            manifestPath: path.join(tmpdir(), `${childId}.manifest.json`),
            logPath: path.join(tmpdir(), `${childId}.log`),
            messages: [
              {
                raw: "",
                parsed: { type: "response", content: votes[childId] },
                stream: "stdout",
                receivedAt: 0,
                sequence: 0,
              },
            ],
            artifacts: [],
          };
        },
      } as unknown as PlanToolContext["supervisor"],
      graphState: new GraphState(),
      logger: createLogger(),
      childrenRoot: tmpdir(),
      defaultChildRuntime: "codex",
      emitEvent: () => {},
      stigmergy: new StigmergyField(),
      supervisorAgent: undefined,
      causalMemory: undefined,
      valueGuard: undefined,
    };

    const input = PlanReduceInputSchema.parse({
      children: Object.keys(votes),
      reducer: "vote",
      spec: { mode: "majority" },
    });

    try {
      await handlePlanReduce(planContext, input);
      expect.fail("expected a ConsensusNoQuorumError to be thrown");
    } catch (error) {
      expect(error).to.be.instanceOf(ConsensusNoQuorumError);
      expect((error as ConsensusNoQuorumError).code).to.equal("E-CONSENSUS-NO-QUORUM");
    }
  });

  it("surfaces Behaviour Tree runtime timeouts with E-BT-RUN-TIMEOUT", async () => {
    const planContext: PlanToolContext = {
      supervisor: {} as PlanToolContext["supervisor"],
      graphState: new GraphState(),
      logger: createLogger(),
      childrenRoot: await mkdtemp(path.join(tmpdir(), "plan-run-timeout-")),
      defaultChildRuntime: "codex",
      emitEvent: () => {},
      stigmergy: new StigmergyField(),
      supervisorAgent: undefined,
      causalMemory: undefined,
      valueGuard: undefined,
    };

    try {
      await handlePlanRunBT(planContext, {
        tree: {
          id: "bt-timeout",
          root: {
            type: "retry",
            max_attempts: 3,
            backoff_ms: 25,
            child: {
              type: "guard",
              condition_key: "allow",
              expected: true,
              child: { type: "task", node_id: "noop", tool: "noop" },
            },
          },
        },
        variables: { allow: false },
        dry_run: false,
        timeout_ms: 10,
      });
      expect.fail("expected BehaviourTreeRunTimeoutError");
    } catch (error) {
      expect(error).to.be.instanceOf(BehaviorTreeRunTimeoutError);
      expect((error as BehaviorTreeRunTimeoutError).code).to.equal("E-BT-RUN-TIMEOUT");
    } finally {
      await rm(planContext.childrenRoot, { recursive: true, force: true });
    }
  });

  it("wraps plan validation errors with E-PLAN-INVALID-INPUT", () => {
    const result = PlanFanoutInputSchema.safeParse({});
    if (result.success) {
      expect.fail("expected PlanFanoutInputSchema to reject the payload");
    }
    const response = formatPlanToolError(createLogger(), "plan_fanout", result.error);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.ok).to.equal(false);
    expect(payload.error).to.equal("E-PLAN-INVALID-INPUT");
    expect(payload.hint).to.equal("invalid_input");
    expect(payload.tool).to.equal("plan_fanout");
    expect(payload).to.have.property("details");
  });

  it("wraps missing child errors with E-CHILD-NOTFOUND", () => {
    const response = formatChildToolError(
      createLogger(),
      "child_status",
      new UnknownChildError("ghost"),
      { child_id: "ghost" },
    );
    const payload = JSON.parse(response.content[0].text);
    expect(payload.ok).to.equal(false);
    expect(payload.error).to.equal("E-CHILD-NOTFOUND");
    expect(payload.hint).to.equal("unknown_child");
    expect(payload.details).to.deep.equal({ child_id: "ghost" });
  });

  it("wraps graph patch failures with E-PATCH-APPLY", () => {
    const response = formatGraphToolError(
      createLogger(),
      "graph_patch",
      new Error("boom"),
      { graph_id: "g" },
      { defaultCode: "E-PATCH-APPLY", invalidInputCode: "E-PATCH-INVALID" },
    );
    const payload = JSON.parse(response.content[0].text);
    expect(payload.ok).to.equal(false);
    expect(payload.error).to.equal("E-PATCH-APPLY");
    expect(payload.tool).to.equal("graph_patch");
  });

  it("wraps value guard errors with E-VALUES-UNEXPECTED", () => {
    const response = formatValueToolError(createLogger(), "values_score", new Error("denied"));
    const payload = JSON.parse(response.content[0].text);
    expect(payload.ok).to.equal(false);
    expect(payload.error).to.equal("E-VALUES-UNEXPECTED");
  });

  it("wraps resource validation errors with E-RES-INVALID-INPUT", () => {
    const response = formatResourceToolError(
      createLogger(),
      "resources_list",
      new z.ZodError([]),
    );
    const payload = JSON.parse(response.content[0].text);
    expect(payload.ok).to.equal(false);
    expect(payload.error).to.equal("E-RES-INVALID-INPUT");
    expect(payload.hint).to.equal("invalid_input");
  });
});
