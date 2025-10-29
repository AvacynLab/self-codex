import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { seedSampleValidationData } from "../../src/validationRun/sampleData.js";

/**
 * High-level tests ensuring the synthetic validation dataset faithfully
 * materialises the artefacts required by the checklist while preserving the
 * idempotence guarantees between S01 et S05.
 */
describe("validationRun/sampleData", () => {
  const tempFolders: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
    );
  });

  it("seeds deterministic artefacts and preserves idempotence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-sample-"));
    tempFolders.push(root);

    await seedSampleValidationData({ baseRoot: root });

    const s01ResponsePath = path.join(root, "runs", "S01_pdf_science", "response.json");
    const s05ResponsePath = path.join(root, "runs", "S05_idempotence", "response.json");
    const s01Response = JSON.parse(await readFile(s01ResponsePath, "utf8"));
    const s05Response = JSON.parse(await readFile(s05ResponsePath, "utf8"));

    const s01DocIds = s01Response.documents.map((entry: { id: string }) => entry.id);
    const s05DocIds = s05Response.documents.map((entry: { id: string }) => entry.id);
    expect(s05DocIds).to.deep.equal(
      s01DocIds,
      "S05 doit réutiliser exactement les docIds de S01 pour l'idempotence",
    );

    const eventsPath = path.join(root, "runs", "S01_pdf_science", "events.ndjson");
    const eventLines = (await readFile(eventsPath, "utf8")).trim().split(/\r?\n/);
    const ingestionEvents = eventLines
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .filter((event) => event.kind === "search:doc_ingested");
    expect(ingestionEvents).to.have.length.greaterThan(0);

    const artefactPath = path.join(
      root,
      "artifacts",
      "S09_charge_moderee",
      "documents_summary.json",
    );
    const artefactContent = JSON.parse(await readFile(artefactPath, "utf8"));
    expect(Array.isArray(artefactContent)).to.equal(true);
    expect(artefactContent.length).to.be.greaterThan(0);

    const dashboardPath = path.join(root, "metrics", "S01_pdf_science_dashboard.json");
    const dashboard = JSON.parse(await readFile(dashboardPath, "utf8"));
    expect(dashboard.scenarioId).to.equal(1);
    expect(dashboard.stages.fetchUrl.p95).to.be.greaterThan(0);

    const s10ResponsePath = path.join(root, "runs", "S10_qualite_rag", "response.json");
    const s10Response = JSON.parse(await readFile(s10ResponsePath, "utf8"));
    expect(Array.isArray(s10Response.citations)).to.equal(true);
    expect(s10Response.citations).to.have.length(3);

    const firstEvents = await readFile(eventsPath, "utf8");
    await seedSampleValidationData({ baseRoot: root });
    const rerunEvents = await readFile(eventsPath, "utf8");
    expect(rerunEvents).to.equal(firstEvents, "La génération doit être idempotente");
  });
});
