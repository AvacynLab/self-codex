/**
 * Validates that event pagination paths remain lossless when clients fetch
 * events in small chunks. The scenarios emulate backpressure handling for both
 * the unified event bus (`events_subscribe`) and the resource registry
 * (`resources_watch`) so slow consumers can drain buffers without dropping
 * envelopes.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";
import { ResourceRegistry } from "../src/resources/registry.js";

/** Utility building a deterministic clock for reproducible timestamps. */
function buildDeterministicClock(): () => number {
  let tick = 0;
  return () => ++tick;
}

describe("stream pagination backpressure", () => {
  it("pages the event bus without dropping envelopes", () => {
    const bus = new EventBus({ historyLimit: 100, now: buildDeterministicClock() });
    const limit = 3;
    let cursor = 0;
    let published = 0;
    const collected: number[] = [];

    // Publish events in bursts that never exceed the configured limit so a slow
    // consumer can poll repeatedly without losing entries between iterations.
    const bursts = [3, 2, 3, 1];
    for (const [burstIndex, burstSize] of bursts.entries()) {
      for (let offset = 0; offset < burstSize; offset += 1) {
        published += 1;
        bus.publish({
          cat: burstIndex % 2 === 0 ? "graph" : "child",
          runId: `run-${burstIndex + 1}`,
          msg: `event-${published}`,
        });
      }

      const page = bus.list({ afterSeq: cursor, limit });
      expect(page.length).to.equal(burstSize);
      const expectedSeqs = Array.from({ length: burstSize }, (_, index) => cursor + index + 1);
      expect(page.map((event) => event.seq)).to.deep.equal(expectedSeqs);

      cursor = page[page.length - 1]!.seq;
      collected.push(...page.map((event) => event.seq));
    }

    const expected = Array.from({ length: collected.length }, (_, index) => index + 1);
    expect(collected).to.deep.equal(expected);

    // A keep-alive request should return no events yet preserve the cursor so a
    // client can wait for additional pages without missing new publications.
    const keepAlive = bus.list({ afterSeq: cursor, limit });
    expect(keepAlive).to.have.length(0);

    const resumed = bus.publish({ cat: "graph", runId: "run-keepalive", msg: "resume" });
    const replay = bus.list({ afterSeq: cursor, limit });
    expect(replay.map((event) => event.seq)).to.deep.equal([resumed.seq]);
  });

  it("pages resource watch results deterministically for run events", () => {
    const registry = new ResourceRegistry({ runHistoryLimit: 100, childLogHistoryLimit: 50 });
    const runId = "run-backpressure";
    const totalEvents = 11;

    for (let index = 0; index < totalEvents; index += 1) {
      registry.recordRunEvent(runId, {
        seq: index + 1,
        ts: index + 1,
        kind: index % 2 === 0 ? "plan" : "child",
        level: "info",
        runId,
        msg: `payload-${index + 1}`,
        component: "graph",
        stage: index % 2 === 0 ? "plan" : "child",
        elapsedMs: null,
      });
    }

    const limit = 4;
    let cursor = 0;
    const seen: number[] = [];
    const uri = `sc://runs/${runId}/events`;

    while (seen.length < totalEvents) {
      const page = registry.watch(uri, { fromSeq: cursor, limit });
      expect(page.events.length).to.be.greaterThan(0);
      expect(page.events.length).to.be.at.most(limit);
      expect(page.kind).to.equal("run_events");
      expect(page.uri).to.equal(uri);

      for (const event of page.events) {
        expect(event.seq).to.be.greaterThan(cursor);
        seen.push(event.seq);
      }

      cursor = page.nextSeq;
    }

    const expected = Array.from({ length: totalEvents }, (_, index) => index + 1);
    expect(seen).to.deep.equal(expected);

    const keepAlive = registry.watch(uri, { fromSeq: cursor, limit });
    expect(keepAlive.events).to.have.length(0);
    expect(keepAlive.nextSeq).to.equal(totalEvents);

    const resumedSeq = totalEvents + 1;
    registry.recordRunEvent(runId, {
      seq: resumedSeq,
      ts: resumedSeq,
      kind: "plan",
      level: "info",
      runId,
      msg: "resume",
      component: "graph",
      stage: "plan",
      elapsedMs: null,
    });

    const resumed = registry.watch(uri, { fromSeq: cursor, limit });
    expect(resumed.events.map((event) => event.seq)).to.deep.equal([resumedSeq]);
    expect(resumed.nextSeq).to.equal(resumedSeq);
  });
});
