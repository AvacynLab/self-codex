import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";

import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import { ChildSupervisor } from "../../src/childSupervisor.js";
import { StructuredLogger } from "../../src/logger.js";
import { BudgetTracker } from "../../src/infra/budget.js";
import { runWithJsonRpcContext } from "../../src/infra/jsonRpcContext.js";
import { runWithRpcTrace } from "../../src/infra/tracing.js";
import {
  CHILD_ORCHESTRATE_TOOL_NAME,
  createChildOrchestrateHandler,
} from "../../src/tools/child_orchestrate.js";

const mockRunnerPath = fileURLToPath(new URL("../fixtures/mock-runner.js", import.meta.url));

/**
 * Builds the `RequestHandlerExtra` stub used by tests to inject transport
 * headers. The helper mirrors the shape of the objects provided by the MCP SDK
 * so the façade observes the same metadata as it would under HTTP.
 */
function createRequestExtras(
  requestId: string,
  headers: Record<string, string>,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    requestInfo: { headers },
    sendNotification: async () => {
      throw new Error("child_orchestrate profile tests do not expect notifications");
    },
    sendRequest: async () => {
      throw new Error("child_orchestrate profile tests do not expect nested requests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("child_orchestrate sandbox profiles", () => {
  let childrenRoot: string;
  let supervisor: ChildSupervisor;
  let logger: StructuredLogger;

  beforeEach(async () => {
    childrenRoot = await mkdtemp(path.join(tmpdir(), "child-orchestrate-profile-"));
    supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath, "--role", "sandbox"],
      idleTimeoutMs: 250,
      idleCheckIntervalMs: 50,
    });
    logger = new StructuredLogger({ logFile: path.join(childrenRoot, "child-orchestrate-profile.log") });
  });

  afterEach(async () => {
    await supervisor.disposeAll();
    await rm(childrenRoot, { recursive: true, force: true });
  });

  const scenarios = [
    {
      label: "strict",
      requested: "strict",
      expected: "strict",
      requestTimeout: 7_500,
      readyTimeout: 1_200,
    },
    {
      label: "standard-alias",
      requested: "std",
      expected: "standard",
      requestTimeout: 6_000,
      readyTimeout: 1_600,
    },
    {
      label: "permissive-alias",
      requested: "perm",
      expected: "permissive",
      requestTimeout: 12_000,
      readyTimeout: 900,
    },
  ] as const;

  for (const scenario of scenarios) {
    it(`propagates runtime headers and metadata for the ${scenario.label} profile`, async () => {
      const handler = createChildOrchestrateHandler({ supervisor, logger });
      const headers = {
        "x-timeout-ms": String(scenario.requestTimeout),
        authorization: "Bearer orchestrate-profile",
      };
      const extras = createRequestExtras(`req-child-profile-${scenario.label}`, headers);

      const requestBudget = new BudgetTracker({
        timeMs: 45_000,
        tokens: 50_000,
        toolCalls: 4,
        bytesIn: 8_192,
        bytesOut: 16_384,
      });
      const toolBudget = new BudgetTracker({ toolCalls: 2, tokens: 5_000, bytesOut: 65_536 });

      const response = await runWithRpcTrace(
        {
          method: `tools/${CHILD_ORCHESTRATE_TOOL_NAME}`,
          traceId: `trace-child-profile-${scenario.label}`,
          requestId: extras.requestId,
        },
        async () =>
          runWithJsonRpcContext(
            {
              requestId: extras.requestId,
              timeoutMs: scenario.requestTimeout,
              headers,
              budget: toolBudget,
              requestBudget,
            },
            () =>
              handler(
                {
                  sandbox: { profile: scenario.requested },
                  ready_timeout_ms: scenario.readyTimeout,
                  collect: { include_messages: false, include_artifacts: false },
                  initial_payload: { type: "ping" },
                  followup_payloads: [],
                  shutdown: { mode: "cancel", timeout_ms: 500 },
                },
                extras,
              ),
          ),
      );

      expect(response.isError).to.equal(false, "the façade should succeed");
      const structured = response.structuredContent as { ok: boolean; details: Record<string, any> };
      expect(structured.ok).to.equal(true, "structured payload should indicate success");

      const childId = structured.details.child_id;
      expect(childId).to.be.a("string");

      const manifestPath = path.join(childrenRoot, childId, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;

      const sandboxMetadata = manifest.metadata?.sandbox as Record<string, any> | undefined;
      expect(sandboxMetadata, "sandbox metadata should be present").to.be.an("object");
      expect(sandboxMetadata?.profile).to.equal(scenario.expected);
      if (scenario.expected === "strict") {
        expect(sandboxMetadata?.deny_network).to.equal(true);
      }
      if (scenario.expected === "permissive") {
        expect(sandboxMetadata?.deny_network).to.equal(false);
      }

      const runtimeHeaders = manifest.metadata?.runtime_headers as Record<string, string> | undefined;
      expect(runtimeHeaders, "runtime headers should be recorded").to.be.an("object");

      const timeoutsHeader = runtimeHeaders?.["x-runtime-timeouts"];
      expect(timeoutsHeader, "timeouts header should be serialised").to.be.a("string");
      const parsedTimeouts = timeoutsHeader ? JSON.parse(timeoutsHeader) : {};
      expect(parsedTimeouts.ready_timeout_ms).to.equal(Math.trunc(Math.max(0, scenario.readyTimeout)));
      expect(parsedTimeouts.request_timeout_ms).to.equal(Math.trunc(Math.max(0, scenario.requestTimeout)));

      const budgetsHeader = runtimeHeaders?.["x-runtime-budgets"];
      expect(budgetsHeader, "budgets header should be serialised").to.be.a("string");
      const parsedBudgets = budgetsHeader ? JSON.parse(budgetsHeader) : {};
      expect(parsedBudgets.transport?.limits?.bytesOut).to.equal(16_384);
      expect(parsedBudgets.tool?.limits?.toolCalls).to.equal(2);
      expect(parsedBudgets.tool?.limits?.tokens).to.equal(5_000);

      // Ensure original transport headers still surface in the manifest so
      // downstream tooling can inspect authentication material if needed.
      expect(runtimeHeaders?.authorization).to.equal("Bearer orchestrate-profile");
    });
  }
});

