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
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = "0";
    process.env.MCP_HTTP_PATH = "/mcp";
    delete process.env.MCP_HTTP_TOKEN;
    process.env.CODEX_NODE_VERSION_OVERRIDE = "20.10.0";
    delete (globalThis as any).CODEX_VALIDATE_PLAN;
    resources.clearValidationArtifacts();
  });

  afterEach(() => {
    delete process.env.CODEX_SCRIPT_TEST;
    delete process.env.START_MCP_BG;
    delete process.env.MCP_HTTP_ENABLE;
    delete process.env.MCP_HTTP_HOST;
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_HTTP_PATH;
    delete process.env.MCP_HTTP_TOKEN;
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
      const expectedSession = `validation_${new Date().toISOString().slice(0, 10)}`;
      expect(outcome.sessionName).to.equal(expectedSession);

      const sessionDir = join(tempRoot, expectedSession);
      await stat(sessionDir);

      for (const folder of ["inputs", "outputs", "events", "logs", "artifacts", "report"]) {
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
      expect(inputs).to.include("phase-00-preflight-requests.jsonl");
      expect(inputs).to.include("01_introspection.jsonl");
      expect(inputs.some((file) => file.includes("mcp_info"))).to.equal(true);
      expect(inputs.some((file) => file.includes("mcp_capabilities"))).to.equal(true);
      expect(inputs.some((file) => file.includes("events_subscribe"))).to.equal(true);

      const outputs = await readdir(join(sessionDir, "outputs"));
      expect(outputs).to.include("phase-00-preflight-responses.jsonl");
      expect(outputs).to.include("01_introspection.jsonl");

      const preflightContext = await readFile(join(sessionDir, "report", "context.json"), "utf8");
      const contextSummary = JSON.parse(preflightContext) as {
        target: { baseUrl: string | null };
        offline?: { reason: string };
        token: { source: string };
      };

      const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;

      if (offlineGuard) {
        expect(contextSummary.offline).to.deep.equal({ reason: offlineGuard });
        expect(contextSummary.target.baseUrl).to.equal(null);
        expect(contextSummary.token.source).to.equal("skipped");
      } else {
        expect(contextSummary.target.baseUrl).to.match(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(contextSummary.token.source).to.equal("generated");
      }

      const preflightReportRaw = await readFile(join(sessionDir, "report", "step00-preflight.json"), "utf8");
      const preflightReport = JSON.parse(preflightReportRaw) as {
        checks: Record<string, { status?: number; skipped?: boolean; reason?: string }>;
        offline?: { reason: string };
      };

      if (offlineGuard) {
        expect(preflightReport.offline).to.deep.equal({ reason: offlineGuard });
        expect(preflightReport.checks.unauthorised).to.include({ skipped: true, reason: offlineGuard });
        expect(preflightReport.checks.authorised).to.include({ skipped: true, reason: offlineGuard });
      } else {
        expect(preflightReport.checks.unauthorised.status).to.equal(401);
        expect(preflightReport.checks.authorised.status).to.equal(200);
      }

      const findingsRaw = await readFile(join(sessionDir, "report", "findings.json"), "utf8");
      const findings = JSON.parse(findingsRaw) as {
        totals: { totalCalls: number; errorCount: number };
        tools: Array<{ toolName: string; p95DurationMs: number }>;
      };
      expect(findings.totals.errorCount).to.equal(0);
      const infoTool = findings.tools.find((tool) => tool.toolName === "mcp_info");
      expect(infoTool?.p95DurationMs).to.be.a("number");

      const phaseEventsFiles = await readdir(join(sessionDir, "events"));
      const preflightEventsFile = phaseEventsFiles.find((file) => file.startsWith("phase-00-preflight"));
      expect(preflightEventsFile).to.be.a("string");
      const preflightEventsContent = await readFile(join(sessionDir, "events", preflightEventsFile as string), "utf8");
      const preflightLines = preflightEventsContent.trim().split("\n").filter(Boolean);
      expect(preflightLines.length).to.equal(2);

      const introspectionEventsFile = phaseEventsFiles.find((file) => file.startsWith("phase-01-introspection"));
      expect(introspectionEventsFile).to.be.a("string");
      const phaseEventsContent = await readFile(join(sessionDir, "events", introspectionEventsFile as string), "utf8");
      const recordedLines = phaseEventsContent.trim().split("\n").filter(Boolean);
      expect(recordedLines.length).to.be.greaterThan(0);

      expect(phaseEventsFiles).to.include("01_bus.jsonl");
      const aggregatedBusContent = await readFile(join(sessionDir, "events", "01_bus.jsonl"), "utf8");
      const aggregatedBusLines = aggregatedBusContent.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (aggregatedBusLines.length > 0) {
        aggregatedBusLines.forEach((entry, index) => {
          expect(entry.sequence).to.equal(index + 1);
        });
      }

      const resourceIndexRaw = await readFile(join(sessionDir, "artifacts", "introspection", "resource-prefixes.json"), "utf8");
      const resourceIndex = JSON.parse(resourceIndexRaw) as { all: unknown[]; byPrefix: unknown[] };
      expect(resourceIndex).to.have.property("all");
      expect(resourceIndex).to.have.property("byPrefix");

      const toolsCatalogRaw = await readFile(join(sessionDir, "artifacts", "introspection", "tools-catalog.json"), "utf8");
      const toolsCatalog = JSON.parse(toolsCatalogRaw) as { total: number; items: Array<{ name: string }> };
      expect(toolsCatalog.total).to.equal(toolsCatalog.items.length);
      expect(toolsCatalog.items.some((tool) => typeof tool.name === "string")).to.equal(true);

      const stageReportRaw = await readFile(join(sessionDir, "report", "step01-introspection.json"), "utf8");
      const stageReport = JSON.parse(stageReportRaw) as {
        events?: Record<string, unknown>;
        tools?: { total?: number };
        artifacts?: { requests?: string; events?: string };
      };
      expect(stageReport.events).to.have.property("baseline_count");
      expect(stageReport.tools?.total ?? 0).to.be.greaterThan(0);
      expect(stageReport.artifacts?.requests).to.be.a("string");
      expect(stageReport.artifacts?.events).to.be.a("string");

      const summaryMarkdown = await readFile(join(sessionDir, "report", "summary.md"), "utf8");
      expect(summaryMarkdown).to.include("Stage coverage");
      expect(summaryMarkdown).to.include("phase-00-preflight");
      expect(summaryMarkdown).to.match(/tools enumerated/i);

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

      const eventResources = validationResources.filter((entry) => entry.kind === "validation_events");
      expect(eventResources.length).to.be.greaterThan(0);
      expect(
        eventResources.some((entry) => entry.metadata?.phase === "phase-00-preflight"),
        "preflight stage events should be exported as validation event resources",
      ).to.equal(true);
      expect(
        eventResources.some((entry) => entry.metadata?.phase === "phase-01-introspection"),
        "introspection stage events should be exported as validation event resources",
      ).to.equal(true);

      const eventResource = eventResources.find((entry) => entry.metadata?.phase === "phase-01-introspection")
        ?? eventResources[0];

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
