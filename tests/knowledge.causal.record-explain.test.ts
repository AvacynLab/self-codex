import { describe, it } from "mocha";
import { expect } from "chai";

import { CausalMemory } from "../src/knowledge/causalMemory.js";

/** Deterministic clock so snapshots remain stable across tests. */
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
 * Validates that the causal memory records deterministic edges and produces
 * bounded explanations when depth constraints are provided.
 */
describe("causal memory record and explain", () => {
  it("records events, enforces cause existence and explains ancestry", () => {
    const clock = new ManualClock();
    const memory = new CausalMemory({ now: () => clock.now() });

    const ready = memory.record({ type: "scheduler.event.taskReady", data: { node_id: "root" } });
    clock.advance(5);
    const tickStart = memory.record(
      { type: "scheduler.tick.start", data: { event: "taskReady" } },
      [ready.id],
    );
    clock.advance(5);
    const tickResult = memory.record(
      { type: "scheduler.tick.result", data: { status: "success" } },
      [tickStart.id],
    );
    const toolSuccess = memory.record(
      { type: "bt.tool.success", data: { tool: "noop" } },
      [tickStart.id],
    );

    const exported = memory.exportAll();
    expect(exported.map((event) => event.id)).to.deep.equal([
      ready.id,
      tickStart.id,
      tickResult.id,
      toolSuccess.id,
    ]);
    expect(exported[0]?.effects).to.deep.equal([tickStart.id]);
    expect(exported[1]?.causes).to.deep.equal([ready.id]);

    const explanation = memory.explain(tickResult.id);
    expect(explanation.outcome.id).to.equal(tickResult.id);
    expect(explanation.ancestors.map((event) => event.id)).to.deep.equal([ready.id, tickStart.id]);
    expect(explanation.edges).to.deep.include({ from: tickStart.id, to: tickResult.id });
    expect(explanation.edges).to.deep.include({ from: ready.id, to: tickStart.id });
    expect(explanation.depth).to.equal(2);

    const truncated = memory.explain(tickResult.id, { maxDepth: 1 });
    expect(truncated.ancestors.map((event) => event.id)).to.deep.equal([tickStart.id]);

    expect(() => memory.record({ type: "scheduler.tick.result" }, ["missing"])).to.throw("unknown cause");
  });
});
