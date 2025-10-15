import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StructuredLogger, type LogEntry } from "../../src/logger.js";

/**
 * Regression coverage for the structured logger rotation and secret redaction
 * features. The tests rely on a dedicated temporary directory so they can
 * freely exercise file-system mutations without polluting the repository.
 */
describe("monitoring logs rotation", () => {
  let tempDir: string;
  let originalRedactEnv: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "codex-logger-"));
    originalRedactEnv = process.env.MCP_LOG_REDACT;
  });

  afterEach(async () => {
    if (originalRedactEnv === undefined) {
      delete process.env.MCP_LOG_REDACT;
    } else {
      process.env.MCP_LOG_REDACT = originalRedactEnv;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rotates log files when the configured size threshold is exceeded", async () => {
    const logFile = join(tempDir, "orchestrator.log");
    const logger = new StructuredLogger({
      logFile,
      maxFileSizeBytes: 512,
      maxFileCount: 3,
    });

    // Each entry weighs roughly 120 bytes which is enough to force multiple
    // rotations when appended repeatedly.
    for (let index = 0; index < 20; index += 1) {
      logger.info("rotation_probe", { index, payload: "x".repeat(64) });
    }

    await logger.flush();

    const files = await readdir(tempDir);
    expect(files).to.include("orchestrator.log");
    expect(files).to.include("orchestrator.log.1");
    expect(files).to.include("orchestrator.log.2");
    expect(files).to.not.include("orchestrator.log.3");

    const primary = await readFile(logFile, "utf8");
    const rotated = await readFile(`${logFile}.1`, "utf8");
    expect(primary.length).to.be.greaterThan(0);
    expect(rotated.length).to.be.greaterThan(0);
  });

  it("redacts custom patterns sourced from MCP_LOG_REDACT", async () => {
    process.env.MCP_LOG_REDACT = "on,sk-test";
    const logFile = join(tempDir, "cognitive.log");
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      logFile,
      maxFileSizeBytes: 1024,
      onEntry(entry) {
        entries.push(entry);
      },
    });

    logger.logCognitive({
      actor: "agent",
      phase: "prompt",
      childId: "child-1",
      content: "Token sk-test must be hidden",
    });

    await logger.flush();

    expect(entries).to.have.lengthOf(1);
    const payload = entries[0]?.payload as Record<string, unknown> | undefined;
    expect(payload).to.not.be.undefined;
    expect(payload?.excerpt).to.equal("Token [REDACTED] must be hidden");

    const mirrored = await readFile(logFile, "utf8");
    expect(mirrored).to.include("[REDACTED]");
    expect(mirrored).to.not.include("sk-test");
  });
});

