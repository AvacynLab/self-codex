import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { z } from "zod";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { ChildSupervisor } from "../../../src/children/supervisor.js";
import { StructuredLogger } from "../../../src/logger.js";
import { BudgetTracker } from "../../../src/infra/budget.js";
import { IdempotencyRegistry } from "../../../src/infra/idempotency.js";
import { runWithJsonRpcContext } from "../../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../../src/infra/tracing.js";
import { resolveFixture, runnerArgs } from "../../helpers/childRunner.js";
import {
  CHILD_ORCHESTRATE_TOOL_NAME,
  createChildOrchestrateHandler,
} from "../../../src/tools/child_orchestrate.js";

const mockRunnerPath = resolveFixture(import.meta.url, "../../fixtures/mock-runner.ts");
const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);

function createRequestExtras(requestId: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    sendNotification: async () => {
      throw new Error("child_orchestrate tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("child_orchestrate tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("child_orchestrate facade", () => {
  let childrenRoot: string;
  let supervisor: ChildSupervisor;
  let logger: StructuredLogger;

  beforeEach(async () => {
    childrenRoot = await mkdtemp(path.join(tmpdir(), "child-orchestrate-"));
    supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs("--role", "friendly"),
      idleTimeoutMs: 250,
      idleCheckIntervalMs: 50,
    });
    logger = new StructuredLogger({ logFile: path.join(childrenRoot, "child-orchestrate.log") });
  });

  afterEach(async () => {
    await supervisor.disposeAll();
    await rm(childrenRoot, { recursive: true, force: true });
  });

  it("spawns, exchanges messages and shuts down the child", async () => {
    const handler = createChildOrchestrateHandler({
      supervisor,
      logger,
      idempotency: new IdempotencyRegistry(),
    });
    const extras = createRequestExtras("req-child-orchestrate-success");
    const budget = new BudgetTracker({ toolCalls: 5, tokens: 20_000, bytesIn: 65_536 });

    const result = await runWithRpcTrace(
      { method: `tools/${CHILD_ORCHESTRATE_TOOL_NAME}`, traceId: "trace-child-orchestrate-success", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler(
            {
              initial_payload: { type: "prompt", content: "bonjour" },
              followup_payloads: [{ type: "ping" }],
              wait_for_message: { timeout_ms: 1_000, stream: "stdout" },
              collect: { include_messages: true, include_artifacts: false },
              shutdown: { mode: "cancel", timeout_ms: 500 },
            },
            extras,
          ),
        ),
    );

    expect(result.isError).to.equal(false);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(true);
    expect(structured.details.child_id).to.be.a("string");
    expect(structured.details.send_results).to.have.lengthOf(2);
    expect(structured.details.shutdown).to.not.equal(null);
    if (structured.details.observation?.message) {
      expect(structured.details.observation.message.stream).to.equal("stdout");
    }
    const hasIdempotent = Object.prototype.hasOwnProperty.call(structured.details, "idempotent");
    expect(hasIdempotent).to.equal(true);
    if (hasIdempotent) {
      expect(structured.details.idempotent).to.equal(false);
    }
  });

  it("replays cached results when the idempotency key matches", async () => {
    const handler = createChildOrchestrateHandler({
      supervisor,
      logger,
      idempotency: new IdempotencyRegistry(),
    });
    const extras = createRequestExtras("req-child-orchestrate-idem");
    const budget = new BudgetTracker({ toolCalls: 10, tokens: 50_000, bytesIn: 131_072 });

    const payload = {
      idempotency_key: "child-idem-1",
      initial_payload: { type: "prompt", content: "hello" },
      followup_payloads: [],
      shutdown: { mode: "cancel" as const },
    };

    const first = await runWithRpcTrace(
      { method: `tools/${CHILD_ORCHESTRATE_TOOL_NAME}`, traceId: "trace-child-orchestrate-first", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(payload, extras)),
    );
    const firstStructured = first.structuredContent as Record<string, any>;
    expect(firstStructured.details.idempotent).to.equal(false);

    const second = await runWithRpcTrace(
      { method: `tools/${CHILD_ORCHESTRATE_TOOL_NAME}`, traceId: "trace-child-orchestrate-second", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () => handler(payload, extras)),
    );
    const secondStructured = second.structuredContent as Record<string, any>;
    expect(secondStructured.details.idempotent).to.equal(true);
    expect(secondStructured.details.child_id).to.equal(firstStructured.details.child_id);
  });

  it("returns a degraded response when the budget is exhausted", async () => {
    const handler = createChildOrchestrateHandler({ supervisor, logger });
    const extras = createRequestExtras("req-child-orchestrate-budget");
    const budget = new BudgetTracker({ toolCalls: 0 });

    const result = await runWithRpcTrace(
      { method: `tools/${CHILD_ORCHESTRATE_TOOL_NAME}`, traceId: "trace-child-orchestrate-budget", requestId: extras.requestId },
      async () =>
        await runWithJsonRpcContext({ requestId: extras.requestId, budget }, () =>
          handler({ initial_payload: { type: "prompt", content: "budget" } }, extras),
        ),
    );

    expect(result.isError).to.equal(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).to.equal(false);
    expect(structured.details.reason).to.equal("budget_exhausted");
  });

  it("validates the input payload", async () => {
    const handler = createChildOrchestrateHandler({ supervisor, logger });
    let captured: unknown;
    try {
      const invalidPayload: Record<string, unknown> = {
        // Intentionally omit the required structured payload so the schema guard rejects the request.
        command: "",
      };
      await handler(invalidPayload, createRequestExtras("req-child-orchestrate-invalid"));
    } catch (error) {
      captured = error;
    }
    expect(captured).to.be.instanceOf(z.ZodError);
  });
});
