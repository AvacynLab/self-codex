import { after, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
    const smokeModulePath = join(process.cwd(), "scripts", "validation", "run-smoke.mjs");
    const inlineRunner = `
      import { writeFile } from 'node:fs/promises';
      const module = await import(process.env.__SMOKE_RUN_MODULE__);
      const options = JSON.parse(process.env.__SMOKE_RUN_OPTIONS__ ?? "{}");
      try {
        const result = await module.run(options);
        await writeFile(process.env.__SMOKE_RESULT_PATH__, JSON.stringify(result), 'utf8');
      } catch (error) {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exit(1);
      }
    `;

    const resultPath = join(runRoot, "result.json");

    // Run the harness under the tsx loader so source TypeScript modules
    // (notably `src/server.ts`) resolve correctly when the validation runtime
    // attempts to import them.  Without the additional `--import tsx` flag the
    // smoke script would fallback to the compiled `dist/` artefacts, which are
    // not present in this test environment.
    await execFileAsync("node", ["--import", "tsx", "--input-type=module", "-e", inlineRunner.trim()], {
      env: {
        ...process.env,
        __SMOKE_RUN_MODULE__: pathToFileURL(smokeModulePath).href,
        __SMOKE_RUN_OPTIONS__: JSON.stringify({
          runId,
          runRoot,
          timestamp: "2025-01-01T00:00:00.000Z",
        }),
        __SMOKE_RESULT_PATH__: resultPath,
        MCP_HTTP_PORT: "0",
        MCP_LOG_FILE: join(runRoot, "smoke.log"),
      },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });

    const rawResult = await readFile(resultPath, "utf8");
    const result = JSON.parse(rawResult);

    expect(result.runId).to.equal(runId);
    expect(result.summaryPath).to.be.a("string");
    expect(result.stages, "expected at least one validation stage").to.be.an("array").that.is.not.empty;

    const preflightStage = result.stages.find((stage) => stage.phaseId === "phase-00-preflight");
    expect(preflightStage, "expected preflight stage summary").to.exist;
    expect(preflightStage?.summary?.checks?.healthz?.ok).to.equal(true);
    expect(preflightStage?.summary?.checks?.metrics?.ok).to.equal(true);
    expect(preflightStage?.summary?.checks?.authorised?.status).to.equal(200);
    expect(preflightStage?.summary?.checks?.unauthorised?.status).to.equal(401);

    const summaryContents = await readFile(result.summaryPath, "utf8");
    expect(summaryContents).to.contain("| Operation | Duration (ms) | Status | Trace ID |");
    expect(summaryContents).to.include("HTTP Preflight");
    expect(summaryContents).to.include("/healthz status: 200");
    expect(summaryContents).to.include("/metrics status: 200");
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

    // Optional telemetry must avoid `undefined` to stay compatible with
    // `exactOptionalPropertyTypes` once it becomes mandatory.  The smoke script
    // should therefore emit explicit `null` sentinels when trace identifiers or
    // details are absent.
    for (const operation of result.operations) {
      for (const [key, value] of Object.entries(operation)) {
        expect(value, `operation ${operation.label} has undefined ${key}`).to.not.equal(undefined);
      }
      expect(operation).to.have.property("durationMs");
      expect(operation.durationMs === null || typeof operation.durationMs === "number").to.equal(true);
      expect(operation).to.have.property("traceId");
      expect(operation.traceId === null || typeof operation.traceId === "string").to.equal(true);
      expect(operation).to.have.property("details");
      expect(operation.details === null || typeof operation.details === "string").to.equal(true);
    }

    const outputEntries = await readdir(join(result.runRoot, "outputs"));
    const hasGraphPatchOutput = outputEntries.some((name) => name.includes("graph_patch"));
    expect(hasGraphPatchOutput, "expected graph_patch output artefact").to.equal(true);
  });
});
