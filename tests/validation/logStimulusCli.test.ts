import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { appendFile, mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  executeLogStimulusCli,
  parseLogStimulusCliOptions,
  type LogStimulusCliLogger,
} from "../../src/validation/logStimulusCli.js";
import { LOG_STIMULUS_JSONL_FILES } from "../../src/validation/logStimulus.js";

/**
 * Tests ensuring the log stimulation CLI orchestrates the workflow as expected.
 */
describe("log stimulus CLI", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;
  let runRoot: string;
  let logPath: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-log-cli-"));
    runRoot = join(workingDir, "validation_cli");
    logPath = join(workingDir, "mcp_http.log");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags", () => {
    const options = parseLogStimulusCliOptions([
      "--run-id",
      "validation_custom",
      "--base-dir",
      "custom_runs",
      "--run-root",
      "runs/validation_foo",
      "--log-path",
      "/tmp/custom.log",
      "--iterations",
      "5",
      "--call-name",
      "manual",
      "--method",
      "tools/custom",
      "--params",
      '{"name":"echo"}',
      "--tool",
      "ping",
      "--text",
      "hello",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_custom",
      baseDir: "custom_runs",
      runRoot: "runs/validation_foo",
      logPath: "/tmp/custom.log",
      iterations: 5,
      callName: "manual",
      method: "tools/custom",
      paramsJson: '{"name":"echo"}',
      toolName: "ping",
      toolText: "hello",
    });
  });

  it("executes the workflow and logs progress", async () => {
    const observedLogs: string[] = [];
    const logger: LogStimulusCliLogger = {
      log: (...args: unknown[]) => {
        observedLogs.push(args.join(" "));
      },
    };

    globalThis.fetch = (async () => {
      await appendFile(logPath, '{"message":"cli"}\n', "utf8");
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { runRoot: resolvedRunRoot, result } = await executeLogStimulusCli(
      {
        runRoot,
        logPath,
        toolName: "echo",
        toolText: "cli probe",
        iterations: 3,
      },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9999",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "token",
      } as NodeJS.ProcessEnv,
      logger,
    );

    expect(resolvedRunRoot).to.equal(runRoot);
    expect(result.logChanged).to.equal(true);
    expect(result.iterations.length).to.equal(3);
    expect(result.call.params).to.deep.equal({ name: "echo", arguments: { text: "cli probe" } });
    expect(result.logDeltaBytes).to.be.greaterThan(0);

    const inputsContent = await readFile(join(runRoot, LOG_STIMULUS_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, LOG_STIMULUS_JSONL_FILES.outputs), "utf8");

    expect(inputsContent).to.contain("log_stimulus_echo");
    expect(outputsContent).to.contain("ok");

    expect(observedLogs.some((line) => line.includes("Log changed"))).to.equal(true);
    expect(observedLogs.some((line) => line.includes("Iterations executed"))).to.equal(true);
  });

  it("fails when the HTTP log does not grow", async () => {
    const logger: LogStimulusCliLogger = { log: () => undefined };

    await appendFile(logPath, '{"message":"baseline"}\n', "utf8");

    globalThis.fetch = (async () => {
      // The simulated MCP response intentionally omits any log append so the
      // CLI detects the missing growth and fails the run as required by Stage 2.
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let thrown: unknown;
    try {
      await executeLogStimulusCli(
        {
          runRoot,
          logPath,
          iterations: 2,
        },
        { MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: "9999", MCP_HTTP_PATH: "/mcp" } as NodeJS.ProcessEnv,
        logger,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as Error).message).to.contain("did not increase the HTTP log");
  });
});
