import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * Verifies that the `scripts/record-run.mjs` helper can scaffold a validation run
 * when operating in fixture mode.  The script should create the expected
 * directory layout, populate the JSONL artefacts, and emit a summary document
 * pointing at the generated tree.
 */
describe("record-run utility", function () {
  this.timeout(10_000);

  it("creates deterministic fixtures in test mode", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "record-run-test-"));
    try {
      const scriptPath = resolve("scripts/record-run.mjs");
      const child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          CODEX_RECORD_RUN_TEST: "1",
          RECORD_RUN_ROOT: sandbox,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const [exitCode] = await once(child, "exit");
      expect(exitCode, "record-run exit code").to.equal(0);

      const entries = await readdir(sandbox);
      const runFolder = entries.find((entry) => entry.startsWith("validation_"));
      expect(runFolder, "validation directory").to.not.equal(undefined);
      const runRoot = join(sandbox, runFolder ?? "");

      const subdirs = ["inputs", "outputs", "events", "logs", "artifacts", "report"];
      for (const dir of subdirs) {
        const stats = await stat(join(runRoot, dir));
        expect(stats.isDirectory(), `${dir} directory`).to.equal(true);
      }

      const requestsLog = await readFile(join(runRoot, "inputs/requests.jsonl"), "utf8");
      const responsesLog = await readFile(join(runRoot, "outputs/responses.jsonl"), "utf8");
      const eventsLog = await readFile(join(runRoot, "events/events.jsonl"), "utf8");
      const summaryRaw = await readFile(join(runRoot, "report/summary.json"), "utf8");

      expect(requestsLog.trim().length, "requests log entries").to.be.greaterThan(0);
      expect(responsesLog.trim().length, "responses log entries").to.be.greaterThan(0);
      expect(eventsLog.trim().length, "events log entries").to.be.greaterThan(0);

      const summary = JSON.parse(summaryRaw) as { testMode?: boolean; runId?: string };
      expect(summary.testMode, "summary testMode flag").to.equal(true);
      expect(summary.runId, "summary runId").to.be.a("string").that.includes("validation_");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
