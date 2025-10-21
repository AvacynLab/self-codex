import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  logJournal,
} from "../src/server.js";
import { assertArray, assertPlainObject, isPlainObject } from "./helpers/assertions.js";

/**
 * End-to-end coverage exercising a hierarchical plan compilation followed by a reactive
 * execution controlled via lifecycle tools. The scenario validates that events are
 * emitted with the expected correlation hints, that pause/resume/cancel operate on the
 * running plan, and that orchestrator logs can be tailed once the run is cancelled.
 */
describe("plan lifecycle end-to-end", () => {
  it("compiles, runs, controls and cancels a reactive plan with correlated telemetry", async function () {
    this.timeout(20000);

    const clock = sinon.useFakeTimers();
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-lifecycle-e2e", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const runId = "plan-e2e-run";
    const opId = "plan-e2e-op";
    const jobId = "plan-e2e-job";
    const graphId = "plan-e2e-graph";
    const nodeId = "plan-e2e-node";

    // Hierarchical graph compiled to a simple linear Behaviour Tree. Each task advertises
    // deterministic tool bindings so the scheduler emits correlated node telemetry.
    const hierarchicalPlan = {
      id: graphId,
      nodes: [
        { id: "ingest", kind: "task", attributes: { bt_tool: "wait", bt_input_key: "ingest" } },
        { id: "process", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "process" } },
        { id: "publish", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "publish" } },
      ],
      edges: [
        { id: "ingest->process", from: { nodeId: "ingest" }, to: { nodeId: "process" }, label: "next" },
        { id: "process->publish", from: { nodeId: "process" }, to: { nodeId: "publish" }, label: "next" },
      ],
    } as const;

    try {
      logJournal.reset();
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableEventsBus: true,
        enablePlanLifecycle: true,
        enableReactiveScheduler: true,
        enableBT: true,
        enableStigmergy: true,
        enableAutoscaler: true,
        enableSupervisor: true,
        enableCancellation: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-lifecycle-e2e" } });
      childProcessSupervisor.childrenIndex.restore({});

      const baselineEvents = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineEvents.isError ?? false).to.equal(false);
      const baselineCursor = (baselineEvents.structuredContent as { next_seq: number | null }).next_seq ?? 0;

      const compileResponse = await client.callTool({
        name: "plan_compile_bt",
        arguments: { graph: hierarchicalPlan },
      });
      expect(compileResponse.isError ?? false).to.equal(false);
      const compiledTree = compileResponse.structuredContent as {
        id: string;
        root: unknown;
      };

      const runPromise = client.callTool({
        name: "plan_run_reactive",
        arguments: {
          tree: compiledTree,
          variables: {
            ingest: { duration_ms: 500 },
            process: { step: "transform" },
            publish: { step: "notify" },
          },
          tick_ms: 50,
          timeout_ms: 1000,
          run_id: runId,
          op_id: opId,
          job_id: jobId,
          graph_id: graphId,
          node_id: nodeId,
        },
      });

      await clock.tickAsync(50);

      const statusResponse = await client.callTool({ name: "plan_status", arguments: { run_id: runId } });
      expect(statusResponse.isError ?? false).to.equal(false);
      const runningSnapshot = statusResponse.structuredContent as { state: string };
      expect(runningSnapshot.state).to.equal("running");

      await clock.tickAsync(200);

      const pauseResponse = await client.callTool({ name: "plan_pause", arguments: { run_id: runId } });
      expect(pauseResponse.isError ?? false).to.equal(false);
      const pausedSnapshot = pauseResponse.structuredContent as { state: string; last_event: { phase: string } | null };
      expect(pausedSnapshot.state).to.equal("paused");
      expect(pausedSnapshot.last_event?.phase).to.equal("pause");

      const resumeResponse = await client.callTool({ name: "plan_resume", arguments: { run_id: runId } });
      expect(resumeResponse.isError ?? false).to.equal(false);
      const resumedSnapshot = resumeResponse.structuredContent as { state: string; last_event: { phase: string } | null };
      expect(resumedSnapshot.state).to.equal("running");
      expect(resumedSnapshot.last_event?.phase).to.equal("resume");

      const cancelResponse = await client.callTool({
        name: "plan_cancel",
        arguments: { run_id: runId, reason: "plan-lifecycle-e2e" },
      });
      expect(cancelResponse.isError ?? false).to.equal(false);
      const cancelContent = cancelResponse.structuredContent as {
        reason: string | null;
        operations: Array<{ op_id: string; outcome: string }>;
      };
      expect(cancelContent.reason).to.equal("plan-lifecycle-e2e");
      expect(cancelContent.operations.some((operation) => operation.op_id === opId)).to.equal(true);

      await clock.tickAsync(0);

      const runOutcome = await runPromise;
      expect(runOutcome.isError ?? false).to.equal(true);
      const errorPayload = JSON.parse(runOutcome.content[0]?.text ?? "{}") as {
        error?: string;
        hint?: string;
        details?: { reason?: string | null };
      };
      expect(errorPayload.error).to.equal("E-CANCEL-OP");
      expect(errorPayload.hint).to.equal("operation_cancelled");
      expect(errorPayload.details?.reason).to.equal("plan-lifecycle-e2e");

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: { from_seq: baselineCursor, cats: ["bt_run"], run_id: runId },
      });
      expect(eventsResponse.isError ?? false).to.equal(false);
      const lifecycleStructured = eventsResponse.structuredContent;
      assertPlainObject(lifecycleStructured, "plan lifecycle events payload");
      const lifecycleEvents = lifecycleStructured.events;
      assertArray(lifecycleEvents, "plan lifecycle events list");
      const runPhases = lifecycleEvents
        .map((event) => (isPlainObject(event) && isPlainObject(event.data) ? event.data.phase : null))
        .filter((phase): phase is string => typeof phase === "string");
      expect(runPhases).to.include("start");
      expect(runPhases).to.include("cancel");

      await logJournal.flush();
      const logsResponse = await client.callTool({
        name: "logs_tail",
        arguments: { stream: "run", id: runId, limit: 20 },
      });
      expect(logsResponse.isError ?? false).to.equal(false);
      const logEntries = (logsResponse.structuredContent as {
        entries: Array<{ message: string; run_id: string | null }>;
      }).entries;
      expect(logEntries.some((entry) => entry.run_id === runId)).to.equal(true);
      expect(logEntries.length).to.be.greaterThan(0);
    } finally {
      await logJournal.flush().catch(() => {});
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      clock.restore();
    }
  });
});
