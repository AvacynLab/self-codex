import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GraphState } from "../src/graph/state.js";
import { StructuredLogger } from "../src/logger.js";
import { MetaCritic } from "../src/agents/metaCritic.js";
import { ThoughtGraphCoordinator } from "../src/reasoning/thoughtCoordinator.js";

/**
 * Exercices a deterministic reasoning harness that highlights how the
 * ThoughtGraph coordinator can recover from a weak planner hint. The synthetic
 * puzzle mirrors a "two moves to mate" riddle: a greedy branch proposes an
 * incomplete line while a systematic branch details the correct sequence.
 *
 * Without the multi-path scoring, the planner candidate would accept the first
 * branch and fail the puzzle. The test verifies that the coordinator reranks
 * branches using the MetaCritic heuristics and surfaces the high quality plan
 * as the winner.
 */
describe("thought graph multi-path harness", () => {
  it("promotes the best rated branch over the planner candidate", async function () {
    this.timeout(5_000);

    const tempRoot = await mkdtemp(path.join(tmpdir(), "thought-graph-multipath-"));
    const logFile = path.join(tempRoot, "coordinator.log");
    const logger = new StructuredLogger({ logFile });
    const graphState = new GraphState();
    const metaCritic = new MetaCritic();

    // Freeze time to keep completedAt ordering deterministic in the assertions.
    let tick = 0;
    const epoch = 1_700_000_000_000;
    const coordinator = new ThoughtGraphCoordinator({
      graphState,
      logger,
      metaCritic,
      now: () => epoch + tick++,
    });

    const jobId = "job-puzzle";
    const runId = "run-puzzle";
    // Register the job upfront so GraphState accepts ThoughtGraph snapshots.
    graphState.createJob(jobId, { goal: "Mat en deux coups", createdAt: epoch, state: "running" });

    coordinator.recordFanout({
      jobId,
      runId,
      goal: "Mat en deux coups",
      parentChildId: null,
      plannerNodeId: null,
      startedAt: epoch,
      branches: [
        {
          childId: "branch-greedy",
          name: "greedy",
          prompt: "Variante directe",
          runtime: "codex",
        },
        {
          childId: "branch-systematic",
          name: "systematic",
          prompt: "Analyse structurée",
          runtime: "codex",
        },
      ],
    });

    // The planner initially prefers the greedy line which leaves TODO markers.
    const candidateWinner = "branch-greedy";

    const observations = [
      {
        childId: "branch-greedy",
        status: "success" as const,
        summary: [
          "1. Dame h5+?", // still leaves multiple replies
          "2. ... TODO stabiliser la position",
          "Plan incomplet, besoin de vérification.",
        ].join("\n"),
      },
      {
        childId: "branch-systematic",
        status: "success" as const,
        summary: [
          "1. Dd8+ Rh7",
          "2. Qg8+ Rxg8",
          "3. Nf7#, toutes les défenses sont couvertes.",
          "Plan détaillé: menaces, alternatives, justification finale.",
        ].join("\n"),
      },
    ];

    const outcome = coordinator.recordJoin({
      jobId,
      runId,
      policy: "all",
      satisfied: true,
      candidateWinner,
      observations,
    });

    expect(candidateWinner).to.equal("branch-greedy");
    expect(outcome.winner).to.equal("branch-systematic");
    expect(outcome.ranking).to.deep.equal(["branch-systematic", "branch-greedy"]);

    // Double-check that the heuristics indeed favour the structured plan.
    const greedyScore = metaCritic.review(observations[0]!.summary ?? "", "plan", []).overall;
    const systematicScore = metaCritic.review(observations[1]!.summary ?? "", "plan", []).overall;
    expect(systematicScore).to.be.greaterThan(greedyScore);

    const snapshot = graphState.getThoughtGraph(jobId);
    expect(snapshot, "Thought graph snapshot should be stored in GraphState").to.not.equal(null);
    const nodes = snapshot!.nodes.filter((node) => node.parents.includes(`run:${runId}`));
    const greedyNode = nodes.find((node) => node.id === "branch-greedy");
    const systematicNode = nodes.find((node) => node.id === "branch-systematic");
    expect(greedyNode?.result).to.include("Plan incomplet");
    expect(greedyNode?.status).to.equal("completed");
    expect(systematicNode?.result).to.include("Plan détaillé");
    expect(systematicNode?.status).to.equal("completed");
    expect(systematicNode?.score).to.be.greaterThan(greedyNode?.score ?? -1);

    await logger.flush();
    await rm(tempRoot, { recursive: true, force: true });
  });
});
