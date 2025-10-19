import { describe, it } from "mocha";
import { expect } from "chai";

import { EventStore } from "../../src/eventStore.js";

/**
 * Regression coverage ensuring the bounded history enforced by {@link EventStore}
 * applies uniformly to both the global log and the per-job indexes so idle jobs
 * do not leak references after their events roll out of the main buffer.
 */
describe("event store retention", function () {
  it("keeps per-job windows accessible while trimming the global history", () => {
    const store = new EventStore({ maxHistory: 3 });

    // Seed the store with a small job-specific burst followed by a different job
    // so the original job stops receiving events once the global buffer fills up.
    for (let index = 0; index < 3; index += 1) {
      store.emit({ kind: "INFO", jobId: "job-a" });
    }

    // Emit three events for the second job to force evictions without adding new
    // events for the first job. The global history now holds only the second job
    // entries, but the per-job index must still expose the original window for
    // job-a so callers can page through its history deterministically.
    for (let index = 0; index < 3; index += 1) {
      store.emit({ kind: "INFO", jobId: "job-b" });
    }

    expect(store.getEventCount()).to.equal(3);
    expect(store.list().map((event) => event.seq)).to.deep.equal([4, 5, 6]);
    expect(store.list({ reverse: true }).map((event) => event.seq)).to.deep.equal([6, 5, 4]);

    // Global filtering against job-a yields an empty slice because its events fell
    // out of the global buffer, yet the per-job helper still exposes the bounded
    // job history.
    expect(store.list({ jobId: "job-a" })).to.deep.equal([]);
    expect(store.listForJob("job-a").map((event) => event.seq)).to.deep.equal([1, 2, 3]);
    expect(store.listForJob("job-b").map((event) => event.seq)).to.deep.equal([4, 5, 6]);
    expect(
      store
        .listForJob("job-a", { reverse: true, limit: 1 })
        .map((event) => event.seq),
    ).to.deep.equal([3]);
    expect(
      store
        .listForJob("job-b", { reverse: true, limit: 1 })
        .map((event) => event.seq),
    ).to.deep.equal([6]);
  });

  it("re-applies the retention window when the history limit is reduced", () => {
    const store = new EventStore({ maxHistory: 5 });

    // Alternate emissions between two jobs so both indexes hold multiple entries
    // before we shrink the window below the original size.
    store.emit({ kind: "INFO", jobId: "job-a" }); // seq 1
    store.emit({ kind: "INFO", jobId: "job-b" }); // seq 2
    store.emit({ kind: "INFO", jobId: "job-a" }); // seq 3
    store.emit({ kind: "INFO", jobId: "job-b" }); // seq 4
    store.emit({ kind: "INFO", jobId: "job-a" }); // seq 5

    // Lowering the max history should immediately evict the oldest entries from
    // both the global buffer and each per-job queue while preserving ordering.
    store.setMaxHistory(2);

    expect(store.getEventCount()).to.equal(2);
    expect(store.list().map((event) => event.seq)).to.deep.equal([4, 5]);

    // Job A retains its two most recent events while Job B keeps the surviving
    // pair. Pagination helpers must continue to respect direction and limits even
    // after the reconfiguration, and minSeq filters should observe the trimmed
    // sequence boundary.
    expect(store.listForJob("job-a").map((event) => event.seq)).to.deep.equal([3, 5]);
    expect(store.listForJob("job-b").map((event) => event.seq)).to.deep.equal([2, 4]);

    expect(
      store
        .list({ reverse: true, limit: 1 })
        .map((event) => event.seq),
    ).to.deep.equal([5]);
    expect(
      store
        .listForJob("job-b", { reverse: true, limit: 1 })
        .map((event) => event.seq),
    ).to.deep.equal([4]);
    expect(store.listForJob("job-a", { minSeq: 5 })).to.deep.equal([]);
  });
});
