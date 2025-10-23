import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  executeLogCaptureCli,
  parseLogCaptureCliOptions,
  type LogCaptureCliLogger,
} from "../../src/validation/logsCli.js";
import { type CaptureHttpLogOptions, type HttpLogSummary } from "../../src/validation/logs.js";

/**
 * Unit tests ensuring the log capture CLI follows the expected orchestration
 * flow and surfaces useful telemetry for operators.
 */
describe("log capture CLI", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-log-capture-"));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI arguments", () => {
    const options = parseLogCaptureCliOptions([
      "--run-id",
      "validation_custom",
      "--base-dir",
      "custom_runs",
      "--run-root",
      "runs/validation_existing",
      "--source",
      "/tmp/http.log",
      "--target",
      "custom.log",
      "--summary",
      "custom-summary.json",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_custom",
      baseDir: "custom_runs",
      runRoot: "runs/validation_existing",
      sourcePath: "/tmp/http.log",
      targetFileName: "custom.log",
      summaryFileName: "custom-summary.json",
    });
  });

  it("captures the log file and reports top messages", async () => {
    const loggerOutput: string[] = [];
    const logger: LogCaptureCliLogger = {
      log: (...args: unknown[]) => {
        loggerOutput.push(args.join(" "));
      },
    };

    const runRoot = join(workingDir, "runs", "validation_cli");
    const sourceLog = join(workingDir, "mcp_http.log");
    await writeFile(
      sourceLog,
      [
        '{"level":"info","message":"first message"}',
        '{"level":"info","message":"first message"}',
        '{"level":"error","detail":"critical failure"}',
        "plain fallback entry",
      ].join("\n"),
      "utf8",
    );

    const { logPath, summaryPath, summary } = await executeLogCaptureCli(
      {
        runRoot,
        sourcePath: sourceLog,
      },
      logger,
    );

    expect(logPath).to.equal(join(runRoot, "logs", "mcp_http.log"));
    expect(summaryPath).to.equal(join(runRoot, "logs", "summary.json"));
    expect(summary.totalLines).to.equal(4);
    expect(summary.topMessages[0]).to.deep.equal({ text: "first message", count: 2 });
    expect(summary.topMessages.some((entry) => entry.text.includes("critical failure"))).to.equal(true);
    expect(summary.topMessages.some((entry) => entry.text.includes("plain fallback entry"))).to.equal(true);

    expect(loggerOutput.some((line) => line.includes("Top messages"))).to.equal(true);
    expect(loggerOutput.some((line) => line.includes("[2] first message"))).to.equal(true);
  });

  it("omits unspecified CLI overrides when capturing logs", async () => {
    const logger: LogCaptureCliLogger = { log: () => undefined };
    const observedOptions: CaptureHttpLogOptions[] = [];
    const stubSummary: HttpLogSummary = {
      generatedAt: new Date().toISOString(),
      sourcePath: "/tmp/mcp_http.log",
      fileSizeBytes: 0,
      totalLines: 0,
      emptyLines: 0,
      parseFailures: 0,
      levelCounts: {},
      errorLines: 0,
      warnLines: 0,
      infoLines: 0,
      topMessages: [],
      latency: { samples: 0, fields: [], min: null, max: null, p50: null, p95: null, p99: null },
    };

    const { runRoot } = await executeLogCaptureCli(
      { baseDir: workingDir, runId: "validation_cli_sanitised" },
      logger,
      {
        capture: async (root, options) => {
          observedOptions.push(options ?? {});
          return {
            logPath: join(root, "logs", "mcp_http.log"),
            summaryPath: join(root, "logs", "summary.json"),
            summary: stubSummary,
          };
        },
      },
    );

    expect(runRoot).to.match(/validation_cli_sanitised/);
    expect(observedOptions).to.have.lengthOf(1);
    // Optional CLI parameters must disappear entirely so strict optional
    // properties never observe `undefined` placeholders when the default
    // behaviour is used.
    expect(observedOptions[0]).to.deep.equal({});
  });

  it("trims CLI overrides before forwarding them to the capture helper", async () => {
    const logger: LogCaptureCliLogger = { log: () => undefined };
    const observedOptions: CaptureHttpLogOptions[] = [];
    const stubSummary: HttpLogSummary = {
      generatedAt: new Date().toISOString(),
      sourcePath: "/tmp/custom.log",
      fileSizeBytes: 0,
      totalLines: 0,
      emptyLines: 0,
      parseFailures: 0,
      levelCounts: {},
      errorLines: 0,
      warnLines: 0,
      infoLines: 0,
      topMessages: [],
      latency: { samples: 0, fields: [], min: null, max: null, p50: null, p95: null, p99: null },
    };

    await executeLogCaptureCli(
      {
        baseDir: workingDir,
        runId: "validation_cli_trim",
        sourcePath: "  /tmp/custom.log  ",
        targetFileName: " custom.log ",
        summaryFileName: " summary.json ",
      },
      logger,
      {
        capture: async (root, options) => {
          observedOptions.push(options ?? {});
          return {
            logPath: join(root, "logs", "custom.log"),
            summaryPath: join(root, "logs", "summary.json"),
            summary: stubSummary,
          };
        },
      },
    );

    expect(observedOptions).to.have.lengthOf(1);
    // Trimming guarantees we forward precise overrides without leaking blank
    // strings that would otherwise serialize as empty values.
    expect(observedOptions[0]).to.deep.equal({
      sourcePath: "/tmp/custom.log",
      targetFileName: "custom.log",
      summaryFileName: "summary.json",
    });
  });
});
