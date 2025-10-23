import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeFinalReportCli,
  parseFinalReportCliOptions,
  type FinalReportCliLogger,
} from "../../src/validation/finalReportCli.js";
import {
  FINAL_REPORT_FINDINGS_FILENAME,
  FINAL_REPORT_RECOMMENDATIONS_FILENAME,
  FINAL_REPORT_SUMMARY_FILENAME,
  type FinalReportOptions,
  type FinalReportResult,
} from "../../src/validation/finalReport.js";

/**
 * Constructs a representative {@link FinalReportResult} for CLI tests so we can focus on
 * verifying option sanitisation and logging without repeating verbose fixtures in each case.
 */
function buildFinalReportResult(runId: string, runRoot: string): FinalReportResult {
  return {
    runId,
    generatedAt: "2099-01-01T00:00:00Z",
    findingsPath: join(runRoot, "report", FINAL_REPORT_FINDINGS_FILENAME),
    summaryPath: join(runRoot, "report", FINAL_REPORT_SUMMARY_FILENAME),
    recommendationsPath: join(runRoot, "report", FINAL_REPORT_RECOMMENDATIONS_FILENAME),
    findings: {
      generatedAt: "2099-01-01T00:00:00Z",
      runId,
      versions: { node: "v99.0.0", npm: "10.0.0", app: "1.0.0", sdk: "1.2.3" },
      metrics: {
        totalCalls: 5,
        errorCount: 1,
        uniqueMethods: 3,
        uniqueTools: 2,
        uniqueScenarios: 2,
        stagesCompleted: 1,
      },
      stages: [],
      tools: [],
      incidents: [],
      coverage: { expectedTools: null, coveredTools: 0, missingTools: [], unexpectedTools: [] },
      kpis: { totalEvents: 0, eventsByStage: [], eventSequences: [], artefactBytes: { total: 0, byStage: [] } },
    },
    summaryMarkdown: "# Summary",
    recommendationsMarkdown: "# Recommendations",
  } satisfies FinalReportResult;
}

describe("validation final report CLI", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "codex-final-report-cli-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("parses CLI arguments", () => {
    const options = parseFinalReportCliOptions([
      "--run-id",
      "validation_custom",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "/tmp/custom-root",
    ]);

    expect(options.runId).to.equal("validation_custom");
    expect(options.baseDir).to.equal("custom-runs");
    expect(options.runRoot).to.equal("/tmp/custom-root");
  });

  it("executes the aggregation workflow and prints artefact paths", async () => {
    const runId = "validation_cli";
    const runRoot = join(workspaceRoot, "runs", runId);
    const logs: string[] = [];
    const logger: FinalReportCliLogger = { log: (...args: unknown[]) => logs.push(args.join(" ")) };

    const fakeResult = buildFinalReportResult(runId, runRoot);

    const result = await executeFinalReportCli(
      { baseDir: join(workspaceRoot, "runs"), runRoot },
      process.env,
      logger,
      {
        runner: async () => fakeResult,
      },
    );

    expect(result.runRoot).to.equal(runRoot);
    expect(result.result.findings.metrics.totalCalls).to.equal(5);
    expect(logs.some((entry) => entry.includes(FINAL_REPORT_FINDINGS_FILENAME))).to.equal(true);
    expect(logs.some((entry) => entry.includes(FINAL_REPORT_SUMMARY_FILENAME))).to.equal(true);
    expect(logs.some((entry) => entry.includes(FINAL_REPORT_RECOMMENDATIONS_FILENAME))).to.equal(true);
  });

  it("sanitises override options before invoking the runner", async () => {
    const runId = "validation_cli";
    const runRoot = join(workspaceRoot, "runs", runId);
    const logger: FinalReportCliLogger = { log: () => undefined };
    const fakeResult = buildFinalReportResult(runId, runRoot);

    const now: FinalReportOptions["now"] = () => new Date("2030-01-01T00:00:00Z");
    let capturedOptions: FinalReportOptions | undefined;

    await executeFinalReportCli(
      { baseDir: join(workspaceRoot, "runs"), runId },
      process.env,
      logger,
      {
        options: {
          now,
          expectedToolsOverride: undefined,
          packageJsonPath: undefined,
        },
        runner: async (_runRoot, options) => {
          capturedOptions = options;
          return fakeResult;
        },
      },
    );

    expect(capturedOptions?.now).to.equal(now);
    expect(Object.prototype.hasOwnProperty.call(capturedOptions ?? {}, "expectedToolsOverride")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(capturedOptions ?? {}, "packageJsonPath")).to.equal(false);
  });
});

