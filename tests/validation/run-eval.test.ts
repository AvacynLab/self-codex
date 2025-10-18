import { after, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  EvaluationRunResult,
  EvaluationCliParseResult,
  EvaluationOperation,
} from "../../scripts/validation/run-eval.mjs";
import {
  parseCliArgs,
  run as runEvaluationValidation,
} from "../../scripts/validation/run-eval.mjs";

/**
 * Integration coverage for the evaluation harness. The script intentionally
 * stresses error paths and large payload handling; the test ensures artefacts
 * are captured correctly and the resulting summary highlights the expected
 * status distribution.
 */
describe("validation evaluation script", function () {
  this.timeout(30_000);

  /** Tracks temporary directories created during the suite to guarantee cleanup. */
  const temporaryRoots = new Set<string>();
  const execFileAsync = promisify(execFile) as (
    file: string,
    args: readonly string[],
    options?: ExecFileOptions & { encoding?: BufferEncoding },
  ) => Promise<{ stdout: string; stderr: string }>;
  const repoRoot = process.cwd();

  after(async () => {
    const roots = Array.from(temporaryRoots);
    await Promise.all(
      roots.map(async (root) => {
        await rm(root, { recursive: true, force: true });
      }),
    );
    temporaryRoots.clear();
  });

  it("captures fuzzing artefacts and renders an aggregated summary", async () => {
    const runRoot = await mkdtemp(join(tmpdir(), "mcp-eval-"));
    temporaryRoots.add(runRoot);

    const runId = `validation_${randomUUID()}`;
    const result: EvaluationRunResult = await runEvaluationValidation({
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

    const expectedErrorCount = result.operations.filter((op: EvaluationOperation) => op.status === "expected_error").length;
    expect(expectedErrorCount).to.be.at.least(1);

    const directories: readonly string[] = ["inputs", "outputs", "logs"];
    for (const directory of directories) {
      const entries = await readdir(join(result.runRoot, directory));
      expect(entries.length, `expected artefacts under ${directory}`).to.be.greaterThan(0);
    }
  });

  it("parses CLI arguments and coerces feature overrides", () => {
    const parsed: EvaluationCliParseResult = parseCliArgs([
      "--run-id",
      "custom",
      "--run-root",
      "./tmp/eval",
      "--workspace-root",
      "./",
      "--timestamp",
      "2025-01-02T00:00:00.000Z",
      "--graph-id",
      "graph-123",
      "--trace-seed",
      "seed-42",
      "--feature",
      "enablePlanner=false",
      "--feature",
      "latencyBudget=12.5",
    ]);

    expect(parsed.errors).to.deep.equal([]);
    expect(parsed.helpRequested).to.equal(false);
    expect(parsed.options.runId).to.equal("custom");
    expect(parsed.options.runRoot).to.equal(resolve("./tmp/eval"));
    expect(parsed.options.workspaceRoot).to.equal(resolve("./"));
    expect(parsed.options.timestamp).to.equal("2025-01-02T00:00:00.000Z");
    expect(parsed.options.graphId).to.equal("graph-123");
    expect(parsed.options.traceSeed).to.equal("seed-42");
    expect(parsed.options.featureOverrides).to.deep.equal({ enablePlanner: false, latencyBudget: 12.5 });
  });

  it("rejects invalid CLI input", () => {
    const parsed: EvaluationCliParseResult = parseCliArgs(["--feature", "missingValue", "--unknown"]);
    expect(parsed.helpRequested).to.equal(false);
    expect(parsed.errors).to.have.length.greaterThan(0);
    expect(parsed.errors[0]).to.match(/Invalid feature override/);
    expect(parsed.errors.some((message: string) => /Unknown option/.test(message))).to.equal(true);
  });

  it("executes the harness via the CLI entrypoint", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "mcp-eval-cli-"));
    temporaryRoots.add(tmpRoot);

    const runId = `validation_${randomUUID()}`;
    const runRoot = join(tmpRoot, runId);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "scripts/validation/run-eval.mjs",
        "--run-id",
        runId,
        "--run-root",
        runRoot,
        "--timestamp",
        "2025-01-03T00:00:00.000Z",
        "--trace-seed",
        "cli-seed",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(stderr, "stderr should remain empty").to.equal("");
    expect(stdout).to.include(`Evaluation validation completed: ${runId}`);

    const summaryPath = join(runRoot, "summary.md");
    const summaryContents = await readFile(summaryPath, "utf8");
    expect(summaryContents).to.include("# Evaluation Validation Run");
  });
});
