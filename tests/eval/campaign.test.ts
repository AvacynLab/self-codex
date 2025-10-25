import { describe, it } from "mocha";
import { expect } from "chai";

import {
  runEvaluationCampaign,
  type EvaluationCampaignDependencies,
  type EvaluationCampaignOptions,
} from "../../scripts/eval.ts";
import type { EvaluationScenario } from "../../src/eval/scenario.js";
import type { CampaignMetrics, ScenarioEvaluationSummary } from "../../src/eval/metrics.js";
import type { EvaluationClient } from "../../src/eval/runner.js";

/**
 * Stubs an evaluation client by replaying pre-recorded tool call results. Tests
 * rely on the helper to exercise the campaign orchestration without invoking
 * the real MCP runtime.
 */
class StubEvaluationClient implements EvaluationClient {
  private index = 0;

  constructor(
    private readonly plan: Array<{
      tool: string;
      text: string;
      durationMs: number;
      tokens?: number;
      isError?: boolean;
    }>,
  ) {}

  async callTool(toolName: string): Promise<{
    toolName: string;
    traceId: string;
    durationMs: number;
    response: {
      isError: boolean;
      content: ReadonlyArray<{ type: string; text: string }>;
      metadata?: { cost: { totalTokens: number } };
    };
  }> {
    const entry = this.plan[this.index];
    this.index += 1;
    if (!entry) {
      throw new Error(`unexpected tool call ${toolName}`);
    }
    expect(toolName).to.equal(entry.tool);
    return {
      toolName,
      traceId: `${toolName}-${this.index}`,
      durationMs: entry.durationMs,
      response: {
        isError: entry.isError ?? false,
        content: [{ type: "text", text: entry.text }],
        metadata:
          typeof entry.tokens === "number"
            ? {
                cost: { totalTokens: entry.tokens },
              }
            : undefined,
      },
    };
  }

  async close(): Promise<void> {
    // No-op close hook to satisfy the EvaluationCampaignDependencies contract.
  }
}

describe("evaluation campaign runner", () => {
  it("executes scenarios, writes reports, and enforces gate thresholds", async () => {
    const scenarioSuccess: EvaluationScenario = {
      id: "scenario-success",
      objective: "validate success",
      tags: ["critical"],
      constraints: { maxDurationMs: 500 },
      steps: [
        { id: "step-1", tool: "alpha", expect: { success: true, match: "ok" } },
      ],
      oracles: [{ type: "regex", pattern: "ok" }],
      featureOverrides: { enablePlanner: false },
    };
    const scenarioFailure: EvaluationScenario = {
      id: "scenario-failure",
      objective: "validate failure",
      tags: ["critical"],
      constraints: {},
      steps: [
        { id: "fail-step", tool: "beta", expect: { success: true, match: "expected" } },
      ],
      oracles: [],
    };

    const options: EvaluationCampaignOptions = {
      runId: "campaign-001",
      runRoot: "/tmp/campaign",
      scenarioPaths: [],
      tags: [],
      gateThresholds: { minSuccessRate: 0.75 },
      featureOverrides: { enableResources: false },
      traceSeed: "seed-1",
    };

    const logs: string[] = [];
    const warnings: string[] = [];
    const scenarioReports: Array<{ index: number; summary: ScenarioEvaluationSummary }> = [];
    let summaryArgs: {
      overall: CampaignMetrics;
      gate: CampaignMetrics;
      gatePassed: boolean;
    } | null = null;
    const observedOverrides: Record<string, unknown>[] = [];

    const dependencies: EvaluationCampaignDependencies = {
      workspaceRoot: "/workspace/test",
      createLogger: () => ({
        log: (message: string) => logs.push(message),
        warn: (message: string) => warnings.push(message),
      }),
      loadScenarios: async () => [scenarioSuccess, scenarioFailure],
      createRunContext: async ({ runId }) => ({
        runId,
        rootDir: "/tmp/run", // Minimal stub for the evaluation context root.
        directories: {
          report: "/tmp/report",
          inputs: "/tmp/inputs",
          outputs: "/tmp/outputs",
          events: "/tmp/events",
          logs: "/tmp/logs",
          artifacts: "/tmp/artifacts",
        },
        createTraceId: () => "trace-stub",
      }),
      createRecorder: async () => ({ recorder: true }),
      createMcpClient: async ({ scenario, featureOverrides }) => {
        observedOverrides.push(featureOverrides);
        if (scenario.id === "scenario-success") {
          return new StubEvaluationClient([
            { tool: "alpha", text: "ok", durationMs: 40, tokens: 3 },
          ]);
        }
        return new StubEvaluationClient([
          { tool: "beta", text: "unexpected", durationMs: 35, tokens: 2, isError: true },
        ]);
      },
      writeScenarioReport: async (_runContext, index, summary, _scenario) => {
        scenarioReports.push({ index, summary });
        return `/tmp/report/${index}.json`;
      },
      writeCampaignSummary: async (
        _runContext,
        _runId,
        _summaries,
        overallMetrics,
        gateMetrics,
        gateResult,
      ) => {
        summaryArgs = {
          overall: overallMetrics,
          gate: gateMetrics,
          gatePassed: gateResult.passed,
        };
        return "/tmp/report/summary.md";
      },
    };

    const result = await runEvaluationCampaign(options, dependencies);

    expect(result.summaries).to.have.length(2);
    expect(result.gateResult.passed).to.equal(false);
    expect(result.summaryPath).to.equal("/tmp/report/summary.md");
    expect(result.summaries.some((summary) => summary.success === false)).to.equal(true);
    expect(scenarioReports).to.have.length(2);
    expect(summaryArgs?.gatePassed).to.equal(false);
    expect(summaryArgs?.overall.successCount).to.equal(1);
    expect(summaryArgs?.overall.scenarioCount).to.equal(2);
    expect(logs.some((line) => line.includes("scenario-success"))).to.equal(true);
    expect(warnings.some((line) => line.includes("scenario-failure"))).to.equal(true);
    expect(observedOverrides[0]).to.include({ enablePlanner: false });
    expect(observedOverrides[0]).to.include({ enableMcpIntrospection: true });
    expect(observedOverrides[0]).to.include({ enableResources: false });
  });

  it("warns and skips orchestration when no scenarios match", async () => {
    const options: EvaluationCampaignOptions = {
      runId: "campaign-empty",
      runRoot: undefined,
      scenarioPaths: [],
      tags: ["smoke"],
      gateThresholds: { minSuccessRate: 1 },
      featureOverrides: {},
      traceSeed: undefined,
    };

    let warnedMessage: string | null = null;
    let runContextCreated = false;

    const dependencies: EvaluationCampaignDependencies = {
      workspaceRoot: "/workspace/test",
      createLogger: () => ({
        log: () => {
          throw new Error("log should not be called when no scenarios are loaded");
        },
        warn: (message: string) => {
          warnedMessage = message;
        },
      }),
      loadScenarios: async () => [],
      createRunContext: async () => {
        runContextCreated = true;
        return {};
      },
      createRecorder: async () => {
        throw new Error("recorder should not be created without scenarios");
      },
      createMcpClient: async () => {
        throw new Error("MCP client should not be created without scenarios");
      },
      writeScenarioReport: async () => {
        throw new Error("scenario reports should not be written without scenarios");
      },
      writeCampaignSummary: async () => {
        throw new Error("campaign summary should not be written without scenarios");
      },
    };

    const result = await runEvaluationCampaign(options, dependencies);

    expect(runContextCreated).to.equal(false);
    expect(result.summaryPath).to.equal(null);
    expect(result.gateResult.passed).to.equal(true);
    expect(result.summaries).to.be.empty;
    expect(warnedMessage).to.include("Aucun scénario");
  });
});
