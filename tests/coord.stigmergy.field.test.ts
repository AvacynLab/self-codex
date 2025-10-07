import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../src/coord/blackboard.js";
import { ContractNetCoordinator } from "../src/coord/contractNet.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { StructuredLogger } from "../src/logger.js";
import { handleStigSnapshot } from "../src/tools/coordTools.js";

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

  it("applies default half-life and intensity bounds", () => {
    const clock = new ManualClock();
    const field = new StigmergyField({
      now: () => clock.now(),
      defaultHalfLifeMs: 2_000,
      minIntensity: 0.5,
      maxIntensity: 5,
    });

    const first = field.mark("alpha", "load", 2);
    expect(first.intensity).to.equal(2);

    const second = field.mark("alpha", "load", 4);
    expect(second.intensity).to.equal(5, "intensity should clamp at maxIntensity");

    clock.advance(1_000);
    const [decayed] = field.evaporate();
    expect(decayed?.intensity ?? 0).to.be.closeTo(5 * Math.pow(0.5, 0.5), 1e-6);

    clock.advance(200_000);
    const [vanished] = field.evaporate();
    expect(vanished?.intensity).to.equal(0);
    expect(field.getNodeIntensity("alpha")).to.equal(undefined);
  });

  it("exposes configured and effective intensity bounds", () => {
    const clock = new ManualClock();
    const field = new StigmergyField({ now: () => clock.now(), minIntensity: 0.25 });

    const emptyBounds = field.getIntensityBounds();
    expect(emptyBounds.minIntensity).to.equal(0.25);
    expect(emptyBounds.maxIntensity).to.equal(Number.POSITIVE_INFINITY);
    expect(emptyBounds.normalisationCeiling).to.equal(1.25);

    field.mark("alpha", "load", 0.5);
    field.mark("beta", "load", 1.5);

    const populatedBounds = field.getIntensityBounds();
    expect(populatedBounds.minIntensity).to.equal(0.25);
    expect(populatedBounds.maxIntensity).to.equal(Number.POSITIVE_INFINITY);
    expect(populatedBounds.normalisationCeiling).to.equal(1.5);

    const boundedField = new StigmergyField({ now: () => clock.now(), minIntensity: 0, maxIntensity: 4 });
    boundedField.mark("node", "signal", 2);
    const bounded = boundedField.getIntensityBounds();
    expect(bounded.maxIntensity).to.equal(4);
    expect(bounded.normalisationCeiling).to.equal(4);
  });

  it("produces heatmap snapshots with normalised intensities", () => {
    const clock = new ManualClock();
    const field = new StigmergyField({ now: () => clock.now(), minIntensity: 1, maxIntensity: 10 });

    field.mark("alpha", "load", 2);
    clock.advance(10);
    field.mark("alpha", "alert", 1);
    clock.advance(10);
    field.mark("beta", "load", 8);

    const snapshot = field.heatmapSnapshot();
    expect(snapshot.minIntensity).to.equal(1);
    expect(snapshot.maxIntensity).to.equal(10);
    expect(snapshot.cells).to.have.length(2);
    expect(snapshot.cells[0]?.nodeId).to.equal("beta");
    expect(snapshot.cells[0]?.normalised ?? 0).to.be.closeTo(7 / 9, 1e-6);
    expect(snapshot.cells[0]?.points).to.have.length(1);
    expect(snapshot.cells[0]?.points[0]?.normalised ?? 0).to.be.closeTo(7 / 9, 1e-6);

    const alphaCell = snapshot.cells.find((cell) => cell.nodeId === "alpha");
    expect(alphaCell?.points).to.have.length(2);
    expect(alphaCell?.points[0]?.type).to.equal("load");
    expect(alphaCell?.points[0]?.normalised ?? 0).to.be.closeTo(1 / 9, 1e-6);
    expect(alphaCell?.points[1]?.type).to.equal("alert");
    expect(alphaCell?.points[1]?.normalised).to.equal(0);
  });

  it("surfaces formatted bounds and summary rows in stig_snapshot", () => {
    const clock = new ManualClock();
    const field = new StigmergyField({ now: () => clock.now(), minIntensity: 0.25, maxIntensity: 5 });

    field.mark("alpha", "load", 1.5);
    clock.advance(10);
    field.mark("beta", "latency", 3);

    const context = {
      blackboard: new BlackboardStore(),
      stigmergy: field,
      contractNet: new ContractNetCoordinator({ now: () => clock.now() }),
      logger: new StructuredLogger(),
    } as const;

    const result = handleStigSnapshot(context, {});

    expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);

    expect(result.pheromone_bounds).to.deep.equal({
      min_intensity: 0.25,
      max_intensity: 5,
      normalisation_ceiling: 5,
    });
    expect(result.summary.bounds).to.deep.equal(result.pheromone_bounds);
    expect(result.summary.tooltip).to.equal("Min 0.25 • Max 5 • Ceiling 5");

    const rows = Object.fromEntries(result.summary.rows.map((row) => [row.label, row]));
    expect(rows["Min intensity"]?.value).to.equal("0.25");
    expect(rows["Max intensity"]?.value).to.equal("5");
    expect(rows["Normalisation ceiling"]?.value).to.equal("5");
    expect(rows["Min intensity"]?.tooltip).to.be.a("string");

    expect(result.heatmap.bounds).to.deep.equal(result.pheromone_bounds);
    expect(result.heatmap.bounds_tooltip).to.equal(result.summary.tooltip);
  });
});
