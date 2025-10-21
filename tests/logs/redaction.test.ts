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

describe("structured payload masking", () => {
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

  it("redacts sensitive headers regardless of casing or nesting", async () => {
    // Purpose: ensure the recursive redaction helper scrubs all known
    // sensitive header keys even when the payload mixes casing styles or
    // embeds the headers deep inside arrays/objects.
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      onEntry(entry) {
        entries.push(entry);
      },
    });

    logger.info("header_redaction", {
      headers: {
        Authorization: "Bearer SECRET-A",
        "Set-Cookie": "session=SECRET-B",
      },
      nested: [
        { headers: { "Proxy-Authorization": "Basic SECRET-C" } },
        { extras: { Cookie: "user=SECRET-D" } },
      ],
    });

    await logger.flush();

    expect(entries).to.have.lengthOf(1);
    const payload = entries[0]?.payload as {
      headers?: Record<string, string>;
      nested?: Array<Record<string, unknown>>;
    };

    expect(payload?.headers?.Authorization).to.equal("[REDACTED]");
    expect(payload?.headers?.["Set-Cookie"]).to.equal("[REDACTED]");

    const firstNested = payload?.nested?.[0] as { headers?: Record<string, string> } | undefined;
    expect(firstNested?.headers?.["Proxy-Authorization"]).to.equal("[REDACTED]");

    const secondNested = payload?.nested?.[1] as { extras?: { Cookie?: string } } | undefined;
    expect(secondNested?.extras?.Cookie).to.equal("[REDACTED]");
  });
});

describe("environment-driven cognitive redaction", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.MCP_LOG_REDACT;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.MCP_LOG_REDACT;
    } else {
      process.env.MCP_LOG_REDACT = previous;
    }
  });

  it("scrubs secrets provided via MCP_LOG_REDACT", async () => {
    // Purpose: confirm operators can inject tokens through the environment so
    // cognitive excerpts never leak raw credentials in persisted artefacts.
    process.env.MCP_LOG_REDACT = "top-secret-token";

    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      onEntry(entry) {
        entries.push(entry);
      },
    });

    logger.logCognitive({
      actor: "orchestrator",
      phase: "prompt",
      content: "Issue top-secret-token during setup",
    });

    await logger.flush();

    expect(entries).to.have.lengthOf(1);
    const payload = entries[0]?.payload as { excerpt?: string } | undefined;
    expect(payload?.excerpt).to.include("[REDACTED]");
    expect(payload?.excerpt).to.not.include("top-secret-token");
  });

  it("supports regular expression tokens for cognitive excerpts", async () => {
    // Purpose: document that regex-based directives can redact dynamic token
    // formats such as runtime-issued API keys.
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({
      onEntry(entry) {
        entries.push(entry);
      },
      redactSecrets: [/sk-[a-z0-9]+/gi],
    });

    logger.logCognitive({
      actor: "child",
      phase: "score",
      content: "Evaluated key sk-AbC123 for the request",
    });

    await logger.flush();

    expect(entries).to.have.lengthOf(1);
    const payload = entries[0]?.payload as { excerpt?: string } | undefined;
    expect(payload?.excerpt).to.include("[REDACTED]");
    expect(payload?.excerpt).to.not.match(/sk-[a-z0-9]+/i);
  });
});
