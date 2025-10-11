import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ensureRunStructure, collectHttpEnvironment } from "../../src/validation/runSetup.js";
import {
  LOG_STIMULUS_JSONL_FILES,
  stimulateHttpLogging,
  type LogStimulusOptions,
} from "../../src/validation/logStimulus.js";

/**
 * Unit tests covering the log stimulation helper that ensures `/tmp/mcp_http.log`
 * receives fresh entries.
 */
describe("stimulateHttpLogging", () => {
  let workingDir: string;
  let runRoot: string;
  let logPath: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-log-stim-"));
    runRoot = await ensureRunStructure(workingDir, "validation_test");
    logPath = join(workingDir, "mcp_http.log");
    await writeFile(logPath, "{}\n", "utf8");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("records artefacts and reports a log change", async () => {
    const environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "8765",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "secret",
    } as NodeJS.ProcessEnv);

    const responses = [
      { jsonrpc: "2.0", result: { ok: true } },
    ];

    const observedBodies: unknown[] = [];

    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      observedBodies.push(init?.body);
      await appendFile(logPath, '{"message":"stimulated"}\n', "utf8");
      return new Response(JSON.stringify(responses.shift() ?? { jsonrpc: "2.0", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const options: LogStimulusOptions = { logPath };
    const result = await stimulateHttpLogging(runRoot, environment, options);

    expect(result.logBefore.exists).to.equal(true);
    expect(result.logAfter.exists).to.equal(true);
    expect(result.logAfter.size).to.be.greaterThan(result.logBefore.size);
    expect(result.logChanged).to.equal(true);
    expect(typeof observedBodies[0]).to.equal("string");

    const inputsContent = await readFile(join(runRoot, LOG_STIMULUS_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, LOG_STIMULUS_JSONL_FILES.outputs), "utf8");
    const logContent = await readFile(join(runRoot, LOG_STIMULUS_JSONL_FILES.log), "utf8");

    expect(inputsContent).to.contain("log_stimulus_echo");
    expect(outputsContent).to.contain("result");
    expect(logContent).to.contain("log_stimulus_echo");
  });

  it("propagates the provided log path", async () => {
    const environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "8765",
      MCP_HTTP_PATH: "/mcp",
    } as NodeJS.ProcessEnv);

    globalThis.fetch = (async () => {
      await appendFile(logPath, '{"message":"default"}\n', "utf8");
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await stimulateHttpLogging(runRoot, environment, { logPath });

    expect(result.logPath).to.equal(logPath);
    expect(result.logChanged).to.equal(true);
  });

  it("exposes the call override", async () => {
    const environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "8765",
      MCP_HTTP_PATH: "/mcp",
    } as NodeJS.ProcessEnv);

    globalThis.fetch = (async () => {
      await appendFile(logPath, '{"message":"custom"}\n', "utf8");
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await stimulateHttpLogging(runRoot, environment, {
      logPath,
      call: { name: "custom", method: "custom/ping" },
    });

    expect(result.call.name).to.equal("custom");
    const inputsContent = await readFile(join(runRoot, LOG_STIMULUS_JSONL_FILES.inputs), "utf8");
    expect(inputsContent).to.contain("custom/ping");
  });
});
