import { describe, it } from "mocha";
import { expect } from "chai";

import { buildChildCognitiveEvents, type QualityAssessmentSnapshot } from "../src/events/cognitive.js";
import type { ReviewResult } from "../src/agents/metaCritic.js";
import type { ReflectionResult } from "../src/agents/selfReflect.js";

describe("events cognitive", () => {
  it("builds correlated review and reflection events", () => {
    const review: ReviewResult = {
      overall: 0.82,
      verdict: "pass",
      feedback: ["Structure claire", "Couverture suffisante"],
      suggestions: ["Renforcer la mitigation"],
      breakdown: [
        { criterion: "clarity", score: 0.8, reasoning: "Paragraphes concis" },
        { criterion: "risks", score: 0.7, reasoning: "Risques identifiés" },
      ],
      fingerprint: "abcd1234ef567890",
    };

    const reflection: ReflectionResult = {
      insights: ["Livrable exploitable"],
      nextSteps: ["Planifier la mitigation"],
      risks: ["Écart sur la couverture tests"],
    };

    const quality: QualityAssessmentSnapshot = {
      kind: "plan",
      score: 76,
      rubric: { coverage: 0.6, coherence: 0.8 },
      metrics: { coverage: 0.6, coherence: 0.8, risk: 0.35 },
      gate: { enabled: true, threshold: 0.75, needs_revision: false },
    };

    const events = buildChildCognitiveEvents({
      childId: "child-123",
      jobId: "job-9",
      summary: { text: "Étude du plan", tags: ["plan", "child-123"], kind: "plan" },
      review,
      reflection,
      quality,
      artifactCount: 2,
      messageCount: 5,
      correlationSources: [
        { run_id: "run-abc", op_id: "op-xyz" },
        { graph_id: "graph-12", node_id: "node-34" },
      ],
    });

    expect(events.review.kind).to.equal("COGNITIVE");
    expect(events.review.level).to.equal("info");
    expect(events.review.childId).to.equal("child-123");
    expect(events.review.jobId).to.equal("job-9");
    expect(events.review.correlation).to.deep.equal({
      childId: "child-123",
      jobId: "job-9",
      runId: "run-abc",
      opId: "op-xyz",
      graphId: "graph-12",
      nodeId: "node-34",
    });

    const reviewPayload = events.review.payload as {
      msg?: string;
      summary?: { kind?: string; text?: string; tags?: string[] };
      review?: ReviewResult;
      metrics?: { artifacts?: number; messages?: number };
      quality_assessment?: QualityAssessmentSnapshot | null;
      run_id?: string | null;
      op_id?: string | null;
    };
    expect(reviewPayload.msg).to.equal("child_meta_review");
    expect(reviewPayload.summary?.kind).to.equal("plan");
    expect(reviewPayload.summary?.tags).to.include("child-123");
    expect(reviewPayload.review?.verdict).to.equal("pass");
    expect(reviewPayload.metrics).to.deep.equal({ artifacts: 2, messages: 5 });
    expect(reviewPayload.quality_assessment).to.deep.equal(quality);
    expect(reviewPayload.run_id).to.equal("run-abc");
    expect(reviewPayload.op_id).to.equal("op-xyz");

    expect(events.reflection).to.not.equal(null);
    const reflectionPayload = events.reflection?.payload as {
      msg?: string;
      reflection?: { insights?: string[]; next_steps?: string[]; risks?: string[] };
    };
    expect(reflectionPayload?.msg).to.equal("child_reflection");
    expect(reflectionPayload?.reflection?.insights).to.deep.equal(reflection.insights);
    expect(events.reflection?.correlation).to.deep.equal(events.review.correlation);
  });

  it("omits the reflection event when no reflection summary is available", () => {
    const review: ReviewResult = {
      overall: 0.55,
      verdict: "warn",
      feedback: ["Couverture partielle"],
      suggestions: ["Ajouter des exemples"],
      breakdown: [{ criterion: "coverage", score: 0.4, reasoning: "Sections manquantes" }],
      fingerprint: "feedfacecafebeef",
    };

    const events = buildChildCognitiveEvents({
      childId: "child-beta",
      summary: { text: "Sortie textuelle", tags: ["text"], kind: "text" },
      review,
      artifactCount: 0,
      messageCount: 1,
      correlationSources: [{ child_id: "child-beta", run_id: "run-txt" }],
    });

    expect(events.review.childId).to.equal("child-beta");
    expect(events.review.correlation.runId).to.equal("run-txt");
    expect(events.reflection).to.equal(null);
  });
});

