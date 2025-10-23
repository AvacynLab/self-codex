import { after, afterEach, before, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression coverage for the introspection validation stage. The suite verifies
 * that the stage enumerates MCP metadata, records the aggregated JSONL artefacts
 * mandated by the campaign checklist, and exports the resource/tool catalogues.
 */
describe("validation introspection stage", function () {
  this.timeout(20000);

  let runContextModule: typeof import("../../scripts/lib/validation/run-context.mjs");
  let recorderModule: typeof import("../../scripts/lib/validation/artifact-recorder.mjs");
  let stageModule: typeof import("../../scripts/lib/validation/stages/introspection.mjs");
  let workspaceRoot: string;

  before(async () => {
    runContextModule = await import("../../scripts/lib/validation/run-context.mjs");
    recorderModule = await import("../../scripts/lib/validation/artifact-recorder.mjs");
    stageModule = await import("../../scripts/lib/validation/stages/introspection.mjs");
  });

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "codex-introspection-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function readJsonLines(filePath: string): Promise<Array<Record<string, any>>> {
    const content = await readFile(filePath, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  }

  it("captures aggregated artefacts for tool, rpc and event probes", async () => {
    const context = await runContextModule.createRunContext({
      runId: "validation_2099-05-02",
      workspaceRoot,
    });

    const recorder = new recorderModule.ArtifactRecorder(context, {
      clock: () => new Date("2099-05-02T00:00:00.000Z"),
      logger: { warn() {} },
    });

    const outcome = await stageModule.runIntrospectionStage({
      context,
      recorder,
      logger: { info() {}, warn() {}, error() {} },
      phaseId: "phase-01-introspection",
    });

    expect(outcome.summary.tools?.total ?? 0).to.be.greaterThan(0);
    expect(outcome.summary.artifacts?.requestsPath).to.be.a("string");
    expect(outcome.summary.artifacts?.responsesPath).to.be.a("string");
    expect(outcome.summary.artifacts?.eventsPath).to.be.a("string");

    const requestsFile = join(context.directories.inputs, "01_introspection.jsonl");
    const responsesFile = join(context.directories.outputs, "01_introspection.jsonl");
    const eventsFile = join(context.directories.events, "01_bus.jsonl");
    const toolsCatalogFile = join(context.directories.artifacts, "introspection", "tools-catalog.json");

    await stat(requestsFile);
    await stat(responsesFile);
    await stat(eventsFile);
    await stat(toolsCatalogFile);

    const requestEntries = await readJsonLines(requestsFile);
    const responseEntries = await readJsonLines(responsesFile);
    const eventEntries = await readJsonLines(eventsFile);

    expect(requestEntries.length).to.be.greaterThan(0);
    expect(responseEntries.length).to.equal(requestEntries.length);
    expect(eventEntries.length).to.be.greaterThan(0);

    expect(requestEntries.some((entry) => entry.tool === "mcp_info")).to.equal(true);
    expect(requestEntries.some((entry) => entry.tool === "mcp_capabilities")).to.equal(true);
    expect(requestEntries.some((entry) => entry.tool === "rpc:tools_list")).to.equal(true);
    expect(
      requestEntries.filter((entry) => entry.tool === "events_subscribe").length,
      "events_subscribe should be invoked at least twice",
    ).to.be.greaterThan(1);

    const pairedTraceIds = new Set(responseEntries.map((entry) => entry.traceId as string));
    requestEntries.forEach((entry) => {
      expect(pairedTraceIds.has(entry.traceId as string), "each request should have a matching response trace").to.equal(true);
    });

    const sequences = eventEntries.map((entry) => entry.sequence as number);
    expect(sequences).to.deep.equal([...sequences].sort((a, b) => a - b));
    expect(sequences[0]).to.equal(1);

    const stageArtifacts = await readdir(join(context.directories.artifacts, "introspection"));
    expect(stageArtifacts).to.include("resource-prefixes.json");
    expect(stageArtifacts).to.include("tools-catalog.json");

    const toolsCatalog = JSON.parse(await readFile(toolsCatalogFile, "utf8")) as {
      total: number;
      items: Array<{ name: string }>;
    };
    expect(toolsCatalog.total).to.equal(toolsCatalog.items.length);
    expect(toolsCatalog.items.some((tool) => typeof tool.name === "string")).to.equal(true);

    const stepReportPath = join(context.directories.report, "step01-introspection.json");
    const stepReport = JSON.parse(await readFile(stepReportPath, "utf8")) as {
      artifacts?: Record<string, unknown>;
      tools?: Record<string, unknown>;
    };

    // The stage report should only surface artefact paths when they exist.
    expect(stepReport.artifacts?.requests).to.be.a("string");
    expect(stepReport.artifacts?.responses).to.be.a("string");
    expect(stepReport.artifacts?.events).to.be.a("string");
    expect(stepReport.tools).to.not.have.property("next_cursor", null);

    // The in-memory summary mirrors the sanitised artefact pointers returned on disk.
    expect(outcome.summary.artifacts?.requestsPath).to.be.a("string");
    expect(outcome.summary.artifacts).to.not.have.property("requestsPath", null);
    expect(outcome.summary.artifacts).to.not.have.property("responsesPath", null);
    expect(outcome.summary.artifacts).to.not.have.property("eventsPath", null);
    expect(outcome.summary.tools).to.not.have.property("nextCursor", null);
  });
});
