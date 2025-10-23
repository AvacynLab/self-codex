import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { StructuredLogger } from "../src/logger.js";

describe("StructuredLogger", () => {
  it("rotates the log file when the configured size is exceeded", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "logger-"));
    const logFile = path.join(directory, "orchestrator.log");

    try {
      const logger = new StructuredLogger({
        logFile,
        maxFileSizeBytes: 256,
        maxFileCount: 3,
      });

      for (let index = 0; index < 6; index += 1) {
        logger.info("rotation_test_entry", { index, payload: "x".repeat(120) });
      }

      await logger.flush();

      const files = await readdir(directory);
      expect(files).to.include("orchestrator.log");
      expect(files).to.include("orchestrator.log.1");

      const archived = await readFile(path.join(directory, "orchestrator.log.1"), "utf8");
      expect(archived).to.contain("rotation_test_entry");
      expect(archived.trim().length).to.be.greaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("redacts configured secrets in cognitive logs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "logger-"));
    const logFile = path.join(directory, "audit.log");

    try {
      const logger = new StructuredLogger({
        logFile,
        redactSecrets: ["SECRET_TOKEN"],
      });

      logger.logCognitive({
        actor: "test",
        phase: "prompt",
        childId: "child-1",
        content: "Using SECRET_TOKEN to call the API",
      });

      await logger.flush();

      const content = await readFile(logFile, "utf8");
      expect(content).to.contain("[REDACTED]");
      expect(content).to.not.contain("SECRET_TOKEN");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("omits file mirroring when callers pass a null logFile override", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "logger-"));
    try {
      const entries: Array<{ message: string }> = [];
      const logger = new StructuredLogger({ logFile: null, onEntry: (entry) => entries.push({ message: entry.message }) });

      logger.warn("null_logfile_sanitised", { detail: "capture" });
      await logger.flush();

      const files = await readdir(directory);
      expect(files.length, "the logger should not create files when mirroring is disabled").to.equal(0);
      expect(entries.map((entry) => entry.message)).to.deep.equal(["null_logfile_sanitised"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

