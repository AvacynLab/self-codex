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
      const summaryMarkdown = await readFile(join(runRoot, "report/summary.md"), "utf8");
      const eventsSummaryRaw = await readFile(join(runRoot, "report/events-summary.json"), "utf8");
      const logDiagnosticsRaw = await readFile(join(runRoot, "report/log-diagnostics.json"), "utf8");
      const anomaliesRaw = await readFile(join(runRoot, "report/anomalies.json"), "utf8");
      const infoRaw = await readFile(join(runRoot, "outputs/info.json"), "utf8");
      const toolsRaw = await readFile(join(runRoot, "outputs/tools.json"), "utf8");
      const resourcesRaw = await readFile(join(runRoot, "outputs/resources.json"), "utf8");
      const archivedCall = await readFile(join(runRoot, "outputs/calls/mcp_info.json"), "utf8");
      const childArchive = await readFile(join(runRoot, "outputs/children/child_spawn.json"), "utf8");
      const childLimitsArchive = await readFile(
        join(runRoot, "outputs/children/child_set_limits.json"),
        "utf8",
      );
      const childStatusArchive = await readFile(
        join(runRoot, "outputs/children/child_status_after_gc.json"),
        "utf8",
      );

      expect(requestsLog.trim().length, "requests log entries").to.be.greaterThan(0);
      expect(responsesLog.trim().length, "responses log entries").to.be.greaterThan(0);
      expect(eventsLog.trim().length, "events log entries").to.be.greaterThan(0);
      expect(JSON.parse(infoRaw), "info.json content").to.be.an("object");
      expect(JSON.parse(toolsRaw), "tools.json content").to.be.an("object");
      expect(JSON.parse(resourcesRaw), "resources.json content").to.be.an("object");
      expect(JSON.parse(archivedCall), "archived call envelope").to.be.an("object");
      expect(JSON.parse(childArchive), "child archive payload").to.be.an("object");
      expect(JSON.parse(childLimitsArchive), "child limit archive payload").to.be.an("object");
      expect(JSON.parse(childStatusArchive), "child status archive payload").to.be.an("object");

      const summary = JSON.parse(summaryRaw) as {
        testMode?: boolean;
        runId?: string;
        archivedOutputs?: string[];
        latency?: { count?: number };
        logDiagnostics?: { probe?: { rotated?: boolean } };
        statusCounts?: Record<string, number>;
        eventSummary?: {
          total?: number;
          autosave?: { count?: number; timestamps?: string[] };
          limits?: { count?: number };
        };
      };
      const eventsSummary = JSON.parse(eventsSummaryRaw) as {
        total?: number;
        autosave?: { count?: number; timestamps?: string[] };
        limits?: { count?: number; entries?: Array<{ reason?: string | null; limit?: string | null }> };
      };
      const logDiagnostics = JSON.parse(logDiagnosticsRaw) as {
        probe?: { files?: { name: string }[]; rotated?: boolean };
        server?: { files?: unknown[] };
      };
      const anomalies = JSON.parse(anomaliesRaw) as Array<{ status: number; archive?: string }>;

      expect(summary.testMode, "summary testMode flag").to.equal(true);
      expect(summary.runId, "summary runId").to.be.a("string").that.includes("validation_");
      expect(summary.archivedOutputs, "summary archived outputs").to.include("calls/mcp_info.json");
      expect(summary.latency?.count, "latency count").to.be.a("number").that.is.greaterThan(0);
      expect(summary.statusCounts?.["401"], "status count for 401").to.equal(1);
      expect(summary.statusCounts?.["404"], "status count for 404").to.equal(1);
      expect(summary.logDiagnostics?.probe?.rotated, "probe rotation flag (summary)").to.equal(true);
      expect(summary.eventSummary?.total, "summary event total").to.equal(3);
      expect(summary.eventSummary?.autosave?.count, "summary autosave count").to.equal(1);
      expect(summary.eventSummary?.limits?.count, "summary limit count").to.equal(1);

      expect(summaryMarkdown, "summary markdown header").to.include("# MCP validation summary");
      expect(summaryMarkdown, "event recap section").to.include("## Event recap");
      expect(summaryMarkdown, "autosave line").to.include("Autosave ticks: 1");
      expect(logDiagnostics.probe?.files ?? [], "probe file inventory").to.not.be.empty;
      expect(anomalies, "anomalies list").to.have.lengthOf(2);
      expect(anomalies.map((entry) => entry.archive), "anomaly archive references").to.include.members([
        "errors/unauthorized.json",
        "children/child_status_after_gc.json",
      ]);

      expect(eventsSummary.total, "events summary total").to.equal(3);
      expect(eventsSummary.autosave?.count, "events summary autosave count").to.equal(1);
      expect(eventsSummary.autosave?.timestamps ?? [], "events summary autosave timestamps").to.have.lengthOf(1);
      expect(eventsSummary.limits?.count, "events summary limit count").to.equal(1);
      expect(eventsSummary.limits?.entries?.[0]?.reason, "limit reason").to.equal("wallclock");
      expect(eventsSummary.limits?.entries?.[0]?.limit, "limit type").to.equal("wallclock_ms");

      const probePrimary = await readFile(join(runRoot, "logs/redaction-rotation-probe.log"), "utf8");
      const probeRotated = await readFile(join(runRoot, "logs/redaction-rotation-probe.log.1"), "utf8");
      expect(probePrimary.trim().length, "probe log entries").to.be.greaterThan(0);
      expect(probeRotated.trim().length, "rotated probe log entries").to.be.greaterThan(0);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
