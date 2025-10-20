/**
 * End-to-end coverage for the structured logger redaction toggles. The suite
 * documents the default-on behaviour while ensuring explicit opt-out
 * directives still disable masking when operators intentionally request it.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { StructuredLogger, type LogEntry } from "../../src/logger.js";

/** Utility payload exercised across the scenarios to ensure stable assertions. */
const SENSITIVE_PAYLOAD = {
  headers: {
    authorization: "Bearer TOP-SECRET",
    "x-api-key": "super-secret-key",
  },
};

describe("log redaction toggles", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.MCP_LOG_REDACT;
    delete process.env.MCP_LOG_REDACT;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.MCP_LOG_REDACT;
    } else {
      process.env.MCP_LOG_REDACT = previous;
    }
  });

  it("redacts sensitive headers when no directives are provided", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      onEntry(entry) {
        entries.push(entry);
      },
    });

    logger.info("redaction_default", SENSITIVE_PAYLOAD);
    await logger.flush();

    expect(entries).to.have.lengthOf(1);
    const headers = (entries[0]?.payload as { headers?: Record<string, string> }).headers;
    expect(headers?.authorization).to.equal("[REDACTED]");
    expect(headers?.["x-api-key"]).to.equal("[REDACTED]");
  });

  it("treats an empty directive list as an explicit opt-out", async () => {
    process.env.MCP_LOG_REDACT = "";
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      onEntry(entry) {
        entries.push(entry);
      },
    });

    logger.info("redaction_enabled", SENSITIVE_PAYLOAD);
    await logger.flush();

    expect(entries).to.have.lengthOf(1);
    const headers = (entries[0]?.payload as { headers?: Record<string, string> }).headers;
    expect(headers?.authorization).to.equal("Bearer TOP-SECRET");
    expect(headers?.["x-api-key"]).to.equal("super-secret-key");
  });

  it("supports opt-out directives even after an explicit enable", async () => {
    process.env.MCP_LOG_REDACT = "off";
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      onEntry(entry) {
        entries.push(entry);
      },
    });

    logger.info("redaction_disabled", SENSITIVE_PAYLOAD);
    await logger.flush();

    expect(entries).to.have.lengthOf(1);
    const headers = (entries[0]?.payload as { headers?: Record<string, string> }).headers;
    expect(headers?.authorization).to.equal("Bearer TOP-SECRET");
    expect(headers?.["x-api-key"]).to.equal("super-secret-key");
  });

  it("continues to redact when explicitly toggled on", async () => {
    process.env.MCP_LOG_REDACT = "on";
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      onEntry(entry) {
        entries.push(entry);
      },
    });

    logger.info("redaction_explicit_enable", SENSITIVE_PAYLOAD);
    await logger.flush();

    expect(entries).to.have.lengthOf(1);
    const headers = (entries[0]?.payload as { headers?: Record<string, string> }).headers;
    expect(headers?.authorization).to.equal("[REDACTED]");
    expect(headers?.["x-api-key"]).to.equal("[REDACTED]");
  });
});
