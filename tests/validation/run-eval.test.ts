import { after, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runEvaluationValidation } from "../../scripts/validation/run-eval.mjs";

/**
 * Integration coverage for the evaluation harness. The script intentionally
 * stresses error paths and large payload handling; the test ensures artefacts
 * are captured correctly and the resulting summary highlights the expected
 * status distribution.
 */
describe("validation evaluation script", function () {
  this.timeout(30_000);

  const temporaryRoots = new Set<string>();

  after(async () => {
    for (const root of temporaryRoots) {
      await rm(root, { recursive: true, force: true });
    }
    temporaryRoots.clear();
  });

  it("captures fuzzing artefacts and renders an aggregated summary", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "mcp-eval-"));
    temporaryRoots.add(runRoot);

    const runId = `validation_${randomUUID()}`;
    const result = await runEvaluationValidation({
      runId,
      runRoot,
      timestamp: "2025-01-02T00:00:00.000Z",
    });

    expect(result.runId).to.equal(runId);
    expect(result.operations.length).to.be.greaterThan(0);

    const summaryContents = await readFile(result.summaryPath, "utf8");
    expect(summaryContents).to.include("# Evaluation Validation Run");
    expect(summaryContents).to.include("## Status Counts");
    expect(summaryContents).to.match(/error rate:/);
    expect(summaryContents).to.match(/p99:/);

    const expectedErrorCount = result.operations.filter((op) => op.status === "expected_error").length;
    expect(expectedErrorCount).to.be.at.least(1);

    const directories = ["inputs", "outputs", "logs"];
    for (const directory of directories) {
      const entries = await readdir(join(result.runRoot, directory));
      expect(entries.length, `expected artefacts under ${directory}`).to.be.greaterThan(0);
    }
  });
});
