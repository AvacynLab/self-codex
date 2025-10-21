import { beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { z, type ZodTypeAny } from "zod";

import { handleJsonRpc, logJournal, buildLiveEvents, server as mcpServer } from "../../src/server.js";
import type { JsonRpcResponse } from "../../src/server.js";
import { RPC_METHOD_SCHEMAS } from "../../src/rpc/schemas.js";
import {
  getMutableJsonRpcRequestHandlerRegistry,
  type InternalJsonRpcHandler,
} from "../../src/mcp/jsonRpcInternals.js";

/**
 * Observability regression suite ensuring JSON-RPC requests emit correlated events and logs.
 * The tests issue direct in-process calls so we can deterministically inspect the event bus and
 * correlated log journal without relying on network transports.
 */
describe("jsonrpc observability", () => {
  beforeEach(() => {
    logJournal.reset();
  });

  function latestEventSeq(): number {
    const recent = buildLiveEvents({ limit: 1, order: "desc" });
    return recent.length > 0 ? recent[0]!.seq : 0;
  }

  it("records run and child correlation for request and error lifecycles", async () => {
    const runId = `run-observability-${Date.now()}`;
    const childId = `child-observability-${Date.now()}`;
    const startSeq = latestEventSeq();

    const response = (await handleJsonRpc(
      {
        jsonrpc: "2.0",
        id: "req-run-child",
        method: "tools/call",
        params: {
          name: "plan_pause",
          arguments: {
            run_id: runId,
          },
        },
      },
      { transport: "http", childId },
    )) as JsonRpcResponse;

    const payload = response.result as { isError?: boolean } | undefined;
    expect(payload?.isError ?? false).to.equal(true);

    const events = buildLiveEvents({ limit: 20, order: "asc", min_seq: startSeq + 1 });
    const requestEvent = events.find(
      (event) => event.stage === "jsonrpc_request" && event.payload?.request_id === "req-run-child",
    );
    const errorEvent = events.find(
      (event) => event.stage === "jsonrpc_error" && event.payload?.request_id === "req-run-child",
    );

    expect(requestEvent, "request event should be captured").to.exist;
    expect(requestEvent?.runId).to.equal(runId);
    expect(requestEvent?.childId).to.equal(childId);
    expect(requestEvent?.payload?.status).to.equal("pending");

    expect(errorEvent, "error event should be captured").to.exist;
    expect(errorEvent?.runId).to.equal(runId);
    expect(errorEvent?.childId).to.equal(childId);
    expect(errorEvent?.seq).to.be.greaterThan(requestEvent?.seq ?? 0);
    expect(errorEvent?.payload?.status).to.equal("error");
    expect(errorEvent?.payload?.elapsed_ms).to.be.a("number");

    const serverLogs = logJournal.tail({ stream: "server", bucketId: "jsonrpc" });
    expect(serverLogs.entries.map((entry) => entry.message)).to.deep.equal([
      "jsonrpc_request",
      "jsonrpc_error",
    ]);
    const [serverRequest, serverError] = serverLogs.entries;
    expect(serverRequest.runId).to.equal(runId);
    expect(serverRequest.childId).to.equal(childId);
    expect(serverError.seq).to.be.greaterThan(serverRequest.seq);

    const runLogs = logJournal.tail({ stream: "run", bucketId: runId });
    expect(runLogs.entries.map((entry) => entry.message)).to.deep.equal([
      "jsonrpc_request",
      "jsonrpc_error",
    ]);
    expect(runLogs.entries[0]?.childId).to.equal(childId);

    const childLogs = logJournal.tail({ stream: "child", bucketId: childId });
    expect(childLogs.entries.map((entry) => entry.message)).to.deep.equal([
      "jsonrpc_request",
      "jsonrpc_error",
    ]);
  });

  it("propagates operation identifiers even when only op_id is provided", async () => {
    logJournal.reset();
    const startSeq = latestEventSeq();

    const response = (await handleJsonRpc(
      {
        jsonrpc: "2.0",
        id: "req-op-only",
        method: "tools/call",
        params: {
          name: "op_cancel",
          arguments: {
            op_id: "op-observability",
          },
        },
      },
      { transport: "http" },
    )) as JsonRpcResponse;

    const payload = response.result as { isError?: boolean } | undefined;
    expect(payload?.isError ?? false).to.equal(true);

    const events = buildLiveEvents({ limit: 20, order: "asc", min_seq: startSeq + 1 });
    const requestEvent = events.find(
      (event) => event.stage === "jsonrpc_request" && event.payload?.request_id === "req-op-only",
    );
    const errorEvent = events.find(
      (event) => event.stage === "jsonrpc_error" && event.payload?.request_id === "req-op-only",
    );

    expect(requestEvent?.opId).to.equal("op-observability");
    expect(errorEvent?.opId).to.equal("op-observability");

    const serverLogs = logJournal.tail({ stream: "server", bucketId: "jsonrpc" });
    expect(serverLogs.entries.map((entry) => entry.message)).to.deep.equal([
      "jsonrpc_request",
      "jsonrpc_error",
    ]);
    expect(serverLogs.entries[0]?.opId).to.equal("op-observability");
    expect(serverLogs.entries[1]?.opId).to.equal("op-observability");
    expect(serverLogs.entries[1]?.seq).to.be.greaterThan(serverLogs.entries[0]?.seq ?? 0);

    const runBucket = logJournal.tail({ stream: "run" });
    expect(runBucket.entries).to.deep.equal([]);
  });

  it("extracts correlation from structuredContent tool responses", async () => {
    logJournal.reset();
    const handlers = getMutableJsonRpcRequestHandlerRegistry(mcpServer);

    const originalToolsCall: InternalJsonRpcHandler | undefined = handlers.get("tools/call");
    const childId = `child-structured-${Date.now()}`;
    const runId = `run-structured-${Date.now()}`;
    const jobId = `job-structured-${Date.now()}`;

    handlers.set("tools/call", async (request, extra) => {
      if (request?.params && typeof request.params === "object") {
        const params = request.params as { name?: string };
        if (params.name === "structured_test") {
          return {
            content: [{ type: "text", text: "{}" }],
            structuredContent: {
              child_id: childId,
              run_id: runId,
              job_id: jobId,
            },
          } as const;
        }
      }
      if (!originalToolsCall) {
        throw new Error("tools/call handler missing");
      }
      return originalToolsCall(request, extra);
    });

    const previousSchema: ZodTypeAny | undefined = RPC_METHOD_SCHEMAS["structured_test"];
    // Register a permissive schema for the synthetic tool leveraged in the
    // regression to ensure the central middleware accepts the payload and the
    // handler hook receives the request.
    RPC_METHOD_SCHEMAS["structured_test"] = z.object({}).strict();

    try {
      const startSeq = latestEventSeq();
      const response = (await handleJsonRpc(
        {
          jsonrpc: "2.0",
          id: "structured-correlation",
          method: "tools/call",
          params: { name: "structured_test" },
        },
        { transport: "http" },
      )) as JsonRpcResponse;

      const payload = response.result as { structuredContent?: Record<string, unknown> } | undefined;
      expect(payload?.structuredContent).to.deep.equal({ child_id: childId, run_id: runId, job_id: jobId });

      const events = buildLiveEvents({ limit: 10, order: "asc", min_seq: startSeq + 1 });
      const requestEvent = events.find(
        (event) => event.stage === "jsonrpc_request" && event.payload?.request_id === "structured-correlation",
      );
      const responseEvent = events.find(
        (event) => event.stage === "jsonrpc_response" && event.payload?.request_id === "structured-correlation",
      );

      expect(requestEvent, "request event should exist").to.exist;
      expect(responseEvent, "response event should exist").to.exist;
      expect(responseEvent, "response event correlation").to.deep.include({ childId, runId, jobId });

      const serverLogs = logJournal.tail({ stream: "server", bucketId: "jsonrpc" });
      const messages = serverLogs.entries.map((entry) => entry.message);
      expect(messages).to.include("jsonrpc_response");
      const responseLog = serverLogs.entries.find((entry) => entry.message === "jsonrpc_response");
      const correlation = responseLog?.data as Record<string, unknown> | undefined;
      // Logger enrichment now stores correlation identifiers inside the mirrored
      // JSON log payload (exposed as `data` through the log journal facade).
      expect(correlation?.child_id).to.equal(childId);
      expect(correlation?.run_id).to.equal(runId);
      expect(correlation?.job_id).to.equal(jobId);
    } finally {
      if (originalToolsCall) {
        handlers.set("tools/call", originalToolsCall);
      } else {
        handlers.delete("tools/call");
      }
      if (previousSchema) {
        RPC_METHOD_SCHEMAS["structured_test"] = previousSchema;
      } else {
        delete RPC_METHOD_SCHEMAS["structured_test"];
      }
    }
  });
});
