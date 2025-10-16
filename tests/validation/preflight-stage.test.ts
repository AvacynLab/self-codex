import { after, afterEach, before, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Focused regression tests for the HTTP preflight validation stage. The suite
 * asserts that the stage: (1) provisions a temporary HTTP endpoint backed by
 * the in-process server, (2) records the probing requests and responses in the
 * expected directories, and (3) restores environment mutations once finished.
 */
describe("validation preflight stage", function () {
  this.timeout(20000);

  let runContextModule: typeof import("../../scripts/lib/validation/run-context.mjs");
  let recorderModule: typeof import("../../scripts/lib/validation/artifact-recorder.mjs");
  let stageModule: typeof import("../../scripts/lib/validation/stages/preflight.mjs");
  let workspaceRoot: string;
  const originalEnv: Partial<Record<string, string>> = {};

  before(async () => {
    runContextModule = await import("../../scripts/lib/validation/run-context.mjs");
    recorderModule = await import("../../scripts/lib/validation/artifact-recorder.mjs");
    stageModule = await import("../../scripts/lib/validation/stages/preflight.mjs");
  });

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "codex-preflight-"));
    originalEnv.MCP_HTTP_HOST = process.env.MCP_HTTP_HOST;
    originalEnv.MCP_HTTP_PORT = process.env.MCP_HTTP_PORT;
    originalEnv.MCP_HTTP_PATH = process.env.MCP_HTTP_PATH;
    originalEnv.MCP_HTTP_TOKEN = process.env.MCP_HTTP_TOKEN;
    originalEnv.MCP_HTTP_ALLOW_NOAUTH = process.env.MCP_HTTP_ALLOW_NOAUTH;
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_HTTP_PORT = "0";
    process.env.MCP_HTTP_PATH = "/mcp";
    delete process.env.MCP_HTTP_TOKEN;
    process.env.MCP_HTTP_ALLOW_NOAUTH = "1";
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    if (originalEnv.MCP_HTTP_HOST === undefined) {
      delete process.env.MCP_HTTP_HOST;
    } else {
      process.env.MCP_HTTP_HOST = originalEnv.MCP_HTTP_HOST;
    }
    if (originalEnv.MCP_HTTP_PORT === undefined) {
      delete process.env.MCP_HTTP_PORT;
    } else {
      process.env.MCP_HTTP_PORT = originalEnv.MCP_HTTP_PORT;
    }
    if (originalEnv.MCP_HTTP_PATH === undefined) {
      delete process.env.MCP_HTTP_PATH;
    } else {
      process.env.MCP_HTTP_PATH = originalEnv.MCP_HTTP_PATH;
    }
    if (originalEnv.MCP_HTTP_TOKEN === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = originalEnv.MCP_HTTP_TOKEN;
    }
    if (originalEnv.MCP_HTTP_ALLOW_NOAUTH === undefined) {
      delete process.env.MCP_HTTP_ALLOW_NOAUTH;
    } else {
      process.env.MCP_HTTP_ALLOW_NOAUTH = originalEnv.MCP_HTTP_ALLOW_NOAUTH;
    }
  });

  after(() => {
    delete originalEnv.MCP_HTTP_HOST;
    delete originalEnv.MCP_HTTP_PORT;
    delete originalEnv.MCP_HTTP_PATH;
    delete originalEnv.MCP_HTTP_TOKEN;
    delete originalEnv.MCP_HTTP_ALLOW_NOAUTH;
  });

  it("records http handshake artefacts and restores tokens", async () => {
    const context = await runContextModule.createRunContext({
      runId: "validation_2099-05-01",
      workspaceRoot,
    });

    const recorder = new recorderModule.ArtifactRecorder(context, {
      clock: () => new Date("2099-05-01T00:00:00.000Z"),
      logger: { warn() {} },
    });

    const outcome = await stageModule.runPreflightStage({
      context,
      recorder,
      logger: { info() {}, warn() {}, error() {} },
      phaseId: "phase-00-preflight",
    });

    expect(outcome.phaseId).to.equal("phase-00-preflight");
    const offlineGuard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;

    if (offlineGuard) {
      expect(outcome.summary.offline).to.deep.equal({ reason: offlineGuard });
      expect(outcome.summary.checks.unauthorised).to.include({ skipped: true, reason: offlineGuard });
      expect(outcome.summary.checks.authorised).to.include({ skipped: true, reason: offlineGuard });
    } else {
      expect(outcome.summary.checks.unauthorised.status).to.equal(401);
      expect(outcome.summary.checks.authorised.status).to.equal(200);
    }
    expect(outcome.summary.artifacts.contextPath).to.be.a("string");

    const requestsFile = join(context.directories.inputs, "phase-00-preflight-requests.jsonl");
    const responsesFile = join(context.directories.outputs, "phase-00-preflight-responses.jsonl");
    const contextFile = join(context.directories.report, "context.json");
    const reportFile = join(context.directories.report, "step00-preflight.json");

    await stat(requestsFile);
    await stat(responsesFile);
    await stat(contextFile);
    await stat(reportFile);

    const contextDocument = JSON.parse(await readFile(contextFile, "utf8")) as {
      target: { baseUrl: string | null; actualPort: number | null };
      token: { source: string };
      offline?: { reason: string };
    };

    if (offlineGuard) {
      expect(contextDocument.offline).to.deep.equal({ reason: offlineGuard });
      expect(contextDocument.target.actualPort).to.equal(null);
      expect(contextDocument.target.baseUrl).to.equal(null);
      expect(contextDocument.token.source).to.equal("skipped");
      const parsedRequests = (await readFile(requestsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      parsedRequests.forEach((entry) => expect(entry).to.include({ skipped: true, reason: offlineGuard }));
      const parsedResponses = (await readFile(responsesFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      parsedResponses.forEach((entry) => expect(entry).to.include({ skipped: true, reason: offlineGuard }));
    } else {
      const requestLines = (await readFile(requestsFile, "utf8")).trim().split("\n");
      expect(requestLines.length).to.equal(2);
      const responseLines = (await readFile(responsesFile, "utf8")).trim().split("\n");
      expect(responseLines.length).to.equal(2);
      expect(contextDocument.target.actualPort).to.be.a("number");
      expect(contextDocument.target.baseUrl).to.match(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(contextDocument.token.source).to.equal("generated");
    }

    expect(process.env.MCP_HTTP_TOKEN).to.equal(originalEnv.MCP_HTTP_TOKEN);

    const phaseEvents = join(context.directories.events, "phase-00-preflight.jsonl");
    const recordedEvents = (await readFile(phaseEvents, "utf8")).trim().split("\n");
    expect(recordedEvents.length).to.equal(2);
  });
});
