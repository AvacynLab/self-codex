import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  executeGraphForgeCli,
  parseGraphForgeCliOptions,
} from "../../src/validation/graphForgeCli.js";
import { GRAPH_FORGE_JSONL_FILES, type AutosaveTickSample } from "../../src/validation/graphForge.js";

/** Captures CLI-level tests for the Graph Forge validation workflow. */
describe("graph forge CLI helpers", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-graph-forge-cli-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parseGraphForgeCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--autosave-interval-ms",
      "1500",
      "--autosave-ticks",
      "3",
      "--autosave-poll-ms",
      "200",
      "--autosave-timeout-ms",
      "5000",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      autosaveIntervalMs: 1500,
      autosaveTicks: 3,
      autosavePollMs: 200,
      autosaveTimeoutMs: 5000,
    });
  });

  it("executes the CLI workflow and surfaces artefact locations", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] } },
      { jsonrpc: "2.0", result: { status: "started" } },
      { jsonrpc: "2.0", result: { status: "stopped" } },
    ];

    globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const autosaveObserver = async (path: string) => {
      await mkdir(dirname(path), { recursive: true });
      const savedAt = new Date().toISOString();
      const serialised = `${JSON.stringify({ metadata: { saved_at: savedAt }, snapshot: {} }, null, 2)}\n`;
      await writeFile(path, serialised, "utf8");
      const samples: AutosaveTickSample[] = [
        { capturedAt: savedAt, savedAt, fileSize: Buffer.byteLength(serialised, "utf8") },
      ];
      return {
        path,
        requiredTicks: 1,
        observedTicks: 1,
        durationMs: 10,
        completed: true,
        samples,
      };
    };

    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    const { runRoot, result } = await executeGraphForgeCli(
      { baseDir: workingDir, runId: "validation_cli" },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9999",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      logger,
      { phaseOptions: { workspaceRoot: workingDir, autosaveObserver, autosaveObservation: { requiredTicks: 1 } } },
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.autosave.observation.observedTicks).to.equal(1);

    const inputsContent = await readFile(join(runRoot, GRAPH_FORGE_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, GRAPH_FORGE_JSONL_FILES.outputs), "utf8");
    expect(inputsContent).to.contain("graph_forge_analyze");
    expect(outputsContent).to.contain("graph_state_autosave");

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(GRAPH_FORGE_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain("Autosave summary");
  });
});
