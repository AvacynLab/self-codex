import { after, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runSmokeValidation } from "../../scripts/validation/run-smoke.mjs";

/**
 * Integration coverage ensuring the smoke validation harness exercises the full
 * MCP toolchain and records the expected artefacts.  The test runs the script
 * against a temporary workspace to keep the repository clean while verifying
 * the generated summary and per-operation snapshots.
 */
describe("validation smoke script", function () {
  this.timeout(30_000);

  const temporaryRoots = new Set<string>();

  after(async () => {
    // Clean up any temporary validation directories created during the run so
    // repeated test executions remain idempotent.
    for (const root of temporaryRoots) {
      await rm(root, { recursive: true, force: true });
    }
    temporaryRoots.clear();
  });

  it("produces validation artefacts for the end-to-end scenario", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "mcp-smoke-"));
    temporaryRoots.add(runRoot);

    const runId = `validation_${randomUUID()}`;
    const result = await runSmokeValidation({
      runId,
      runRoot,
      timestamp: "2025-01-01T00:00:00.000Z",
    });

    expect(result.runId).to.equal(runId);
    expect(result.summaryPath).to.be.a("string");

    const summaryContents = await readFile(result.summaryPath, "utf8");
    expect(summaryContents).to.contain("| Operation | Duration (ms) | Status | Trace ID |");
    expect(summaryContents).to.include("mcp_info");
    expect(summaryContents).to.include("child_spawn_codex");
    expect(summaryContents).to.match(/p99:/);
    expect(summaryContents).to.match(/error rate:/);

    // The smoke harness should capture at least inputs, outputs and logs while
    // creating the remaining directories for optional artefacts.
    const directoryExpectations: Array<{ name: string; minEntries: number }> = [
      { name: "inputs", minEntries: 1 },
      { name: "outputs", minEntries: 1 },
      { name: "logs", minEntries: 1 },
      { name: "events", minEntries: 0 },
      { name: "artifacts", minEntries: 0 },
      { name: "report", minEntries: 0 },
    ];
    for (const { name, minEntries } of directoryExpectations) {
      const entries = await readdir(join(result.runRoot, name));
      expect(entries.length, `expected at least ${minEntries} artefacts under ${name}`).to.be.at.least(minEntries);
    }

    // Ensure every recorded operation succeeded so the artefacts reflect a
    // healthy orchestration pipeline.
    for (const operation of result.operations) {
      expect(["ok", "skipped"], `unexpected status for ${operation.label}`).to.include(operation.status);
    }

    const outputEntries = await readdir(join(result.runRoot, "outputs"));
    const hasGraphPatchOutput = outputEntries.some((name) => name.includes("graph_patch"));
    expect(hasGraphPatchOutput, "expected graph_patch output artefact").to.equal(true);
  });
});
