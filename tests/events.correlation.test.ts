import { describe, it } from "mocha";
import { expect } from "chai";

import {
  buildChildCorrelationHints,
  buildJobCorrelationHints,
  cloneCorrelationHints,
  extractCorrelationHints,
  mergeCorrelationHints,
} from "../src/events/correlation.js";

/**
 * Dedicated unit coverage for the correlation helpers ensures regressions in
 * the merge semantics are caught without relying solely on integration tests.
 */
describe("event correlation helpers", () => {
  it("preserves existing identifiers when the source omits fields", () => {
    const target = { runId: "run-1", opId: "op-1", jobId: "job-1" };
    mergeCorrelationHints(target, { runId: undefined, jobId: null });

    expect(target).to.deep.equal({ runId: "run-1", opId: "op-1", jobId: null });
  });

  it("overrides hints when the source provides explicit values", () => {
    const target = { runId: null, opId: null };
    mergeCorrelationHints(target, { runId: "run-22", opId: "op-55", graphId: "graph-9" });

    expect(target).to.deep.equal({ runId: "run-22", opId: "op-55", graphId: "graph-9" });
  });

  it("produces a shallow clone when copying correlation hints", () => {
    const source = { runId: "run-1", nodeId: "node-7" };
    const cloned = cloneCorrelationHints(source);
    expect(cloned).to.deep.equal({ runId: "run-1", nodeId: "node-7" });
    expect(cloned).to.not.equal(source);
  });

  it("extracts identifiers from heterogeneous correlation records", () => {
    const hints = extractCorrelationHints({
      run_id: "run-snake",
      correlation: { opId: "op-nested" },
      jobId: "job-camel",
      graph_id: "graph-123",
      nodeId: "node-abc",
      child_ids: ["child-only"],
    });

    expect(hints).to.deep.equal({
      runId: "run-snake",
      opId: "op-nested",
      jobId: "job-camel",
      graphId: "graph-123",
      nodeId: "node-abc",
      childId: "child-only",
    });
  });

  it("ignores ambiguous child arrays when extracting hints", () => {
    const hints = extractCorrelationHints({ childIds: ["child-a", "child-b"] });
    expect(hints).to.deep.equal({});
  });

  it("preserves explicit null overrides when extracting hints", () => {
    const hints = extractCorrelationHints({
      run_id: null,
      opId: null,
      correlation: { job_id: null },
      graph_id: "graph-42",
      node_id: 99,
    });

    expect(hints).to.deep.equal({
      runId: null,
      opId: null,
      jobId: null,
      graphId: "graph-42",
      nodeId: "99",
    });
  });

  it("builds child correlation hints from job metadata and embedded records", () => {
    const hints = buildChildCorrelationHints({
      childId: "child-77",
      jobId: " job-101 ",
      sources: [
        { correlation: { run_id: "run-55" } },
        { opId: "op-89", graph_id: "graph-3" },
      ],
    });

    expect(hints).to.deep.equal({
      childId: "child-77",
      jobId: "job-101",
      runId: "run-55",
      opId: "op-89",
      graphId: "graph-3",
    });
  });

  it("honours explicit null overrides provided by metadata when building child hints", () => {
    const hints = buildChildCorrelationHints({
      childId: "child-detached",
      jobId: "job-native",
      sources: [{ job_id: null, correlation: { op_id: null, runId: undefined } }],
    });

    expect(hints).to.deep.equal({
      childId: "child-detached",
      jobId: null,
      opId: null,
    });
  });

  it("builds job correlation hints from aggregated child metadata", () => {
    const hints = buildJobCorrelationHints({
      jobId: " job-204 ",
      sources: [
        { child_ids: ["child-primary"], correlation: { run_id: "run-204" } },
        { job_id: "job-override", correlation: { opId: "op-88" } },
        { graph_id: "graph-12", node_id: "node-alpha" },
      ],
    });

    expect(hints).to.deep.equal({
      jobId: "job-204",
      childId: "child-primary",
      runId: "run-204",
      opId: "op-88",
      graphId: "graph-12",
      nodeId: "node-alpha",
    });
  });

  it("respects explicit null overrides when building job correlation hints", () => {
    const hints = buildJobCorrelationHints({
      jobId: "job-explicit",
      sources: [
        { correlation: { job_id: null, run_id: null } },
        { jobId: undefined, op_id: null },
        { job_id: "job-other", correlation: { run_id: "run-other" } },
      ],
    });

    expect(hints).to.deep.equal({
      jobId: null,
      runId: null,
      opId: null,
    });
  });

  it("returns trimmed job identifiers when no additional sources are provided", () => {
    const hints = buildJobCorrelationHints({ jobId: "  job-alone  ", sources: [] });

    expect(hints).to.deep.equal({ jobId: "job-alone" });
  });

  it("nullifies conflicting job identifiers discovered across sources", () => {
    const hints = buildJobCorrelationHints({
      sources: [
        { correlation: { job_id: "job-one", run_id: "run-one" } },
        { job_id: "job-two", correlation: { op_id: "op-two" } },
      ],
    });

    expect(hints).to.deep.equal({
      jobId: null,
      runId: "run-one",
      opId: "op-two",
    });
  });
});
