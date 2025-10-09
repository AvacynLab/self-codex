import { describe, it } from "mocha";
import { expect } from "chai";

import { StigmergyField } from "../../src/coord/stigmergy.js";

/**
 * Validates that stigmergic evaporation applies a stable exponential decay when the
 * elapsed time stays constant between cycles, guaranteeing schedulers observe smooth
 * pheromone cooling regardless of polling cadence.
 */
describe("stigmergy decay integration", () => {
  it("applies consistent exponential decay deltas across fixed intervals", () => {
    let now = 0;
    const field = new StigmergyField({ now: () => now, defaultHalfLifeMs: 1_000 });

    // Deposit an initial pheromone that will decay deterministically over two half-lives.
    const initial = field.mark("node-a", "explore", 8);
    expect(initial.intensity).to.equal(8);

    // After one half-life the intensity should halve (8 -> 4) within numerical tolerance.
    now += 1_000;
    const firstDecay = field.evaporate();
    expect(firstDecay).to.have.length(1);
    expect(firstDecay[0].nodeId).to.equal("node-a");
    expect(firstDecay[0].intensity).to.be.closeTo(4, 1e-6);
    expect(field.getNodeIntensity("node-a")?.intensity).to.be.closeTo(4, 1e-6);

    // A second half-life reduces the pheromone again (4 -> 2) proving deltas are stable
    // and independent of cumulative rounding errors.
    now += 1_000;
    const secondDecay = field.evaporate();
    expect(secondDecay).to.have.length(1);
    expect(secondDecay[0].intensity).to.be.closeTo(2, 1e-6);
    expect(field.getNodeIntensity("node-a")?.intensity).to.be.closeTo(2, 1e-6);

    // After a long idle period (≈23 half-lives) the pheromone should fall below the eviction
    // threshold which forces the field to delete the entry and emit a zeroed change event.
    now += 23_000;
    const finalDecay = field.evaporate();
    expect(finalDecay).to.have.length(1);
    expect(finalDecay[0].intensity).to.equal(0);
    expect(field.getNodeIntensity("node-a")).to.equal(undefined);
  });
});
