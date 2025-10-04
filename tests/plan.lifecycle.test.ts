import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  server,
  graphState,
  childSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
} from "../src/server.js";
import {
  PlanLifecycleRegistry,
  PlanLifecycleCompletedError,
  PlanLifecycleUnsupportedError,
} from "../src/executor/planLifecycle.js";

/** Unit coverage for the lifecycle registry to guard manual pause/resume semantics. */
describe("PlanLifecycleRegistry", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("rejects resuming runs that already completed", async () => {
    const registry = new PlanLifecycleRegistry({ clock: () => clock.now });
    registry.registerRun({ runId: "run", opId: "op", mode: "reactive" });
    registry.attachControls("run", { pause: async () => true, resume: async () => true });
    registry.recordEvent("run", { phase: "complete", payload: {}, timestamp: clock.now });

    try {
      await registry.resume("run");
      expect.fail("resume should fail once the run completed");
    } catch (error) {
      expect(error).to.be.instanceOf(PlanLifecycleCompletedError);
    }
  });

  it("errors when pausing runs that do not expose controls", async () => {
    const registry = new PlanLifecycleRegistry({ clock: () => clock.now });
    registry.registerRun({ runId: "run", opId: "op", mode: "bt" });

    try {
      await registry.pause("run");
      expect.fail("pause should require registered controls");
    } catch (error) {
      expect(error).to.be.instanceOf(PlanLifecycleUnsupportedError);
    }
  });
});

/**
 * Integration scenarios asserting that plan lifecycle tools can pause, resume and inspect
 * reactive Behaviour Tree executions without losing progress information.
 */
describe("plan lifecycle", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("pauses and resumes reactive plan runs", async function () {
    this.timeout(10000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-lifecycle-client", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enablePlanLifecycle: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-lifecycle" } });
      childSupervisor.childrenIndex.restore({});

      const planArguments = {
        tree: {
          id: "plan-lifecycle-tree",
          root: { type: "task", id: "noop", node_id: "noop", tool: "noop", input_key: "payload" },
        },
        variables: { payload: { scenario: "plan-lifecycle" } },
        tick_ms: 50,
        timeout_ms: 1000,
        run_id: "plan-lifecycle-run",
        op_id: "plan-lifecycle-op",
      } as const;

      const runPromise = client.callTool({ name: "plan_run_reactive", arguments: planArguments });

      // Allow the server to register the lifecycle run without advancing ticks.
      await clock.tickAsync(0);

      const statusBefore = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(statusBefore.isError ?? false).to.equal(false);
      const beforeSnapshot = statusBefore.structuredContent as {
        run_id: string;
        state: string;
        progress: number;
      };
      expect(beforeSnapshot.state).to.equal("running");
      expect(beforeSnapshot.progress).to.equal(0);

      const pauseResponse = await client.callTool({ name: "plan_pause", arguments: { run_id: planArguments.run_id } });
      expect(pauseResponse.isError ?? false).to.equal(false);
      const pausedSnapshot = pauseResponse.structuredContent as {
        state: string;
        supports_resume: boolean;
        progress: number;
      };
      expect(pausedSnapshot.state).to.equal("paused");
      expect(pausedSnapshot.supports_resume).to.equal(true);

      // Ensure no progress occurs while the run is paused.
      await clock.tickAsync(100);
      const pausedStatus = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(pausedStatus.isError ?? false).to.equal(false);
      const pausedStatusSnapshot = pausedStatus.structuredContent as { state: string; progress: number };
      expect(pausedStatusSnapshot.state).to.equal("paused");
      expect(pausedStatusSnapshot.progress).to.equal(pausedSnapshot.progress);

      const resumeResponse = await client.callTool({ name: "plan_resume", arguments: { run_id: planArguments.run_id } });
      expect(resumeResponse.isError ?? false).to.equal(false);
      const resumedSnapshot = resumeResponse.structuredContent as { state: string };
      expect(resumedSnapshot.state).to.equal("running");

      await clock.tickAsync(50);
      const runResponse = await runPromise;
      expect(runResponse.isError ?? false).to.equal(false);
      const runContent = runResponse.structuredContent as { status: string };
      expect(runContent.status).to.equal("success");

      const finalStatus = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(finalStatus.isError ?? false).to.equal(false);
      const finalSnapshot = finalStatus.structuredContent as { state: string; progress: number };
      expect(finalSnapshot.state).to.equal("done");
      expect(finalSnapshot.progress).to.equal(100);

      const resumeAfterDone = await client.callTool({
        name: "plan_resume",
        arguments: { run_id: planArguments.run_id },
      });
      expect(resumeAfterDone.isError ?? false).to.equal(true);
      const resumePayload = JSON.parse(resumeAfterDone.content?.[0]?.text ?? "{}");
      expect(resumePayload.error).to.equal("E-PLAN-COMPLETED");
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      childSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it("supports pausing and resuming reactive plans with multiple nodes", async function () {
    this.timeout(10000);

    // Capture the current orchestrator state so the scenario can restore it after execution.
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-lifecycle-multi-node", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Track the asynchronous run promise so the cleanup step can await it when errors occur.
    let runPromise: ReturnType<Client["callTool"]> | null = null;

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enablePlanLifecycle: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-lifecycle" } });
      childSupervisor.childrenIndex.restore({});

      const planArguments = {
        tree: {
          id: "plan-lifecycle-multi",
          root: {
            type: "sequence",
            id: "seq-root",
            children: [
              { type: "task", id: "fetch", node_id: "fetch", tool: "noop", input_key: "fetch" },
              { type: "task", id: "deploy", node_id: "deploy", tool: "noop", input_key: "deploy" },
              { type: "task", id: "verify", node_id: "verify", tool: "noop", input_key: "verify" },
            ],
          },
        },
        variables: {
          fetch: { ref: "artifact" },
          deploy: { environment: "staging" },
          verify: { suite: "smoke" },
        },
        tick_ms: 25,
        timeout_ms: 1000,
        run_id: "plan-lifecycle-multi-run",
        op_id: "plan-lifecycle-multi-op",
      } as const;

      runPromise = client.callTool({ name: "plan_run_reactive", arguments: planArguments });

      // Allow the registry to record the run before issuing lifecycle operations.
      await clock.tickAsync(0);

      const statusBefore = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(statusBefore.isError ?? false).to.equal(false);
      const beforeSnapshot = statusBefore.structuredContent as {
        run_id: string;
        state: string;
        progress: number;
        last_event: { phase: string } | null;
      };
      expect(beforeSnapshot.state).to.equal("running");
      expect(beforeSnapshot.last_event?.phase).to.equal("start");

      const pauseResponse = await client.callTool({ name: "plan_pause", arguments: { run_id: planArguments.run_id } });
      expect(pauseResponse.isError ?? false).to.equal(false);
      const pausedSnapshot = pauseResponse.structuredContent as {
        state: string;
        supports_resume: boolean;
        progress: number;
        last_event: { phase: string } | null;
      };
      expect(pausedSnapshot.state).to.equal("paused");
      expect(pausedSnapshot.supports_resume).to.equal(true);
      expect(pausedSnapshot.last_event?.phase).to.equal("pause");
      expect(pausedSnapshot.progress).to.equal(0);

      // Advance fake time while paused to ensure no progress occurs before resuming.
      await clock.tickAsync(100);
      const pausedStatus = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(pausedStatus.isError ?? false).to.equal(false);
      const pausedStatusSnapshot = pausedStatus.structuredContent as { state: string; progress: number };
      expect(pausedStatusSnapshot.state).to.equal("paused");
      expect(pausedStatusSnapshot.progress).to.equal(pausedSnapshot.progress);

      const resumeResponse = await client.callTool({ name: "plan_resume", arguments: { run_id: planArguments.run_id } });
      expect(resumeResponse.isError ?? false).to.equal(false);
      const resumedSnapshot = resumeResponse.structuredContent as { state: string; last_event: { phase: string } | null };
      expect(resumedSnapshot.state).to.equal("running");
      expect(resumedSnapshot.last_event?.phase).to.equal("resume");

      // Let the execution loop process the queued Behaviour Tree ticks.
      await clock.tickAsync(50);

      const runResponse = await runPromise;
      expect(runResponse.isError ?? false).to.equal(false);
      const runContent = runResponse.structuredContent as {
        status: string;
        invocations: Array<{ tool: string }>;
      };
      expect(runContent.status).to.equal("success");
      expect(runContent.invocations.map((entry) => entry.tool)).to.deep.equal([
        "noop",
        "noop",
        "noop",
      ]);

      const finalStatus = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(finalStatus.isError ?? false).to.equal(false);
      const finalSnapshot = finalStatus.structuredContent as { state: string; progress: number };
      expect(finalSnapshot.state).to.equal("done");
      expect(finalSnapshot.progress).to.equal(100);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      childSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      if (runPromise) {
        await runPromise.catch(() => {});
      }
    }
  });
});
