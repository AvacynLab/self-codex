import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { CreateChildOptions, CreateChildResult } from "../src/children/supervisor.js";
import type {
  ChildCollectedOutputs,
  ChildMessageStreamResult,
  ChildRuntimeMessage,
  ChildRuntimeStatus,
  ChildShutdownResult,
} from "../src/childRuntime.js";
import {
  server,
  graphState,
  childProcessSupervisor,
  configureRuntimeFeatures,
  getRuntimeFeatures,
  logJournal,
  contractNet,
} from "../src/server.js";
import { createStubChildRuntime } from "./helpers/childRuntime.js";

/**
 * Builds a deep clone of the collected child outputs so the test can perform
 * assertions without mutating the cached snapshots returned by the stubs.
 */
function cloneOutputs(snapshot: ChildCollectedOutputs): ChildCollectedOutputs {
  return {
    childId: snapshot.childId,
    manifestPath: snapshot.manifestPath,
    logPath: snapshot.logPath,
    artifacts: [...snapshot.artifacts],
    messages: snapshot.messages.map((message) => cloneMessage(message)),
  };
}

/** Deeply clones a child runtime message so predicate checks remain pure. */
function cloneMessage<T>(message: ChildRuntimeMessage<T>): ChildRuntimeMessage<T> {
  return {
    raw: message.raw,
    parsed: message.parsed ? JSON.parse(JSON.stringify(message.parsed)) : null,
    stream: message.stream,
    receivedAt: message.receivedAt,
    sequence: message.sequence,
  };
}

/**
 * Helper fabricating deterministic child outputs with terminal responses so the
 * join/reduce sequence can operate without real child processes.
 */
function createOutputs(
  childId: string,
  options: { type: "response" | "error"; content: string; receivedAt: number },
): ChildCollectedOutputs {
  const message: ChildRuntimeMessage<{ type: string; content: string }> = {
    raw: JSON.stringify({ type: options.type, content: options.content }),
    parsed: { type: options.type, content: options.content },
    stream: "stdout",
    receivedAt: options.receivedAt,
    sequence: 1,
  };
  return {
    childId,
    manifestPath: path.join(tmpdir(), `${childId}-manifest.json`),
    logPath: path.join(tmpdir(), `${childId}-log.txt`),
    messages: [message],
    artifacts: [],
  };
}

/**
 * Exercises the full MCP stack by registering contract-net agents via
 * `child_create`, announcing an auction, then joining and reducing the emitted
 * child outputs using quorum-based consensus.
 */
describe("contract-net consensus MCP end-to-end", function () {
  this.timeout(20000);

  it("awards the preferred bid and satisfies quorum reduce voting", async function () {
    this.timeout(20000);

    const clock = sinon.useFakeTimers();
    const baselineGraph = graphState.serialize();
    const baselineChildren = childProcessSupervisor.childrenIndex.serialize();
    const baselineFeatures = getRuntimeFeatures();
    const baselineAgents = new Map(
      contractNet.listAgents().map((agent) => [agent.agentId, agent] as const),
    );

    const stubbedChildren = new Set<string>();
    const stubbedOutputs = new Map<string, ChildCollectedOutputs>();
    const shutdownSnapshot: ChildShutdownResult = {
      code: 0,
      signal: null,
      forced: false,
      durationMs: 0,
    };

    const originalCreateChild = childProcessSupervisor.createChild.bind(childProcessSupervisor);
    const originalCollect = childProcessSupervisor.collect.bind(childProcessSupervisor);
    const originalWaitForMessage = childProcessSupervisor.waitForMessage.bind(childProcessSupervisor);

    childProcessSupervisor.createChild = (async function stubCreateChild(
      this: typeof childProcessSupervisor,
      options: CreateChildOptions = {},
    ) {
      const index = stubbedChildren.size + 1;
      const childId = options.childId ?? `cnp-e2e-child-${index}`;
      const now = typeof clock.now === "number" ? clock.now : Date.now();
      const workdir = path.join(tmpdir(), childId);
      const manifestPath = path.join(workdir, `${childId}.manifest.json`);
      const logPath = path.join(workdir, `${childId}.log`);

      const snapshot = this.childrenIndex.registerChild({
        childId,
        pid: 10_000 + index,
        workdir,
        metadata: { ...(options.metadata ?? {}) },
        state: "starting",
        limits: options.limits ?? null,
        role: options.role ?? null,
        attachedAt: now,
      });

      this.childrenIndex.updateHeartbeat(childId, now);
      this.childrenIndex.updateState(childId, "ready");

      const readyMessage: ChildRuntimeMessage<{ type: string; content: string }> = {
        raw: JSON.stringify({ type: "ready", content: `${childId}:ready` }),
        parsed: { type: "ready", content: `${childId}:ready` },
        stream: "stdout",
        receivedAt: now,
        sequence: 0,
      };

      const runtimeStatus: ChildRuntimeStatus = {
        childId,
        pid: snapshot.pid,
        command: options.command ?? "stub-runtime",
        args: options.args ? [...options.args] : [],
        workdir,
        startedAt: now,
        lastHeartbeatAt: now,
        lifecycle: "running",
        closed: false,
        exit: null,
        resourceUsage: null,
      };

      stubbedChildren.add(childId);

      const runtime = createStubChildRuntime({
        childId,
        manifestPath,
        logPath,
        status: runtimeStatus,
        shutdownResult: shutdownSnapshot,
        waitForMessage: async () => cloneMessage(readyMessage),
        collectOutputs: async () => {
          const outputs = stubbedOutputs.get(childId);
          return outputs
            ? cloneOutputs(outputs)
            : createOutputs(childId, {
                type: "response",
                content: "{}",
                receivedAt: now,
              });
        },
        streamMessages: () => {
          const outputs = stubbedOutputs.get(childId);
          const messages = outputs ? outputs.messages.map((message) => cloneMessage(message)) : [];
          const totalMessages = messages.length;
          return {
            childId,
            totalMessages,
            matchedMessages: totalMessages,
            hasMore: false,
            nextCursor: totalMessages > 0 ? messages[totalMessages - 1].sequence : null,
            messages,
          } satisfies ChildMessageStreamResult;
        },
      });

      return {
        childId,
        index: snapshot,
        runtime,
        readyMessage,
      } satisfies CreateChildResult;
    }).bind(childProcessSupervisor);

    childProcessSupervisor.collect = (async function stubCollect(
      this: typeof childProcessSupervisor,
      childId: string,
    ) {
      const outputs = stubbedOutputs.get(childId);
      if (outputs) {
        return cloneOutputs(outputs);
      }
      return originalCollect(childId);
    }).bind(childProcessSupervisor);

    childProcessSupervisor.waitForMessage = (async function stubWaitForMessage(
      this: typeof childProcessSupervisor,
      childId: string,
      predicate: (message: ChildRuntimeMessage) => boolean,
    ) {
      const outputs = stubbedOutputs.get(childId);
      if (outputs) {
        const candidate = [...outputs.messages].reverse().find((message) => predicate(message));
        if (candidate) {
          return cloneMessage(candidate);
        }
      }
      return originalWaitForMessage(childId, predicate);
    }).bind(childProcessSupervisor);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "cnp-consensus-e2e", version: "1.0.0-test" });

    const createdChildren: string[] = [];
    const runId = "cnp-e2e-run";
    const opId = "cnp-e2e-op";
    const jobId = "cnp-e2e-job";
    const graphId = "cnp-e2e-graph";
    let awardedCallId: string | null = null;

    try {
      await server.close().catch(() => {});
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      configureRuntimeFeatures({
        ...baselineFeatures,
        enableEventsBus: true,
        enablePlanLifecycle: true,
        enableSupervisor: true,
        enableCNP: true,
        enableConsensus: true,
        enableBlackboard: true,
        enableStigmergy: true,
        enableCancellation: true,
      });

      logJournal.reset();
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: graphId } });
      childProcessSupervisor.childrenIndex.restore({});

      const childConfigs = [
        { id: "cnp-child-alpha", reliability: 0.9, wallclock: 6_000 },
        { id: "cnp-child-beta", reliability: 0.95, wallclock: 4_000 },
        { id: "cnp-child-gamma", reliability: 0.85, wallclock: 5_500 },
      ] as const;

      for (const config of childConfigs) {
        const response = await client.callTool({
          name: "child_create",
          arguments: {
            child_id: config.id,
            metadata: { contract_net: { reliability: config.reliability } },
            budget: { wallclock_ms: config.wallclock },
            tools_allow: ["plan_wait"],
          },
        });
        expect(response.isError ?? false).to.equal(false);
        const snapshot = response.structuredContent as {
          child_id: string;
          ready_message: unknown;
        };
        createdChildren.push(snapshot.child_id);
      }

      expect(createdChildren).to.have.length(3);

      const announceResponse = await client.callTool({
        name: "cnp_announce",
        arguments: {
          task_id: "triage-incident",
          payload: { severity: "high" },
          auto_bid: false,
          manual_bids: [
            { agent_id: createdChildren[0], cost: 72 },
            { agent_id: createdChildren[1], cost: 48 },
            { agent_id: createdChildren[2], cost: 61 },
          ],
          heuristics: {
            prefer_agents: [createdChildren[1]],
            preference_bonus: 5,
            busy_penalty: 5,
          },
          run_id: runId,
          op_id: `${opId}-auction`,
          job_id: jobId,
          graph_id: graphId,
        },
      });
      expect(announceResponse.isError ?? false).to.equal(false);
      const announcement = announceResponse.structuredContent as {
        call_id: string;
        awarded_agent_id: string;
        bids: unknown[];
      };
      expect(announcement.bids).to.have.length(3);
      expect(announcement.awarded_agent_id).to.equal(createdChildren[1]);
      awardedCallId = announcement.call_id;

      clock.tick(10);
      stubbedOutputs.set(
        createdChildren[1],
        createOutputs(createdChildren[1], {
          type: "response",
          content: '{"vote":"approve"}',
          receivedAt: typeof clock.now === "number" ? clock.now : Date.now(),
        }),
      );
      clock.tick(10);
      stubbedOutputs.set(
        createdChildren[0],
        createOutputs(createdChildren[0], {
          type: "response",
          content: '{"vote":"approve"}',
          receivedAt: typeof clock.now === "number" ? clock.now : Date.now(),
        }),
      );
      clock.tick(10);
      stubbedOutputs.set(
        createdChildren[2],
        createOutputs(createdChildren[2], {
          type: "error",
          content: " ",
          receivedAt: typeof clock.now === "number" ? clock.now : Date.now(),
        }),
      );

      const joinResponse = await client.callTool({
        name: "plan_join",
        arguments: {
          children: createdChildren,
          join_policy: "quorum",
          quorum_count: 2,
          timeout_sec: 1,
          consensus: {
            mode: "quorum",
            quorum: 2,
            tie_breaker: "prefer",
            prefer_value: "success",
          },
          run_id: runId,
          op_id: `${opId}-join`,
          job_id: jobId,
          graph_id: graphId,
        },
      });
      expect(joinResponse.isError ?? false).to.equal(false);
      const joinResult = joinResponse.structuredContent as {
        policy: string;
        satisfied: boolean;
        winning_child_id: string | null;
        success_count: number;
        failure_count: number;
        consensus?: { outcome: string; satisfied: boolean; tally: Record<string, number> };
      };
      expect(joinResult.policy).to.equal("quorum");
      expect(joinResult.satisfied).to.equal(true);
      expect(joinResult.winning_child_id).to.equal(createdChildren[1]);
      expect(joinResult.success_count).to.equal(2);
      expect(joinResult.failure_count).to.equal(1);
      expect(joinResult.consensus?.outcome).to.equal("success");
      expect(joinResult.consensus?.tally?.success).to.equal(2);

      const reduceResponse = await client.callTool({
        name: "plan_reduce",
        arguments: {
          children: createdChildren,
          reducer: "vote",
          spec: {
            mode: "weighted",
            quorum: 3,
            weights: {
              [createdChildren[1]]: 2,
              [createdChildren[0]]: 1,
              [createdChildren[2]]: 1,
            },
            tie_breaker: "first",
          },
          run_id: runId,
          op_id: `${opId}-reduce`,
          job_id: jobId,
          graph_id: graphId,
        },
      });
      expect(reduceResponse.isError ?? false).to.equal(false);
      const reduceResult = reduceResponse.structuredContent as {
        reducer: string;
        aggregate: { mode: string; value: string; satisfied: boolean; total_weight: number };
        trace: { per_child: Array<{ child_id: string; summary: string | null }> };
      };
      expect(reduceResult.reducer).to.equal("vote");
      expect(reduceResult.aggregate.value).to.equal("approve");
      expect(reduceResult.aggregate.satisfied).to.equal(true);
      expect(reduceResult.aggregate.total_weight).to.equal(3);
      const reduceSummaries = new Map(
        reduceResult.trace.per_child.map((entry) => [entry.child_id, entry.summary]),
      );
      expect(reduceSummaries.get(createdChildren[2])).to.equal(" ");
      expect(reduceSummaries.get(createdChildren[1])).to.contain("approve");
    } finally {
      if (awardedCallId) {
        try {
          contractNet.complete(awardedCallId);
        } catch {}
      }
      for (const agent of contractNet.listAgents()) {
        if (!baselineAgents.has(agent.agentId)) {
          contractNet.unregisterAgent(agent.agentId);
        }
      }
      configureRuntimeFeatures(baselineFeatures);
      childProcessSupervisor.createChild = originalCreateChild;
      childProcessSupervisor.collect = originalCollect;
      childProcessSupervisor.waitForMessage = originalWaitForMessage;
      childProcessSupervisor.childrenIndex.restore(baselineChildren);
      graphState.resetFromSnapshot(baselineGraph);
      logJournal.reset();
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      clock.restore();
    }
  });
});
