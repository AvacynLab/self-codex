import { describe, it } from "mocha";
import { expect } from "chai";

import {
  majority,
  quorum,
  weighted,
  type ConsensusVote,
} from "../src/coord/consensus.js";

const successVote = (voter: string): ConsensusVote => ({
  voter,
  value: "success",
});

const failureVote = (voter: string): ConsensusVote => ({
  voter,
  value: "failure",
});

describe("coordination consensus helpers", () => {
  it("computes a simple majority and reports ties", () => {
    const votes: ConsensusVote[] = [
      successVote("alpha"),
      successVote("beta"),
      failureVote("gamma"),
    ];

    const decision = majority(votes, { tieBreaker: "null" });
    expect(decision.mode).to.equal("majority");
    expect(decision.outcome).to.equal("success");
    expect(decision.satisfied).to.equal(true);
    expect(decision.tie).to.equal(false);
    expect(decision.threshold).to.equal(2);
    expect(decision.tally.success).to.equal(2);
    expect(decision.tally.failure).to.equal(1);

    const tieDecision = majority(
      [successVote("alpha"), failureVote("beta")],
      { tieBreaker: "null" },
    );
    expect(tieDecision.outcome).to.equal(null);
    expect(tieDecision.satisfied).to.equal(false);
    expect(tieDecision.tie).to.equal(true);
  });

  it("requires the configured quorum to accept an outcome", () => {
    const votes: ConsensusVote[] = [
      successVote("alpha"),
      successVote("beta"),
      failureVote("gamma"),
    ];

    const belowQuorum = quorum(votes, { quorum: 4 });
    expect(belowQuorum.outcome).to.equal("success");
    expect(belowQuorum.satisfied).to.equal(false);
    expect(belowQuorum.threshold).to.equal(4);

    const metQuorum = quorum(votes, { quorum: 2 });
    expect(metQuorum.satisfied).to.equal(true);
    expect(metQuorum.threshold).to.equal(2);
  });

  it("applies custom weights and optional quorum constraints", () => {
    const votes: ConsensusVote[] = [
      successVote("alpha"),
      failureVote("beta"),
      successVote("gamma"),
    ];
    const weights = { alpha: 2, beta: 1, gamma: 1 };

    const weightedMajority = weighted(votes, { weights });
    expect(weightedMajority.outcome).to.equal("success");
    expect(weightedMajority.totalWeight).to.equal(4);
    expect(weightedMajority.threshold).to.equal(3);
    expect(weightedMajority.satisfied).to.equal(true);

    const weightedQuorum = weighted(votes, { weights, quorum: 3 });
    expect(weightedQuorum.outcome).to.equal("success");
    expect(weightedQuorum.satisfied).to.equal(true);
    expect(weightedQuorum.threshold).to.equal(3);

    const strictWeighted = weighted(votes, { weights, quorum: 5 });
    expect(strictWeighted.satisfied).to.equal(false);
    expect(strictWeighted.threshold).to.equal(5);
  });
});
