import { describe, it } from "mocha";
import { expect } from "chai";

import { GraphState } from "../src/graphState.js";
import { ThoughtGraphCoordinator } from "../src/reasoning/thoughtCoordinator.js";
import { MetaCritic } from "../src/agents/metaCritic.js";
import { ValueGraph } from "../src/values/valueGraph.js";

describe("ThoughtGraphCoordinator", () => {
  it("records fanout and join snapshots while pruning weak branches", () => {
    const graphState = new GraphState();
    graphState.createJob("job-test", { createdAt: Date.now(), goal: "Explore", state: "running" });

    const coordinator = new ThoughtGraphCoordinator({
      graphState,
      metaCritic: new MetaCritic(),
      maxBranches: 2,
      maxDepth: 3,
    });

    coordinator.recordFanout({
      jobId: "job-test",
      runId: "run-1",
      goal: "Explore",
      parentChildId: null,
      plannerNodeId: null,
      startedAt: 10,
      branches: [
        { childId: "child-a", name: "alpha", prompt: "alpha", runtime: "codex" },
        { childId: "child-b", name: "beta", prompt: "beta", runtime: "codex" },
        { childId: "child-c", name: "gamma", prompt: "gamma", runtime: "codex" },
      ],
    });

    const afterFanout = graphState.getThoughtGraph("job-test");
    expect(afterFanout).to.not.equal(null);
    const runNodes = afterFanout!.nodes.filter((node) => node.parents.includes("run:run-1"));
    expect(runNodes).to.have.length(3);
    expect(runNodes.some((node) => node.status === "pruned")).to.equal(true);

    const outcome = coordinator.recordJoin({
      jobId: "job-test",
      runId: "run-1",
      policy: "quorum",
      satisfied: true,
      candidateWinner: "child-a",
      observations: [
        { childId: "child-a", status: "success", summary: "Plan réussi" },
        { childId: "child-b", status: "error", summary: "Erreur" },
        { childId: "child-c", status: "timeout", summary: null },
      ],
    });

    expect(outcome.winner).to.equal("child-a");
    expect(outcome.ranking[0]).to.equal("child-a");

    const afterJoin = graphState.getThoughtGraph("job-test");
    expect(afterJoin).to.not.equal(null);
    const joinedNodes = afterJoin!.nodes.filter((node) => node.parents.includes("run:run-1"));
    const winningNode = joinedNodes.find((node) => node.id === "child-a");
    expect(winningNode?.status).to.equal("completed");
    expect(typeof winningNode?.result).to.equal("string");
    const rejectedNode = joinedNodes.find((node) => node.id === "child-b");
    expect(rejectedNode?.status).to.equal("errored");
  });

  it("weights join ranking with value guard verdicts", () => {
    const graphState = new GraphState();
    graphState.createJob("job-guard", { createdAt: Date.now(), goal: "Guard", state: "running" });

    let tick = 0;
    const coordinator = new ThoughtGraphCoordinator({
      graphState,
      metaCritic: new MetaCritic(),
      valueGraph: new ValueGraph(),
      maxBranches: 3,
      now: () => {
        tick += 1;
        return tick;
      },
    });

    coordinator.recordFanout({
      jobId: "job-guard",
      runId: "run-guard",
      goal: "Guard",
      parentChildId: null,
      plannerNodeId: null,
      startedAt: 5,
      branches: [
        { childId: "child-safe", name: "safe", prompt: "safe", runtime: "codex" },
        { childId: "child-risky", name: "risky", prompt: "risky", runtime: "codex" },
      ],
    });

    const outcome = coordinator.recordJoin({
      jobId: "job-guard",
      runId: "run-guard",
      policy: "all",
      satisfied: true,
      candidateWinner: "child-risky",
      observations: [
        {
          childId: "child-safe",
          status: "success",
          summary: "Plan structuré avec mesures de mitigation",
          valueGuard: {
            allowed: true,
            score: 0.92,
            total: 1,
            threshold: 0.6,
            violationCount: 0,
          },
        },
        {
          childId: "child-risky",
          status: "success",
          summary: "Plan structuré avec mesures de mitigation",
          valueGuard: {
            allowed: false,
            score: 0.3,
            total: 1,
            threshold: 0.7,
            violationCount: 2,
          },
        },
      ],
    });

    expect(outcome.winner).to.equal("child-safe");
    expect(outcome.ranking[0]).to.equal("child-safe");

    const snapshot = graphState.getThoughtGraph("job-guard");
    expect(snapshot).to.not.equal(null);
    const safeNode = snapshot!.nodes.find((node) => node.id === "child-safe");
    const riskyNode = snapshot!.nodes.find((node) => node.id === "child-risky");
    expect(safeNode?.score).to.be.greaterThan(0.3);
    expect(riskyNode?.score).to.be.below(-0.9);
  });
});
