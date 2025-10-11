import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { captureHttpLog, summariseHttpLogFile } from "../../src/validation/logs.js";

async function createTempLogFile(root: string, name: string, content: string): Promise<string> {
  const target = join(root, name);
  await writeFile(target, content, "utf8");
  return target;
}

describe("validation log utilities", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-log-"));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("summarises structured logs and exposes latency percentiles", async () => {
    const logPath = await createTempLogFile(
      workingDir,
      "mcp_http.log",
      [
        '{"level":"info","durationMs":10,"message":"ok"}',
        '{"level":"WARN","metrics":{"latencyMs":20}}',
        "Plain WARN line without JSON", // fallback detection should count this as warn
        '{"event":{"elapsed_ms":50},"level":"INFO"}',
        "",
        "   ",
        "not-json",
      ].join("\n"),
    );

    const summary = await summariseHttpLogFile(logPath);

    expect(summary.totalLines).to.equal(7);
    expect(summary.emptyLines).to.equal(2);
    expect(summary.parseFailures).to.equal(2); // plain text + invalid JSON
    expect(summary.warnLines).to.be.greaterThanOrEqual(2);
    expect(summary.infoLines).to.be.at.least(1);
    expect(summary.latency.samples).to.equal(3);
    expect(summary.latency.fields).to.include.members(["durationMs", "latencyMs", "elapsed_ms"]);
    expect(summary.latency.min).to.equal(10);
    expect(summary.latency.max).to.equal(50);
    expect(summary.latency.p50).to.equal(20);
    expect(summary.latency.p95).to.be.closeTo(47, 1);
  });

  it("copies the log into the run folder and persists the summary", async () => {
    const sourceLog = await createTempLogFile(workingDir, "source.log", '{"level":"error","durationMs":123}');

    const runRoot = join(workingDir, "run");
    await captureHttpLog(runRoot, { sourcePath: sourceLog });

    const copiedLog = await readFile(join(runRoot, "logs", "mcp_http.log"), "utf8");
    const summaryContent = await readFile(join(runRoot, "logs", "summary.json"), "utf8");

    expect(copiedLog).to.contain("durationMs");
    const summary = JSON.parse(summaryContent);
    expect(summary.errorLines).to.equal(1);
    expect(summary.latency.p95).to.equal(123);
  });
});
