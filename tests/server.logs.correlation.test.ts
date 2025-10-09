import { beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import type { LogEntry } from "../src/logger.js";
import { logJournal, __serverLogInternals } from "../src/server.js";

/**
 * Unit coverage ensuring the server log journal preserves run/op/child correlation metadata even when
 * the structured logger only emits nested hints. The regression previously caused `logs_tail` to
 * drop identifiers for autoscaler, supervisor and child lifecycle entries emitted over HTTP.
 */
describe("server log correlation", () => {
  beforeEach(async () => {
    await logJournal.flush();
    logJournal.reset();
  });

  it("propagates nested correlation hints into journal entries", async () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      message: "autoscaler_event",
      payload: {
        correlation: {
          run_id: "run-correlation",
          op_id: "op-nested",
          graph_id: "graph-nested",
          job_id: "job-nested",
        },
        participants: ["child-array"],
        node_id: "node-direct",
      },
    };

    __serverLogInternals.recordServerLogEntry(entry);
    await logJournal.flush();

    const { entries } = logJournal.tail({ stream: "server", bucketId: "orchestrator" });
    expect(entries.length).to.equal(1);
    const [recorded] = entries;
    expect(recorded?.runId).to.equal("run-correlation");
    expect(recorded?.opId).to.equal("op-nested");
    expect(recorded?.jobId).to.equal("job-nested");
    expect(recorded?.graphId).to.equal("graph-nested");
    expect(recorded?.nodeId).to.equal("node-direct");
    expect(recorded?.childId).to.equal("child-array");
  });

  it("merges correlation hints provided as arrays of objects", async () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "info",
      message: "array_correlation",
      payload: {
        correlation: [
          { run_id: "run-array" },
          { op_id: "op-array" },
          { child_id: "child-array" },
        ],
        node_id: "node-array",
      },
    };

    __serverLogInternals.recordServerLogEntry(entry);
    await logJournal.flush();

    const { entries } = logJournal.tail({ stream: "server", bucketId: "orchestrator" });
    expect(entries.length).to.equal(1);
    const [recorded] = entries;
    expect(recorded?.runId).to.equal("run-array");
    expect(recorded?.opId).to.equal("op-array");
    expect(recorded?.childId).to.equal("child-array");
    expect(recorded?.nodeId).to.equal("node-array");
  });

  it("falls back to legacy payload identifiers when correlation hints are absent", async () => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: "warn",
      message: "legacy_payload",
      payload: {
        job_id: "job-direct",
        run_id: "run-direct",
        op_id: "op-direct",
        graph_id: "graph-direct",
        node_id: "node-direct",
        child_id: "child-direct",
      },
    };

    __serverLogInternals.recordServerLogEntry(entry);
    await logJournal.flush();

    const { entries } = logJournal.tail({ stream: "server", bucketId: "orchestrator" });
    expect(entries.length).to.equal(1);
    const [recorded] = entries;
    expect(recorded?.jobId).to.equal("job-direct");
    expect(recorded?.runId).to.equal("run-direct");
    expect(recorded?.opId).to.equal("op-direct");
    expect(recorded?.graphId).to.equal("graph-direct");
    expect(recorded?.nodeId).to.equal("node-direct");
    expect(recorded?.childId).to.equal("child-direct");
  });
});
