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
} from "../../src/server.js";

/**
 * Integration regression ensuring reactive plan runs honour pause/resume commands and preserve
 * their progress snapshots while fake timers advance. The scenario spins up the MCP server over an
 * in-memory transport, executes a minimal behaviour tree, and validates that lifecycle endpoints
 * report consistent state transitions.
 */
describe("plan pause & resume integration", () => {
  let clock: sinon.SinonFakeTimers;
  let baselineGraphSnapshot: ReturnType<typeof graphState.serialize>;
  let baselineChildrenSnapshot: ReturnType<typeof childProcessSupervisor.childrenIndex.serialize>;
  let baselineFeatures: ReturnType<typeof getRuntimeFeatures>;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    baselineGraphSnapshot = graphState.serialize();
    baselineChildrenSnapshot = childProcessSupervisor.childrenIndex.serialize();
    baselineFeatures = getRuntimeFeatures();
  });

  afterEach(async () => {
    clock.restore();
    configureRuntimeFeatures(baselineFeatures);
    graphState.resetFromSnapshot(baselineGraphSnapshot);
    childProcessSupervisor.childrenIndex.restore(baselineChildrenSnapshot);
    await server.close().catch(() => {});
  });

  it("pauses and resumes a reactive behaviour tree run", async function () {
    this.timeout(10_000);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plan-pause-resume", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    configureRuntimeFeatures({
      ...baselineFeatures,
      enableBT: true,
      enableReactiveScheduler: true,
      enableStigmergy: true,
      enablePlanLifecycle: true,
    });
    graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "plan-pause" } });
    childProcessSupervisor.childrenIndex.restore({});

    const planArguments = {
      tree: {
        id: "plan-pause-tree",
        root: { type: "task", id: "noop", node_id: "noop", tool: "noop", input_key: "payload" },
      },
      variables: { payload: { stage: "pause-resume" } },
      tick_ms: 20,
      timeout_ms: 200,
      run_id: "plan-pause-run",
      op_id: "plan-pause-op",
    } as const;

    const runPromise = client.callTool({ name: "plan_run_reactive", arguments: planArguments });

    await clock.tickAsync(0);

    const statusBefore = await client.callTool({
      name: "plan_status",
      arguments: { run_id: planArguments.run_id },
    });
    expect(statusBefore.isError ?? false).to.equal(false);
    const beforeSnapshot = statusBefore.structuredContent as { state: string; progress: number };
    expect(beforeSnapshot.state).to.equal("running");

    const pauseResponse = await client.callTool({
      name: "plan_pause",
      arguments: { run_id: planArguments.run_id },
    });
    expect(pauseResponse.isError ?? false).to.equal(false);
    const pauseSnapshot = pauseResponse.structuredContent as { state: string; supports_resume: boolean; progress: number };
    expect(pauseSnapshot.state).to.equal("paused");
    expect(pauseSnapshot.supports_resume).to.equal(true);

    await clock.tickAsync(60);
    const pausedStatus = await client.callTool({
      name: "plan_status",
      arguments: { run_id: planArguments.run_id },
    });
    expect(pausedStatus.isError ?? false).to.equal(false);
    const pausedSnapshot = pausedStatus.structuredContent as { state: string; progress: number };
    expect(pausedSnapshot.state).to.equal("paused");
    expect(pausedSnapshot.progress).to.equal(pauseSnapshot.progress);

    const resumeResponse = await client.callTool({
      name: "plan_resume",
      arguments: { run_id: planArguments.run_id },
    });
    expect(resumeResponse.isError ?? false).to.equal(false);
    const resumedSnapshot = resumeResponse.structuredContent as { state: string };
    expect(resumedSnapshot.state).to.equal("running");

    await clock.tickAsync(40);
    const runResult = await runPromise;
    expect(runResult.isError ?? false).to.equal(false);
    const runContent = runResult.structuredContent as { status: string };
    expect(runContent.status).to.equal("success");

    const finalStatus = await client.callTool({
      name: "plan_status",
      arguments: { run_id: planArguments.run_id },
    });
    expect(finalStatus.isError ?? false).to.equal(false);
    const finalSnapshot = finalStatus.structuredContent as { state: string; progress: number };
    expect(finalSnapshot.state).to.equal("done");
    expect(finalSnapshot.progress).to.equal(100);

    await client.close().catch(() => {});
  });
});
