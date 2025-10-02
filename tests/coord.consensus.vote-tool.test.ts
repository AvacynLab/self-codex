import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../src/coord/blackboard.js";
import { ContractNetCoordinator } from "../src/coord/contractNet.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { StructuredLogger } from "../src/logger.js";
import {
  ConsensusVoteInputSchema,
  handleConsensusVote,
} from "../src/tools/coordTools.js";

/**
 * Validates the dedicated consensus tool that exposes the voting helpers through
 * MCP and surfaces deterministic telemetry for operators.
 */
describe("coordination consensus vote tool", () => {
  function createContext() {
    return {
      blackboard: new BlackboardStore(),
      stigmergy: new StigmergyField(),
      contractNet: new ContractNetCoordinator(),
      logger: new StructuredLogger(),
    };
  }

  it("computes a majority decision and records telemetry", () => {
    const context = createContext();
    const input = {
      votes: [
        { voter: "alpha", value: "success" },
        { voter: "beta", value: "success" },
        { voter: "gamma", value: "failure" },
      ],
      config: { mode: "majority", tie_breaker: "null" },
    } as const;

    const result = handleConsensusVote(context, input);

    expect(result.mode).to.equal("majority");
    expect(result.outcome).to.equal("success");
    expect(result.satisfied).to.equal(true);
    expect(result.tie).to.equal(false);
    expect(result.threshold).to.equal(2);
    expect(result.total_weight).to.equal(3);
    expect(result.tally.success).to.equal(2);
    expect(result.votes).to.equal(3);
  });

  it("supports weighted votes with quorum guards", () => {
    const context = createContext();
    const input = {
      votes: [
        { voter: "alpha", value: "success" },
        { voter: "beta", value: "failure" },
        { voter: "gamma", value: "success" },
      ],
      config: { mode: "weighted", weights: { alpha: 2, beta: 1, gamma: 1 }, quorum: 3 },
    } as const;

    const result = handleConsensusVote(context, input);

    expect(result.mode).to.equal("weighted");
    expect(result.outcome).to.equal("success");
    expect(result.satisfied).to.equal(true);
    expect(result.threshold).to.equal(3);
    expect(result.total_weight).to.equal(4);
  });

  it("rejects empty ballots via schema validation", () => {
    const outcome = ConsensusVoteInputSchema.safeParse({ votes: [] });
    expect(outcome.success).to.equal(false);
  });
});
