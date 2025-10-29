import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";

import {
  buildScenarioDashboardExport,
  buildScenarioTimingReport,
  computeScenarioTimingReportFromEvents,
  computeScenarioTimingReportFromFile,
  computeTimingBucket,
  extractScenarioMetricsFromEvents,
  writeScenarioDashboardExport,
  type ScenarioMetricSamples,
} from "../../src/validationRun/metrics";
import { type ScenarioTimingReport } from "../../src/validationRun/artefacts";
import { ensureValidationRunLayout } from "../../src/validationRun/layout";

/** Utility to create an isolated sandbox for filesystem assertions. */
async function createSandbox(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("validationRun.metrics", () => {
  describe("computeTimingBucket", () => {
    it("computes linear interpolation percentiles", () => {
      const bucket = computeTimingBucket([10, 20, 30, 40, 50]);
      expect(bucket).to.deep.equal({ p50: 30, p95: 48, p99: 49.6 });
    });

    it("throws when no samples are provided", () => {
      expect(() => computeTimingBucket([])).to.throw(
        "Cannot compute timing bucket from an empty sample set.",
      );
    });
  });

  describe("buildScenarioTimingReport", () => {
    it("combines samples into the canonical report", () => {
      const samples: ScenarioMetricSamples = {
        stageDurations: {
          searxQuery: [100, 110, 120],
          fetchUrl: [200, 250, 300],
          extractWithUnstructured: [400],
          ingestToGraph: [150, 175, 190],
          ingestToVector: [160, 170, 180],
        },
        totalDurations: [1234, 1180],
        documentIds: ["doc-1", "doc-2", "doc-1"],
        documentCountIncrements: [1],
        errorCategories: ["network_error", "network_error", "robots_denied"],
      };

      const { report, notes } = buildScenarioTimingReport(samples, {
        totalDurationAggregator: "median",
      });

      expect(report.tookMs).to.equal(1207);
      expect(report.documentsIngested).to.equal(2);
      expect(report.errors).to.deep.equal({ network_error: 2, robots_denied: 1 });
      expect(notes).to.deep.equal([]);
    });

    it("reports missing stages and falls back to maxima for tookMs", () => {
      const samples: ScenarioMetricSamples = {
        stageDurations: {
          searxQuery: [100],
        },
        totalDurations: [],
        documentIds: [],
        documentCountIncrements: [],
        errorCategories: [],
      };

      const { report, notes } = buildScenarioTimingReport(samples);

      expect(report.tookMs).to.equal(100);
      expect(report.searxQuery.p50).to.equal(100);
      expect(report.fetchUrl).to.deep.equal({ p50: 0, p95: 0, p99: 0 });
      expect(notes).to.have.length.greaterThan(0);
    });
  });

  describe("buildScenarioDashboardExport", () => {
    it("returns an immutable snapshot of the scenario report", () => {
      const report: ScenarioTimingReport = {
        searxQuery: { p50: 100, p95: 110, p99: 120 },
        fetchUrl: { p50: 200, p95: 210, p99: 220 },
        extractWithUnstructured: { p50: 300, p95: 310, p99: 320 },
        ingestToGraph: { p50: 400, p95: 410, p99: 420 },
        ingestToVector: { p50: 500, p95: 510, p99: 520 },
        tookMs: 1337,
        documentsIngested: 4,
        errors: { network_error: 2 },
      };

      const exportPayload = buildScenarioDashboardExport(
        1,
        "S01_pdf_science",
        "PDF scientifique",
        report,
        new Date("2025-01-02T10:00:00Z"),
      );

      expect(exportPayload.generatedAt).to.equal("2025-01-02T10:00:00.000Z");
      expect(exportPayload.stages.fetchUrl.p95).to.equal(210);
      expect(exportPayload.errors).to.not.equal(report.errors);
      expect(exportPayload.errors).to.deep.equal({ network_error: 2 });
    });
  });

  describe("writeScenarioDashboardExport", () => {
    it("persists the JSON export in the metrics directory", async () => {
      const sandbox = await createSandbox("validation-dashboard-");
      const root = path.join(sandbox, "validation_run");
      const layout = await ensureValidationRunLayout(root);
      const report: ScenarioTimingReport = {
        searxQuery: { p50: 90, p95: 95, p99: 99 },
        fetchUrl: { p50: 180, p95: 190, p99: 195 },
        extractWithUnstructured: { p50: 270, p95: 280, p99: 290 },
        ingestToGraph: { p50: 360, p95: 370, p99: 380 },
        ingestToVector: { p50: 450, p95: 460, p99: 470 },
        tookMs: 987,
        documentsIngested: 5,
        errors: { robots_denied: 1 },
      };

      const result = await writeScenarioDashboardExport(1, report, {
        layout,
        now: new Date("2025-01-03T08:30:00Z"),
      });

      const expectedPath = path.join(layout.metricsDir, "S01_pdf_science_dashboard.json");
      expect(result.path).to.equal(expectedPath);

      const raw = await readFile(expectedPath, "utf8");
      const serialised = JSON.parse(raw);
      expect(serialised.slug).to.equal("S01_pdf_science");
      expect(serialised.generatedAt).to.equal("2025-01-03T08:30:00.000Z");
      expect(serialised.stages.searxQuery.p50).to.equal(90);

      await rm(sandbox, { recursive: true, force: true });
    });
  });

  describe("extractScenarioMetricsFromEvents", () => {
    it("handles nested payloads and custom stage aliases", () => {
      const events = [
        {
          metrics: { stage: "searx_query", durationMs: 120 },
        },
        {
          stage: "fetch-url",
          durationMs: "210",
        },
        {
          stage: "custom_extract",
          duration_ms: 320,
          tookMs: 900,
        },
        {
          payload: { documentId: "doc-1", documentsIngested: 1 },
          status: "success",
        },
        {
          docId: "doc-2",
          success: false,
        },
        {
          category: "network_error",
        },
        {
          error: { category: "robots_denied" },
        },
      ];

      const { samples, notes } = extractScenarioMetricsFromEvents(events, {
        stageMap: { custom_extract: "extractWithUnstructured" },
      });

      expect(notes).to.deep.equal([]);
      expect(samples.stageDurations.searxQuery).to.deep.equal([120]);
      expect(samples.stageDurations.fetchUrl).to.deep.equal([210]);
      expect(samples.stageDurations.extractWithUnstructured).to.deep.equal([320]);
      expect(samples.totalDurations).to.deep.equal([900]);
      expect(samples.documentIds).to.deep.equal(["doc-1"]);
      expect(samples.documentCountIncrements).to.deep.equal([1]);
      expect(samples.errorCategories).to.deep.equal(["network_error", "robots_denied"]);
    });
  });

  describe("computeScenarioTimingReportFromFile", () => {
    it("parses NDJSON files and surfaces parse errors as notes", async () => {
      const sandbox = await createSandbox("validation-metrics-");
      const eventsPath = path.join(sandbox, "events.ndjson");
      await writeFile(
        eventsPath,
        [
          "{\"stage\":\"searxQuery\",\"durationMs\":100}",
          "{\"stage\":\"fetchUrl\",\"durationMs\":200}",
          "invalid json",
          "",
        ].join("\n"),
        "utf8",
      );

      const { report, notes } = await computeScenarioTimingReportFromFile(eventsPath);

      expect(report.searxQuery.p50).to.equal(100);
      expect(report.fetchUrl.p95).to.equal(200);
      expect(notes.some((note) => note.includes("Ligne 3: JSON invalide"))).to.equal(true);

      await rm(sandbox, { recursive: true, force: true });
    });
  });

  describe("computeScenarioTimingReportFromEvents", () => {
    it("chains extraction and aggregation", () => {
      const events = [
        { stage: "searxQuery", durationMs: 100, tookMs: 500 },
        { stage: "fetchUrl", durationMs: 200 },
        { stage: "ingestToGraph", durationMs: 150 },
        { stage: "ingestToVector", durationMs: 160 },
        { documentId: "doc-1", success: true },
        { category: "network_error" },
      ];

      const { report, notes } = computeScenarioTimingReportFromEvents(events);

      expect(report.tookMs).to.equal(500);
      expect(report.documentsIngested).to.equal(1);
      expect(report.errors).to.deep.equal({ network_error: 1 });
      expect(notes).to.have.length(1);
      expect(notes[0]).to.include("extractWithUnstructured");
    });
  });
});
