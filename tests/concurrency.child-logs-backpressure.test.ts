/**
 * Validates that child log pagination remains lossless even when consumers
 * request very small pages. The scenarios emulate the backpressure handling we
 * need for the future SSE bridge so slow clients can resume draining logs
 * without missing entries.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { ResourceRegistry } from "../src/resources/registry.js";

/** Number of log entries seeded in the main pagination scenario. */
const CHILD_LOG_ENTRY_COUNT = 9;

/**
 * Helper generating deterministic log payloads so the assertions can focus on
 * the pagination guarantees. Each log increments both `ts` and the sequence the
 * registry maintains for the targeted child.
 */
function seedChildLogs(registry: ResourceRegistry, childId: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    registry.recordChildLogEntry(childId, {
      ts: index + 1,
      stream: index % 2 === 0 ? "stdout" : "stderr",
      message: `log-${childId}-${index + 1}`,
      jobId: index % 3 === 0 ? `job-${childId}` : null,
      runId: `run-${childId}`,
      opId: index % 2 === 0 ? `op-${index + 1}` : null,
      graphId: null,
      nodeId: null,
      raw: null,
      parsed: { position: index + 1 },
    });
  }
}

describe("child log pagination backpressure", () => {
  it("pages child logs without dropping entries across keep-alives", () => {
    const registry = new ResourceRegistry({ childLogHistoryLimit: 100 });
    const childId = "child-backpressure";
    seedChildLogs(registry, childId, CHILD_LOG_ENTRY_COUNT);

    const limit = 3;
    let cursor = 0;
    const seen: number[] = [];
    const uri = `sc://children/${childId}/logs`;

    while (seen.length < CHILD_LOG_ENTRY_COUNT) {
      const page = registry.watch(uri, { fromSeq: cursor, limit });
      expect(page.kind).to.equal("child_logs");
      expect(page.uri).to.equal(uri);
      expect(page.events.length).to.be.greaterThan(0);
      expect(page.events.length).to.be.at.most(limit);

      for (const event of page.events) {
        expect(event.seq).to.be.greaterThan(cursor);
        expect(event.childId).to.equal(childId);
        expect(event.message).to.equal(`log-${childId}-${event.seq}`);
        seen.push(event.seq);
      }

      cursor = page.nextSeq;
    }

    const expected = Array.from({ length: CHILD_LOG_ENTRY_COUNT }, (_, index) => index + 1);
    expect(seen).to.deep.equal(expected);

    const keepAlive = registry.watch(uri, { fromSeq: cursor, limit });
    expect(keepAlive.events).to.have.length(0);
    expect(keepAlive.nextSeq).to.equal(CHILD_LOG_ENTRY_COUNT);

    registry.recordChildLogEntry(childId, {
      ts: CHILD_LOG_ENTRY_COUNT + 1,
      stream: "meta",
      message: `log-${childId}-${CHILD_LOG_ENTRY_COUNT + 1}`,
      jobId: null,
      runId: `run-${childId}`,
      opId: null,
      graphId: null,
      nodeId: null,
      raw: null,
      parsed: { position: CHILD_LOG_ENTRY_COUNT + 1 },
    });
    const resumed = registry.watch(uri, { fromSeq: cursor, limit });
    expect(resumed.events.map((entry) => entry.seq)).to.deep.equal([CHILD_LOG_ENTRY_COUNT + 1]);
    expect(resumed.nextSeq).to.equal(CHILD_LOG_ENTRY_COUNT + 1);
  });

  it("isolates pagination state between different children", () => {
    const registry = new ResourceRegistry({ childLogHistoryLimit: 50 });
    const children = ["alpha", "beta"] as const;

    // Interleave the entries so we prove that each child maintains an independent
    // sequence and that pagination does not leak entries across buckets.
    for (let round = 0; round < 4; round += 1) {
      for (const childId of children) {
        registry.recordChildLogEntry(childId, {
          ts: round * children.length + (childId === "alpha" ? 1 : 2),
          stream: "stdout",
          message: `round-${round + 1}-${childId}`,
        });
      }
    }

    const limit = 2;
    for (const childId of children) {
      let cursor = 0;
      const seen: number[] = [];
      const uri = `sc://children/${childId}/logs`;

      while (seen.length < 4) {
        const page = registry.watch(uri, { fromSeq: cursor, limit });
        expect(page.kind).to.equal("child_logs");
        expect(page.uri).to.equal(uri);
        expect(page.events).to.have.length.at.most(limit);

        for (const entry of page.events) {
          expect(entry.childId).to.equal(childId);
          expect(entry.seq).to.equal(seen.length + 1);
          expect(entry.message).to.equal(`round-${entry.seq}-${childId}`);
          seen.push(entry.seq);
        }

        cursor = page.nextSeq;
      }

      expect(seen).to.deep.equal([1, 2, 3, 4]);

      const keepAlive = registry.watch(uri, { fromSeq: cursor, limit });
      expect(keepAlive.events).to.have.length(0);
      expect(keepAlive.nextSeq).to.equal(4);
    }
  });
});
