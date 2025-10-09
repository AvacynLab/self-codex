import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, stat, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resources } from "../src/server.js";

/**
 * The validation run script is still under construction.  These regression tests
 * verify the safety guarantees that already exist:
 *   • dry-run mode should not touch the filesystem and must expose the planned
 *     operations for inspection;
 *   • prepare-only mode must lay down the expected folder structure with
 *     `.gitkeep` sentinels so future steps can drop artefacts deterministically.
 */
describe("validate run script", () => {
  beforeEach(() => {
    process.env.CODEX_SCRIPT_TEST = "1";
    delete process.env.START_MCP_BG;
    delete process.env.MCP_HTTP_ENABLE;
    process.env.CODEX_NODE_VERSION_OVERRIDE = "20.10.0";
    delete (globalThis as any).CODEX_VALIDATE_PLAN;
    resources.clearValidationArtifacts();
  });

  afterEach(() => {
    delete process.env.CODEX_SCRIPT_TEST;
    delete process.env.START_MCP_BG;
    delete process.env.MCP_HTTP_ENABLE;
    delete process.env.CODEX_NODE_VERSION_OVERRIDE;
    delete (globalThis as any).CODEX_VALIDATE_PLAN;
    resources.clearValidationArtifacts();
  });

  it("records the planned actions in dry-run mode", async () => {
    const module = await import("../scripts/validate-run.mjs");
    const rootDir = resolve("/tmp", "codex-dry-run");

    const result = await module.runValidationCampaign({
      dryRun: true,
      rootDir,
      sessionName: "SESSION-A",
    });

    expect(result.prepared).to.equal(true);
    expect(result.executed).to.equal(false);
    expect(result.dryRun).to.equal(true);

    const plan = (globalThis as any).CODEX_VALIDATE_PLAN as Array<Record<string, unknown>>;
    expect(plan, "plan should be recorded during dry-run").to.be.an("array").that.is.not.empty;
    const ensureSession = plan.find((item) => item.type === "session");
    expect(ensureSession).to.include({ sessionName: "SESSION-A", dryRun: true });
    const ensures = plan.filter((item) => item.type === "ensure-dir");
    expect(ensures.length).to.be.greaterThanOrEqual(2);
    ensures.forEach((entry) => {
      expect(entry).to.have.property("dryRun", true);
    });
  });

  it("creates the validation skeleton in prepare-only mode", async () => {
    const module = await import("../scripts/validate-run.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "codex-validate-"));

    try {
      const outcome = await module.runValidationCampaign({
        prepareOnly: true,
        rootDir: tempRoot,
      });

      expect(outcome.prepared).to.equal(true);
      expect(outcome.executed).to.equal(false);
      expect(outcome.sessionName).to.equal("LATEST");

      const sessionDir = join(tempRoot, "LATEST");
      await stat(sessionDir);

      for (const folder of ["inputs", "outputs", "events", "logs", "resources", "report"]) {
        const folderPath = join(sessionDir, folder);
        await stat(folderPath);
        const gitkeepPath = join(folderPath, ".gitkeep");
        const sentinel = await readFile(gitkeepPath, "utf8");
        expect(sentinel).to.equal("");
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("executes the default campaign and captures introspection artefacts", async function () {
    this.timeout(20000);
    const module = await import("../scripts/validate-run.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "codex-validate-"));

    try {
      const outcome = await module.runValidationCampaign({
        rootDir: tempRoot,
        sessionName: "RUN-CAMPAIGN",
        logger: { info() {}, warn() {}, error() {} },
      });

      expect(outcome.executed).to.equal(true);
      expect(outcome.findings.totals.totalCalls).to.be.greaterThan(2);
      expect(outcome.stages).to.be.an("array").that.is.not.empty;
      expect(outcome.readmePath).to.be.a("string");

      const sessionDir = join(tempRoot, "RUN-CAMPAIGN");
      const inputs = await readdir(join(sessionDir, "inputs"));
      expect(inputs.some((file) => file.includes("mcp_info"))).to.equal(true);
      expect(inputs.some((file) => file.includes("mcp_capabilities"))).to.equal(true);
      expect(inputs.some((file) => file.includes("events_subscribe"))).to.equal(true);

      const findingsRaw = await readFile(join(sessionDir, "report", "findings.json"), "utf8");
      const findings = JSON.parse(findingsRaw) as {
        totals: { totalCalls: number; errorCount: number };
        tools: Array<{ toolName: string; p95DurationMs: number }>;
      };
      expect(findings.totals.errorCount).to.equal(0);
      const infoTool = findings.tools.find((tool) => tool.toolName === "mcp_info");
      expect(infoTool?.p95DurationMs).to.be.a("number");

      const phaseEventsFiles = await readdir(join(sessionDir, "events"));
      const phaseFile = phaseEventsFiles.find((file) => file.startsWith("phase-01-introspection"));
      expect(phaseFile).to.be.a("string");
      const phaseEventsContent = await readFile(join(sessionDir, "events", phaseFile as string), "utf8");
      const recordedLines = phaseEventsContent.trim().split("\n").filter(Boolean);
      expect(recordedLines.length).to.be.greaterThan(0);

      const resourceIndexRaw = await readFile(join(sessionDir, "resources", "resource-prefixes.json"), "utf8");
      const resourceIndex = JSON.parse(resourceIndexRaw) as { all: unknown[]; byPrefix: unknown[] };
      expect(resourceIndex).to.have.property("all");
      expect(resourceIndex).to.have.property("byPrefix");

      const stageReportRaw = await readFile(join(sessionDir, "report", "step01-introspection.json"), "utf8");
      const stageReport = JSON.parse(stageReportRaw) as { events?: Record<string, unknown> };
      expect(stageReport.events).to.have.property("baseline_count");

      const summaryMarkdown = await readFile(join(sessionDir, "report", "summary.md"), "utf8");
      expect(summaryMarkdown).to.include("Stage coverage");

      const readmeContent = await readFile(join(tempRoot, "README.md"), "utf8");
      expect(readmeContent).to.include("## Dernière campagne");
      expect(readmeContent).to.include("RUN-CAMPAIGN/report/summary.md");
      expect(readmeContent).to.match(/Succès : \d+\.\d{2}%/);

      const validationResources = resources.list("sc://validation/RUN-CAMPAIGN/");
      expect(validationResources, "validation resources should include inputs/outputs/events/logs")
        .to.be.an("array")
        .that.is.not.empty;

      const inputResource = validationResources.find((entry) => entry.kind === "validation_input");
      expect(inputResource?.metadata?.artifact_type).to.equal("inputs");
      expect(inputResource?.uri).to.be.a("string");

      const outputResource = validationResources.find((entry) => entry.kind === "validation_output");
      expect(outputResource?.metadata?.artifact_type).to.equal("outputs");

      const eventResource = validationResources.find((entry) => entry.kind === "validation_events");
      expect(eventResource?.metadata?.phase).to.equal("phase-01-introspection");

      const logResource = validationResources.find((entry) => entry.kind === "validation_logs");
      expect(logResource?.metadata?.entry_count).to.be.greaterThan(0);

      expect(inputResource).to.not.equal(undefined);
      const readInput = resources.read(inputResource.uri);
      expect(readInput.payload).to.have.property("artifactType", "input");
      expect(readInput.payload).to.have.property("data");

      expect(eventResource).to.not.equal(undefined);
      const readEvents = resources.read(eventResource.uri);
      expect(readEvents.payload).to.have.property("artifactType", "events");
      expect((readEvents.payload as any).data?.events?.length ?? 0).to.be.greaterThan(0);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("plans the background server start when the flag is enabled", async function () {
    this.timeout(20000);
    const module = await import("../scripts/validate-run.mjs");
    const tempRoot = await mkdtemp(join(tmpdir(), "codex-validate-"));

    process.env.START_MCP_BG = "1";
    process.env.MCP_HTTP_ENABLE = "1";

    try {
      const outcome = await module.runValidationCampaign({
        rootDir: tempRoot,
        sessionName: "BG-TEST",
        logger: { info() {}, warn() {}, error() {} },
      });

      expect(outcome.executed).to.equal(true);

      const plan = (globalThis as any).CODEX_VALIDATE_PLAN as Array<Record<string, unknown>>;
      const serverPlans = plan.filter((entry) => entry.type === "server-plan");
      expect(serverPlans.length).to.be.greaterThan(0);

      const startEntry = serverPlans.find((entry) => entry.stage === "start");
      expect(startEntry).to.include({ transport: "http", sessionName: "BG-TEST", testMode: true });
      expect(startEntry?.nodeOptions).to.be.a("string").and.to.include("--enable-source-maps");

      const startedEntry = serverPlans.find((entry) => entry.stage === "started");
      expect(startedEntry).to.include({ transport: "http", sessionName: "BG-TEST" });
      expect(startedEntry?.logPath).to.be.a("string");

      const stopEntry = serverPlans.find((entry) => entry.stage === "stop");
      expect(stopEntry).to.include({ transport: "http", sessionName: "BG-TEST" });

      const logContent = await readFile(join(tempRoot, "BG-TEST", "logs", "run.log"), "utf8");
      const logLines = logContent
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(
        logLines.some(
          (entry) => entry.message === "background_server_mocked" && entry.details?.transport === "http",
        ),
      ).to.equal(true);
      expect(
        logLines.some(
          (entry) => entry.message === "background_server_mocked_stop" && entry.details?.transport === "http",
        ),
      ).to.equal(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
