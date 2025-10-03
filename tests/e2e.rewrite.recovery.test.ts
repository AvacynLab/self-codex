import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import type { ChildRuntimeMessage } from "../src/childRuntime.js";
import type { ChildRecordSnapshot } from "../src/state/childrenIndex.js";
import type { ChildMessageStreamResult, SendResult } from "../src/childSupervisor.js";
import type { ChildSupervisor } from "../src/childSupervisor.js";
import { ChildSendInputSchema, handleChildSend } from "../src/tools/childTools.js";
import type { ChildToolContext } from "../src/tools/childTools.js";
import { LoopDetector } from "../src/guard/loopDetector.js";
import {
  OrchestratorSupervisor,
  type SupervisorIncident,
  type SupervisorChildManager,
} from "../src/agents/supervisor.js";
import type { HierGraph } from "../src/graph/hierarchy.js";
import { compileHierGraphToBehaviorTree } from "../src/executor/bt/compiler.js";
import { BehaviorTreeInterpreter, buildBehaviorTree } from "../src/executor/bt/interpreter.js";
import type { BehaviorTickResult } from "../src/executor/bt/types.js";
import type { GraphDescriptorPayload } from "../src/tools/graphTools.js";
import { GraphRewriteApplyInputSchema, handleGraphRewriteApply } from "../src/tools/graphTools.js";
import type { GraphAttributeValue } from "../src/graph/types.js";

/**
 * Lightweight supervisor double that keeps enough state for the rewrite
 * scenario. The stub records every message exchange so the loop detector can
 * raise warnings and drive rewrite requests through the orchestrator supervisor.
 */
class LoopingChildSupervisorStub implements SupervisorChildManager {
  public readonly childId = "child-loop";
  private readonly baseSnapshot: ChildRecordSnapshot;
  private readonly messages: ChildRuntimeMessage[] = [];
  private sequence = 0;

  constructor(private readonly clock: sinon.SinonFakeTimers) {
    const now = clock.now;
    this.baseSnapshot = {
      childId: this.childId,
      pid: 4242,
      workdir: `/tmp/${this.childId}`,
      state: "running",
      startedAt: now,
      lastHeartbeatAt: now,
      retries: 0,
      metadata: { job_id: "rewrite-job", task: "analysis" },
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      forcedTermination: false,
      stopReason: null,
      role: "analyst",
      limits: null,
      attachedAt: null,
    };
  }

  private snapshot(): ChildRecordSnapshot {
    return {
      ...this.baseSnapshot,
      lastHeartbeatAt: this.clock.now,
    };
  }

  public readonly childrenIndex = {
    list: (): ChildRecordSnapshot[] => [this.snapshot()],
    getChild: (childId: string): ChildRecordSnapshot | undefined =>
      childId === this.childId ? this.snapshot() : undefined,
  };

  stream(childId: string, options?: { limit?: number }): ChildMessageStreamResult {
    if (childId !== this.childId) {
      throw new Error(`unexpected child ${childId}`);
    }
    const totalMessages = this.messages.length;
    const limit = options?.limit ?? totalMessages;
    const slice = this.messages.slice(-limit);
    return {
      childId,
      totalMessages,
      matchedMessages: slice.length,
      hasMore: false,
      nextCursor: null,
      messages: slice.map((message) => ({ ...message })),
    };
  }

  getAllowedTools(): readonly string[] {
    return [];
  }

  async send(childId: string, _payload: unknown): Promise<SendResult> {
    if (childId !== this.childId) {
      throw new Error(`unexpected child ${childId}`);
    }
    return { messageId: `msg-${this.sequence + 1}`, sentAt: this.clock.now };
  }

  async waitForMessage(
    childId: string,
    predicate: (message: ChildRuntimeMessage) => boolean,
    timeoutMs = 1_000,
  ): Promise<ChildRuntimeMessage> {
    if (childId !== this.childId) {
      throw new Error(`unexpected child ${childId}`);
    }
    await this.clock.tickAsync(5);
    const message: ChildRuntimeMessage<{ type: string; content: string }> = {
      raw: JSON.stringify({ type: "response", content: "loop" }),
      parsed: { type: "response", content: "loop" },
      stream: "stdout",
      receivedAt: this.clock.now,
      sequence: ++this.sequence,
    };
    if (!predicate(message)) {
      throw new Error(`predicate rejected stub message after ${timeoutMs}ms`);
    }
    this.messages.push(message);
    return message;
  }

  async cancel(): Promise<void> {
    // No-op: the scenario never escalates to cancellation.
  }

  async kill(): Promise<void> {
    // No-op: kill paths are out of scope for this regression.
  }
}

/** Convert a graph descriptor into a hierarchical graph usable by the compiler. */
function descriptorToHierGraph(descriptor: GraphDescriptorPayload): HierGraph {
  return {
    id: descriptor.graph_id ?? descriptor.name,
    nodes: descriptor.nodes.map((node) => ({
      id: node.id,
      kind: "task" as const,
      attributes: {
        bt_tool: (node.attributes?.bt_tool as string) ?? "noop",
        bt_input_key: (node.attributes?.bt_input_key as string) ?? node.id,
      },
    })),
    edges: descriptor.edges.map((edge, index) => ({
      id: edge.label ?? `${edge.from}->${edge.to}#${index}`,
      from: { nodeId: edge.from },
      to: { nodeId: edge.to },
      label: edge.label,
      attributes: edge.attributes as Record<string, GraphAttributeValue> | undefined,
    })),
  };
}

/**
 * Execute a compiled behaviour tree until it reaches a terminal state using the
 * provided runtime variables. The helper raises an error whenever a node marked
 * with `should_fail` is encountered to emulate repeated execution failures.
 */
async function runBehaviourTree(
  clock: sinon.SinonFakeTimers,
  graph: HierGraph,
  variables: Record<string, unknown>,
): Promise<BehaviorTickResult> {
  const compiled = compileHierGraphToBehaviorTree(graph);
  const interpreter = new BehaviorTreeInterpreter(buildBehaviorTree(compiled.root));
  const runtime = {
    async invokeTool(_tool: string, input: unknown): Promise<unknown> {
      const payload = (input ?? {}) as { should_fail?: boolean; step?: string };
      if (payload.should_fail) {
        throw new Error(`step ${payload.step ?? "unknown"} failed`);
      }
      return { ...payload, acknowledged: true };
    },
    now: () => clock.now,
    wait: async (ms: number) => {
      if (ms > 0) {
        await clock.tickAsync(ms);
      }
    },
    variables,
  } satisfies Parameters<BehaviorTreeInterpreter["tick"]>[0];

  try {
    let result = await interpreter.tick(runtime);
    while (result.status === "running") {
      await clock.tickAsync(1);
      result = await interpreter.tick(runtime);
    }
    return result;
  } catch (error) {
    return { status: "failure", output: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Validates that repeated loop alerts trigger a rewrite request and that the
 * graph rewrite removes the failing node so the behaviour tree run succeeds on
 * the next attempt.
 */
describe("rewrite recovery end-to-end flow", function () {
  this.timeout(5000);

  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("requests a rewrite after loop warnings and succeeds once the plan is rerouted", async () => {
    const childSupervisorStub = new LoopingChildSupervisorStub(clock);
    const loopDetector = new LoopDetector({ loopWindowMs: 10_000, maxAlternations: 4, warnAtAlternations: 2 });

    const rewriteIncidents: SupervisorIncident[] = [];
    const supervisorAgent = new OrchestratorSupervisor({
      childManager: childSupervisorStub,
      now: () => clock.now,
      actions: {
        emitAlert: async () => {},
        requestRewrite: async (incident) => {
          rewriteIncidents.push(incident);
        },
        requestRedispatch: async () => {},
      },
    });

    const logger = {
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
      debug: sinon.spy(),
      logCognitive: sinon.spy(),
    };

    const childContext: ChildToolContext = {
      supervisor: childSupervisorStub as unknown as ChildSupervisor,
      logger: logger as unknown as ChildToolContext["logger"],
      loopDetector,
      supervisorAgent,
    };

    const sendInput = ChildSendInputSchema.parse({
      child_id: childSupervisorStub.childId,
      payload: { type: "task", content: "investigate" },
      expect: "final" as const,
      timeout_ms: 250,
    });

    const first = await handleChildSend(childContext, sendInput);
    await clock.tickAsync(10);
    const second = await handleChildSend(childContext, sendInput);
    await clock.tickAsync(10);
    const third = await handleChildSend(childContext, sendInput);

    expect(first.loop_alert).to.equal(null);
    expect(second.loop_alert?.recommendation).to.equal("warn");
    expect(["warn", "kill"]).to.include(third.loop_alert?.recommendation);
    expect(rewriteIncidents).to.have.lengthOf(1);
    expect(rewriteIncidents[0].type).to.equal("loop");

    const hierGraph: HierGraph = {
      id: "rewrite-e2e",
      nodes: [
        { id: "ingest", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "ingest" } },
        { id: "review", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "review" } },
        { id: "ship", kind: "task", attributes: { bt_tool: "noop", bt_input_key: "ship" } },
      ],
      edges: [
        { id: "ingest->review", from: { nodeId: "ingest" }, to: { nodeId: "review" } },
        { id: "review->ship", from: { nodeId: "review" }, to: { nodeId: "ship" } },
      ],
    };

    const failingResult = await runBehaviourTree(clock, hierGraph, {
      ingest: { step: "ingest" },
      review: { step: "review", should_fail: true },
      ship: { step: "ship" },
    });
    expect(failingResult.status).to.equal("failure");

    const descriptor: GraphDescriptorPayload = {
      name: "rewrite-e2e",
      graph_id: "rewrite-e2e",
      graph_version: 1,
      metadata: {},
      nodes: hierGraph.nodes.map((node) => ({
        id: node.id,
        label: node.id,
        attributes: node.attributes as Record<string, string | number | boolean>,
      })),
      edges: hierGraph.edges.map((edge) => ({
        from: edge.from.nodeId,
        to: edge.to.nodeId,
        label: edge.id,
        attributes: {},
      })),
    };

    const rewriteInput = GraphRewriteApplyInputSchema.parse({
      graph: descriptor,
      mode: "manual" as const,
      rules: ["reroute_avoid"],
      options: { reroute_avoid_node_ids: ["review"], stop_on_no_change: true },
    });
    const rewriteResult = handleGraphRewriteApply(rewriteInput);

    expect(rewriteResult.changed).to.equal(true);
    expect(rewriteResult.rules_invoked).to.include("reroute-avoid");
    expect(rewriteResult.graph.nodes.map((node) => node.id)).to.not.include("review");
    expect(
      rewriteResult.graph.edges.some((edge) => edge.from === "ingest" && edge.to === "ship"),
    ).to.equal(true);

    const rewrittenGraph = descriptorToHierGraph(rewriteResult.graph);
    const recoveryResult = await runBehaviourTree(clock, rewrittenGraph, {
      ingest: { step: "ingest" },
      ship: { step: "ship" },
    });

    expect(recoveryResult.status).to.equal("success");
  });
});
