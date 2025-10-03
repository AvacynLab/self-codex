import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { StructuredLogger } from "../src/logger.js";
import { GraphState } from "../src/graphState.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { ValueGraph } from "../src/values/valueGraph.js";
import {
  PlanDryRunInputSchema,
  type PlanToolContext,
  handlePlanDryRun,
} from "../src/tools/planTools.js";

describe("plan dry run integration", () => {
  let tmpDir: string;
  let logger: StructuredLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "plan-dry-run-"));
    logger = new StructuredLogger({ logFile: path.join(tmpDir, "orchestrator.log") });
  });

  afterEach(async () => {
    await logger.flush();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function buildContext(overrides: Partial<PlanToolContext> = {}): PlanToolContext {
    const base: PlanToolContext = {
      supervisor: {} as never,
      graphState: new GraphState(),
      logger,
      childrenRoot: tmpDir,
      defaultChildRuntime: "codex",
      emitEvent: () => {
        /* intentionally left blank for dry-run tests */
      },
      stigmergy: new StigmergyField(),
    };
    return { ...base, ...overrides };
  }

  it("aggregates node impacts and surfaces value guard explanations", () => {
    const valueGraph = new ValueGraph();
    valueGraph.set({
      defaultThreshold: 0.7,
      values: [
        { id: "privacy", weight: 1, tolerance: 0.2 },
        { id: "safety", weight: 1, tolerance: 0.4 },
        { id: "compliance", weight: 1, tolerance: 0.5 },
      ],
    });

    const context = buildContext({ valueGuard: { graph: valueGraph, registry: new Map() } });

    const input = PlanDryRunInputSchema.parse({
      plan_id: "plan-42",
      plan_label: "Risky experiment",
      threshold: 0.6,
      graph: {
        id: "demo-graph",
        nodes: [
          { id: "alpha", kind: "task", label: "Alpha", attributes: { bt_tool: "noop" } },
          { id: "beta", kind: "task", label: "Beta", attributes: { bt_tool: "noop" } },
        ],
        edges: [{ id: "edge-alpha-beta", from: { nodeId: "alpha" }, to: { nodeId: "beta" } }],
      },
      nodes: [
        {
          id: "alpha",
          label: "Alpha",
          value_impacts: [
            { value: "privacy", impact: "risk", severity: 0.9 },
            { value: "safety", impact: "support", severity: 0.4, nodeId: "custom-node" },
          ],
        },
      ],
      impacts: [{ value: "compliance", impact: "risk", severity: 0.6, source: "global" }],
    });

    const result = handlePlanDryRun(context, input);

    expect(result.compiled_tree).to.not.equal(null);
    expect(result.compiled_tree?.id).to.equal("demo-graph");
    expect(result.nodes).to.have.length(1);
    expect(result.nodes[0]?.impacts).to.have.length(2);
    expect(result.nodes[0]?.impacts[0]?.nodeId).to.equal("alpha");
    expect(result.nodes[0]?.impacts[1]?.nodeId).to.equal("custom-node");

    expect(result.impacts).to.have.length(3);

    expect(result.value_guard).to.not.equal(null);
    expect(result.value_guard?.decision.allowed).to.equal(false);
    const privacyViolation = result.value_guard?.violations.find((violation) => violation.value === "privacy");
    expect(privacyViolation).to.not.equal(undefined);
    expect(privacyViolation?.nodeId).to.equal("alpha");
    expect(privacyViolation?.primaryContributor?.impact.nodeId).to.equal("alpha");
  });

  it("returns null explanations when the value guard is disabled", () => {
    const context = buildContext();

    const input = PlanDryRunInputSchema.parse({
      plan_id: "plan-no-guard",
      impacts: [{ value: "privacy", impact: "risk", severity: 0.2 }],
    });

    const result = handlePlanDryRun(context, input);

    expect(result.value_guard).to.equal(null);
    expect(result.impacts).to.have.length(1);
    expect(result.compiled_tree).to.equal(null);
  });

  it("propagates correlation hints to value guard telemetry", () => {
    const valueGraph = new ValueGraph();
    valueGraph.set({
      defaultThreshold: 0.2,
      values: [
        { id: "privacy", weight: 1, tolerance: 0.1 },
        { id: "safety", weight: 1, tolerance: 0.2 },
      ],
    });

    const capturedEvents: unknown[] = [];
    const unsubscribe = valueGraph.subscribe((event) => {
      capturedEvents.push(event);
    });

    const context = buildContext({ valueGuard: { graph: valueGraph, registry: new Map() } });

    const input = PlanDryRunInputSchema.parse({
      plan_id: "plan-correlation",
      run_id: "run-123",
      op_id: "op-456",
      job_id: "job-789",
      graph_id: "graph-321",
      node_id: "node-654",
      child_id: "child-987",
      impacts: [{ value: "privacy", impact: "risk", severity: 0.4 }],
    });

    handlePlanDryRun(context, input);

    unsubscribe();

    expect(capturedEvents).to.have.length(1);
    const [event] = capturedEvents as Array<{
      kind: string;
      correlation: {
        runId: string | null;
        opId: string | null;
        jobId: string | null;
        graphId: string | null;
        nodeId: string | null;
        childId: string | null;
      } | null;
    }>;
    expect(event.kind).to.equal("plan_explained");
    expect(event.correlation).to.not.equal(null);
    expect(event.correlation?.runId).to.equal("run-123");
    expect(event.correlation?.opId).to.equal("op-456");
    expect(event.correlation?.jobId).to.equal("job-789");
    expect(event.correlation?.graphId).to.equal("graph-321");
    expect(event.correlation?.nodeId).to.equal("node-654");
    expect(event.correlation?.childId).to.equal("child-987");
  });
});
