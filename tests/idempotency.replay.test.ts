import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { IdempotencyRegistry } from "../src/infra/idempotency.js";
import { ChildCreateInputSchema, handleChildCreate, type ChildToolContext } from "../src/tools/childTools.js";
import type { ChildSupervisor } from "../src/childSupervisor.js";
import type { ChildRuntimeStatus } from "../src/childRuntime.js";
import type { ChildRecordSnapshot } from "../src/state/childrenIndex.js";
import {
  PlanRunBTInputSchema,
  PlanRunReactiveInputSchema,
  handlePlanRunBT,
  handlePlanRunReactive,
  type PlanToolContext,
} from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { handleCnpAnnounce, CnpAnnounceInputSchema, type CoordinationToolContext } from "../src/tools/coordTools.js";
import { ContractNetCoordinator } from "../src/coord/contractNet.js";
import { BlackboardStore } from "../src/coord/blackboard.js";
import { handleTxBegin, TxBeginInputSchema, type TxToolContext } from "../src/tools/txTools.js";
import { GraphTransactionManager } from "../src/graph/tx.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import { GraphLockManager } from "../src/graph/locks.js";
import type { StructuredLogger } from "../src/logger.js";
import {
  GraphBatchMutateInputSchema,
  handleGraphBatchMutate,
  type GraphBatchToolContext,
} from "../src/tools/graphBatchTools.js";
import { normaliseGraphPayload, type GraphDescriptorPayload } from "../src/tools/graphTools.js";

function createLoggerSpy(): StructuredLogger {
  return {
    info: sinon.spy(),
    warn: sinon.spy(),
    error: sinon.spy(),
    debug: sinon.spy(),
  } as unknown as StructuredLogger;
}

describe("idempotency cache integrations", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("replays child_create once the result is cached", async () => {
    const registry = new IdempotencyRegistry({ defaultTtlMs: 1_000, clock: () => clock.now });
    const logger = createLoggerSpy();
    const runtimeStatus: ChildRuntimeStatus = {
      childId: "child-1",
      pid: 1234,
      command: "node",
      args: ["child.js"],
      workdir: "/tmp/child-1",
      startedAt: 10,
      lastHeartbeatAt: null,
      lifecycle: "running",
      closed: false,
      exit: null,
      resourceUsage: null,
    };
    const indexSnapshot: ChildRecordSnapshot = {
      childId: "child-1",
      pid: 1234,
      workdir: "/tmp/child-1",
      state: "running",
      startedAt: 10,
      lastHeartbeatAt: null,
      retries: 0,
      metadata: {},
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      forcedTermination: false,
      stopReason: null,
      role: null,
      limits: null,
      attachedAt: null,
    };
    const runtime = {
      manifestPath: "/tmp/child-1/manifest.json",
      logPath: "/tmp/child-1/log.ndjson",
      getStatus: () => runtimeStatus,
    };
    const createChild = sinon.stub().resolves({ childId: "child-1", runtime, index: indexSnapshot, readyMessage: null });
    const send = sinon.stub().resolves();

    const context: ChildToolContext = {
      supervisor: { createChild, send } as unknown as ChildSupervisor,
      logger,
      contractNet: undefined,
      supervisorAgent: undefined,
      loopDetector: undefined,
      idempotency: registry,
    };

    const input = ChildCreateInputSchema.parse({
      command: "node",
      args: ["--version"],
      wait_for_ready: false,
      idempotency_key: "child-alpha",
    });

    const first = await handleChildCreate(context, input);
    const second = await handleChildCreate(context, input);

    expect(first.idempotent).to.equal(false);
    expect(second.idempotent).to.equal(true);
    expect(second.child_id).to.equal(first.child_id);
    expect(first.op_id).to.be.a("string");
    expect(second.op_id).to.equal(first.op_id);
    expect(createChild.calledOnce).to.equal(true);

    clock.tick(1_001);
    const third = await handleChildCreate(context, input);
    expect(third.idempotent).to.equal(false);
    expect(createChild.callCount).to.equal(2);
    expect(third.op_id).to.not.equal(first.op_id);
  });

  it("returns cached plan_run_bt results on retries", async () => {
    const registry = new IdempotencyRegistry({ defaultTtlMs: 5_000, clock: () => clock.now });
    const logger = createLoggerSpy();
    const events: Array<{ kind: string; payload: unknown }> = [];
    const context: PlanToolContext = {
      supervisor: {} as PlanToolContext["supervisor"],
      graphState: {} as PlanToolContext["graphState"],
      logger,
      childrenRoot: "/tmp",
      defaultChildRuntime: "codex",
      emitEvent: (event) => events.push(event),
      stigmergy: new StigmergyField(),
      idempotency: registry,
    };
    const input = PlanRunBTInputSchema.parse({
      tree: {
        id: "cached-run",
        root: { type: "task", id: "root", node_id: "root", tool: "noop", input_key: "payload" },
      },
      variables: { payload: { message: "ping" } },
      idempotency_key: "plan-1",
    });

    const first = await handlePlanRunBT(context, input);
    const second = await handlePlanRunBT(context, input);

    expect(first.idempotent).to.equal(false);
    expect(second.idempotent).to.equal(true);
    expect(second.run_id).to.equal(first.run_id);
    expect(logger.info.calledWithMatch("plan_run_bt_replayed", { idempotency_key: "plan-1" })).to.equal(true);
  });

  it("replays plan_run_reactive results on retries", async () => {
    const registry = new IdempotencyRegistry({ defaultTtlMs: 5_000, clock: () => clock.now });
    const logger = createLoggerSpy();
    const events: Array<{ kind: string; payload: unknown }> = [];
    const context: PlanToolContext = {
      supervisor: {} as PlanToolContext["supervisor"],
      graphState: {} as PlanToolContext["graphState"],
      logger,
      childrenRoot: "/tmp",
      defaultChildRuntime: "codex",
      emitEvent: (event) => events.push(event),
      stigmergy: new StigmergyField(),
      idempotency: registry,
    };
    const input = PlanRunReactiveInputSchema.parse({
      tree: {
        id: "cached-reactive",
        root: { type: "task", id: "root", node_id: "root", tool: "noop", input_key: "payload" },
      },
      variables: { payload: { message: "ping" } },
      tick_ms: 25,
      idempotency_key: "plan-reactive-1",
    });

    const execution = handlePlanRunReactive(context, input);
    await clock.tickAsync(25);
    const first = await execution;
    const second = await handlePlanRunReactive(context, input);

    expect(first.idempotent).to.equal(false);
    expect(second.idempotent).to.equal(true);
    expect(second.run_id).to.equal(first.run_id);
    expect(logger.info.calledWithMatch("plan_run_reactive_replayed", { idempotency_key: "plan-reactive-1" })).to.equal(true);
  });

  it("replays cnp_announce decisions when the key matches", () => {
    const registry = new IdempotencyRegistry({ defaultTtlMs: 2_000, clock: () => clock.now });
    const logger = createLoggerSpy();
    const contractNet = new ContractNetCoordinator();
    const announceSpy = sinon.spy(contractNet, "announce");
    const bidSpy = sinon.spy(contractNet, "bid");
    contractNet.registerAgent("agent-a", { baseCost: 3, reliability: 1 });

    const context: CoordinationToolContext = {
      blackboard: new BlackboardStore(),
      stigmergy: new StigmergyField(),
      contractNet,
      logger,
      idempotency: registry,
    };

    const input = CnpAnnounceInputSchema.parse({
      task_id: "demo",
      payload: { task: "write" },
      tags: ["test"],
      auto_bid: true,
      manual_bids: [{ agent_id: "agent-a", cost: 3 }],
      idempotency_key: "auction-1",
    });

    const first = handleCnpAnnounce(context, input);
    const second = handleCnpAnnounce(context, input);

    expect(first.idempotent).to.equal(false);
    expect(second.idempotent).to.equal(true);
    expect(second.call_id).to.equal(first.call_id);
    expect(first.pheromone_bounds).to.deep.equal(second.pheromone_bounds);
    expect(announceSpy.calledOnce).to.equal(true);
    expect(bidSpy.calledOnce).to.equal(true);
    expect(logger.info.calledWithMatch("cnp_announce_replayed", { idempotency_key: "auction-1" })).to.equal(true);
  });

  it("replays graph_batch_mutate updates when the idempotency key matches", async () => {
    const registry = new IdempotencyRegistry({ defaultTtlMs: 1_500, clock: () => clock.now });
    const transactions = new GraphTransactionManager();
    const locks = new GraphLockManager(() => clock.now);
    const resources = new ResourceRegistry({ blackboard: new BlackboardStore({ now: () => clock.now }) });

    // Seed the transaction manager with a committed descriptor so batch mutations
    // operate on a realistic baseline before exercising the idempotency logic.
    const baseDescriptor: GraphDescriptorPayload = {
      name: "graph-batch-idempotent",
      graph_id: "graph-batch-idempotent",
      graph_version: 1,
      nodes: [
        { id: "alpha", label: "Alpha", attributes: {} },
        { id: "beta", label: "Beta", attributes: {} },
      ],
      edges: [
        { from: "alpha", to: "beta", label: "edge", attributes: {} },
      ],
      metadata: {},
    };
    const baseline = normaliseGraphPayload(baseDescriptor);
    const seedTx = transactions.begin(baseline);
    transactions.commit(seedTx.txId, baseline);
    resources.recordGraphVersion({
      graphId: baseline.graphId,
      version: baseline.graphVersion,
      committedAt: clock.now,
      graph: baseline,
    });

    const context: GraphBatchToolContext = {
      transactions,
      resources,
      locks,
      idempotency: registry,
    };
    const beginSpy = sinon.spy(transactions, "begin");
    const commitSpy = sinon.spy(transactions, "commit");

    const input = GraphBatchMutateInputSchema.parse({
      graph_id: baseline.graphId,
      operations: [
        { op: "set_node_attribute", id: "alpha", key: "owner", value: "analysis" },
        { op: "set_edge_attribute", from: "alpha", to: "beta", key: "weight", value: 3 },
      ],
      note: "seed attributes",
      idempotency_key: "graph-batch-1",
    });

    const first = await handleGraphBatchMutate(context, input);
    const second = await handleGraphBatchMutate(context, input);

    expect(first.idempotent).to.equal(false);
    expect(first.idempotency_key).to.equal("graph-batch-1");
    expect(second.idempotent).to.equal(true);
    expect(beginSpy.calledOnce).to.equal(true);
    expect(commitSpy.calledOnce).to.equal(true);

    // Once the TTL elapses, the cached snapshot expires and the mutation runs
    // again, producing a fresh snapshot and incrementing the commit counter.
    clock.tick(1_501);
    const third = await handleGraphBatchMutate(context, input);
    expect(third.idempotent).to.equal(false);
    expect(commitSpy.callCount).to.equal(2);
    expect(beginSpy.callCount).to.equal(2);
  });

  it("returns the same transaction descriptor when tx_begin retries", () => {
    const registry = new IdempotencyRegistry({ defaultTtlMs: 3_000, clock: () => clock.now });
    const transactions = new GraphTransactionManager();
    const locks = new GraphLockManager(() => clock.now);
    const resources = new ResourceRegistry({ blackboard: new BlackboardStore() });

    const context: TxToolContext = { transactions, resources, locks, idempotency: registry };
    const graphDescriptor = {
      graph_id: "graph-1",
      graph_version: 1,
      name: "demo",
      // Invariant validation now rejects isolated nodes, therefore the seed
      // descriptor includes a minimal connected pair to keep the begin replay
      // scenario representative while satisfying the structural rules.
      nodes: [
        { id: "alpha", label: "Alpha", attributes: {} },
        { id: "beta", label: "Beta", attributes: {} },
      ],
      edges: [{ from: "alpha", to: "beta", label: "alpha→beta", attributes: {} }],
    } as const;
    const input = TxBeginInputSchema.parse({
      graph_id: graphDescriptor.graph_id,
      graph: graphDescriptor,
      idempotency_key: "tx-alpha",
    });

    const first = handleTxBegin(context, input);
    const second = handleTxBegin(context, input);

    expect(first.idempotent).to.equal(false);
    expect(second.idempotent).to.equal(true);
    expect(second.tx_id).to.equal(first.tx_id);
    expect(transactions.describe(first.tx_id).txId).to.equal(first.tx_id);
  });
});

