import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { CreateChildOptions } from "../src/children/supervisor.js";
import type { ChildShutdownResult } from "../src/childRuntime.js";
import {
  server,
  graphState,
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  logJournal,
} from "../src/server.js";

/**
 * End-to-end validation ensuring the autoscaler reacts to stigmergic pressure, spawns a
 * surrogate child runtime, and cooperates with the supervisor to retire the capacity once the
 * backlog evaporates. The scenario uses fake timers alongside a stubbed child supervisor to keep
 * the orchestration deterministic while still exercising the real server tooling stack.
 */
describe("autoscaler and supervisor end-to-end", () => {
  it("scales up under pressure then scales down once the backlog clears", async function () {
    this.timeout(20000);

    const clock = sinon.useFakeTimers();
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const originalCreateChild = childProcessSupervisor.createChild.bind(childProcessSupervisor);
    const originalCancel = childProcessSupervisor.cancel.bind(childProcessSupervisor);
    const originalKill = childProcessSupervisor.kill?.bind(childProcessSupervisor) ?? null;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "autoscaler-supervisor-e2e", version: "1.0.0-test" });

    /**
     * Track stubbed child identifiers so the test can assert scale-up / scale-down transitions
     * without spawning real processes.
     */
    const createdChildren: string[] = [];
    const retiredChildren: string[] = [];
    const stubbedChildren = new Set<string>();

    const stubbedShutdown: ChildShutdownResult = { code: 0, signal: null, forced: false, durationMs: 0 };
    const autoscalerEventsLog: Array<{ data?: { msg?: string; child_id?: string } }> = [];

    // Replace the supervisor spawning helpers with lightweight stubs so the autoscaler can
    // manipulate lifecycle state deterministically while keeping the index in sync.
    childProcessSupervisor.createChild = (async function stubCreateChild(
      this: typeof childProcessSupervisor,
      options: CreateChildOptions = {},
    ) {
      const childId = options.childId ?? `stub-child-${createdChildren.length + 1}`;
      const startedAt = typeof clock.now === "function" ? clock.now() : clock.now;
      const snapshot = this.childrenIndex.registerChild({
        childId,
        pid: 10_000 + createdChildren.length,
        workdir: `/tmp/${childId}`,
        state: "starting",
        startedAt,
        metadata: { ...(options.metadata ?? {}) },
        role: options.role ?? null,
        limits: null,
        attachedAt: startedAt,
      });
      this.childrenIndex.updateHeartbeat(childId, startedAt);
      this.childrenIndex.updateState(childId, "ready");
      stubbedChildren.add(childId);
      createdChildren.push(childId);
      return {
        childId,
        index: snapshot,
        runtime: {
          shutdown: async () => stubbedShutdown,
          waitForExit: async () => stubbedShutdown,
          getStatus: () => ({ startedAt }),
        },
      } as unknown as Awaited<ReturnType<typeof originalCreateChild>>;
    }).bind(childProcessSupervisor);

    childProcessSupervisor.cancel = (async function stubCancel(
      this: typeof childProcessSupervisor,
      childId: string,
    ) {
      if (!stubbedChildren.has(childId)) {
        return originalCancel(childId);
      }
      this.childrenIndex.updateState(childId, "stopping");
      const timestamp = typeof clock.now === "function" ? clock.now() : clock.now;
      this.childrenIndex.recordExit(childId, { code: 0, signal: null, at: timestamp, forced: false });
      this.childrenIndex.removeChild(childId);
      stubbedChildren.delete(childId);
      retiredChildren.push(childId);
      return stubbedShutdown;
    }).bind(childProcessSupervisor);

    if (originalKill) {
      childProcessSupervisor.kill = (async function stubKill(this: typeof childProcessSupervisor, childId: string) {
        return this.cancel(childId);
      }).bind(childProcessSupervisor);
    }

    const runId = "autoscaler-e2e-run";
    const opId = "autoscaler-e2e-op";
    const jobId = "autoscaler-e2e-job";
    const graphId = "autoscaler-e2e-graph";
    const nodeId = "autoscaler-e2e-node";

    try {
      await server.close().catch(() => {});
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      configureRuntimeFeatures({
        ...baselineFeatures,
        enableEventsBus: true,
        enablePlanLifecycle: true,
        enableReactiveScheduler: true,
        enableBT: true,
        enableAutoscaler: true,
        enableSupervisor: true,
        enableStigmergy: true,
        enableCancellation: true,
      });
      logJournal.reset();
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "autoscaler-supervisor-e2e" } });
      childProcessSupervisor.childrenIndex.restore({});

      const baselineEvents = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineEvents.isError ?? false).to.equal(false);
      const baselineCursor = (baselineEvents.structuredContent as { next_seq: number | null }).next_seq ?? 0;
      let autoscalerCursor = baselineCursor;
      // Preserve the Behaviour Tree cursor so the run timeline can be replayed after the
      // autoscaler polling loop advances its own sequence position.
      const runEventsCursor = baselineCursor;

      const autoscaleConfig = await client.callTool({
        name: "agent_autoscale_set",
        arguments: { min: 0, max: 2, cooldown_ms: 0 },
      });
      expect(autoscaleConfig.isError ?? false).to.equal(false);

      const compileResponse = await client.callTool({
        name: "plan_compile_bt",
        arguments: {
          graph: {
            id: graphId,
            nodes: [
              { id: "ingest", kind: "task", attributes: { bt_tool: "wait", bt_input_key: "ingest" } },
              { id: "process", kind: "task", attributes: { bt_tool: "wait", bt_input_key: "process" } },
              { id: "publish", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "publish" } },
            ],
            edges: [
              { id: "ingest->process", from: { nodeId: "ingest" }, to: { nodeId: "process" }, label: "next" },
              { id: "process->publish", from: { nodeId: "process" }, to: { nodeId: "publish" }, label: "next" },
            ],
          },
        },
      });
      expect(compileResponse.isError ?? false).to.equal(false);
      const compiledTree = compileResponse.structuredContent as { id: string; root: unknown };

      const runPromise = client.callTool({
        name: "plan_run_reactive",
        arguments: {
          tree: compiledTree,
          variables: {
            ingest: { duration_ms: 200 },
            process: { duration_ms: 200 },
            publish: { step: "emit" },
          },
          tick_ms: 50,
          timeout_ms: 12000,
          run_id: runId,
          op_id: opId,
          job_id: jobId,
          graph_id: graphId,
          node_id: nodeId,
        },
      });

      await clock.tickAsync(50);

      const scaleUpConfig = await client.callTool({
        name: "agent_autoscale_set",
        arguments: { min: 1, max: 2, cooldown_ms: 0 },
      });
      expect(scaleUpConfig.isError ?? false).to.equal(false);

      let scaleUpEvent: { data?: { msg?: string; child_id?: string } } | null = null;
      let spawnedChildId: string | null = null;
      for (let attempt = 0; attempt < 200 && !scaleUpEvent; attempt += 1) {
        await clock.tickAsync(50);
        const autoscalerPressureResponse = await client.callTool({
          name: "events_subscribe",
          arguments: { from_seq: autoscalerCursor, cats: ["autoscaler"] },
        });
        expect(autoscalerPressureResponse.isError ?? false).to.equal(false);
        const pressureContent = autoscalerPressureResponse.structuredContent as {
          events: Array<{ data?: { msg?: string; child_id?: string } }>;
          next_seq: number | null;
        };
        autoscalerEventsLog.push(...pressureContent.events);
        autoscalerCursor = pressureContent.next_seq ?? autoscalerCursor;
        scaleUpEvent = autoscalerEventsLog.find((event) => event.data?.msg === "scale_up") ?? null;
        if (scaleUpEvent?.data?.child_id) {
          spawnedChildId = scaleUpEvent.data.child_id;
        } else if (createdChildren[0]) {
          spawnedChildId = createdChildren[0]!;
        }
      }

      expect(scaleUpEvent, "autoscaler should emit a scale_up event").to.not.equal(null);
      expect(spawnedChildId, "scale_up event should expose a child identifier").to.be.a("string");

      if (spawnedChildId) {
        childProcessSupervisor.childrenIndex.updateState(spawnedChildId, "idle");
      }

      const firstRunOutcome = await runPromise;
      expect(firstRunOutcome.isError ?? false).to.equal(false);

      const scaleDownConfig = await client.callTool({
        name: "agent_autoscale_set",
        arguments: { min: 0, max: 2, cooldown_ms: 0 },
      });
      expect(scaleDownConfig.isError ?? false).to.equal(false);

      const runIdScaleDown = `${runId}-scale-down`;
      const opIdScaleDown = `${opId}-scale-down`;
      const secondRunPromise = client.callTool({
        name: "plan_run_reactive",
        arguments: {
          tree: compiledTree,
          variables: {
            ingest: { duration_ms: 200 },
            process: { duration_ms: 200 },
            publish: { step: "emit" },
          },
          tick_ms: 50,
          timeout_ms: 12000,
          run_id: runIdScaleDown,
          op_id: opIdScaleDown,
          job_id: `${jobId}-scale-down`,
          graph_id: graphId,
          node_id: nodeId,
        },
      });

      let scaleDownEvent: { data?: { msg?: string; child_id?: string } } | null = null;
      for (let attempt = 0; attempt < 200 && !scaleDownEvent; attempt += 1) {
        await clock.tickAsync(50);
        if (spawnedChildId) {
          try {
            childProcessSupervisor.childrenIndex.updateState(spawnedChildId, "idle");
          } catch (error) {
            void error;
          }
        }
        const autoscalerRelaxResponse = await client.callTool({
          name: "events_subscribe",
          arguments: { from_seq: autoscalerCursor, cats: ["autoscaler"] },
        });
        expect(autoscalerRelaxResponse.isError ?? false).to.equal(false);
        const relaxContent = autoscalerRelaxResponse.structuredContent as {
          events: Array<{ data?: { msg?: string; child_id?: string } }>;
          next_seq: number | null;
        };
        autoscalerEventsLog.push(...relaxContent.events);
        autoscalerCursor = relaxContent.next_seq ?? autoscalerCursor;
        scaleDownEvent = autoscalerEventsLog.find((event) => event.data?.msg === "scale_down") ?? null;
      }

      expect(scaleDownEvent, "autoscaler should emit a scale_down event").to.not.equal(null);
      if (spawnedChildId) {
        expect(retiredChildren).to.include(spawnedChildId);
      }

      const cancelSecondRun = await client.callTool({
        name: "plan_cancel",
        arguments: { run_id: runIdScaleDown, reason: "autoscaler-e2e" },
      });
      expect(cancelSecondRun.isError ?? false).to.equal(false);

      const secondRunOutcome = await secondRunPromise;
      expect(secondRunOutcome.isError ?? false).to.equal(false);
      const autoscalerPhases = autoscalerEventsLog
        .map((event) => event.data?.msg)
        .filter((msg): msg is string => typeof msg === "string");
      expect(autoscalerPhases).to.include("scale_up");
      expect(autoscalerPhases).to.include("scale_down");

      const runEvents = await client.callTool({
        name: "events_subscribe",
        arguments: { from_seq: runEventsCursor, cats: ["bt_run"], run_id: runId },
      });
      expect(runEvents.isError ?? false).to.equal(false);
      const loopReconcilers = (runEvents.structuredContent as {
        events: Array<{ data?: { phase?: string; reconcilers?: Array<{ id?: string; status?: string }> } }>;
      }).events
        .filter((event) => event.data?.phase === "loop")
        .flatMap((event) => event.data?.reconcilers ?? []);
      const reconcilerIds = new Set(loopReconcilers.map((entry) => entry.id));
      expect(reconcilerIds.has("autoscaler")).to.equal(true);
      expect(reconcilerIds.has("supervisor")).to.equal(true);
      loopReconcilers
        .filter((entry) => entry.id === "autoscaler" || entry.id === "supervisor")
        .forEach((entry) => {
          expect(entry.status).to.equal("ok");
        });

      const statusSnapshot = await client.callTool({ name: "plan_status", arguments: { run_id: runId } });
      expect(statusSnapshot.isError ?? false).to.equal(false);
      const snapshotContent = statusSnapshot.structuredContent as { state: string; failure: { status: string | null } | null };
      expect(snapshotContent.state).to.equal("done");
      expect(snapshotContent.failure?.status ?? null).to.equal(null);
      expect(childProcessSupervisor.childrenIndex.list()).to.deep.equal([]);
    } finally {
      childProcessSupervisor.createChild = originalCreateChild;
      childProcessSupervisor.cancel = originalCancel;
      if (originalKill) {
        childProcessSupervisor.kill = originalKill;
      }
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
