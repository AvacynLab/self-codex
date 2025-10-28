import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect } from "chai";

import { auditValidationRun } from "../../src/validationRun/audit.js";
import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";
import {
  SCENARIO_ARTEFACT_FILENAMES,
  VALIDATION_SCENARIOS,
  initialiseAllScenarios,
  formatScenarioSlug,
} from "../../src/validationRun/scenario.js";

const tmpRoot = path.join(process.cwd(), "tmp", "audit-test");

/**
 * Helper producing a fully populated timing payload so tests start from a clean
 * baseline. Using a function keeps the object immutable across assertions.
 */
function buildValidTimings() {
  return {
    searxQuery: { p50: 10, p95: 80, p99: 120 },
    fetchUrl: { p50: 40, p95: 150, p99: 400 },
    extractWithUnstructured: { p50: 90, p95: 250, p99: 420 },
    ingestToGraph: { p50: 20, p95: 45, p99: 70 },
    ingestToVector: { p50: 30, p95: 60, p99: 110 },
    tookMs: 950,
    documentsIngested: 6,
    errors: { network_error: 0 },
  };
}

async function seedValidTimings(layout: Awaited<ReturnType<typeof ensureValidationRunLayout>>): Promise<void> {
  const serialised = `${JSON.stringify(buildValidTimings(), null, 2)}\n`;
  for (const scenario of VALIDATION_SCENARIOS) {
    const slug = formatScenarioSlug(scenario);
    const timingPath = path.join(
      layout.runsDir,
      slug,
      SCENARIO_ARTEFACT_FILENAMES.timings,
    );
    await writeFile(timingPath, serialised, { encoding: "utf8" });
  }
}

describe("validationRun/audit", () => {
  beforeEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    const layout = await ensureValidationRunLayout(tmpRoot);
    await initialiseAllScenarios({ layout });
    await seedValidTimings(layout);
  });

  it("reports missing artefacts per scénario", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const scenarioSlug = "S01_pdf_science";
    const responsePath = path.join(
      layout.runsDir,
      scenarioSlug,
      SCENARIO_ARTEFACT_FILENAMES.response,
    );
    await rm(responsePath);

    const report = await auditValidationRun({ layout });
    const scenarioReport = report.scenarios.find((entry) => entry.slug === scenarioSlug);
    expect(scenarioReport).to.not.equal(undefined);
    expect(scenarioReport?.missingArtefacts).to.deep.equal([
      SCENARIO_ARTEFACT_FILENAMES.response,
    ]);
    expect(scenarioReport?.timingIssues).to.deep.equal([]);
    expect(report.hasBlockingIssues).to.equal(true);
  });

  it("signale les champs manquants dans timings.json", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const scenarioSlug = "S02_html_long_images";
    const timingPath = path.join(
      layout.runsDir,
      scenarioSlug,
      SCENARIO_ARTEFACT_FILENAMES.timings,
    );
    await writeFile(
      timingPath,
      `${JSON.stringify({ searxQuery: { p50: 10 } }, null, 2)}\n`,
      { encoding: "utf8" },
    );

    const report = await auditValidationRun({ layout });
    const scenarioReport = report.scenarios.find((entry) => entry.slug === scenarioSlug);
    expect(scenarioReport).to.not.equal(undefined);
    expect(scenarioReport?.missingArtefacts).to.deep.equal([]);
    expect(
      scenarioReport?.timingIssues.some((issue) =>
        issue.includes("bucket searxQuery") && issue.includes("p95"),
      ),
    ).to.equal(true);
    expect(report.hasBlockingIssues).to.equal(true);
  });

  it("détecte les secrets potentiels dans les journaux", async () => {
    const layout = await ensureValidationRunLayout(tmpRoot);
    const scenarioSlug = "S03_actualites_fraicheur";
    const logPath = path.join(
      layout.runsDir,
      scenarioSlug,
      SCENARIO_ARTEFACT_FILENAMES.serverLog,
    );
    await writeFile(logPath, "MCP_HTTP_TOKEN=super-secret\n", { encoding: "utf8" });

    const report = await auditValidationRun({ layout });
    expect(report.secretFindings).to.deep.include({
      file: logPath,
      line: 1,
      description: "Variable MCP_*TOKEN exposée",
      snippet: "MCP_HTTP_TOKEN=super-secret",
    });
    expect(report.hasBlockingIssues).to.equal(true);
  });
});
