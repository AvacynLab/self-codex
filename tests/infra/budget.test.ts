import { describe, it } from "mocha";
import { expect } from "chai";
import { Buffer } from "node:buffer";

import {
  BudgetTracker,
  BudgetExceededError,
  estimateTokenUsage,
  measureBudgetBytes,
} from "../../src/infra/budget.js";

/**
 * Behavioural coverage for the multi-dimensional {@link BudgetTracker} helper.
 * The suite verifies that charges mutate the internal counters as expected,
 * exhaustion emits rich errors and refunds restore the remaining capacity.
 */
describe("infra/budget tracker", () => {
  it("records consumption and exposes structured snapshots", () => {
    const clock = { now: 5_000 };
    const tracker = new BudgetTracker(
      { timeMs: 100, tokens: 50, toolCalls: 2, bytesIn: 256, bytesOut: 512 },
      { clock: () => clock.now },
    );

    const firstCharge = tracker.consume(
      { toolCalls: 1, tokens: 10, bytesIn: 128 },
      { actor: "test", operation: "unit", stage: "ingress" },
    );
    expect(firstCharge).to.deep.equal({ timeMs: 0, tokens: 10, toolCalls: 1, bytesIn: 128, bytesOut: 0 });

    clock.now += 50;
    const secondCharge = tracker.consume(
      { timeMs: 40, bytesOut: 200 },
      { actor: "test", operation: "unit", stage: "egress" },
    );
    expect(secondCharge).to.deep.equal({ timeMs: 40, tokens: 0, toolCalls: 0, bytesIn: 0, bytesOut: 200 });

    const snapshot = tracker.snapshot();
    expect(snapshot.consumed).to.deep.equal({ timeMs: 40, tokens: 10, toolCalls: 1, bytesIn: 128, bytesOut: 200 });
    expect(snapshot.remaining).to.deep.equal({
      timeMs: 60,
      tokens: 40,
      toolCalls: 1,
      bytesIn: 128,
      bytesOut: 312,
    });
    expect(snapshot.lastUsage?.metadata).to.deep.equal({ actor: "test", operation: "unit", stage: "egress" });
  });

  it("throws a BudgetExceededError when attempting to consume beyond capacity", () => {
    const tracker = new BudgetTracker({ tokens: 5 });
    tracker.consume({ tokens: 5 });

    try {
      tracker.consume({ tokens: 1 });
      throw new Error("expected budget exhaustion");
    } catch (error) {
      expect(error).to.be.instanceOf(BudgetExceededError);
      const exceeded = error as BudgetExceededError;
      expect(exceeded.dimension).to.equal("tokens");
      expect(exceeded.remaining).to.equal(0);
      expect(exceeded.attempted).to.equal(1);
      expect(exceeded.limit).to.equal(5);
    }
  });

  it("refunds charges to restore the remaining capacity", () => {
    const tracker = new BudgetTracker({ toolCalls: 2, bytesOut: 100 });
    const charge = tracker.consume({ toolCalls: 1, bytesOut: 60 });
    tracker.refund(charge);
    const snapshot = tracker.snapshot();
    expect(snapshot.consumed).to.deep.equal({ timeMs: 0, tokens: 0, toolCalls: 0, bytesIn: 0, bytesOut: 0 });
    expect(snapshot.remaining.toolCalls).to.equal(2);
    expect(snapshot.remaining.bytesOut).to.equal(100);
  });
});

/**
 * Lightweight regression tests for the heuristic helpers estimating tokens and
 * byte usage. The tests intentionally cover heterogeneous payloads to guard the
 * future adjustments that may tweak the heuristics.
 */
describe("infra/budget heuristics", () => {
  it("estimates tokens across primitive and structured payloads", () => {
    expect(estimateTokenUsage("hello world")).to.be.greaterThan(1);
    expect(estimateTokenUsage(["one", "two", "three"])).to.equal(3);
    expect(estimateTokenUsage({ text: "lorem ipsum", nested: { count: 2 } })).to.be.greaterThan(5);
  });

  it("measures UTF-8 byte lengths for diverse payloads", () => {
    expect(measureBudgetBytes("résumé")).to.equal(Buffer.from("résumé", "utf8").byteLength);
    expect(measureBudgetBytes({ value: 42 })).to.be.greaterThan(0);
    expect(measureBudgetBytes([1, 2, 3])).to.be.greaterThan(0);
  });
});
