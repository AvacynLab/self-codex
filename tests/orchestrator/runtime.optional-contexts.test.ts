import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import {
  configureRuntimeFeatures,
  getRuntimeFeatures,
  handleJsonRpc,
  __runtimeToolInternals,
  __serverLogInternals,
  __qualityAssessmentInternals,
  __graphForgeInternals,
  __transcriptAggregationInternals,
  __jsonRpcCorrelationInternals,
  __rpcServerInternals,
} from "../../src/orchestrator/runtime.js";
import type { FeatureToggles } from "../../src/serverOptions.js";
import type { ReviewResult } from "../../src/agents/metaCritic.js";

describe("orchestrator/runtime optional context sanitisation", () => {
  let originalFeatures: FeatureToggles;

  beforeEach(() => {
    originalFeatures = getRuntimeFeatures();
  });

  afterEach(() => {
    configureRuntimeFeatures(originalFeatures);
  });

  it("omits optional tool context fields when feature toggles are disabled", () => {
    configureRuntimeFeatures({
      ...originalFeatures,
      enableAutoscaler: false,
      enableIdempotency: false,
      enableBlackboard: false,
      enableCausalMemory: false,
      enableValueGuard: false,
      enableThoughtGraph: false,
    });

    const childContext = __runtimeToolInternals.getChildToolContext();
    expect(Object.prototype.hasOwnProperty.call(childContext, "idempotency"), "child context omits idempotency")
      .to.equal(false);

    const planContext = __runtimeToolInternals.getPlanToolContext();
    expect(Object.prototype.hasOwnProperty.call(planContext, "autoscaler"), "plan context omits autoscaler")
      .to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(planContext, "idempotency"), "plan context omits idempotency")
      .to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(planContext, "thoughtManager"), "plan context omits thought graph")
      .to.equal(false);

    const txContext = __runtimeToolInternals.getTxToolContext();
    expect(Object.prototype.hasOwnProperty.call(txContext, "idempotency"), "tx context omits idempotency")
      .to.equal(false);

    const batchContext = __runtimeToolInternals.getGraphBatchToolContext();
    expect(Object.prototype.hasOwnProperty.call(batchContext, "idempotency"), "batch context omits idempotency")
      .to.equal(false);

    const coordinationContext = __runtimeToolInternals.getCoordinationToolContext();
    expect(Object.prototype.hasOwnProperty.call(coordinationContext, "idempotency"), "coordination context omits idempotency")
      .to.equal(false);
  });

  it("restores optional tool context fields when toggles are enabled", () => {
    configureRuntimeFeatures({
      ...originalFeatures,
      enableAutoscaler: true,
      enableIdempotency: true,
      enableBlackboard: true,
      enableCausalMemory: true,
      enableValueGuard: true,
      enableThoughtGraph: true,
    });

    const childContext = __runtimeToolInternals.getChildToolContext();
    expect(childContext.idempotency, "child context exposes idempotency when enabled").to.be.ok;

    const planContext = __runtimeToolInternals.getPlanToolContext();
    expect(planContext.autoscaler, "plan context exposes autoscaler when enabled").to.be.ok;
    expect(planContext.idempotency, "plan context exposes idempotency when enabled").to.be.ok;
    expect(planContext.thoughtManager, "plan context exposes thought manager when enabled").to.be.ok;

    const txContext = __runtimeToolInternals.getTxToolContext();
    expect(txContext.idempotency, "tx context exposes idempotency when enabled").to.be.ok;

    const batchContext = __runtimeToolInternals.getGraphBatchToolContext();
    expect(batchContext.idempotency, "graph batch context exposes idempotency when enabled").to.be.ok;

    const coordinationContext = __runtimeToolInternals.getCoordinationToolContext();
    expect(coordinationContext.idempotency, "coordination context exposes idempotency when enabled").to.be.ok;
  });

  it("sanitises tool registration contexts when optional dependencies are unavailable", () => {
    const originalRunsRoot = process.env.MCP_RUNS_ROOT;
    configureRuntimeFeatures({ ...originalFeatures, enableIdempotency: false });
    process.env.MCP_RUNS_ROOT = "   ";

    try {
      const projectScaffoldContext = __runtimeToolInternals.getProjectScaffoldRunToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(projectScaffoldContext, "idempotency"),
        "project scaffold omits idempotency when disabled",
      ).to.equal(false);

      const artifactWriteContext = __runtimeToolInternals.getArtifactWriteToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(artifactWriteContext, "idempotency"),
        "artifact write omits idempotency when disabled",
      ).to.equal(false);

      const graphApplyContext = __runtimeToolInternals.getGraphApplyChangeSetToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(graphApplyContext, "idempotency"),
        "graph apply omits idempotency when disabled",
      ).to.equal(false);
      expect(
        Object.prototype.hasOwnProperty.call(graphApplyContext, "workerPool"),
        "graph apply omits worker pool when unset",
      ).to.equal(false);

      const graphSnapshotContext = __runtimeToolInternals.getGraphSnapshotToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(graphSnapshotContext, "idempotency"),
        "graph snapshot omits idempotency when disabled",
      ).to.equal(false);
      expect(
        Object.prototype.hasOwnProperty.call(graphSnapshotContext, "runsRoot"),
        "graph snapshot omits runs root when blank",
      ).to.equal(false);

      const planCompileContext = __runtimeToolInternals.getPlanCompileExecuteToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(planCompileContext, "idempotency"),
        "plan compile omits idempotency when disabled",
      ).to.equal(false);

      const childOrchestrateContext = __runtimeToolInternals.getChildOrchestrateToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(childOrchestrateContext, "idempotency"),
        "child orchestrate omits idempotency when disabled",
      ).to.equal(false);

      const memoryUpsertContext = __runtimeToolInternals.getMemoryUpsertToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(memoryUpsertContext, "idempotency"),
        "memory upsert omits idempotency when disabled",
      ).to.equal(false);
    } finally {
      if (originalRunsRoot === undefined) {
        delete process.env.MCP_RUNS_ROOT;
      } else {
        process.env.MCP_RUNS_ROOT = originalRunsRoot;
      }
      configureRuntimeFeatures(originalFeatures);
    }
  });

  it("exposes optional tool registration dependencies when features are enabled", () => {
    const originalRunsRoot = process.env.MCP_RUNS_ROOT;
    configureRuntimeFeatures({ ...originalFeatures, enableIdempotency: true });
    process.env.MCP_RUNS_ROOT = "/tmp/mcp-runs";

    try {
      const projectScaffoldContext = __runtimeToolInternals.getProjectScaffoldRunToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(projectScaffoldContext, "idempotency"),
        "project scaffold exposes idempotency when enabled",
      ).to.equal(true);
      expect(projectScaffoldContext.idempotency, "project scaffold idempotency reference is defined").to.not.equal(undefined);

      const artifactWriteContext = __runtimeToolInternals.getArtifactWriteToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(artifactWriteContext, "idempotency"),
        "artifact write exposes idempotency when enabled",
      ).to.equal(true);
      expect(artifactWriteContext.idempotency, "artifact write idempotency reference is defined").to.not.equal(undefined);

      const graphSnapshotContext = __runtimeToolInternals.getGraphSnapshotToolContext();
      expect(graphSnapshotContext.runsRoot, "graph snapshot surfaces trimmed runs root when provided").to.equal("/tmp/mcp-runs");

      const planCompileContext = __runtimeToolInternals.getPlanCompileExecuteToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(planCompileContext, "idempotency"),
        "plan compile exposes idempotency when enabled",
      ).to.equal(true);
      expect(planCompileContext.idempotency, "plan compile idempotency reference is defined").to.not.equal(undefined);

      const childOrchestrateContext = __runtimeToolInternals.getChildOrchestrateToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(childOrchestrateContext, "idempotency"),
        "child orchestrate exposes idempotency when enabled",
      ).to.equal(true);
      expect(childOrchestrateContext.idempotency, "child orchestrate idempotency reference is defined").to.not.equal(
        undefined,
      );

      const memoryUpsertContext = __runtimeToolInternals.getMemoryUpsertToolContext();
      expect(
        Object.prototype.hasOwnProperty.call(memoryUpsertContext, "idempotency"),
        "memory upsert exposes idempotency when enabled",
      ).to.equal(true);
      expect(memoryUpsertContext.idempotency, "memory upsert idempotency reference is defined").to.not.equal(undefined);
    } finally {
      if (originalRunsRoot === undefined) {
        delete process.env.MCP_RUNS_ROOT;
      } else {
        process.env.MCP_RUNS_ROOT = originalRunsRoot;
      }
      configureRuntimeFeatures(originalFeatures);
    }
  });

  it("does not surface undefined logger overrides in the active configuration", () => {
    const options = __serverLogInternals.snapshotLoggerOptions();
    expect(Object.values(options).every((value) => value !== undefined), "logger options never expose undefined values").to.equal(
      true,
    );
    if ("maxFileSizeBytes" in options) {
      expect(options.maxFileSizeBytes, "rotate size remains numeric when provided").to.be.a("number");
    }
    if ("maxFileCount" in options) {
      expect(options.maxFileCount, "rotate count remains numeric when provided").to.be.a("number");
    }
  });

  it("normalises quality assessment metrics to exclude undefined entries", () => {
    const review: ReviewResult = {
      overall: 0.65,
      verdict: "pass",
      feedback: [],
      suggestions: [],
      breakdown: [],
      fingerprint: "test",
    };

    const assessment = __qualityAssessmentInternals.computeQualityAssessment(
      "code",
      "Tests cover main paths and lint errors remain low.",
      review,
    );

    expect(assessment, "assessment is produced").to.not.equal(null);
    if (assessment) {
      expect(Object.values(assessment.metrics).every((value) => typeof value === "number"), "metrics are numeric").to.equal(true);
      expect(Object.prototype.hasOwnProperty.call(assessment.metrics, "missing"), "no stray metric keys").to.equal(false);
    }
  });

  it("omits undefined weight keys when constructing Graph Forge tasks", () => {
    const compiled = {
      graph: {
        name: "TestGraph",
        directives: new Map<string, unknown>(),
        listNodes: () => [],
        listEdges: () => [],
        getNode: () => undefined,
        getOutgoing: () => [],
      },
      analyses: [
        {
          name: "defined_from_dsl",
          tokenLine: 1,
          tokenColumn: 1,
          args: [{ value: "sample", tokenLine: 1, tokenColumn: 1 }],
        },
      ],
    } as Parameters<typeof __graphForgeInternals.buildGraphForgeTasks>[0];
    const tasks = __graphForgeInternals.buildGraphForgeTasks(
      compiled,
      {
        source: "graph forge stub",
        use_defined_analyses: false,
        analyses: [
          { name: "custom", args: ["a"], weight_key: undefined },
          { name: "weighted", args: [], weight_key: "latency" },
        ],
      } as Parameters<typeof __graphForgeInternals.buildGraphForgeTasks>[1],
    );
    const customTask = tasks.find((task) => task.name === "custom" && task.source === "request");
    expect(customTask, "custom task is produced").to.not.equal(undefined);
    if (customTask) {
      expect(Object.prototype.hasOwnProperty.call(customTask, "weightKey"), "weightKey omitted when undefined").to.equal(false);
    }
    const weightedTask = tasks.find((task) => task.name === "weighted");
    expect(weightedTask?.weightKey, "weight key is preserved when provided").to.equal("latency");
  });

  it("drops aggregate flags that are undefined", () => {
    const options = __transcriptAggregationInternals.normaliseAggregateOptions({
      include_system: undefined,
      include_goals: true,
    });
    expect(options).to.deep.equal({ includeGoals: true });
  });

  it("invokes JSON-RPC handlers without surfacing a sessionId when absent", async () => {
    const method = `unit/session/${Date.now()}`;
    const capturedExtras: unknown[] = [];
    __rpcServerInternals.setRequestHandler(method, async (_request, extra) => {
      capturedExtras.push(extra);
      return { ok: true };
    });
    try {
      const response = await handleJsonRpc({ jsonrpc: "2.0" as const, id: "session-test", method });
      expect((response as { error?: unknown }).error, "JSON-RPC call succeeds").to.equal(undefined);
    } finally {
      __rpcServerInternals.deleteRequestHandler(method);
    }
    expect(capturedExtras).to.have.lengthOf(1);
    const extra = capturedExtras[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(extra, "sessionId"), "sessionId property is omitted").to.equal(false);
  });

  it("merges correlation snapshots without propagating undefined values", () => {
    const base = { runId: "run-1", jobId: "job-1" };
    const merged = __jsonRpcCorrelationInternals.mergeCorrelationSnapshots(base, { jobId: undefined });
    expect(base.jobId, "base snapshot remains unchanged").to.equal("job-1");
    expect(Object.prototype.hasOwnProperty.call(merged, "jobId"), "undefined overrides remove the key").to.equal(false);
    expect(merged.runId).to.equal("run-1");
  });
});
