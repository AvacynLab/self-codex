import { expect } from "chai";

import {
  type SupervisorIncident,
  inferSupervisorIncidentCorrelation,
} from "../src/agents/supervisor.js";

describe("supervisor incident correlation", () => {
  it("extracts direct identifiers from incident context", () => {
    const incident: SupervisorIncident = {
      type: "loop",
      severity: "critical",
      reason: "test",
      context: {
        run_id: "run-123",
        op_id: "op-456",
        job_id: "job-789",
        graph_id: "graph-321",
        node_id: "node-654",
        child_id: "child-987",
      },
    };

    const correlation = inferSupervisorIncidentCorrelation(incident);

    expect(correlation).to.deep.equal({
      runId: "run-123",
      opId: "op-456",
      jobId: "job-789",
      graphId: "graph-321",
      nodeId: "node-654",
      childId: "child-987",
    });
  });

  it("derives hints from camelCase fields and single child arrays", () => {
    const incident: SupervisorIncident = {
      type: "starvation",
      severity: "warning",
      reason: "idle",
      context: {
        runId: "run-camel",
        operationId: "op-camel",
        jobId: "job-camel",
        graphId: "graph-camel",
        nodeId: "node-camel",
        childIds: ["   child-array   "],
      },
    };

    const correlation = inferSupervisorIncidentCorrelation(incident);

    expect(correlation).to.deep.equal({
      runId: "run-camel",
      opId: "op-camel",
      jobId: "job-camel",
      graphId: "graph-camel",
      nodeId: "node-camel",
      childId: "child-array",
    });
  });

  it("merges embedded correlation blocks without overriding extracted hints", () => {
    const incident: SupervisorIncident = {
      type: "stagnation",
      severity: "warning",
      reason: "backlog",
      context: {
        correlation: { runId: "embedded-run", childId: "embedded-child" },
        run_id: "external-run",
        idle_children: ["child-single"],
      },
    };

    const correlation = inferSupervisorIncidentCorrelation(incident);

    expect(correlation).to.deep.equal({
      runId: "external-run",
      childId: "child-single",
    });
  });

  it("ignores ambiguous child lists", () => {
    const incident: SupervisorIncident = {
      type: "loop",
      severity: "warning",
      reason: "multi",
      context: {
        child_ids: ["child-a", "child-b"],
      },
    };

    const correlation = inferSupervisorIncidentCorrelation(incident);

    expect(correlation).to.deep.equal({});
  });
});
