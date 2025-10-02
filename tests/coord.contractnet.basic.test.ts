import { describe, it } from "mocha";
import { expect } from "chai";

import { ContractNetCoordinator } from "../src/coord/contractNet.js";

/** Manual clock mirroring {@link Date.now} so bids stay deterministic. */
class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Validates the Contract-Net coordinator core flow (announce → bid → award). */
describe("coordination contract-net basic", () => {
  it("awards the lowest cost bid and releases the assignment on completion", () => {
    const clock = new ManualClock();
    const coordinator = new ContractNetCoordinator({ now: () => clock.now(), defaultBusyPenalty: 2 });

    coordinator.registerAgent("alpha", { baseCost: 8, reliability: 0.8, tags: ["analysis"] });
    coordinator.registerAgent("beta", { baseCost: 12, reliability: 0.9, tags: ["survey"] });

    const announcement = coordinator.announce({
      taskId: "survey-1",
      payload: { priority: 2 },
      tags: ["survey"],
      metadata: { hint: "collect samples" },
    });

    expect(announcement.bids.length).to.equal(2);

    clock.advance(5);
    coordinator.bid(announcement.callId, "beta", 4, { metadata: { note: "fast" } });
    clock.advance(3);
    coordinator.bid(announcement.callId, "alpha", 6);

    const decision = coordinator.award(announcement.callId);
    expect(decision.agentId).to.equal("beta");
    expect(decision.cost).to.equal(4);
    expect(decision.effectiveCost).to.be.lessThanOrEqual(6);

    const awarded = coordinator.getCall(announcement.callId);
    expect(awarded?.status).to.equal("awarded");
    expect(awarded?.awardedAgentId).to.equal("beta");
    expect(coordinator.getAgent("beta")?.activeAssignments).to.equal(1);

    const completed = coordinator.complete(announcement.callId);
    expect(completed.status).to.equal("completed");
    expect(coordinator.getAgent("beta")?.activeAssignments).to.equal(0);
  });
});
