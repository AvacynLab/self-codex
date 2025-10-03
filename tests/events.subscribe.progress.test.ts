/**
 * Exercises the unified event bus by validating filtering semantics, streaming
 * behaviour and correlation friendly pagination. The tests use a deterministic
 * clock so sequence ordering and timestamps remain predictable.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";

describe("event bus", () => {
  it("normalises categories and filters by run/op identifiers", () => {
    const bus = new EventBus({ historyLimit: 10, now: (() => {
      let tick = 0;
      return () => ++tick;
    })() });

    bus.publish({ cat: "PLAN", jobId: "job-1", runId: "run-1", opId: "op-alpha", msg: "start" });
    bus.publish({ cat: "PLAN", jobId: "job-2", runId: "run-2", opId: "op-beta", msg: "progress" });
    bus.publish({ cat: "CHILD", jobId: "job-1", childId: "child-9", msg: "ready" });

    const filtered = bus.list({ cats: ["plan"], runId: "run-1" });
    expect(filtered).to.have.lengthOf(1);
    expect(filtered[0].runId).to.equal("run-1");
    expect(filtered[0].opId).to.equal("op-alpha");
    expect(filtered[0].cat).to.equal("plan");

    const byChild = bus.list({ cats: ["child"], childId: "child-9" });
    expect(byChild).to.have.lengthOf(1);
    expect(byChild[0].childId).to.equal("child-9");

    const ordered = bus.list({});
    expect(ordered.map((event) => event.seq)).to.deep.equal([1, 2, 3]);
  });

  it("streams events sequentially when subscribing after a checkpoint", async () => {
    const bus = new EventBus({ historyLimit: 5 });

    const first = bus.publish({ cat: "plan", runId: "run-42", msg: "queued" });
    const second = bus.publish({ cat: "plan", runId: "run-42", msg: "executing" });
    const third = bus.publish({ cat: "plan", runId: "run-42", msg: "done" });

    const stream = bus.subscribe({ runId: "run-42", afterSeq: first.seq });
    const iterator = stream[Symbol.asyncIterator]();

    const next = await iterator.next();
    expect(next.done).to.equal(false);
    expect(next.value.seq).to.equal(second.seq);
    expect(next.value.msg).to.equal("executing");

    const final = await iterator.next();
    expect(final.done).to.equal(false);
    expect(final.value.seq).to.equal(third.seq);
    expect(final.value.msg).to.equal("done");

    const pending = iterator.next();
    stream.close();
    const closing = await pending;
    expect(closing.done).to.equal(true);
  });

  it("paginates idempotently by leveraging the afterSeq cursor", () => {
    const bus = new EventBus({ historyLimit: 5 });

    bus.publish({ cat: "plan", runId: "run-9", msg: "start" });
    const latest = bus.publish({ cat: "plan", runId: "run-9", msg: "finish" });

    const firstPage = bus.list({ cats: ["plan"], runId: "run-9" });
    expect(firstPage).to.have.lengthOf(2);

    const secondPage = bus.list({ cats: ["plan"], runId: "run-9", afterSeq: latest.seq });
    expect(secondPage).to.have.lengthOf(0);

    bus.publish({ cat: "plan", runId: "run-9", msg: "cleanup" });
    const thirdPage = bus.list({ cats: ["plan"], runId: "run-9", afterSeq: latest.seq });
    expect(thirdPage).to.have.lengthOf(1);
    expect(thirdPage[0].msg).to.equal("cleanup");
  });
});
