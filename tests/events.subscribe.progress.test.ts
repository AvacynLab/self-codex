import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";

/**
 * Builds a deterministic child spawned payload so the sequencing tests can
 * focus on pagination behaviour without re-specifying the lifecycle structure
 * required by the event bus discriminated unions.
 */
function createChildSpawnedPayload(childId: string, overrides: Partial<ReturnType<typeof baseSpawnPayload>> = {}) {
  return { ...baseSpawnPayload(childId), ...overrides };
}

function baseSpawnPayload(childId: string) {
  return {
    childId,
    phase: "spawned" as const,
    at: 0,
    pid: 1234,
    forced: false,
    reason: null,
  };
}

describe("event bus progress", () => {
  it("filters correlation identifiers within a category", () => {
    let tick = 0;
    const bus = new EventBus({ historyLimit: 10, now: () => ++tick });

    bus.publish({ cat: "graph", jobId: "job-1", runId: "run-1", opId: "op-alpha", msg: "plan" });
    bus.publish({ cat: "graph", jobId: "job-2", runId: "run-2", opId: "op-beta", msg: "status" });
    bus.publish({
      cat: "child",
      jobId: "job-1",
      childId: "child-9",
      msg: "child_spawned",
      data: createChildSpawnedPayload("child-9"),
    });

    const filtered = bus.list({ cats: ["graph"], runId: "run-1" });
    expect(filtered).to.have.lengthOf(1);
    expect(filtered[0]?.runId).to.equal("run-1");
    expect(filtered[0]?.opId).to.equal("op-alpha");
    expect(filtered[0]?.cat).to.equal("graph");
    expect(filtered[0]?.seq).to.equal(1);

    const byChild = bus.list({ cats: ["child"], childId: "child-9" });
    expect(byChild).to.have.lengthOf(1);
    expect(byChild[0]?.childId).to.equal("child-9");
    expect(byChild[0]?.jobId).to.equal("job-1");

    const ordered = bus.list();
    expect(ordered.map((event) => event.seq)).to.deep.equal([1, 2, 3]);
  });

  it("merges categories while preserving chronological ordering", () => {
    const bus = new EventBus({ historyLimit: 10 });

    const planStart = bus.publish({ cat: "graph", runId: "run-multi", msg: "plan" });
    const childReady = bus.publish({
      cat: "child",
      childId: "child-multi",
      msg: "child_spawned",
      data: createChildSpawnedPayload("child-multi"),
    });
    const planFinish = bus.publish({ cat: "graph", runId: "run-multi", msg: "aggregate" });
    bus.publish({ cat: "scheduler", msg: "scheduler" });

    const filtered = bus.list({ cats: ["child", "graph"], limit: 10 });
    expect(filtered).to.have.lengthOf(3);
    expect(filtered.map((event) => event.seq)).to.deep.equal([
      planStart.seq,
      childReady.seq,
      planFinish.seq,
    ]);
    expect(filtered[0]?.cat).to.equal("graph");
    expect(filtered[1]?.cat).to.equal("child");
    expect(filtered[2]?.msg).to.equal("aggregate");
  });

  it("streams sequentially from the requested checkpoint", async () => {
    const bus = new EventBus({ historyLimit: 5 });

    const first = bus.publish({ cat: "graph", runId: "run-42", msg: "plan" });
    const second = bus.publish({ cat: "graph", runId: "run-42", msg: "status" });
    const third = bus.publish({ cat: "graph", runId: "run-42", msg: "aggregate" });

    const stream = bus.subscribe({ runId: "run-42", afterSeq: first.seq });
    const iterator = stream[Symbol.asyncIterator]();

    const next = await iterator.next();
    expect(next.done).to.equal(false);
    expect(next.value.seq).to.equal(second.seq);
    expect(next.value.msg).to.equal("status");

    const final = await iterator.next();
    expect(final.done).to.equal(false);
    expect(final.value.seq).to.equal(third.seq);
    expect(final.value.msg).to.equal("aggregate");

    const pending = iterator.next();
    stream.close();
    const closing = await pending;
    expect(closing.done).to.equal(true);
  });

  it("uses the afterSeq cursor for idempotent pagination", () => {
    const bus = new EventBus({ historyLimit: 5 });

    bus.publish({ cat: "graph", runId: "run-9", msg: "plan" });
    const latest = bus.publish({ cat: "graph", runId: "run-9", msg: "status" });

    const firstPage = bus.list({ cats: ["graph"], runId: "run-9" });
    expect(firstPage).to.have.lengthOf(2);

    const secondPage = bus.list({ cats: ["graph"], runId: "run-9", afterSeq: latest.seq });
    expect(secondPage).to.have.lengthOf(0);

    bus.publish({ cat: "graph", runId: "run-9", msg: "aggregate" });
    const thirdPage = bus.list({ cats: ["graph"], runId: "run-9", afterSeq: latest.seq });
    expect(thirdPage).to.have.lengthOf(1);
    expect(thirdPage[0]?.msg).to.equal("aggregate");
  });
});
