import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LogJournal, type CorrelatedLogEntry } from "../../src/monitor/log.js";

/**
 * Ensures the correlated log journal surfaces run/operation/child metadata through the `tail` API.
 * The regression suite writes entries across different streams and verifies that downstream
 * consumers receive the component, stage and elapsed timing fields alongside the correlation IDs.
 */
describe("logs tail correlation", () => {
  let rootDir: string;
  let journal: LogJournal;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "logs-tail-context-"));
    journal = new LogJournal({ rootDir, maxEntriesPerBucket: 16, maxFileSizeBytes: 256 * 1024 });
  });

  afterEach(async () => {
    await journal.flush();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("returns correlated identifiers and metadata when tailing a bucket", () => {
    journal.record({
      stream: "run",
      bucketId: "run-42",
      level: "info",
      message: "plan_started",
      runId: "run-42",
      jobId: "job-7",
      opId: "op-99",
      graphId: "graph-1",
      nodeId: "node-a",
      childId: "child-5",
      component: "plan_executor",
      stage: "plan.start",
      elapsedMs: 12.4,
      data: { context: "start" },
    });

    journal.record({
      stream: "run",
      bucketId: "run-42",
      level: "warn",
      message: "plan_completed",
      runId: "run-42",
      jobId: "job-7",
      opId: "op-100",
      graphId: "graph-1",
      nodeId: "node-b",
      childId: "child-5",
      component: "plan_executor",
      stage: "plan.end",
      elapsedMs: 55.2,
      data: { context: "end" },
    });

    const { entries, nextSeq } = journal.tail({ stream: "run", bucketId: "run-42" });
    expect(entries.length).to.equal(2);
    expect(nextSeq).to.equal(entries[entries.length - 1]?.seq ?? 0);

    const [first, second] = entries as CorrelatedLogEntry[];

    expect(first.seq).to.equal(1);
    expect(first.runId).to.equal("run-42");
    expect(first.opId).to.equal("op-99");
    expect(first.childId).to.equal("child-5");
    expect(first.component).to.equal("plan_executor");
    expect(first.stage).to.equal("plan.start");
    expect(first.elapsedMs).to.equal(12);

    expect(second.seq).to.equal(2);
    expect(second.opId).to.equal("op-100");
    expect(second.stage).to.equal("plan.end");
    expect(second.elapsedMs).to.equal(55);
  });
});
