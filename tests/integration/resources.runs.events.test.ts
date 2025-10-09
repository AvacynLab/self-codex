import { expect } from "chai";

import { ResourceRegistry } from "../../src/resources/registry.js";

describe("resources runs events", () => {
  it("exports consolidated JSONL alongside structured run events", () => {
    const registry = new ResourceRegistry();

    registry.recordRunEvent("run-export", {
      seq: 1,
      ts: 1_000,
      kind: "START",
      level: "info",
      jobId: "job-1",
      payload: { stage: "begin" },
    });
    registry.recordRunEvent("run-export", {
      seq: 2,
      ts: 1_500,
      kind: "STATUS",
      level: "info",
      jobId: "job-1",
      childId: "child-1",
      payload: { stage: "progress" },
    });

    const listing = registry.list("sc://runs/");
    expect(listing).to.deep.equal([
      {
        uri: "sc://runs/run-export/events",
        kind: "run_events",
        metadata: {
          event_count: 2,
          latest_seq: 2,
          available_formats: ["structured", "jsonl"],
        },
      },
    ]);

    const readResult = registry.read("sc://runs/run-export/events");
    expect(readResult.kind).to.equal("run_events");
    const expectedEvents = [
      {
        seq: 1,
        ts: 1_000,
        kind: "START",
        level: "info",
        jobId: "job-1",
        runId: "run-export",
        opId: null,
        graphId: null,
        nodeId: null,
        childId: null,
        component: "run",
        stage: "start",
        elapsedMs: null,
        payload: { stage: "begin" },
      },
      {
        seq: 2,
        ts: 1_500,
        kind: "STATUS",
        level: "info",
        jobId: "job-1",
        runId: "run-export",
        opId: null,
        graphId: null,
        nodeId: null,
        childId: "child-1",
        component: "run",
        stage: "status",
        elapsedMs: null,
        payload: { stage: "progress" },
      },
    ];
    expect(readResult.payload).to.deep.equal({
      runId: "run-export",
      events: expectedEvents,
      jsonl: `${expectedEvents.map((evt) => JSON.stringify(evt)).join("\n")}\n`,
    });
  });

  it("surfaces validation artefacts through resources_list and resources_read", () => {
    const registry = new ResourceRegistry();
    const data = { tool: "graph_diff", params: { foo: "bar" } };

    const uri = registry.registerValidationArtifact({
      sessionId: "LATEST",
      artifactType: "inputs",
      name: "graph_diff-1.json",
      recordedAt: 1_700,
      runId: "run-export",
      phase: "phase-a",
      mime: "application/json",
      data,
      metadata: { call_index: 1 },
    });

    // Mutate the original payload to ensure the registry keeps an isolated snapshot.
    data.params.foo = "mutated";

    expect(uri).to.equal("sc://validation/LATEST/inputs/graph_diff-1.json");

    const listed = registry.list("sc://validation/");
    expect(listed).to.deep.equal([
      {
        uri: "sc://validation/LATEST/inputs/graph_diff-1.json",
        kind: "validation_input",
        metadata: {
          session_id: "LATEST",
          artifact_type: "inputs",
          recorded_at: 1_700,
          mime: "application/json",
          run_id: "run-export",
          phase: "phase-a",
          call_index: 1,
        },
      },
    ]);

    const read = registry.read("sc://validation/LATEST/inputs/graph_diff-1.json");
    expect(read.kind).to.equal("validation_input");
    expect(read.payload).to.deep.equal({
      sessionId: "LATEST",
      runId: "run-export",
      phase: "phase-a",
      artifactType: "input",
      name: "graph_diff-1.json",
      recordedAt: 1_700,
      mime: "application/json",
      data: { tool: "graph_diff", params: { foo: "bar" } },
      metadata: { call_index: 1 },
    });
  });

  it("clears validation artefacts for selected sessions", () => {
    const registry = new ResourceRegistry();

    registry.registerValidationArtifact({
      sessionId: "RUN-A",
      artifactType: "inputs",
      name: "a.json",
      data: { foo: "bar" },
    });
    registry.registerValidationArtifact({
      sessionId: "RUN-B",
      artifactType: "outputs",
      name: "b.json",
      data: { foo: "baz" },
    });

    registry.clearValidationArtifacts("RUN-A");
    const remaining = registry.list("sc://validation/");
    expect(remaining).to.have.length(1);
    expect(remaining[0]).to.include({ uri: "sc://validation/RUN-B/outputs/b.json", kind: "validation_output" });

    registry.clearValidationArtifacts();
    expect(registry.list("sc://validation/")).to.deep.equal([]);
  });
});

