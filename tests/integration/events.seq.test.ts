import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus, type EventEnvelope } from "../../src/events/bus.js";

/**
 * Integration regression suite verifying that the event bus keeps a strictly monotonic sequence even
 * when history windows rotate or when callers mix historical seeds with live streaming. The tests
 * deliberately go through both code paths (list/subscribe) to guarantee downstream consumers can
 * rely on deterministic ordering when persisting validation artefacts.
 */
describe("event bus sequencing", () => {
  it("assigns a strictly increasing sequence to every published event", () => {
    const bus = new EventBus({ historyLimit: 4, now: () => 1700 });

    const first = bus.publish({ cat: "child", msg: "child_spawned" });
    const second = bus.publish({ cat: "child", msg: "child_lifecycle" });
    const third = bus.publish({ cat: "child", msg: "child_exit" });

    expect(first.seq).to.equal(1);
    expect(second.seq).to.equal(2);
    expect(third.seq).to.equal(3);

    const events = bus.list();
    const sequences = events.map((event) => event.seq);
    expect(sequences).to.deep.equal([1, 2, 3]);
  });

  it("preserves monotonic ordering when mixing history seeds and live streaming", async () => {
    let now = 10;
    const bus = new EventBus({ historyLimit: 5, now: () => now++ });

    // Seed the history buffer before a subscriber attaches to ensure the iterator is primed.
    bus.publish({ cat: "graph", msg: "plan" });

    const stream = bus.subscribe();
    const observed: EventEnvelope[] = [];

    const collect = (async () => {
      for await (const event of stream) {
        observed.push(event);
        if (observed.length >= 4) {
          break;
        }
      }
    })();

    bus.publish({ cat: "graph", msg: "status" });
    bus.publish({ cat: "graph", msg: "aggregate" });
    bus.publish({ cat: "graph", msg: "info" });

    await collect;

    expect(observed.length).to.equal(4);
    const seqs = observed.map((event) => event.seq);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).to.be.greaterThan(seqs[index - 1]);
    }
  });
});
