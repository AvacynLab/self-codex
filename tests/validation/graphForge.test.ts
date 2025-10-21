import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  type HttpEnvironmentSummary,
} from "../../src/validation/runSetup.js";
import {
  GRAPH_FORGE_JSONL_FILES,
  runGraphForgePhase,
  verifyAutosaveQuiescence,
  type GraphForgePhaseOptions,
  type AutosaveTickSample,
} from "../../src/validation/graphForge.js";

/**
 * Unit tests targeting the Graph Forge validation runner. The suite focuses on
 * artefact persistence and request orchestration – the HTTP layer is stubbed so
 * we can assert deterministic payloads.
 */
describe("graph forge validation runner", () => {
  let workingDir: string;
  let runRoot: string;
  let environment: HttpEnvironmentSummary;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-graph-forge-"));
    runRoot = await ensureRunStructure(workingDir, "validation_graph_forge");
    environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "9999",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "forge-token",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("persists DSL, analysis report, autosave summary, and JSONL artefacts", async function () {
    this.timeout(5000);
    const responses = [
      { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ report: "ok" }) }] } },
      { jsonrpc: "2.0", result: { status: "started" } },
      { jsonrpc: "2.0", result: { status: "stopped" } },
    ];

    const capturedRequests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({ url, init });
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const autosaveObserver: GraphForgePhaseOptions["autosaveObserver"] = async (
      path,
      observerOptions,
    ) => {
      await mkdir(dirname(path), { recursive: true });
      const samples: AutosaveTickSample[] = [];
      const required = observerOptions.requiredTicks ?? 2;
      for (let index = 0; index < required; index += 1) {
        const savedAt = new Date(Date.now() + index * 1_000).toISOString();
        const payload = {
          metadata: { saved_at: savedAt },
          snapshot: { nodes: [], edges: [] },
        };
        const serialised = `${JSON.stringify(payload, null, 2)}\n`;
        await writeFile(path, serialised, "utf8");
        samples.push({
          capturedAt: new Date().toISOString(),
          savedAt,
          fileSize: Buffer.byteLength(serialised, "utf8"),
        });
      }
      return {
        path,
        requiredTicks: required,
        observedTicks: samples.length,
        durationMs: 25,
        completed: true,
        samples,
      };
    };

    const result = await runGraphForgePhase(runRoot, environment, {
      workspaceRoot: workingDir,
      autosaveObserver,
      autosaveObservation: { requiredTicks: 2 },
      autosaveQuiescence: { pollIntervalMs: 5, durationMs: 50 },
    });

    expect(result.analysis.dslPath).to.equal(join(runRoot, "artifacts", "forge", "sample_pipeline.gf"));
    expect(result.analysis.resultPath).to.equal(join(runRoot, "artifacts", "forge", "analysis_result.json"));
    expect(result.autosave.summaryPath).to.equal(join(runRoot, "artifacts", "forge", "autosave_summary.json"));

    const dslContent = await readFile(result.analysis.dslPath, "utf8");
    expect(dslContent).to.contain("graph ValidationPipeline");

    const analysisDocument = JSON.parse(await readFile(result.analysis.resultPath, "utf8")) as {
      parsed?: unknown;
      parseError?: unknown;
    };
    expect(analysisDocument.parsed).to.deep.equal({ report: "ok" });
    expect(analysisDocument.parseError).to.be.null;

    const summaryDocument = JSON.parse(await readFile(result.autosave.summaryPath, "utf8"));
    expect(summaryDocument.autosave.observation.completed).to.equal(true);
    expect(summaryDocument.autosave.observation.observedTicks).to.equal(2);
    expect(summaryDocument.autosave.quiescence.verified).to.equal(true);
    expect(Object.prototype.hasOwnProperty.call(summaryDocument.autosave.observation, "lastError")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(summaryDocument.autosave.quiescence, "lastError")).to.equal(false);

    const inputsLog = await readFile(join(runRoot, GRAPH_FORGE_JSONL_FILES.inputs), "utf8");
    const outputsLog = await readFile(join(runRoot, GRAPH_FORGE_JSONL_FILES.outputs), "utf8");
    const eventsLog = await readFile(join(runRoot, GRAPH_FORGE_JSONL_FILES.events), "utf8");
    const httpLog = await readFile(join(runRoot, GRAPH_FORGE_JSONL_FILES.log), "utf8");

    expect(inputsLog).to.contain("graph_forge_analyze");
    expect(outputsLog).to.contain("graph_state_autosave");
    expect(eventsLog).to.contain("autosave.tick");
    expect(eventsLog).to.contain("autosave.quiescence");
    expect(httpLog).to.contain("graph_forge_analyze");
    expect(httpLog).to.contain("graph_state_autosave:start");
    expect(httpLog).to.contain("graph_state_autosave:stop");

    expect(capturedRequests).to.have.lengthOf(3);
    const firstRequest = capturedRequests[0]?.init;
    expect(firstRequest?.headers).to.satisfy((headers: HeadersInit) => {
      if (headers instanceof Headers) {
        return headers.get("authorization") === "Bearer forge-token";
      }
      if (Array.isArray(headers)) {
        return headers.some(([key, value]) => key.toLowerCase() === "authorization" && value === "Bearer forge-token");
      }
      const record = headers as Record<string, string>;
      return record.authorization === "Bearer forge-token";
    });
  });

  it("sanitises custom autosave overrides before writing to disk", async function () {
    this.timeout(5000);
    const responses = [
      { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ report: "ok" }) }] } },
      { jsonrpc: "2.0", result: { status: "started" } },
      { jsonrpc: "2.0", result: { status: "stopped" } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const observedPaths: string[] = [];
    const autosaveObserver: GraphForgePhaseOptions["autosaveObserver"] = async (absolutePath) => {
      observedPaths.push(absolutePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      const payload = {
        metadata: { saved_at: new Date().toISOString() },
        snapshot: { nodes: [], edges: [] },
      };
      const serialised = `${JSON.stringify(payload, null, 2)}\n`;
      await writeFile(absolutePath, serialised, "utf8");
      const sample: AutosaveTickSample = {
        capturedAt: new Date().toISOString(),
        savedAt: payload.metadata.saved_at ?? null,
        fileSize: Buffer.byteLength(serialised, "utf8"),
      };
      return {
        path: absolutePath,
        requiredTicks: 1,
        observedTicks: 1,
        durationMs: 5,
        completed: true,
        samples: [sample],
      };
    };

    const result = await runGraphForgePhase(runRoot, environment, {
      workspaceRoot: workingDir,
      autosaveRelativePath: "tmp/<danger>.json",
      autosaveObserver,
      autosaveObservation: { requiredTicks: 1 },
      autosaveQuiescence: { pollIntervalMs: 5, durationMs: 20 },
    });

    expect(result.autosave.relativePath).to.equal("tmp/_danger_.json");
    expect(result.autosave.absolutePath).to.equal(join(workingDir, "tmp", "_danger_.json"));
    expect(observedPaths).to.deep.equal([result.autosave.absolutePath]);
    expect(result.autosave.absolutePath).to.not.include("<");
  });

  it("throws when the autosave artefact changes after stop", async function () {
    this.timeout(5000);
    const responses = [
      { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ report: "ok" }) }] } },
      { jsonrpc: "2.0", result: { status: "started" } },
      { jsonrpc: "2.0", result: { status: "stopped" } },
    ];

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const autosaveObserver: GraphForgePhaseOptions["autosaveObserver"] = async (path, observerOptions) => {
      await mkdir(dirname(path), { recursive: true });
      const samples: AutosaveTickSample[] = [];
      const required = observerOptions.requiredTicks ?? 2;
      for (let index = 0; index < required; index += 1) {
        const savedAt = new Date(Date.now() + index * 1_000).toISOString();
        const payload = {
          metadata: { saved_at: savedAt },
          snapshot: { nodes: [], edges: [] },
        };
        const serialised = `${JSON.stringify(payload, null, 2)}\n`;
        await writeFile(path, serialised, "utf8");
        samples.push({
          capturedAt: new Date().toISOString(),
          savedAt,
          fileSize: Buffer.byteLength(serialised, "utf8"),
        });
      }

      // Mutate the autosave artefact immediately to simulate an unexpected
      // tick emitted after the `stop` call completes.
      const mutatedPayload = {
        metadata: { saved_at: new Date(Date.now() + 9_000).toISOString() },
        snapshot: { nodes: [], edges: [] },
      };
      await writeFile(path, `${JSON.stringify(mutatedPayload, null, 2)}\n`, "utf8");

      return {
        path,
        requiredTicks: required,
        observedTicks: samples.length,
        durationMs: 25,
        completed: true,
        samples,
      };
    };

    let error: unknown;
    try {
      await runGraphForgePhase(runRoot, environment, {
        workspaceRoot: workingDir,
        autosaveObserver,
        autosaveObservation: { requiredTicks: 2, pollIntervalMs: 5, timeoutMs: 250 },
        autosaveQuiescence: { pollIntervalMs: 5, durationMs: 40 },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.match(/Autosave did not quiesce/);
  });

  it("treats a missing autosave file as quiescent", async function () {
    this.timeout(5000);
    const directory = await mkdtemp(join(tmpdir(), "codex-quiescence-"));
    const filePath = join(directory, "autosave.json");

    const checkPromise = verifyAutosaveQuiescence(filePath, "expected", {
      pollIntervalMs: 5,
      durationMs: 20,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await rm(directory, { recursive: true, force: true });

    const result = await checkPromise;
    expect(result.verified).to.equal(true);
    expect(result.fileMissing).to.equal(true);
    expect(result.observedSavedAt).to.equal(null);
  });

  it("exposes quiescence errors without retaining undefined placeholders", async () => {
    const missingPath = join(runRoot, "artifacts", "forge", "missing_autosave.json");
    const result = await verifyAutosaveQuiescence(missingPath, null, {
      pollIntervalMs: 10,
      durationMs: 25,
    });

    expect(result.fileMissing).to.equal(true);
    expect(result.verified).to.equal(true);
    expect(result.lastError).to.equal("ENOENT");
    expect(Object.prototype.hasOwnProperty.call(result, "lastError")).to.equal(true);
  });
});
