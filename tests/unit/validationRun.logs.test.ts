import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureValidationRunLayout } from "../../src/validationRun/layout.js";
import { extractServerLogExcerpt } from "../../src/validationRun/logs.js";

/**
 * Unit tests covering the extraction of log excerpts for validation scenarios.
 * The helper scans `validation_run/logs/self-codex.log` and returns a short
 * window around the scenario job identifier so the resulting artefacts satisfy
 * the checklist requirement of archiving 5–10 lines of server logs.
 */
describe("validationRun/logs", () => {
  const tempFolders: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempFolders.splice(0).map(async (folder) => {
        await rm(folder, { recursive: true, force: true });
      }),
    );
  });

  it("returns null when the server log is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-logs-missing-"));
    tempFolders.push(root);

    const layout = await ensureValidationRunLayout(root);
    const excerpt = await extractServerLogExcerpt({
      jobId: "S01_pdf_science_job",
      scenarioSlug: "S01_pdf_science",
      layout,
    });

    expect(excerpt).to.equal(null);
  });

  it("captures lines around the job identifier", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-logs-excerpt-"));
    tempFolders.push(root);
    const layout = await ensureValidationRunLayout(root);
    const logPath = path.join(layout.logsDir, "self-codex.log");

    const jobId = "S03_actualites_fraicheur_20240101_abcd";
    const lines = [
      JSON.stringify({ timestamp: "2024-01-01T00:00:00.000Z", level: "info", message: "boot_completed" }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01.000Z",
        level: "info",
        message: "search_job_started",
        payload: { job_id: jobId, query: "actualité" },
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02.000Z",
        level: "info",
        message: "search_doc_ingested",
        payload: { job_id: jobId, doc_id: "doc-1" },
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:03.000Z",
        level: "info",
        message: "search_job_completed",
        payload: { job_id: jobId, documents: 1 },
      }),
      JSON.stringify({ timestamp: "2024-01-01T00:00:04.000Z", level: "info", message: "idle" }),
    ];
    await writeFile(logPath, `${lines.join("\n")}\n`, "utf8");

    const excerpt = await extractServerLogExcerpt({
      jobId,
      scenarioSlug: "S03_actualites_fraicheur",
      layout,
      maxEntries: 5,
      contextRadius: 1,
    });

    expect(excerpt).to.not.equal(null);
    expect(excerpt?.lines).to.have.length.greaterThan(0);
    expect(excerpt?.lines.join("\n")).to.include(jobId);
    expect(excerpt?.lines[0]).to.include("boot_completed");
    expect(excerpt?.lines.at(-1)).to.include("idle");
  });

  it("falls back to the tail of the log when no match is found", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "validation-logs-tail-"));
    tempFolders.push(root);
    const layout = await ensureValidationRunLayout(root);
    const logPath = path.join(layout.logsDir, "self-codex.log");

    const lines = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({ timestamp: `2024-01-01T00:00:${String(index).padStart(2, "0")}.000Z`, level: "info", message: `line_${index}` }),
    );
    await writeFile(logPath, `${lines.join("\n")}\n`, "utf8");

    const excerpt = await extractServerLogExcerpt({
      jobId: "nonexistent",
      scenarioSlug: "S99_unknown",
      layout,
      maxEntries: 5,
    });

    expect(excerpt).to.not.equal(null);
    expect(excerpt?.lines).to.deep.equal(lines.slice(-5));
  });
});
