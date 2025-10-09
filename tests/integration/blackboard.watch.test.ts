import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../../src/coord/blackboard.js";
import { StigmergyField } from "../../src/coord/stigmergy.js";
import { ContractNetCoordinator } from "../../src/coord/contractNet.js";
import {
  BbSetInputSchema,
  BbWatchInputSchema,
  handleBbSet,
  handleBbWatch,
  type CoordinationToolContext,
} from "../../src/tools/coordTools.js";
import { StructuredLogger } from "../../src/logger.js";

/**
 * Integration coverage ensuring the blackboard watch tool only emits bounded batches
 * and surfaces TTL driven expirations deterministically so downstream agents can
 * resume from persisted cursors without observing unbounded streams.
 */
describe("blackboard watch integration", () => {
  it("returns finite slices and records TTL expirations as discrete events", () => {
    let now = 10_000;
    const store = new BlackboardStore({ now: () => now, historyLimit: 10 });
    const stigmergy = new StigmergyField({ now: () => now });
    const contractNet = new ContractNetCoordinator({ now: () => now });
    const logger = new StructuredLogger();

    const context: CoordinationToolContext = {
      blackboard: store,
      stigmergy,
      contractNet,
      logger,
    };

    // Seed two entries: one expiring shortly to exercise TTL eviction, another permanent
    // entry so the pagination logic has to respect the requested limit.
    const alpha = BbSetInputSchema.parse({
      key: "alpha",
      value: { payload: 1 },
      tags: ["ops"],
      ttl_ms: 120,
    });
    handleBbSet(context, alpha);
    now += 10;
    const beta = BbSetInputSchema.parse({ key: "beta", value: { payload: 2 } });
    handleBbSet(context, beta);

    // First slice only requests a single event, proving the server honours the limit and
    // returns a bounded batch even when more history is available.
    const firstSlice = handleBbWatch(context, BbWatchInputSchema.parse({ start_version: 0, limit: 1 }));
    expect(firstSlice.events).to.have.length(1);
    expect(firstSlice.events[0]).to.include({ key: "alpha", kind: "set" });
    expect(firstSlice.next_version).to.equal(firstSlice.events[0].version);

    // Fetch the remaining backlog to align the cursor with the most recent mutation.
    const secondSlice = handleBbWatch(
      context,
      BbWatchInputSchema.parse({ start_version: firstSlice.next_version, limit: 10 }),
    );
    expect(secondSlice.events).to.have.length(1);
    expect(secondSlice.events[0]).to.include({ key: "beta", kind: "set" });
    expect(secondSlice.next_version).to.equal(secondSlice.events[0].version);

    // Advance past the TTL and ensure the eviction is materialised as a single expire event.
    now += 150;
    const expireSlice = handleBbWatch(
      context,
      BbWatchInputSchema.parse({ start_version: secondSlice.next_version, limit: 10 }),
    );
    expect(expireSlice.events).to.have.length(1);
    expect(expireSlice.events[0]).to.include({ key: "alpha", kind: "expire", reason: "ttl" });
    expect(expireSlice.events[0].previous).to.not.equal(null);
    expect(expireSlice.next_version).to.equal(expireSlice.events[0].version);

    // Replaying from the last cursor should be idempotent: no additional events are emitted.
    const emptySlice = handleBbWatch(
      context,
      BbWatchInputSchema.parse({ start_version: expireSlice.next_version, limit: 10 }),
    );
    expect(emptySlice.events).to.have.length(0);
    expect(emptySlice.next_version).to.equal(expireSlice.next_version);
  });
});
