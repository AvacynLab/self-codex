import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect } from "chai";

import {
  runValidationCampaign,
  type ValidationCampaignHooks,
} from "../../src/validationRun/campaign.js";
import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";
import {
  formatScenarioSlug,
  resolveScenarioById,
} from "../../src/validationRun/scenario.js";
import type {
  ScenarioTimingBucket,
  ScenarioTimingReport,
  ScenarioRunPaths,
} from "../../src/validationRun/artefacts.js";
import type {
  ExecuteSearchScenarioResult,
} from "../../src/validationRun/execution.js";
import type {
  IdempotenceDiff,
  ScenarioIdempotenceComparison,
  ScenarioIdempotenceSnapshot,
} from "../../src/validationRun/idempotence.js";
import type { ValidationAuditReport, SecretFinding } from "../../src/validationRun/audit.js";
import type {
  PersistedRemediationPlan,
  RemediationPlan,
} from "../../src/validationRun/remediation.js";
import type {
  PersistedValidationReport,
  ValidationSummaryReport,
} from "../../src/validationRun/reports.js";

function buildBucket(p50: number, p95: number, p99: number): ScenarioTimingBucket {
  return { p50, p95, p99 };
}

function buildTimingReport(documentsIngested = 2, tookMs = 1200): ScenarioTimingReport {
  return {
    searxQuery: buildBucket(100, 200, 240),
    fetchUrl: buildBucket(80, 150, 210),
    extractWithUnstructured: buildBucket(120, 260, 320),
    ingestToGraph: buildBucket(60, 90, 110),
    ingestToVector: buildBucket(70, 100, 140),
    tookMs,
    documentsIngested,
    errors: {},
  };
}

function buildRunPaths(layout: Awaited<ReturnType<typeof ensureValidationRunLayout>>, scenarioId: number): ScenarioRunPaths {
  const scenario = resolveScenarioById(scenarioId);
  const slug = formatScenarioSlug(scenario);
  const root = path.join(layout.runsDir, slug);
  return {
    root,
    input: path.join(root, "input.json"),
    response: path.join(root, "response.json"),
    events: path.join(root, "events.ndjson"),
    timings: path.join(root, "timings.json"),
    errors: path.join(root, "errors.json"),
    kgChanges: path.join(root, "kg_changes.ndjson"),
    vectorUpserts: path.join(root, "vector_upserts.json"),
    serverLog: path.join(root, "server.log"),
  };
}

function buildScenarioResult(
  layout: Awaited<ReturnType<typeof ensureValidationRunLayout>>,
  scenarioId: number,
  overrides: Partial<ExecuteSearchScenarioResult> = {},
): ExecuteSearchScenarioResult {
  const scenario = resolveScenarioById(scenarioId);
  const runPaths = buildRunPaths(layout, scenarioId);
  return {
    scenario,
    jobId: overrides.jobId ?? `job-${scenarioId}`,
    events: overrides.events ?? [],
    timings: overrides.timings,
    timingNotes: overrides.timingNotes ?? [],
    response: overrides.response ?? {},
    documents: overrides.documents ?? [],
    knowledgeSummaries: overrides.knowledgeSummaries ?? [],
    vectorSummaries: overrides.vectorSummaries ?? [],
    runPaths,
    layout,
    artifactDir: overrides.artifactDir ?? path.join(layout.artifactsDir, formatScenarioSlug(scenario)),
  };
}

function buildIdempotenceSnapshot(
  layout: Awaited<ReturnType<typeof ensureValidationRunLayout>>,
  scenarioId: number,
  overrides: Partial<ScenarioIdempotenceSnapshot> = {},
): ScenarioIdempotenceSnapshot {
  const scenario = resolveScenarioById(scenarioId);
  const runPaths = buildRunPaths(layout, scenarioId);
  return {
    scenario,
    runPaths,
    documentIds: overrides.documentIds ?? [],
    documentDuplicates: overrides.documentDuplicates ?? [],
    eventDocIds: overrides.eventDocIds ?? [],
    eventDuplicates: overrides.eventDuplicates ?? [],
    notes: overrides.notes ?? [],
  };
}

describe("validationRun/campaign", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "validation-campaign-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("orchestrates the full pipeline and aggregates notes", async () => {
    const baseRoot = path.join(tempRoot, "full");
    const layout = await ensureValidationRunLayout(baseRoot);
    const calls: string[] = [];

    const hooks: ValidationCampaignHooks = {
      captureSnapshots: async (options) => {
        calls.push("snapshots");
        expect(options.layout?.root).to.equal(layout.root);
        return {
          versions: path.join(layout.snapshotsDir, "versions.txt"),
          git: path.join(layout.snapshotsDir, "git.txt"),
          env: path.join(layout.snapshotsDir, ".env.effective"),
          searxProbe: path.join(layout.snapshotsDir, "searxng_probe.txt"),
          unstructuredProbe: path.join(layout.snapshotsDir, "unstructured_probe.txt"),
        };
      },
      runBuild: async (options) => {
        calls.push("build");
        expect(options.root).to.equal(layout.root);
        return { logFile: path.join(layout.logsDir, "build.log"), steps: [], success: true };
      },
      ensureRuntime: async (options) => {
        calls.push("runtime");
        expect(options.root).to.equal(layout.root);
        return { layout, env: { MCP_RUNS_ROOT: layout.root } };
      },
      executeScenario: async (options) => {
        calls.push(`scenario:${options.scenarioId}`);
        expect(options.layout?.root).to.equal(layout.root);
        if (options.scenarioId === 1) {
          expect(options.jobId).to.equal("nightly_S01_pdf_science");
        }
        if (options.scenarioId === 10) {
          expect(options.jobId).to.equal("nightly_S10_qualite_rag");
        }
        const scenarioResult = buildScenarioResult(layout, options.scenarioId, {
          jobId: options.jobId,
          timings: options.scenarioId === 10 ? undefined : buildTimingReport(),
          timingNotes: options.scenarioId === 1 ? ["latence searxQuery manquante"] : [],
        });
        return scenarioResult;
      },
      writeReport: async () => {
        calls.push("report");
        const summary: ValidationSummaryReport = {
          generatedAt: "2025-12-07T00:00:00.000Z",
          scenarios: [],
          totals: { documentsIngested: 0, events: 0, kgChanges: 0, vectorUpserts: 0, errors: {} },
          acceptance: {
            functional: { status: "pass", details: "ok" },
            idempotence: { status: "pass", details: "ok" },
            extraction: { status: "pass", details: "ok" },
            language: { status: "pass", details: "ok" },
            ragQuality: { status: "pass", details: "ok" },
            performance: { status: "pass", details: "ok" },
            robustness: { status: "pass", details: "ok" },
          },
        };
        const report: PersistedValidationReport = {
          summary,
          summaryPath: path.join(layout.reportsDir, "summary.json"),
          reportPath: path.join(layout.reportsDir, "REPORT.md"),
        };
        return report;
      },
      compareIdempotence: async () => {
        calls.push("idempotence");
        const diff: IdempotenceDiff = { baseOnly: [], rerunOnly: [] };
        const comparison: ScenarioIdempotenceComparison = {
          base: buildIdempotenceSnapshot(layout, 1),
          rerun: buildIdempotenceSnapshot(layout, 5),
          documentDiff: diff,
          eventDiff: diff,
          status: "pass",
          notes: ["Aucun diff détecté"],
        };
        return comparison;
      },
      audit: async () => {
        calls.push("audit");
        const auditReport: ValidationAuditReport = {
          layout,
          scenarios: [],
          secretFindings: [],
          hasBlockingIssues: false,
        };
        return auditReport;
      },
      writeRemediationPlan: async () => {
        calls.push("remediation");
        const plan: RemediationPlan = {
          generatedAt: "2025-12-07T00:15:00.000Z",
          status: "clear",
          actions: [],
          notes: [],
        };
        const persisted: PersistedRemediationPlan = {
          plan,
          jsonPath: path.join(layout.reportsDir, "remediation_plan.json"),
          markdownPath: path.join(layout.reportsDir, "REMEDIATION_PLAN.md"),
        };
        return persisted;
      },
    };

    const result = await runValidationCampaign({
      baseRoot,
      scenarioIds: [1, 10],
      scenarioJobIdPrefix: "nightly",
      hooks,
    });

    expect(result.success).to.equal(true);
    expect(result.scenarios).to.have.lengthOf(2);
    expect(result.scenarios.every((scenario) => scenario.ok)).to.equal(true);
    expect(result.notes).to.deep.include("S01_pdf_science: latence searxQuery manquante");
    expect(result.notes).to.deep.include("Idempotence: Aucun diff détecté");
    expect(calls).to.deep.equal([
      "snapshots",
      "build",
      "runtime",
      "scenario:1",
      "scenario:10",
      "report",
      "idempotence",
      "audit",
      "remediation",
    ]);
  });

  it("stops executing scenarios after the first failure when requested", async () => {
    const baseRoot = path.join(tempRoot, "stop-on-error");
    const layout = await ensureValidationRunLayout(baseRoot);
    let executionCount = 0;

    const hooks: ValidationCampaignHooks = {
      executeScenario: async (options) => {
        executionCount += 1;
        expect(options.layout?.root).to.equal(layout.root);
        if (options.scenarioId === 1) {
          throw new Error("network timeout");
        }
        return buildScenarioResult(layout, options.scenarioId, {
          timings: buildTimingReport(),
        });
      },
    };

    const result = await runValidationCampaign({
      baseRoot,
      scenarioIds: [1, 2],
      stopOnScenarioFailure: true,
      captureSnapshots: false,
      runBuild: false,
      ensureRuntime: false,
      generateReport: false,
      runIdempotence: false,
      runAudit: false,
      runRemediation: false,
      hooks,
    });

    expect(result.success).to.equal(false);
    expect(result.scenarios).to.have.lengthOf(1);
    expect(result.scenarios[0].scenarioId).to.equal(1);
    expect(result.scenarios[0].ok).to.equal(false);
    expect(result.scenarios[0].error).to.equal("network timeout");
    expect(executionCount).to.equal(1);
  });

  it("marks the campaign as failed when idempotence or audit raise blocking issues", async () => {
    const baseRoot = path.join(tempRoot, "checks");
    const layout = await ensureValidationRunLayout(baseRoot);

    const secret: SecretFinding = {
      file: path.join(layout.runsDir, "S01_pdf_science", "events.ndjson"),
      line: 42,
      description: "Token exposé",
      snippet: "MCP_HTTP_TOKEN=abcd",
    };

    const hooks: ValidationCampaignHooks = {
      compareIdempotence: async () => {
        const diff: IdempotenceDiff = { baseOnly: ["docA"], rerunOnly: [] };
        const comparison: ScenarioIdempotenceComparison = {
          base: buildIdempotenceSnapshot(layout, 1, { documentIds: ["docA"] }),
          rerun: buildIdempotenceSnapshot(layout, 5, { documentIds: [] }),
          documentDiff: diff,
          eventDiff: diff,
          status: "fail",
          notes: ["DocIds divergents"],
        };
        return comparison;
      },
      audit: async () => {
        const auditReport: ValidationAuditReport = {
          layout,
          scenarios: [],
          secretFindings: [secret],
          hasBlockingIssues: true,
        };
        return auditReport;
      },
      writeRemediationPlan: async () => {
        const plan: RemediationPlan = {
          generatedAt: "2025-12-07T01:00:00.000Z",
          status: "blocked",
          actions: [],
          notes: [],
        };
        const persisted: PersistedRemediationPlan = {
          plan,
          jsonPath: path.join(layout.reportsDir, "remediation_plan.json"),
          markdownPath: path.join(layout.reportsDir, "REMEDIATION_PLAN.md"),
        };
        return persisted;
      },
      writeReport: async () => {
        const summary: ValidationSummaryReport = {
          generatedAt: "2025-12-07T01:00:00.000Z",
          scenarios: [],
          totals: { documentsIngested: 0, events: 0, kgChanges: 0, vectorUpserts: 0, errors: {} },
          acceptance: {
            functional: { status: "pass", details: "ok" },
            idempotence: { status: "fail", details: "diff" },
            extraction: { status: "pass", details: "ok" },
            language: { status: "pass", details: "ok" },
            ragQuality: { status: "pass", details: "ok" },
            performance: { status: "pass", details: "ok" },
            robustness: { status: "pass", details: "ok" },
          },
        };
        const report: PersistedValidationReport = {
          summary,
          summaryPath: path.join(layout.reportsDir, "summary.json"),
          reportPath: path.join(layout.reportsDir, "REPORT.md"),
        };
        return report;
      },
    };

    const result = await runValidationCampaign({
      baseRoot,
      captureSnapshots: false,
      runBuild: false,
      ensureRuntime: false,
      generateReport: true,
      runIdempotence: true,
      runAudit: true,
      runRemediation: true,
      scenarioIds: [],
      hooks,
    });

    expect(result.success).to.equal(false);
    expect(result.idempotence?.ok).to.equal(false);
    expect(result.audit?.ok).to.equal(false);
    expect(result.audit?.error).to.include("audit");
    expect(result.notes).to.deep.include("Idempotence: DocIds divergents");
    expect(result.notes).to.deep.include("Audit: 1 indice(s) de secret à vérifier.");
  });
});
