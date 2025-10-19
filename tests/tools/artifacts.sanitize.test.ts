import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { BudgetTracker } from "../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../src/infra/tracing.js";
import { StructuredLogger, type LogEntry } from "../../src/logger.js";
import {
  ARTIFACT_WRITE_TOOL_NAME,
  createArtifactWriteHandler,
} from "../../src/tools/artifact_write.js";
import { sanitizeArtifactPath, resolveMaxArtifactBytes } from "../../src/tools/artifact_paths.js";
import { ARTIFACT_READ_TOOL_NAME, createArtifactReadHandler } from "../../src/tools/artifact_read.js";

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("notifications are not expected in artifact sanitisation tests");
    },
    sendRequest: async () => {
      throw new Error("nested requests are not expected in artifact sanitisation tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("artifact façades sanitisation", () => {
  let childrenRoot: string;
  let previousMaxBytes: string | undefined;

  beforeEach(async () => {
    childrenRoot = await mkdtemp(join(tmpdir(), "artifact-sanitize-"));
    previousMaxBytes = process.env.MCP_MAX_ARTIFACT_BYTES;
  });

  afterEach(async () => {
    if (previousMaxBytes === undefined) {
      delete process.env.MCP_MAX_ARTIFACT_BYTES;
    } else {
      process.env.MCP_MAX_ARTIFACT_BYTES = previousMaxBytes;
    }
    await rm(childrenRoot, { recursive: true, force: true });
  });

  it("falls back to the default artifact size when the override is invalid", () => {
    process.env.MCP_MAX_ARTIFACT_BYTES = "garbage";

    expect(resolveMaxArtifactBytes()).to.equal(8 * 1024 * 1024);
  });

  it("rejects traversal attempts before touching the filesystem", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createArtifactWriteHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-traversal");
    const budget = new BudgetTracker({ toolCalls: 2, bytesIn: 1_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_WRITE_TOOL_NAME}`, traceId: "trace-artifact-traversal", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-safety",
              path: "../secrets/../../../passwd.txt",
              content: "should not be written",
              mime_type: "text/plain",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(true);
    expect(structured.ok).to.equal(false);
    expect(structured.summary).to.include("chemin d'artefact invalide");
    expect(structured.details.path).to.equal("../secrets/../../../passwd.txt");

    const logEntry = entries.find((entry) => entry.message === "artifact_write_invalid_path");
    expect(logEntry).to.not.equal(undefined);
    const payload = logEntry?.payload as Record<string, unknown> | undefined;
    expect(payload?.path_hash).to.be.a("string").with.length(16);
    expect(payload?.path_relative).to.equal(undefined);
  });

  it("sanitises special characters before persisting the artifact", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createArtifactWriteHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-sanitise");
    const budget = new BudgetTracker({ toolCalls: 4, bytesIn: 10_000 });

    const requestedPath = "reports//analysis:?.txt";
    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_WRITE_TOOL_NAME}`, traceId: "trace-artifact-sanitise", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-sanitised",
              path: requestedPath,
              content: "santé",
              mime_type: "text/plain",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    const sanitised = sanitizeArtifactPath(childrenRoot, "child-sanitised", requestedPath);
    expect(structured.details.path).to.equal(sanitised.relative);

    const stored = await readFile(
      join(childrenRoot, "child-sanitised", "outbox", ...sanitised.relative.split(/[\\/]/)),
      "utf8",
    );
    expect(stored).to.equal("santé");

    const logEntry = entries.find((entry) => entry.message === "artifact_write_completed");
    const payload = logEntry?.payload as Record<string, unknown> | undefined;
    expect(payload?.path_relative).to.equal(sanitised.relative);
    expect(payload?.path_hash).to.be.a("string").with.length(16);
  });

  it("enforces the maximum artifact size advertised by the configuration", async () => {
    process.env.MCP_MAX_ARTIFACT_BYTES = "128";

    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createArtifactWriteHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-max-size");
    const budget = new BudgetTracker({ toolCalls: 3, bytesIn: 10_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_WRITE_TOOL_NAME}`, traceId: "trace-artifact-max-size", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-max-size",
              path: "reports/too-big.txt",
              content: "x".repeat(512),
              mime_type: "text/plain",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(true);
    expect(structured.ok).to.equal(false);
    expect(structured.summary).to.include("artefact trop volumineux");
    expect(structured.details.size).to.equal(512);

    const logEntry = entries.find((entry) => entry.message === "artifact_write_size_exceeded");
    const payload = logEntry?.payload as Record<string, unknown> | undefined;
    expect(payload?.limit).to.equal(128);
    expect(payload?.attempted).to.equal(512);
  });

  it("rejects traversal attempts on artifact_read", async () => {
    const entries: LogEntry[] = [];
    const logger = new StructuredLogger({ onEntry: (entry) => entries.push(entry) });
    const handler = createArtifactReadHandler({ logger, childrenRoot });
    const extras = createRequestExtras("req-artifact-read-traversal");
    const budget = new BudgetTracker({ toolCalls: 2, bytesOut: 1_000 });

    const result = await runWithRpcTrace(
      { method: `tools/${ARTIFACT_READ_TOOL_NAME}`, traceId: "trace-artifact-read-traversal", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              child_id: "child-reader",
              path: "../../../../etc/shadow",
            },
            extras,
          ),
        ),
    );

    const structured = result.structuredContent as Record<string, any>;
    expect(result.isError).to.equal(true);
    expect(structured.ok).to.equal(false);
    expect(structured.summary).to.include("chemin d'artefact invalide");
    expect(structured.details.path).to.equal("../../../../etc/shadow");

    const logEntry = entries.find((entry) => entry.message === "artifact_read_invalid_path");
    const payload = logEntry?.payload as Record<string, unknown> | undefined;
    expect(payload?.path_hash).to.be.a("string").with.length(16);
    expect(payload?.error).to.be.a("string");
  });
});

