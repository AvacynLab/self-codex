import { describe, it } from "mocha";
import { expect } from "chai";

import { StigmergyField } from "../src/coord/stigmergy.js";

/** Manual clock mirroring {@link Date.now} so evaporation stays deterministic. */
class ManualClock {
  private current = 0;

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/**
 * Validates that the stigmergic field accumulates markings, exposes snapshots
 * and evaporates intensities exponentially when instructed to decay.
 */
describe("coordination stigmergy field", () => {
  it("accumulates intensity and evaporates deterministically", () => {
    const clock = new ManualClock();
    const field = new StigmergyField({ now: () => clock.now() });
    const events: Array<{ node: string; total: number }> = [];
    const unsubscribe = field.onChange((change) => {
      events.push({ node: change.nodeId, total: change.totalIntensity });
    });

    const created = field.mark("alpha", "Explore", 5);
    expect(created.intensity).to.equal(5);
    expect(field.getNodeIntensity("alpha")?.intensity).to.equal(5);

    clock.advance(500);
    const updated = field.mark("alpha", "explore", 3);
    expect(updated.updatedAt).to.equal(clock.now());
    expect(updated.intensity).to.equal(8);

    const snapshot = field.fieldSnapshot();
    expect(snapshot.points).to.have.length(1);
    expect(snapshot.points[0]?.intensity).to.equal(8);
    expect(snapshot.totals[0]?.intensity).to.equal(8);

    clock.advance(1_000);
    const decayed = field.evaporate(1_000);
    expect(decayed).to.have.length(1);
    expect(decayed[0]?.intensity).to.be.closeTo(4, 1e-6);
    expect(field.getNodeIntensity("alpha")?.intensity).to.be.closeTo(4, 1e-6);

    clock.advance(2_000);
    const vanished = field.evaporate(10);
    expect(vanished[0]?.intensity).to.be.closeTo(0, 1e-6);
    expect(field.getNodeIntensity("alpha")).to.equal(undefined);

    unsubscribe();
    expect(events.length).to.be.greaterThan(0);
  });
});
