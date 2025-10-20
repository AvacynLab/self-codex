import { describe, it, beforeEach, afterEach } from "mocha";
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
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-lifecycle-client", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // Désactive la fonctionnalité lifecycle pour vérifier la dégradation à null des champs progress/lifecycle.
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enablePlanLifecycle: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-lifecycle" } });
      childProcessSupervisor.childrenIndex.restore({});

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
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it("supports pausing and resuming reactive plans with multiple nodes", async function () {
    this.timeout(10000);

    // Capture the current orchestrator state so the scenario can restore it after execution.
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-lifecycle-multi-node", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Track the asynchronous run promise so the cleanup step can await it when errors occur.
    let runPromise: ReturnType<Client["callTool"]> | null = null;

    try {
      // Active la fonctionnalité lifecycle afin que op_cancel puisse relayer le snapshot de progression.
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enablePlanLifecycle: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-lifecycle" } });
      childProcessSupervisor.childrenIndex.restore({});

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
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      if (runPromise) {
        await runPromise.catch(() => {});
      }
    }
  });

  it("returns lifecycle progress snapshots when plan_cancel aborts a running plan", async function () {
    this.timeout(10000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-cancel-progress-client", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const planArguments = {
      tree: {
        id: "plan-cancel-progress-tree",
        root: {
          type: "retry",
          id: "retry-root",
          max_attempts: 50,
          backoff_ms: 500,
          child: {
            type: "guard",
            id: "guard-node",
            condition_key: "allow",
            expected: true,
            child: {
              type: "task",
              id: "noop-node",
              node_id: "noop-node",
              tool: "noop",
              input_key: "payload",
            },
          },
        },
      },
      variables: { allow: false, payload: { attempt: 1 } },
      tick_ms: 25,
      timeout_ms: 5_000,
      run_id: "plan-cancel-progress-run",
      op_id: "plan-cancel-progress-op",
    } as const;

    let runPromise: ReturnType<Client["callTool"]> | null = null;
    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enableCancellation: true,
        enablePlanLifecycle: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-cancel" } });
      childProcessSupervisor.childrenIndex.restore({});

      runPromise = client.callTool({ name: "plan_run_reactive", arguments: planArguments });

      // Allow the lifecycle registry to register the run before querying status.
      await clock.tickAsync(0);

      const statusBefore = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(statusBefore.isError ?? false).to.equal(false);
      const beforeSnapshot = statusBefore.structuredContent as { state: string; progress: number };
      expect(beforeSnapshot.state).to.equal("running");
      expect(beforeSnapshot.progress).to.equal(0);

      // Advance the scheduler slightly so ticks accumulate before the cancellation request.
      await clock.tickAsync(50);

      const cancelResponse = await client.callTool({
        name: "plan_cancel",
        arguments: { run_id: planArguments.run_id, reason: "test-progress" },
      });
      expect(cancelResponse.isError ?? false).to.equal(false);
      const cancelContent = cancelResponse.structuredContent as {
        run_id: string;
        progress: number | null;
        lifecycle: { state: string; progress: number; failure: { reason: string | null } | null } | null;
        operations: Array<{ op_id: string; outcome: string }>;
      };
      expect(cancelContent.run_id).to.equal(planArguments.run_id);
      expect(cancelContent.operations).to.have.lengthOf(1);
      expect(cancelContent.operations[0]?.op_id).to.equal(planArguments.op_id);
      expect(cancelContent.operations[0]?.outcome).to.equal("requested");
      expect(cancelContent.progress).to.equal(100);
      expect(cancelContent.lifecycle?.state).to.equal("failed");
      expect(cancelContent.lifecycle?.progress).to.equal(100);
      expect(cancelContent.lifecycle?.failure?.reason).to.equal("test-progress");

      await clock.tickAsync(50);

      const runResult = await runPromise;
      expect(runResult.isError ?? false).to.equal(true);
      const runPayload = JSON.parse(runResult.content?.[0]?.text ?? "{}");
      expect(runPayload.error).to.equal("E-CANCEL-OP");
      expect(runPayload.details?.reason).to.equal("test-progress");

      const finalStatus = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(finalStatus.isError ?? false).to.equal(false);
      const finalSnapshot = finalStatus.structuredContent as {
        state: string;
        progress: number;
        failure: { reason: string | null } | null;
      };
      expect(finalSnapshot.state).to.equal("failed");
      expect(finalSnapshot.progress).to.equal(100);
      expect(finalSnapshot.failure?.reason).to.equal("test-progress");
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      if (runPromise) {
        await runPromise.catch(() => {});
      }
    }
  });

  it("degrades gracefully when plan_cancel runs without lifecycle snapshots", async function () {
    this.timeout(10000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-cancel-no-lifecycle", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const planArguments = {
      tree: {
        id: "plan-cancel-no-lifecycle-tree",
        root: {
          type: "retry",
          id: "retry-no-lifecycle",
          max_attempts: 10,
          backoff_ms: 250,
          child: {
            type: "guard",
            id: "guard-no-lifecycle",
            condition_key: "allow",
            expected: true,
            child: {
              type: "task",
              id: "noop-node",
              node_id: "noop-node",
              tool: "noop",
              input_key: "payload",
            },
          },
        },
      },
      variables: { allow: false, payload: { attempt: 1 } },
      tick_ms: 25,
      timeout_ms: 5_000,
      run_id: "plan-cancel-no-lifecycle-run",
      op_id: "plan-cancel-no-lifecycle-op",
    } as const;

    let runPromise: ReturnType<Client["callTool"]> | null = null;

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enableCancellation: true,
        enablePlanLifecycle: false,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-cancel-no-lifecycle" } });
      childProcessSupervisor.childrenIndex.restore({});

      runPromise = client.callTool({ name: "plan_run_reactive", arguments: planArguments });

      await clock.tickAsync(0);
      await clock.tickAsync(50);

      const cancelResponse = await client.callTool({
        name: "plan_cancel",
        arguments: { run_id: planArguments.run_id, reason: "no-lifecycle" },
      });
      expect(cancelResponse.isError ?? false).to.equal(false);
      const cancelContent = cancelResponse.structuredContent as {
        run_id: string;
        operations: Array<{ op_id: string; outcome: string }>;
        progress: number | null;
        lifecycle: unknown;
      };
      expect(cancelContent.run_id).to.equal(planArguments.run_id);
      expect(cancelContent.operations).to.have.lengthOf(1);
      expect(cancelContent.operations[0]?.op_id).to.equal(planArguments.op_id);
      expect(cancelContent.progress).to.equal(null);
      expect(cancelContent.lifecycle).to.equal(null);

      await clock.tickAsync(50);

      const runResult = await runPromise;
      expect(runResult.isError ?? false).to.equal(true);
      const runPayload = JSON.parse(runResult.content?.[0]?.text ?? "{}");
      expect(runPayload.error).to.equal("E-CANCEL-OP");
      expect(runPayload.details?.reason).to.equal("no-lifecycle");
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      if (runPromise) {
        await runPromise.catch(() => {});
      }
    }
  });

  it("returns lifecycle progress when op_cancel aborts a running plan", async function () {
    this.timeout(10000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "op-cancel-progress-client", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const planArguments = {
      tree: {
        id: "op-cancel-progress-tree",
        root: {
          type: "retry",
          id: "retry-op-cancel",
          max_attempts: 25,
          backoff_ms: 500,
          child: {
            type: "guard",
            id: "guard-op-cancel",
            condition_key: "allow",
            expected: true,
            child: {
              type: "task",
              id: "noop-node",
              node_id: "noop-node",
              tool: "noop",
              input_key: "payload",
            },
          },
        },
      },
      variables: { allow: false, payload: { attempt: 1 } },
      tick_ms: 25,
      timeout_ms: 5_000,
      run_id: "op-cancel-progress-run",
      op_id: "op-cancel-progress-op",
    } as const;

    let runPromise: ReturnType<Client["callTool"]> | null = null;

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enableCancellation: true,
        enablePlanLifecycle: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "op-cancel" } });
      childProcessSupervisor.childrenIndex.restore({});

      runPromise = client.callTool({ name: "plan_run_reactive", arguments: planArguments });

      await clock.tickAsync(0);
      await clock.tickAsync(50);

      const cancelResponse = await client.callTool({
        name: "op_cancel",
        arguments: { op_id: planArguments.op_id, reason: "op-cancel-test" },
      });
      expect(cancelResponse.isError ?? false).to.equal(false);
      const cancelContent = cancelResponse.structuredContent as {
        ok: boolean;
        op_id: string;
        outcome: string;
        run_id: string | null;
        progress: number | null;
        lifecycle: { state: string; progress: number; failure: { reason: string | null } | null } | null;
      };
      expect(cancelContent.ok).to.equal(true);
      expect(cancelContent.op_id).to.equal(planArguments.op_id);
      expect(cancelContent.run_id).to.equal(planArguments.run_id);
      expect(cancelContent.progress).to.equal(100);
      expect(cancelContent.lifecycle?.state).to.equal("failed");
      expect(cancelContent.lifecycle?.progress).to.equal(100);
      expect(cancelContent.lifecycle?.failure?.reason).to.equal("op-cancel-test");

      await clock.tickAsync(50);

      const runResult = await runPromise;
      expect(runResult.isError ?? false).to.equal(true);
      const runPayload = JSON.parse(runResult.content?.[0]?.text ?? "{}");
      expect(runPayload.error).to.equal("E-CANCEL-OP");
      expect(runPayload.details?.reason).to.equal("op-cancel-test");
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      if (runPromise) {
        await runPromise.catch(() => {});
      }
    }
  });

  it("surfaces E-CANCEL-NOTFOUND when op_cancel targets an unknown operation", async function () {
    this.timeout(5000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "op-cancel-notfound-client", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableCancellation: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "op-cancel-notfound" } });
      childProcessSupervisor.childrenIndex.restore({});

      const response = await client.callTool({
        name: "op_cancel",
        arguments: { op_id: "missing-op", reason: "verif" },
      });

      expect(response.isError ?? false).to.equal(true);
      const payload = JSON.parse(response.content?.[0]?.text ?? "{}");
      // Ensure the error payload mirrors the documented `{ ok:false }` contract for MCP clients.
      expect(payload.ok).to.equal(false);
      expect(payload.error).to.equal("E-CANCEL-NOTFOUND");
      expect(payload.message).to.equal("unknown opId");
      expect(payload.hint).to.equal("verify opId via events_subscribe");
      expect(payload.details).to.deep.equal({ opId: "missing-op" });
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it("catches up lifecycle snapshots when the feature is re-enabled mid-run", async function () {
    this.timeout(10000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-lifecycle-reactivation", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enablePlanLifecycle: false,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-lifecycle-reactivation" } });
      childProcessSupervisor.childrenIndex.restore({});

      const planArguments = {
        tree: {
          id: "plan-lifecycle-reactivation-tree",
          root: { type: "task", id: "noop", node_id: "noop", tool: "noop", input_key: "payload" },
        },
        variables: { payload: { scenario: "plan-lifecycle-reactivation" } },
        tick_ms: 50,
        timeout_ms: 1000,
        run_id: "plan-lifecycle-reactivation-run",
        op_id: "plan-lifecycle-reactivation-op",
      } as const;

      const runPromise = client.callTool({ name: "plan_run_reactive", arguments: planArguments });

      // Allow the reactive loop to bootstrap without executing ticks yet.
      await clock.tickAsync(0);

      // Re-enable the lifecycle feature while the run remains active.
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
        enablePlanLifecycle: true,
      });

      const statusAfterEnable = await client.callTool({
        name: "plan_status",
        arguments: { run_id: planArguments.run_id },
      });
      expect(statusAfterEnable.isError ?? false).to.equal(false);
      const runningSnapshot = statusAfterEnable.structuredContent as { state: string; progress: number };
      expect(runningSnapshot.state).to.equal("running");
      expect(runningSnapshot.progress).to.equal(0);

      const pauseResponse = await client.callTool({
        name: "plan_pause",
        arguments: { run_id: planArguments.run_id },
      });
      expect(pauseResponse.isError ?? false).to.equal(false);
      const pausedSnapshot = pauseResponse.structuredContent as { state: string; supports_resume: boolean };
      expect(pausedSnapshot.state).to.equal("paused");
      expect(pausedSnapshot.supports_resume).to.equal(true);

      const pausedStatus = await client.callTool({
        name: "plan_status",
        arguments: { run_id: planArguments.run_id },
      });
      expect(pausedStatus.isError ?? false).to.equal(false);
      const pausedStatusSnapshot = pausedStatus.structuredContent as { state: string };
      expect(pausedStatusSnapshot.state).to.equal("paused");

      const resumeResponse = await client.callTool({
        name: "plan_resume",
        arguments: { run_id: planArguments.run_id },
      });
      expect(resumeResponse.isError ?? false).to.equal(false);
      const resumedSnapshot = resumeResponse.structuredContent as { state: string };
      expect(resumedSnapshot.state).to.equal("running");

      await clock.tickAsync(50);
      const runResponse = await runPromise;
      expect(runResponse.isError ?? false).to.equal(false);
      const runContent = runResponse.structuredContent as { status: string };
      expect(runContent.status).to.equal("success");

      const finalStatus = await client.callTool({
        name: "plan_status",
        arguments: { run_id: planArguments.run_id },
      });
      expect(finalStatus.isError ?? false).to.equal(false);
      const finalSnapshot = finalStatus.structuredContent as { state: string; progress: number };
      expect(finalSnapshot.state).to.equal("done");
      expect(finalSnapshot.progress).to.equal(100);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it("surfaces explicit lifecycle-disabled errors for status and pause/resume requests", async function () {
    this.timeout(10000);

    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-lifecycle-disabled-client", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // Désactive explicitement le registre lifecycle pour vérifier que les outils
      // de statut/pause/resume signalent l'erreur dédiée et orientent l'opérateur
      // vers le flag à activer.
      configureRuntimeFeatures({
        ...baselineFeatures,
        enablePlanLifecycle: false,
      });

      const statusResponse = await client.callTool({ name: "plan_status", arguments: { run_id: "missing" } });
      expect(statusResponse.isError ?? false).to.equal(true);
      const statusPayload = JSON.parse(statusResponse.content?.[0]?.text ?? "{}");
      expect(statusPayload.error).to.equal("E-PLAN-LIFECYCLE-DISABLED");
      expect(statusPayload.hint).to.equal("enable_plan_lifecycle");

      const pauseResponse = await client.callTool({ name: "plan_pause", arguments: { run_id: "missing" } });
      expect(pauseResponse.isError ?? false).to.equal(true);
      const pausePayload = JSON.parse(pauseResponse.content?.[0]?.text ?? "{}");
      expect(pausePayload.error).to.equal("E-PLAN-LIFECYCLE-DISABLED");
      expect(pausePayload.hint).to.equal("enable_plan_lifecycle");

      const resumeResponse = await client.callTool({ name: "plan_resume", arguments: { run_id: "missing" } });
      expect(resumeResponse.isError ?? false).to.equal(true);
      const resumePayload = JSON.parse(resumeResponse.content?.[0]?.text ?? "{}");
      expect(resumePayload.error).to.equal("E-PLAN-LIFECYCLE-DISABLED");
      expect(resumePayload.hint).to.equal("enable_plan_lifecycle");
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
