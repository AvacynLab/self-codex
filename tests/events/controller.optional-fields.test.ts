import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createOrchestratorController } from "../../src/orchestrator/controller.js";
import { EventBus, type EventEnvelope, type EventInput, type EventMessage } from "../../src/events/bus.js";
import { StructuredLogger } from "../../src/logger.js";
import { LogJournal } from "../../src/monitor/log.js";
import { ToolRegistry } from "../../src/mcp/registry.js";
import type { BudgetLimits } from "../../src/infra/budget.js";

/**
 * Test event bus capturing helper.
 *
 * The subclass records the raw inputs published by the orchestrator controller before the
 * {@link EventBus.publish} normalisation logic removes `undefined` fields. This gives the test direct
 * visibility into the payload built by {@link createOrchestratorController} without re-implementing
 * the production sanitisation.
 */
class CapturingEventBus extends EventBus {
  public readonly published: EventInput<EventMessage>[] = [];

  override publish<M extends EventMessage>(input: EventInput<M>): EventEnvelope<M> {
    // Store a shallow copy so assertions observe the controller payload exactly as provided.
    this.published.push({ ...input });
    return super.publish(input);
  }
}

describe("orchestrator controller optional telemetry fields", () => {
  let runsRoot: string;
  let server: McpServer;
  let registry: ToolRegistry;
  let eventBus: CapturingEventBus;
  let logger: StructuredLogger;
  let logJournal: LogJournal;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "controller-optional-"));
    server = new McpServer({ name: "controller-optional", version: "1.0.0" });
    logger = new StructuredLogger();
    registry = await ToolRegistry.create({
      server,
      logger,
      runsRoot,
      clock: () => new Date("2025-01-01T00:00:00.000Z"),
      // The registry is not invoked during this test; return a placeholder promise to satisfy the type.
      invokeTool: async (): Promise<CallToolResult> => ({ content: [] }),
    });
    eventBus = new CapturingEventBus({ historyLimit: 8 });
    logJournal = new LogJournal({ rootDir: join(runsRoot, "journal") });
  });

  afterEach(async () => {
    registry.close();
    logJournal.reset();
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("omits elapsedMs when the controller reports a JSON-RPC validation error", async () => {
    const requestBudgetLimits: BudgetLimits = {};
    const controller = createOrchestratorController({
      server,
      toolRegistry: registry,
      logger,
      eventBus,
      logJournal,
      requestBudgetLimits,
      defaultTimeoutOverride: null,
    });

    // Trigger the fast-path validation error: the middleware rejects an empty method string which leads
    // to an immediate `jsonrpc_error` observability record with no latency measurement.
    const response = await controller.handleJsonRpc({
      jsonrpc: "2.0",
      id: "invalid",
      method: "",
    });

    expect(response.error?.code).to.equal(-32600);
    expect(response.error?.message).to.equal("Invalid Request");

    const schedulerEvents = eventBus.published.filter((entry) => entry.cat === "scheduler");
    expect(schedulerEvents, "scheduler events emitted").to.have.length.greaterThan(0);
    const latest = schedulerEvents.at(-1);
    expect(latest?.msg).to.equal("jsonrpc_error");
    expect(latest?.elapsedMs, "elapsedMs should be omitted when undefined").to.equal(undefined);
    expect(latest?.data && Object.prototype.hasOwnProperty.call(latest.data, "transport"))
      .to.equal(true, "transport property exposed on scheduler payload");
    expect(latest?.data?.transport, "transport defaults to null when omitted upstream").to.equal(null);

    const journalEntries = logJournal.tail({ stream: "server", bucketId: "jsonrpc" });
    expect(journalEntries.entries, "journal entries emitted").to.have.length.greaterThan(0);
    expect(journalEntries.entries.at(-1)?.elapsedMs, "log entries preserve null latency hints").to.equal(null);
  });
});
