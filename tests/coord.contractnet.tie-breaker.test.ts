import { describe, it } from "mocha";
import { expect } from "chai";

import { ContractNetCoordinator } from "../src/coord/contractNet.js";

class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** Ensures the coordinator favours the least busy or lexicographically stable agent on ties. */
describe("coordination contract-net tie-breaker", () => {
  it("prefers the less busy agent when bids tie", () => {
    const clock = new ManualClock();
    const coordinator = new ContractNetCoordinator({ now: () => clock.now(), defaultBusyPenalty: 3 });

    coordinator.registerAgent("alpha", { baseCost: 10 });
    coordinator.registerAgent("beta", { baseCost: 10 });

    const first = coordinator.announce({ taskId: "mission-1", autoBid: false });
    coordinator.bid(first.callId, "alpha", 2);
    coordinator.bid(first.callId, "beta", 2);
    const firstAward = coordinator.award(first.callId, "alpha");
    expect(firstAward.agentId).to.equal("alpha");

    const second = coordinator.announce({ taskId: "mission-2", autoBid: false });
    clock.advance(1);
    coordinator.bid(second.callId, "alpha", 2);
    clock.advance(1);
    coordinator.bid(second.callId, "beta", 2);
    const secondAward = coordinator.award(second.callId);
    expect(secondAward.agentId).to.equal("beta");
    expect(coordinator.getAgent("alpha")?.activeAssignments).to.equal(1);
    expect(coordinator.getAgent("beta")?.activeAssignments).to.equal(1);

    coordinator.complete(first.callId);
    coordinator.complete(second.callId);

    const third = coordinator.announce({ taskId: "mission-3", autoBid: false });
    coordinator.bid(third.callId, "alpha", 5);
    coordinator.bid(third.callId, "beta", 5);
    const thirdAward = coordinator.award(third.callId);
    expect(thirdAward.agentId).to.equal("alpha");
    coordinator.complete(third.callId);
  });
});
