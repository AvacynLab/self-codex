import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "chai";

import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";
import {
  recordScenarioRun,
  type ScenarioErrorEntry,
  type ScenarioTimingReport,
} from "../../src/validationRun/artefacts.js";
import {
  generateValidationSummary,
  renderMarkdownReport,
  writeValidationReport,
} from "../../src/validationRun/reports.js";

describe("validationRun/reports", () => {
  const tmpRoot = path.join(process.cwd(), "tmp", "reports-test");

  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("aggregates scenario artefacts into a summary", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);

    const timingsScenario1: ScenarioTimingReport = {
      searxQuery: { p50: 110, p95: 220, p99: 280 },
      fetchUrl: { p50: 500, p95: 800, p99: 1200 },
      extractWithUnstructured: { p50: 900, p95: 1500, p99: 2100 },
      ingestToGraph: { p50: 120, p95: 200, p99: 260 },
      ingestToVector: { p50: 140, p95: 210, p99: 300 },
      tookMs: 4200,
      documentsIngested: 6,
      errors: { network_error: 1 },
    };
    const errorsScenario7: ScenarioErrorEntry[] = [
      { category: "network_error", message: "timeout" },
      { category: "robots_denied", message: "blocked" },
    ];
    const timingsScenario9: ScenarioTimingReport = {
      searxQuery: { p50: 1200, p95: 2500, p99: 2800 },
      fetchUrl: { p50: 1500, p95: 3200, p99: 4000 },
      extractWithUnstructured: { p50: 3500, p95: 7200, p99: 9000 },
      ingestToGraph: { p50: 400, p95: 800, p99: 1200 },
      ingestToVector: { p50: 420, p95: 900, p99: 1400 },
      tookMs: 55000,
      documentsIngested: 12,
      errors: { network_error: 2 },
    };

    await recordScenarioRun(
      1,
      {
        timings: timingsScenario1,
        vectorUpserts: [
          { id: "doc-a" },
          { id: "doc-b" },
          { id: "doc-c" },
        ],
        kgChanges: [
          { subject: "a" },
          { subject: "b" },
        ],
        events: [
          { type: "start" },
          { type: "finish" },
        ],
      },
      { layout },
    );

    const scenario1Artifacts = path.join(layout.artifactsDir, "S01_pdf_science");
    await mkdir(scenario1Artifacts, { recursive: true });
    const documentsScenario1 = [
      {
        id: "d1",
        url: "https://example.com/a.pdf",
        title: "Doc 1",
        language: "en",
        description: null,
        mimeType: "application/pdf",
        checksum: "chk-1",
        size: 1_024,
        fetchedAt: 1,
        segmentCount: 3,
        provenance: [{}],
      },
      {
        id: "d2",
        url: "https://example.com/b",
        title: "Doc 2",
        language: "en",
        description: null,
        mimeType: "text/html",
        checksum: "chk-2",
        size: 2_048,
        fetchedAt: 2,
        segmentCount: 4,
        provenance: [{}],
      },
      {
        id: "d3",
        url: "notaurl",
        title: "Doc 3",
        language: "fr",
        description: null,
        mimeType: null,
        checksum: "chk-3",
        size: 512,
        fetchedAt: 3,
        segmentCount: 2,
        provenance: [{}],
      },
    ];
    await writeFile(
      path.join(scenario1Artifacts, "documents_summary.json"),
      `${JSON.stringify(documentsScenario1, null, 2)}\n`,
      "utf8",
    );

    await recordScenarioRun(7, { errors: errorsScenario7 }, { layout });

    await recordScenarioRun(
      9,
      {
        timings: timingsScenario9,
        errors: [
          { category: "network_error", message: "retry" },
        ],
      },
      { layout },
    );

    const scenario9Artifacts = path.join(layout.artifactsDir, "S09_charge_moderee");
    await mkdir(scenario9Artifacts, { recursive: true });
    const documentsScenario9 = [
      {
        id: "d4",
        url: "https://research.example.com/report.pdf",
        title: "Doc 4",
        language: "en",
        description: null,
        mimeType: "application/pdf",
        checksum: "chk-4",
        size: 8_192,
        fetchedAt: 4,
        segmentCount: 5,
        provenance: [{}],
      },
      {
        id: "d5",
        url: "https://another.org/page.html",
        title: "Doc 5",
        language: "en",
        description: null,
        mimeType: "text/html",
        checksum: "chk-5",
        size: 4_096,
        fetchedAt: 5,
        segmentCount: 6,
        provenance: [{}],
      },
    ];
    await writeFile(
      path.join(scenario9Artifacts, "documents_summary.json"),
      `${JSON.stringify(documentsScenario9, null, 2)}\n`,
      "utf8",
    );

    const summary = await generateValidationSummary({ layout, now: new Date("2025-11-24T10:00:00Z") });

    const scenario1 = summary.scenarios.find((entry) => entry.id === 1);
    expect(scenario1).to.not.be.undefined;
    expect(scenario1?.documentsIngested).to.equal(6);
    expect(scenario1?.vectorUpsertsCount).to.equal(3);
    expect(scenario1?.kgChangesCount).to.equal(2);
    expect(scenario1?.eventsCount).to.equal(2);
    expect(scenario1?.notes).to.include("server.log vide");

    const scenario7 = summary.scenarios.find((entry) => entry.id === 7);
    expect(scenario7?.errorCounts).to.deep.equal({ network_error: 1, robots_denied: 1 });
    expect(scenario7?.notes?.some((note) => note.startsWith("timings.json:"))).to.equal(true);

    const performanceCheck = summary.acceptance.performance;
    expect(performanceCheck.status).to.equal("pass");
    expect(performanceCheck.scenarios).to.deep.equal(["S09_charge_moderee"]);

    const robustnessCheck = summary.acceptance.robustness;
    expect(robustnessCheck.status).to.equal("pass");
    expect(robustnessCheck.scenarios).to.include("S07_sources_instables");

    expect(summary.totals.documentsIngested).to.equal(18);
    expect(summary.totals.vectorUpserts).to.equal(3);
    expect(summary.totals.errors).to.have.property("network_error", 5);
    expect(summary.totals.topDomains).to.deep.equal([
      { domain: "example.com", count: 2, percentage: 40 },
      { domain: "another.org", count: 1, percentage: 20 },
      { domain: "research.example.com", count: 1, percentage: 20 },
      { domain: "unknown", count: 1, percentage: 20 },
    ]);
    expect(summary.totals.contentTypes).to.deep.equal([
      { mimeType: "application/pdf", count: 2, percentage: 40 },
      { mimeType: "text/html", count: 2, percentage: 40 },
      { mimeType: "unknown", count: 1, percentage: 20 },
    ]);
    expect(summary.generatedAt).to.equal("2025-11-24T10:00:00.000Z");

    const markdown = renderMarkdownReport(summary);
    expect(markdown).to.include(
      "- Top domaines : example.com (40.0%, 2) ; another.org (20.0%, 1)",
    );
    expect(markdown).to.include(
      "- Types de contenu : application/pdf (40.0%, 2) ; text/html (40.0%, 2)",
    );
  });

  it("évalue les critères d'extraction et de langue à partir des artefacts", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);

    await recordScenarioRun(
      1,
      {
        timings: {
          searxQuery: { p50: 100, p95: 200, p99: 250 },
          fetchUrl: { p50: 150, p95: 260, p99: 320 },
          extractWithUnstructured: { p50: 180, p95: 300, p99: 360 },
          ingestToGraph: { p50: 90, p95: 140, p99: 200 },
          ingestToVector: { p50: 95, p95: 150, p99: 210 },
          tookMs: 1200,
          documentsIngested: 5,
          errors: {},
        },
      },
      { layout },
    );

    const artifactDir = path.join(layout.artifactsDir, "S01_pdf_science");
    await mkdir(artifactDir, { recursive: true });

    const vectorChunks = [
      { chunkId: "c1", segmentIds: ["s1", "s2", "s3"] },
      { chunkId: "c2", segmentIds: ["s4", "s5", "s6"] },
      { chunkId: "c3", segmentIds: ["s7", "s8", "s9"] },
      { chunkId: "c4", segmentIds: ["s9"] },
    ];
    await writeFile(
      path.join(artifactDir, "vector_chunks.json"),
      `${JSON.stringify(vectorChunks, null, 2)}\n`,
      "utf8",
    );

    const documentsSummary = [
      { id: "d1", language: "en" },
      { id: "d2", language: "en" },
      { id: "d3", language: "en-US" },
      { id: "d4", language: "fr" },
      { id: "d5", language: "en" },
      { id: "d6", language: "fr" },
      { id: "d7", language: "en" },
      { id: "d8", language: "en" },
      { id: "d9", language: "en" },
      { id: "d10", language: "" },
    ];
    await writeFile(
      path.join(artifactDir, "documents_summary.json"),
      `${JSON.stringify(documentsSummary, null, 2)}\n`,
      "utf8",
    );

    const summary = await generateValidationSummary({ layout, now: new Date("2025-11-24T13:00:00Z") });

    const extractionCheck = summary.acceptance.extraction;
    expect(extractionCheck.status).to.equal("pass");
    expect(extractionCheck.details).to.include("Segments uniques: 90.0% (9/10)");
    expect(extractionCheck.scenarios).to.deep.equal(["S01_pdf_science"]);

    const languageCheck = summary.acceptance.language;
    expect(languageCheck.status).to.equal("pass");
    expect(languageCheck.details).to.include("Détections valides: 90.0% (9/10)");
    expect(languageCheck.details).to.include("Top langues: en: 6, fr: 2, en-us: 1");
    expect(languageCheck.details).to.include("1 documents sans code langue normalisé");
  });

  it("renders a markdown report with scenario tables and criteria", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    await recordScenarioRun(
      1,
      {
        timings: {
          searxQuery: { p50: 10, p95: 20, p99: 30 },
          fetchUrl: { p50: 40, p95: 80, p99: 100 },
          extractWithUnstructured: { p50: 50, p95: 90, p99: 150 },
          ingestToGraph: { p50: 30, p95: 60, p99: 90 },
          ingestToVector: { p50: 35, p95: 65, p99: 95 },
          tookMs: 900,
          documentsIngested: 2,
          errors: { network_error: 0 },
        },
      },
      { layout },
    );

    const summary = await generateValidationSummary({ layout, now: new Date("2025-11-24T11:00:00Z") });
    const markdown = renderMarkdownReport(summary);

    expect(markdown).to.include("| S01_pdf_science | 900 | 2 | 0 |");
    expect(markdown).to.include("## Critères d'acceptation");
    expect(markdown).to.include("Fonctionnel : ✅ OK");
    expect(markdown).to.include("- S01_pdf_science : 2 documents ingérés sans erreur classée.");
    expect(markdown).to.include("### Faiblesses");
    expect(markdown).to.include("Langue non conclu");
    expect(markdown).to.include("### Recommandations");
    expect(markdown).to.include("Documenter les éléments nécessaires pour conclure le critère Langue.");
    expect(markdown).to.include("- Validation bloquée : corriger les critères RAG avant diffusion.");
    expect(markdown).to.include("- ⚠️ S01_pdf_science : events.ndjson vide");
    expect(markdown).to.include("### S01_pdf_science – PDF scientifique");
  });

  it("met en avant les scénarios incomplets dans la synthèse thématique", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);

    await recordScenarioRun(2, { errors: [{ category: "network_error", message: "timeout" }] }, { layout });

    const summary = await generateValidationSummary({ layout, now: new Date("2025-11-24T12:30:00Z") });
    const markdown = renderMarkdownReport(summary);

    expect(markdown).to.include("- S02_html_long_images : timings.json: bucket searxQuery incomplet.");
    expect(markdown).to.include(
      "- Résoudre timings.json: bucket searxQuery incomplet pour S02_html_long_images puis régénérer le rapport.",
    );
  });

  it("persists summary.json et REPORT.md", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    await recordScenarioRun(
      1,
      {
        timings: {
          searxQuery: { p50: 5, p95: 10, p99: 15 },
          fetchUrl: { p50: 6, p95: 12, p99: 18 },
          extractWithUnstructured: { p50: 7, p95: 14, p99: 21 },
          ingestToGraph: { p50: 3, p95: 6, p99: 9 },
          ingestToVector: { p50: 4, p95: 8, p99: 12 },
          tookMs: 400,
          documentsIngested: 1,
          errors: {},
        },
      },
      { layout },
    );

    const result = await writeValidationReport({ layout, now: new Date("2025-11-24T12:00:00Z") });
    const summaryContent = await readFile(result.summaryPath, "utf8");
    const reportContent = await readFile(result.reportPath, "utf8");

    expect(summaryContent).to.include("\n  \"generatedAt\": \"2025-11-24T12:00:00.000Z\"");
    expect(reportContent).to.include("# Validation Report");
    expect(reportContent).to.include("S01_pdf_science");
  });
});
