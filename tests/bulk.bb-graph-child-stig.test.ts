import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BlackboardStore } from "../src/coord/blackboard.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { ContractNetCoordinator } from "../src/coord/contractNet.js";
import { StructuredLogger } from "../src/logger.js";
import { GraphTransactionManager } from "../src/graph/tx.js";
import { GraphLockManager } from "../src/graph/locks.js";
import { ResourceRegistry } from "../src/resources/registry.js";
import { IdempotencyRegistry } from "../src/infra/idempotency.js";
import {
  BbBatchSetInputSchema,
  handleBbBatchSet,
  StigBatchInputSchema,
  handleStigBatch,
  type CoordinationToolContext,
} from "../src/tools/coordTools.js";
import {
  GraphBatchMutateInputSchema,
  handleGraphBatchMutate,
  type GraphBatchToolContext,
} from "../src/tools/graphBatchTools.js";
import {
  handleGraphGenerate,
  normaliseGraphPayload,
} from "../src/tools/graphTools.js";
import { ChildSupervisor } from "../src/children/supervisor.js";
import {
  ChildBatchCreateInputSchema,
  ChildToolContext,
  handleChildBatchCreate,
} from "../src/tools/childTools.js";
import type { ChildLifecycleState } from "../src/state/childrenIndex.js";
import { GraphMutationLockedError } from "../src/graph/locks.js";
import { GraphVersionConflictError } from "../src/graph/tx.js";
import { ERROR_CODES } from "../src/types.js";
import { resolveFixture, runnerArgs } from "./helpers/childRunner.js";
import { ChildLimitExceededError } from "../src/children/supervisor.js";
import { BulkOperationError } from "../src/tools/bulkError.js";

/**
 * Builds a coordination context backed by deterministic clocks so the tests can
 * reason about TTLs and versioning without flakiness.
 */
function createCoordinationContext(clock: { now: number }): CoordinationToolContext {
  const now = () => clock.now;
  return {
    blackboard: new BlackboardStore({ now }),
    stigmergy: new StigmergyField({ now }),
    contractNet: new ContractNetCoordinator({ now }),
    logger: new StructuredLogger(),
  };
}

function createGraphBatchFixture(clock: { now: number }): {
  context: GraphBatchToolContext;
  graphId: string;
  baseVersion: number;
} {
  const transactions = new GraphTransactionManager();
  const locks = new GraphLockManager(() => clock.now);
  const resources = new ResourceRegistry();
  const idempotency = new IdempotencyRegistry({ clock: () => clock.now });
  const generated = handleGraphGenerate({ name: "pipeline", preset: "lint_test_build_package" });
  const baseline = normaliseGraphPayload(generated.graph);
  const opened = transactions.begin(baseline);
  const committed = transactions.commit(opened.txId, opened.workingCopy);
  const context: GraphBatchToolContext = { transactions, resources, locks, idempotency };
  return { context, graphId: committed.graphId, baseVersion: committed.version };
}

const mockRunnerPath = resolveFixture(import.meta.url, "./fixtures/mock-runner.ts");
const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);

async function createChildBatchFixture(options: {
  maxChildren?: number;
} = {}): Promise<{
  context: ChildToolContext;
  supervisor: ChildSupervisor;
  logger: StructuredLogger;
  cleanup: () => Promise<void>;
}> {
  const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-batch-"));
  const supervisor = new ChildSupervisor({
    childrenRoot,
    defaultCommand: process.execPath,
    defaultArgs: mockRunnerArgs("--role", "friendly"),
    idleTimeoutMs: 200,
    idleCheckIntervalMs: 40,
    // The supervisor now expects guardrails to be provided through the `safety`
    // block so mimic the production configuration to keep the tests honest.
    safety:
      typeof options.maxChildren === "number"
        ? {
            maxChildren: options.maxChildren,
          }
        : undefined,
  });
  const logFile = path.join(childrenRoot, "child-batch.log");
  const logger = new StructuredLogger({ logFile });
  const idempotency = new IdempotencyRegistry({ clock: () => Date.now() });
  const context: ChildToolContext = { supervisor, logger, idempotency };
  const cleanup = async () => {
    await supervisor.disposeAll();
    await logger.flush();
    await rm(childrenRoot, { recursive: true, force: true });
  };
  return { context, supervisor, logger, cleanup };
}

/**
 * Counts active child runtimes using the public index instead of the private
 * `runtimes` map so the test remains coupled to the documented API surface.
 */
function getRuntimeCount(supervisor: ChildSupervisor): number {
  const activeStates = new Set<ChildLifecycleState>([
    "starting",
    "ready",
    "running",
    "idle",
    "stopping",
  ]);
  return supervisor.childrenIndex
    .list()
    .filter((snapshot) => activeStates.has(snapshot.state))
    .length;
}

describe("bulk tools", () => {
  describe("bb_batch_set", () => {
    it("applies all mutations atomically with sequential versions", () => {
      const clock = { now: 10_000 };
      const context = createCoordinationContext(clock);

      const parsed = BbBatchSetInputSchema.parse({
        entries: [
          { key: "alpha", value: { status: "ready" }, tags: ["coord"], ttl_ms: 5_000 },
          { key: "beta", value: 42 },
        ],
      });

      const result = handleBbBatchSet(context, parsed);
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      expect(result.entries).to.have.lengthOf(2);

      const alpha = context.blackboard.get("alpha");
      const beta = context.blackboard.get("beta");
      expect(alpha).to.not.be.undefined;
      expect(beta).to.not.be.undefined;
      expect(alpha?.value).to.deep.equal({ status: "ready" });
      expect(alpha?.tags).to.deep.equal(["coord"]);
      expect(alpha?.expiresAt).to.equal(15_000);
      expect(beta?.value).to.equal(42);
      expect(alpha?.version).to.equal(1);
      expect(beta?.version).to.equal(2);

      const events = context.blackboard.getEventsSince(0);
      expect(events.map((event) => ({ version: event.version, key: event.key }))).to.deep.equal([
        { version: 1, key: "alpha" },
        { version: 2, key: "beta" },
      ]);
    });

    it("rolls back the batch when one entry cannot be cloned", () => {
      const clock = { now: 25_000 };
      const context = createCoordinationContext(clock);

      const initial = context.blackboard.set("alpha", { status: "seed" });
      expect(initial.version).to.equal(1);

      try {
        handleBbBatchSet(
          context,
          BbBatchSetInputSchema.parse({
            entries: [
              { key: "alpha", value: { status: "updated" } },
              // Functions cannot be cloned and therefore trigger the rollback path.
              { key: "beta", value: () => "boom" },
            ],
          }),
        );
        expect.fail("expected BulkOperationError");
      } catch (error) {
        expect(error).to.be.instanceOf(BulkOperationError);
        const failure = (error as BulkOperationError).details.failures[0];
        expect(failure?.index).to.equal(1);
        expect(failure?.code).to.equal(ERROR_CODES.BULK_PARTIAL);
        expect(failure?.entry).to.deep.equal({ key: "beta", tags: null });
        expect((error as BulkOperationError).details.rolled_back).to.equal(true);
      }

      const after = context.blackboard.get("alpha");
      expect(after?.value).to.deep.equal({ status: "seed" });
      expect(context.blackboard.get("beta")).to.be.undefined;
      expect(context.blackboard.getCurrentVersion()).to.equal(initial.version);
      expect(context.blackboard.getEventsSince(initial.version)).to.have.lengthOf(0);
    });
  });

  describe("graph_batch_mutate", () => {
    it("commits graph operations atomically and supports idempotent replays", async () => {
      const clock = { now: 5_000 };
      const { context, graphId, baseVersion } = createGraphBatchFixture(clock);

      const parsed = GraphBatchMutateInputSchema.parse({
        graph_id: graphId,
        expected_version: baseVersion,
        operations: [
          { op: "add_node", node: { id: "qa", label: "QA" } },
          { op: "add_edge", edge: { from: "build", to: "qa", weight: 1 } },
        ],
        idempotency_key: "graph-batch-commit",
      });

      const result = await handleGraphBatchMutate(context, parsed);
      expect(result.changed).to.equal(true);
      expect(result.idempotent).to.equal(false);
      expect(result.base_version).to.equal(baseVersion);
      expect(result.committed_version).to.equal(baseVersion + 1);
      const committed = context.transactions.getCommittedState(graphId);
      expect(committed?.version).to.equal(result.committed_version);

      const replay = await handleGraphBatchMutate(context, parsed);
      expect(replay.idempotent).to.equal(true);
      expect(replay.committed_version).to.equal(result.committed_version);
      const committedAfterReplay = context.transactions.getCommittedState(graphId);
      expect(committedAfterReplay?.version).to.equal(result.committed_version);
    });

    it("rejects when a conflicting lock is held and leaves the graph unchanged", async () => {
      const clock = { now: 9_000 };
      const { context, graphId, baseVersion } = createGraphBatchFixture(clock);
      context.locks.acquire(graphId, "other-holder", { ttlMs: 1_000 });

      const parsed = GraphBatchMutateInputSchema.parse({
        graph_id: graphId,
        owner: "batch-owner",
        expected_version: baseVersion,
        operations: [{ op: "add_node", node: { id: "orphan" } }],
      });

      await handleGraphBatchMutate(context, parsed)
        .then(() => expect.fail("expected GraphMutationLockedError"))
        .catch((error) => {
          expect(error).to.be.instanceOf(GraphMutationLockedError);
        });
      const committed = context.transactions.getCommittedState(graphId);
      expect(committed?.version).to.equal(baseVersion);
    });

    it("rejects when the expected version does not match", async () => {
      const clock = { now: 12_000 };
      const { context, graphId, baseVersion } = createGraphBatchFixture(clock);

      const parsed = GraphBatchMutateInputSchema.parse({
        graph_id: graphId,
        expected_version: Math.max(0, baseVersion - 1),
        operations: [{ op: "add_node", node: { id: "noop" } }],
      });

      await handleGraphBatchMutate(context, parsed)
        .then(() => expect.fail("expected GraphVersionConflictError"))
        .catch((error) => {
          expect(error).to.be.instanceOf(GraphVersionConflictError);
          const conflict = error as GraphVersionConflictError;
          expect(conflict.code).to.equal(ERROR_CODES.TX_CONFLICT);
          expect(conflict.hint).to.equal("reload latest committed graph before retrying");
        });
      const committed = context.transactions.getCommittedState(graphId);
      expect(committed?.version).to.equal(baseVersion);
    });

    it("reports unchanged operations without bumping the graph version", async () => {
      const clock = { now: 15_000 };
      const { context, graphId, baseVersion } = createGraphBatchFixture(clock);

      const parsed = GraphBatchMutateInputSchema.parse({
        graph_id: graphId,
        expected_version: baseVersion,
        operations: [
          // Adding an existing node merges attributes without modifying the graph structure.
          { op: "add_node", node: { id: "build" } },
        ],
      });

      const result = await handleGraphBatchMutate(context, parsed);
      expect(result.changed).to.equal(false);
      expect(result.operations_applied).to.equal(1);
      expect(result.committed_version).to.equal(baseVersion);
      const committed = context.transactions.getCommittedState(graphId);
      expect(committed?.version).to.equal(baseVersion);
    });
  });

  describe("child_batch_create", () => {
    it("spawns multiple children and reports idempotent replays", async () => {
      const fixture = await createChildBatchFixture();
      const context = fixture.context;

      try {
        const parsed = ChildBatchCreateInputSchema.parse({
          entries: [
            {
              prompt: { system: "Tu es un copilote.", user: ["Analyse"] },
              role: "planner",
              idempotency_key: "child-batch-1",
            },
            {
              prompt: { system: "Tu es un copilote.", user: ["Synthèse"] },
              role: "reviewer",
              idempotency_key: "child-batch-2",
            },
          ],
        });

        const result = await handleChildBatchCreate(context, parsed);
        expect(result.children).to.have.lengthOf(2);
        expect(result.created).to.equal(2);
        expect(result.idempotent_entries).to.equal(0);
        for (const child of result.children) {
          expect(child.op_id).to.be.a("string");
          expect(child.idempotent).to.equal(false);
          const status = fixture.supervisor.status(child.child_id);
          expect(status.index.childId).to.equal(child.child_id);
        }

        const opIdsByChild = new Map(result.children.map((child) => [child.child_id, child.op_id]));

        const replay = await handleChildBatchCreate(context, parsed);
        expect(replay.idempotent_entries).to.equal(2);
        expect(replay.created).to.equal(0);
        replay.children.forEach((child) => {
          expect(child.op_id).to.equal(opIdsByChild.get(child.child_id));
          expect(child.idempotent).to.equal(true);
        });

        for (const child of result.children) {
          await fixture.supervisor.cancel(child.child_id, { signal: "SIGINT", timeoutMs: 200 });
          await fixture.supervisor.waitForExit(child.child_id, 1000);
          fixture.supervisor.gc(child.child_id);
        }
      } finally {
        await fixture.cleanup();
      }
    });

    it("rolls back spawned children when the supervisor rejects a later entry", async () => {
      const fixture = await createChildBatchFixture({ maxChildren: 1 });
      const context = fixture.context;

      try {
        const parsed = ChildBatchCreateInputSchema.parse({
          entries: [
            {
              prompt: { system: "Assistant", user: ["Tâche A"] },
              role: "executor",
              idempotency_key: "child-batch-limit-1",
            },
            {
              prompt: { system: "Assistant", user: ["Tâche B"] },
              role: "executor",
              idempotency_key: "child-batch-limit-2",
            },
          ],
        });

        const originalCreateChild = fixture.supervisor.createChild;
        let spawnCount = 0;
        const overrideCreateChild: ChildSupervisor["createChild"] = async function (...args) {
          spawnCount += 1;
          if (spawnCount === 2) {
            throw new ChildLimitExceededError(1, 1);
          }
          return originalCreateChild.apply(this, args);
        };
        Reflect.set(fixture.supervisor, "createChild", overrideCreateChild);

        try {
          await handleChildBatchCreate(context, parsed)
            .then(() => expect.fail("expected BulkOperationError"))
            .catch((error: unknown) => {
              expect(error).to.be.instanceOf(BulkOperationError);
              const failure = (error as BulkOperationError).details.failures[0];
              expect(failure?.code).to.equal(ERROR_CODES.CHILD_LIMIT_EXCEEDED);
              expect(failure?.entry).to.deep.equal({
                role: "executor",
                idempotency_key: "child-batch-limit-2",
                prompt_keys: ["system", "user"],
              });
              expect((error as BulkOperationError).details.metadata?.rollback_child_ids).to.have.lengthOf(1);
            });
        } finally {
          // Restore the supervisor behaviour for cleanup to avoid masking other scenarios.
          Reflect.set(fixture.supervisor, "createChild", originalCreateChild);
        }
        expect(getRuntimeCount(fixture.supervisor)).to.equal(0);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("stig_batch", () => {
    it("deposits multiple pheromones atomically", () => {
      const clock = { now: 42_000 };
      const context = createCoordinationContext(clock);

      const parsed = StigBatchInputSchema.parse({
        entries: [
          { node_id: "triage", type: "backlog", intensity: 2.5 },
          { node_id: "triage", type: "latency", intensity: 1.25 },
        ],
      });

      const result = handleStigBatch(context, parsed);
      expect(result.op_id).to.be.a("string").and.to.have.length.greaterThan(0);
      expect(result.changes).to.have.lengthOf(2);
      const total = context.stigmergy.getNodeIntensity("triage");
      expect(total?.intensity).to.be.closeTo(3.75, 1e-6);
      expect(result.changes[0]?.point.node_id).to.equal("triage");
    });

    it("rolls back when one entry cannot be normalised", () => {
      const clock = { now: 55_000 };
      const context = createCoordinationContext(clock);

      const parsed = StigBatchInputSchema.parse({
        entries: [
          { node_id: "alpha", type: "load", intensity: 1 },
          { node_id: "alpha", type: "   ", intensity: 2 },
        ],
      });

      try {
        handleStigBatch(context, parsed);
        expect.fail("expected BulkOperationError");
      } catch (error) {
        expect(error).to.be.instanceOf(BulkOperationError);
        const failure = (error as BulkOperationError).details.failures[0];
        expect(failure?.code).to.equal("E-STIG-TYPE");
        expect(failure?.entry).to.deep.equal({ node_id: "alpha", type: "   ", intensity: 2 });
        expect((error as BulkOperationError).details.rolled_back).to.equal(true);
      }
      expect(context.stigmergy.fieldSnapshot().points).to.have.lengthOf(0);
    });
  });
});
