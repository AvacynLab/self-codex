import { describe, it } from "mocha";
import { expect } from "chai";
import { rm } from "node:fs/promises";
import path from "node:path";
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
import { childWorkspacePath, resolveWithin } from "../src/paths.js";
import { resolveFixture, runnerArgs } from "./helpers/childRunner.js";
import { assertPlainObject, assertString, isPlainObject } from "./helpers/assertions.js";

/**
 * Integration scenarios ensuring plan orchestration tools publish correlated events retrievable via
 * the `events_subscribe` MCP tool. These tests exercise both Behaviour Tree executions and fan-out
 * orchestration so downstream clients can rely on consistent run/op/job identifiers when tailing
 * planner activity.
 */
describe("events subscribe plan correlation", () => {
  const mockRunnerPath = resolveFixture(import.meta.url, "./fixtures/mock-runner.ts");
  const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);
  const childrenRoot = process.env.MCP_CHILDREN_ROOT
    ? path.resolve(process.cwd(), process.env.MCP_CHILDREN_ROOT)
    : path.resolve(process.cwd(), "children");

  it("streams correlated BT and reactive plan events", async function () {
    this.timeout(10000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-plan-bt", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      configureRuntimeFeatures({ ...baselineFeatures, enableEventsBus: true });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-events" } });
      childProcessSupervisor.childrenIndex.restore({});

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent;
      assertPlainObject(baselineContent, "plan loop baseline events payload");
      const baselineNextSeq = baselineContent.next_seq;
      const cursor = typeof baselineNextSeq === "number" ? baselineNextSeq : 0;

      const btResponse = await client.callTool({
        name: "plan_run_bt",
        arguments: {
          tree: {
            id: "coverage-bt",
            root: { type: "task", id: "root", node_id: "root", tool: "noop", input_key: "payload" },
          },
          variables: { payload: { ping: "bt" } },
          run_id: "plan-bt-run",
          op_id: "plan-bt-op",
          job_id: "plan-bt-job",
          graph_id: "plan-bt-graph",
          node_id: "plan-bt-node",
        },
      });
      expect(btResponse.isError ?? false).to.equal(false);
      const btResult = btResponse.structuredContent as {
        run_id: string;
        op_id: string;
        job_id: string | null;
        graph_id: string | null;
        node_id: string | null;
      };

      const reactiveResponse = await client.callTool({
        name: "plan_run_reactive",
        arguments: {
          tree: {
            id: "coverage-reactive",
            root: { type: "task", id: "root", node_id: "root", tool: "noop", input_key: "payload" },
          },
          variables: { payload: { ping: "reactive" } },
          tick_ms: 10,
          timeout_ms: 250,
          run_id: "plan-reactive-run",
          op_id: "plan-reactive-op",
          job_id: "plan-reactive-job",
          graph_id: "plan-reactive-graph",
          node_id: "plan-reactive-node",
        },
      });
      expect(reactiveResponse.isError ?? false).to.equal(false);
      const reactiveResult = reactiveResponse.structuredContent as {
        run_id: string;
        op_id: string;
        job_id: string | null;
        graph_id: string | null;
        node_id: string | null;
      };

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["bt_run"],
        },
      });
      expect(eventsResponse.isError ?? false).to.equal(false);

      const structured = eventsResponse.structuredContent;
      assertPlainObject(structured, "plan correlation JSON payload");
      const rawEvents = Array.isArray(structured.events) ? structured.events : [];
      const btEvents = rawEvents.filter(
        (event): event is Record<string, unknown> => isPlainObject(event) && event.kind === "BT_RUN",
      );
      expect(btEvents.length).to.be.at.least(2);

      const btStart = btEvents.find(
        (event) => isPlainObject(event.data) && event.data.phase === "start" && event.data.mode === "bt",
      );
      expect(btStart, "Behaviour Tree start event should be present").to.not.equal(undefined);
      if (!btStart) {
        throw new Error("Behaviour Tree start event should be present");
      }
      expect(btStart.run_id).to.equal(btResult.run_id);
      expect(btStart.op_id).to.equal(btResult.op_id);
      expect(btStart.job_id).to.equal(btResult.job_id);
      expect(btStart.graph_id).to.equal(btResult.graph_id);
      expect(btStart.node_id).to.equal(btResult.node_id);

      const reactiveStart = btEvents.find(
        (event) => isPlainObject(event.data) && event.data.phase === "start" && event.data.mode === "reactive",
      );
      expect(reactiveStart, "Reactive loop start event should be present").to.not.equal(undefined);
      if (!reactiveStart) {
        throw new Error("Reactive loop start event should be present");
      }
      expect(reactiveStart.run_id).to.equal(reactiveResult.run_id);
      expect(reactiveStart.op_id).to.equal(reactiveResult.op_id);
      expect(reactiveStart.job_id).to.equal(reactiveResult.job_id);
      expect(reactiveStart.graph_id).to.equal(reactiveResult.graph_id);
      expect(reactiveStart.node_id).to.equal(reactiveResult.node_id);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("publishes reconcilers telemetry for reactive loop events", async function () {
    this.timeout(15000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-plan-reconcilers", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      // Enable the scheduler stack so the execution loop publishes reconcilers diagnostics.
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableEventsBus: true,
        enableReactiveScheduler: true,
        enablePlanLifecycle: true,
        enableBT: true,
        enableStigmergy: true,
        enableAutoscaler: true,
        enableSupervisor: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-loop-telemetry" } });
      childProcessSupervisor.childrenIndex.restore({});

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const runId = "plan-loop-run";
      const opId = "plan-loop-op";
      const graphId = "plan-loop-graph";
      const nodeId = "plan-loop-node";

      const reactiveResponse = await client.callTool({
        name: "plan_run_reactive",
        arguments: {
          tree: {
            id: "plan-loop-tree",
            root: { type: "task", id: "root", node_id: "root", tool: "noop", input_key: "payload" },
          },
          variables: { payload: { ping: "loop" } },
          tick_ms: 10,
          timeout_ms: 250,
          run_id: runId,
          op_id: opId,
          graph_id: graphId,
          node_id: nodeId,
        },
      });
      expect(reactiveResponse.isError ?? false).to.equal(false);

      const jsonlinesResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["bt_run"],
          format: "jsonlines",
        },
      });
      expect(jsonlinesResponse.isError ?? false).to.equal(false);

      const jsonlinesStructured = jsonlinesResponse.structuredContent;
      assertPlainObject(jsonlinesStructured, "plan loop JSON payload");
      const jsonlinesEvents = Array.isArray(jsonlinesStructured.events) ? jsonlinesStructured.events : [];
      const loopEvent = jsonlinesEvents.find(
        (event): event is Record<string, unknown> =>
          isPlainObject(event) && event.run_id === runId && isPlainObject(event.data) && event.data.phase === "loop",
      );
      expect(loopEvent, "Reactive loop event should be exposed via JSON Lines").to.not.equal(undefined);
      if (!loopEvent || !isPlainObject(loopEvent.data)) {
        throw new Error("Reactive loop event should be exposed via JSON Lines");
      }
      const reconcilers = Array.isArray(loopEvent.data.reconcilers)
        ? loopEvent.data.reconcilers.filter(isPlainObject)
        : [];
      expect(reconcilers.length, "At least one reconciler should be reported").to.be.greaterThan(0);
      for (const reconciler of reconcilers) {
        expect(typeof reconciler.id).to.equal("string");
        const status = reconciler.status;
        expect(typeof status === "string" && ["ok", "error"].includes(status)).to.equal(true);
        expect(typeof reconciler.duration_ms).to.equal("number");
        const errorValue = reconciler.error;
        expect(errorValue === null || typeof errorValue === "string").to.equal(true);
      }
      const reconcilerIds = reconcilers
        .map((entry) => (typeof entry.id === "string" ? entry.id : null))
        .filter((identifier): identifier is string => identifier !== null);
      expect(reconcilerIds).to.include("supervisor");
      expect(reconcilerIds).to.include("autoscaler");

      const sseResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["bt_run"],
          format: "sse",
        },
      });
      expect(sseResponse.isError ?? false).to.equal(false);
      const sseStructured = sseResponse.structuredContent;
      assertPlainObject(sseStructured, "plan loop SSE payload");
      assertString(sseStructured.stream, "plan loop SSE stream");

      // Decode every `data:` line to confirm the SSE format preserves reconcilers telemetry.
      const sseEvents = sseStructured.stream
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)));
      const sseLoop = sseEvents.find(
        (event): event is Record<string, unknown> =>
          isPlainObject(event) && event.run_id === runId && isPlainObject(event.data) && event.data.phase === "loop",
      );
      expect(sseLoop, "Reactive loop event should be serialised in SSE output").to.not.equal(undefined);
      if (!sseLoop || !isPlainObject(sseLoop.data)) {
        throw new Error("Reactive loop event should be serialised in SSE output");
      }
      expect(Array.isArray(sseLoop.data.reconcilers), "SSE payload should expose reconcilers").to.equal(true);
    } finally {
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("streams correlated events when reactive plans are paused and resumed", async function () {
    this.timeout(15000);

    const clock = sinon.useFakeTimers();
    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-plan-resume", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    let runPromise: ReturnType<Client["callTool"]> | null = null;

    try {
      configureRuntimeFeatures({
        ...baselineFeatures,
        enableEventsBus: true,
        enablePlanLifecycle: true,
        enableBT: true,
        enableReactiveScheduler: true,
        enableStigmergy: true,
      });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-resume" } });
      childProcessSupervisor.childrenIndex.restore({});

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const planArguments = {
        tree: {
          id: "plan-resume-tree",
          root: {
            type: "sequence",
            id: "plan-resume-seq",
            children: [
              { type: "task", id: "fetch", node_id: "fetch", tool: "noop", input_key: "fetch" },
              { type: "task", id: "deploy", node_id: "deploy", tool: "noop", input_key: "deploy" },
              { type: "task", id: "verify", node_id: "verify", tool: "noop", input_key: "verify" },
            ],
          },
        },
        variables: {
          fetch: { ref: "artifact" },
          deploy: { environment: "prod" },
          verify: { suite: "regression" },
        },
        tick_ms: 25,
        timeout_ms: 1000,
        run_id: "plan-resume-run",
        op_id: "plan-resume-op",
        job_id: "plan-resume-job",
        graph_id: "plan-resume-graph",
        node_id: "plan-resume-node",
      } as const;

      runPromise = client.callTool({ name: "plan_run_reactive", arguments: planArguments });

      // Allow the lifecycle registry to capture the start event before pausing the execution loop.
      await clock.tickAsync(0);

      const statusBefore = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(statusBefore.isError ?? false).to.equal(false);
      const beforeSnapshot = statusBefore.structuredContent as { state: string; last_event: { phase: string } | null };
      expect(beforeSnapshot.state).to.equal("running");
      expect(beforeSnapshot.last_event?.phase).to.equal("start");

      const pauseResponse = await client.callTool({ name: "plan_pause", arguments: { run_id: planArguments.run_id } });
      expect(pauseResponse.isError ?? false).to.equal(false);
      const pausedSnapshot = pauseResponse.structuredContent as { state: string; last_event: { phase: string } | null };
      expect(pausedSnapshot.state).to.equal("paused");
      expect(pausedSnapshot.last_event?.phase).to.equal("pause");

      await clock.tickAsync(100);
      const pausedStatus = await client.callTool({ name: "plan_status", arguments: { run_id: planArguments.run_id } });
      expect(pausedStatus.isError ?? false).to.equal(false);
      const pausedStatusSnapshot = pausedStatus.structuredContent as { state: string; progress: number };
      expect(pausedStatusSnapshot.state).to.equal("paused");

      const resumeResponse = await client.callTool({ name: "plan_resume", arguments: { run_id: planArguments.run_id } });
      expect(resumeResponse.isError ?? false).to.equal(false);
      const resumedSnapshot = resumeResponse.structuredContent as { state: string; last_event: { phase: string } | null };
      expect(resumedSnapshot.state).to.equal("running");
      expect(resumedSnapshot.last_event?.phase).to.equal("resume");

      await clock.tickAsync(100);

      const runResponse = await runPromise;
      expect(runResponse.isError ?? false).to.equal(false);
      const runContent = runResponse.structuredContent as {
        status: string;
        invocations: Array<{ tool: string; input: unknown }>;
      };
      expect(runContent.status).to.equal("success");
      expect(runContent.invocations).to.have.length(3);

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["bt_run"],
          run_id: planArguments.run_id,
        },
      });
      expect(eventsResponse.isError ?? false).to.equal(false);

      const structured = eventsResponse.structuredContent;
      assertPlainObject(structured, "plan resume events payload");
      const runEvents = (Array.isArray(structured.events) ? structured.events : []).filter(
        (event): event is Record<string, unknown> => isPlainObject(event) && event.run_id === planArguments.run_id,
      );
      expect(runEvents.some((event) => isPlainObject(event.data) && event.data.phase === "start")).to.equal(true);
      expect(runEvents.some((event) => isPlainObject(event.data) && event.data.phase === "complete")).to.equal(true);

      const nodeEvents = runEvents.filter((event) => isPlainObject(event.data) && event.data.phase === "node");
      const executedNodes = nodeEvents
        .map((event) => (isPlainObject(event.data) ? event.data.node_id : null))
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      const executedNodeSet = new Set(executedNodes);
      expect(executedNodeSet.has("fetch"), "fetch node should have executed").to.equal(true);
      expect(executedNodeSet.has("deploy"), "deploy node should have executed").to.equal(true);
      expect(executedNodeSet.has("verify"), "verify node should have executed").to.equal(true);

      const tickLifecycle = runEvents.find((event) => isPlainObject(event.data) && event.data.phase === "tick");
      expect(tickLifecycle, "tick event should be published").to.not.equal(undefined);
      if (!tickLifecycle || !isPlainObject(tickLifecycle.data)) {
        throw new Error("tick event should be published");
      }
      const tickPayload = isPlainObject(tickLifecycle.data.event_payload) ? tickLifecycle.data.event_payload : null;
      const tickBounds = tickPayload && isPlainObject(tickPayload.pheromone_bounds)
        ? tickPayload.pheromone_bounds
        : null;
      expect(tickBounds).to.not.equal(null);
      if (!tickBounds) {
        throw new Error("tick event should include pheromone bounds");
      }
      expect(tickBounds.min_intensity).to.equal(0);
      expect(tickBounds.max_intensity ?? null).to.equal(null);
    } finally {
      if (runPromise) {
        await runPromise.catch(() => {});
      }
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close();
      await server.close().catch(() => {});
      clock.restore();
    }
  });

  it("streams correlated plan fan-out events", async function () {
    this.timeout(20000);

    const baselineGraphSnapshot = graphState.serialize();
    const baselineChildrenIndex = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "events-subscribe-plan-fanout", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const plannedChildren: string[] = [];

    try {
      configureRuntimeFeatures({ ...baselineFeatures, enableEventsBus: true });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-fanout" } });
      childProcessSupervisor.childrenIndex.restore({});

      const baselineResponse = await client.callTool({ name: "events_subscribe", arguments: { limit: 1 } });
      expect(baselineResponse.isError ?? false).to.equal(false);
      const baselineContent = baselineResponse.structuredContent as { next_seq: number | null };
      const cursor = baselineContent?.next_seq ?? 0;

      const hints = {
        run_id: "plan-fanout-run",
        op_id: "plan-fanout-op",
        job_id: "plan-fanout-job",
        graph_id: "plan-fanout-graph",
        node_id: "plan-fanout-node",
        child_id: "plan-fanout-parent",
      } as const;

      const fanoutResponse = await client.callTool({
        name: "plan_fanout",
        arguments: {
          goal: "Collect plan coverage",
          prompt_template: {
            system: "Tu es {{child_name}} et tu aides au scenario planifié.",
            user: "Objectif: {{goal}}",
          },
          children_spec: {
            list: [
              {
                name: "scout",
                command: process.execPath,
                args: mockRunnerArgs("--role", "scout"),
                metadata: { origin: "plan-coverage" },
              },
            ],
          },
          parallelism: 1,
          retry: { max_attempts: 1, delay_ms: 0 },
          ...hints,
        },
      });
      expect(fanoutResponse.isError ?? false).to.equal(false);
      const fanoutResult = fanoutResponse.structuredContent as {
        run_id: string;
        op_id: string;
        job_id: string;
        graph_id: string | null;
        node_id: string | null;
        child_id: string | null;
        child_ids: string[];
      };
      plannedChildren.push(...fanoutResult.child_ids);

      const eventsResponse = await client.callTool({
        name: "events_subscribe",
        arguments: {
          from_seq: cursor,
          cats: ["plan"],
        },
      });
      expect(eventsResponse.isError ?? false).to.equal(false);

      const structured = eventsResponse.structuredContent;
      assertPlainObject(structured, "plan fan-out events payload");
      const planEvent = (Array.isArray(structured.events) ? structured.events : []).find(
        (event): event is Record<string, unknown> => isPlainObject(event) && event.kind === "PLAN",
      );
      expect(planEvent, "PLAN fan-out event should be present").to.not.equal(undefined);
      if (!planEvent) {
        throw new Error("PLAN fan-out event should be present");
      }
      expect(planEvent.run_id).to.equal(hints.run_id);
      expect(planEvent.op_id).to.equal(hints.op_id);
      expect(planEvent.job_id).to.equal(hints.job_id);
      expect(planEvent.graph_id).to.equal(hints.graph_id);
      expect(planEvent.node_id).to.equal(hints.node_id);
      expect(planEvent.child_id).to.equal(hints.child_id);

      const payload = isPlainObject(planEvent.data) ? planEvent.data : {};
      const children = Array.isArray(payload.children)
        ? payload.children.filter(isPlainObject)
        : [];
      expect(children, "fan-out event should list planned children").to.be.an("array");
      expect(children.length).to.equal(1);
      expect(children[0]?.name).to.equal("scout");
      expect(Array.isArray(payload.rejected)).to.equal(true);
    } finally {
      for (const childId of plannedChildren) {
        await client.callTool({ name: "child_kill", arguments: { child_id: childId, timeout_ms: 500 } }).catch(() => {});
        await client.callTool({ name: "child_gc", arguments: { child_id: childId } }).catch(() => {});
        await rm(childWorkspacePath(childrenRoot, childId), { recursive: true, force: true }).catch(() => {});
      }
      await rm(resolveWithin(childrenRoot, "plan-fanout-run"), { recursive: true, force: true }).catch(() => {});

      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.childrenIndex.restore(baselineChildrenIndex);
      graphState.resetFromSnapshot(baselineGraphSnapshot);
      await childProcessSupervisor.disposeAll().catch(() => {});
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
