import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../../src/coord/blackboard.js";
import { StigmergyField } from "../../src/coord/stigmergy.js";
import { ContractNetCoordinator } from "../../src/coord/contractNet.js";
import {
  ConsensusVoteInputSchema,
  handleConsensusVote,
  type CoordinationToolContext,
} from "../../src/tools/coordTools.js";
import { StructuredLogger } from "../../src/logger.js";

/**
 * Exercises both the consensus vote tool and the Contract-Net coordinator to prove that
 * tied outcomes resolve deterministically without depending on implicit randomness.
 */
describe("consensus and contract-net deterministic tie-breaking", () => {
  it("honours configured preferences when votes end in a tie", () => {
    const logger = new StructuredLogger();
    const context: CoordinationToolContext = {
      blackboard: new BlackboardStore(),
      stigmergy: new StigmergyField(),
      contractNet: new ContractNetCoordinator(),
      logger,
    };

    const parsed = ConsensusVoteInputSchema.parse({
      votes: [
        { voter: "alpha", value: "plan-a" },
        { voter: "beta", value: "plan-b" },
      ],
      config: { mode: "majority", tie_breaker: "prefer", prefer_value: "plan-b" },
    });

    const decision = handleConsensusVote(context, parsed);
    expect(decision.mode).to.equal("majority");
    expect(decision.outcome).to.equal("plan-b");
    expect(decision.tie).to.equal(false);
    expect(decision.satisfied).to.equal(false);
  });

  it("falls back to lexical order when contract-net bids remain indistinguishable", () => {
    let now = 1_000;
    const coordinator = new ContractNetCoordinator({ now: () => now });
    coordinator.registerAgent("agent-b");
    coordinator.registerAgent("agent-a");

    const call = coordinator.announce({ taskId: "triage", autoBid: false });

    // Submit two identical bids at the exact same timestamp to trigger the deterministic
    // tie-break chain: busy assignments -> submission time -> agent identifier.
    coordinator.bid(call.callId, "agent-b", 42);
    coordinator.bid(call.callId, "agent-a", 42);

    const decision = coordinator.award(call.callId);
    expect(decision.agentId).to.equal("agent-a");
    expect(decision.cost).to.equal(42);
  });
});
