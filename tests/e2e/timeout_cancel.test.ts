/**
 * End-to-end regression tests covering timeout budgets and cancellation flows
 * exposed by the HTTP transport. The suite provisions the stateless server,
 * drives a minimal Behaviour Tree through the public JSON-RPC interface and
 * asserts that both budget overruns and explicit cancellation requests surface
 * the structured telemetry mandated by the checklist (error codes, hints and
 * correlation metadata).
 */
import { after, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/** Generic JSON-RPC envelope returned by the HTTP fast-path. */
interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: string | null;
  result?: T;
  error?: { code: number; message: string };
}

/** Shape returned by {@link invokeJsonRpc}. */
interface JsonRpcResponse<T> {
  status: number;
  envelope: JsonRpcEnvelope<T>;
}

/** Structured payload serialised when a tool reports an error. */
interface ToolErrorPayload {
  error?: string;
  hint?: string;
  message?: string;
  details?: unknown;
}

/** Deterministic Behaviour Tree exercising the `wait` tool. */
const WAIT_TREE = {
  id: "wait-budget-test",
  root: {
    type: "task" as const,
    id: "wait-node",
    node_id: "wait-node",
    tool: "wait",
    input_key: "wait_payload",
  },
};

/** Default variables resolved by the Behaviour Tree runtime. */
const BASE_VARIABLES = {
  wait_payload: { duration_ms: 2_000 },
};

/** Issues a JSON-RPC request against the provided endpoint. */
async function invokeJsonRpc<T>(baseUrl: string, method: string, params: unknown): Promise<JsonRpcResponse<T>> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0" as const,
      id: randomUUID(),
      method,
      params,
    }),
  });
  const envelope = (await response.json()) as JsonRpcEnvelope<T>;
  return { status: response.status, envelope };
}

/** Extracts the structured tool error embedded in the JSON-RPC result payload. */
function extractToolError(result: unknown): ToolErrorPayload | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as {
    isError?: unknown;
    ok?: unknown;
    error?: unknown;
    message?: unknown;
    hint?: unknown;
    details?: unknown;
    content?: unknown;
  };
  const flagged = record.isError === true || record.ok === false || typeof record.error === "string";
  if (!flagged) {
    return null;
  }

  const payload: ToolErrorPayload = {};
  if (typeof record.error === "string") {
    payload.error = record.error;
  }
  if (typeof record.message === "string") {
    payload.message = record.message;
  }
  if (typeof record.hint === "string") {
    payload.hint = record.hint;
  }
  if (Object.prototype.hasOwnProperty.call(record, "details")) {
    payload.details = record.details;
  }

  if (!payload.error || !payload.message || payload.details === undefined || payload.hint === undefined) {
    const content = record.content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const text = (entry as { text?: unknown }).text;
        if (typeof text !== "string" || text.trim().length === 0) {
          continue;
        }
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object") {
            const parsedPayload = parsed as ToolErrorPayload;
            if (payload.error === undefined && typeof parsedPayload.error === "string") {
              payload.error = parsedPayload.error;
            }
            if (payload.message === undefined && typeof parsedPayload.message === "string") {
              payload.message = parsedPayload.message;
            }
            if (payload.hint === undefined && typeof parsedPayload.hint === "string") {
              payload.hint = parsedPayload.hint;
            }
            if (payload.details === undefined && Object.prototype.hasOwnProperty.call(parsedPayload, "details")) {
              payload.details = parsedPayload.details;
            }
          }
        } catch {
          // Ignore malformed fragments and continue scanning the content array.
        }
      }
    }
  }

  if (
    payload.error === undefined &&
    payload.message === undefined &&
    payload.hint === undefined &&
    payload.details === undefined
  ) {
    return null;
  }
  return payload;
}

/**
 * HTTP regression coverage for timeout budgets and cancellation behaviour.
 *
 * The tests run with a generous timeout to accommodate the underlying
 * Behaviour Tree execution (the slowest branch intentionally waits for two
 * seconds before being cancelled).
 */
describe("HTTP plan timeouts and cancellation", function () {
  this.timeout(20_000);

  const logger = new StructuredLogger();
  let originalFeatures: FeatureToggles;
  let originalToken: string | undefined;
  let handle: HttpServerHandle | null = null;
  let baseUrl = "";

  before(async function () {
    const guard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (guard && guard !== "loopback-only") {
      this.skip();
    }

    originalToken = process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_TOKEN;

    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({
      ...originalFeatures,
      enableReactiveScheduler: true,
      enableBT: true,
      enablePlanLifecycle: true,
      enableCancellation: true,
      enableEventsBus: true,
      enableStigmergy: true,
      enableAutoscaler: true,
      enableSupervisor: true,
    });

    handle = await startHttpServer(
      mcpServer,
      {
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        enableJson: true,
        stateless: true,
      },
      logger,
    );

    baseUrl = `http://127.0.0.1:${handle.port}/mcp`;
  });

  after(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    configureRuntimeFeatures(originalFeatures);
    if (originalToken === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = originalToken;
    }
  });

  it("reports Behaviour Tree timeouts with structured error metadata", async () => {
    if (!handle) {
      throw new Error("HTTP server handle not initialised");
    }

    const response = await invokeJsonRpc(baseUrl, "plan_run_reactive", {
      tree: WAIT_TREE,
      variables: BASE_VARIABLES,
      tick_ms: 50,
      timeout_ms: 100,
      run_id: "timeout-run",
      op_id: "timeout-op",
      job_id: "timeout-job",
      graph_id: "timeout-graph",
      node_id: "timeout-node",
    });

    expect(response.status).to.equal(200);
    const toolError = extractToolError(response.envelope.result);
    expect(toolError, "expected plan_run_reactive to report a tool error").to.not.equal(null);
    expect(toolError?.error).to.equal("E-BT-RUN-TIMEOUT");
    expect(toolError?.details).to.deep.equal({ timeoutMs: 100 });
    expect(toolError?.message).to.match(/timed out/i);
  });

  it("allows op_cancel to abort a running plan and surfaces the cancellation reason", async () => {
    if (!handle) {
      throw new Error("HTTP server handle not initialised");
    }

    const runId = "cancel-run";
    const opId = "cancel-op";
    const cancelReason = "cleanup-request";

    const runPromise = invokeJsonRpc(baseUrl, "plan_run_reactive", {
      tree: WAIT_TREE,
      variables: BASE_VARIABLES,
      tick_ms: 50,
      run_id: runId,
      op_id: opId,
      job_id: "cancel-job",
      graph_id: "cancel-graph",
      node_id: "cancel-node",
    });

    await delay(150);

    const cancelResponse = await invokeJsonRpc(baseUrl, "op_cancel", { op_id: opId, reason: cancelReason });
    expect(cancelResponse.status).to.equal(200);
    const rawResult = cancelResponse.envelope.result;
    const cancelResult =
      rawResult && typeof rawResult === "object"
        ? ((rawResult as { structuredContent?: { outcome: string; op_id: string; reason: string | null } }).structuredContent ??
          rawResult)
        : undefined;
    expect(cancelResult, "expected op_cancel to return structured content").to.not.equal(undefined);
    expect(cancelResult?.op_id).to.equal(opId);
    expect(cancelResult?.outcome).to.equal("requested");
    expect(cancelResult?.reason).to.equal(cancelReason);

    const runOutcome = await runPromise;
    const cancellationError = extractToolError(runOutcome.envelope.result);
    expect(cancellationError, "expected cancellation error payload").to.not.equal(null);
    expect(cancellationError?.error).to.equal("E-CANCEL-OP");
    expect(cancellationError?.hint).to.equal("operation_cancelled");
    expect(cancellationError?.details).to.deep.equal({
      childId: null,
      graphId: "cancel-graph",
      jobId: "cancel-job",
      nodeId: "cancel-node",
      opId,
      reason: cancelReason,
      runId,
    });
  });
});
