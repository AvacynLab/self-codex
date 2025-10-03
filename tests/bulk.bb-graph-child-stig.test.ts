import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
import { ChildSupervisor } from "../src/childSupervisor.js";
import {
  ChildBatchCreateInputSchema,
  ChildToolContext,
  handleChildBatchCreate,
} from "../src/tools/childTools.js";
import { StigmergyInvalidTypeError } from "../src/coord/stigmergy.js";
import { GraphMutationLockedError } from "../src/graph/locks.js";
import { GraphVersionConflictError } from "../src/graph/tx.js";
import { ChildLimitExceededError } from "../src/childSupervisor.js";

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

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));

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
    defaultArgs: [mockRunnerPath, "--role", "friendly"],
    idleTimeoutMs: 200,
    idleCheckIntervalMs: 40,
    maxChildren: options.maxChildren,
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

function getRuntimeCount(supervisor: ChildSupervisor): number {
  const internal = supervisor as unknown as { runtimes: Map<string, unknown> };
  return internal.runtimes.size;
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

      expect(() =>
        handleBbBatchSet(
          context,
          BbBatchSetInputSchema.parse({
            entries: [
              { key: "alpha", value: { status: "updated" } },
              // Functions cannot be cloned and therefore trigger the rollback path.
              { key: "beta", value: () => "boom" },
            ],
          }),
        ),
      ).to.throw();

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
          expect(child.idempotent).to.equal(false);
          const status = fixture.supervisor.status(child.child_id);
          expect(status.index.childId).to.equal(child.child_id);
        }

        const replay = await handleChildBatchCreate(context, parsed);
        expect(replay.idempotent_entries).to.equal(2);
        expect(replay.created).to.equal(0);
        replay.children.forEach((child) => {
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

        const originalCreateChild = fixture.supervisor.createChild.bind(fixture.supervisor);
        let spawnCount = 0;
        // Force the supervisor to reject the second spawn to exercise the rollback path deterministically.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fixture.supervisor.createChild as any) = async (...args: Parameters<typeof originalCreateChild>) => {
          spawnCount += 1;
          if (spawnCount === 2) {
            throw new ChildLimitExceededError(1, 1);
          }
          return originalCreateChild(...args);
        };

        await handleChildBatchCreate(context, parsed)
          .then(() => expect.fail("expected ChildLimitExceededError"))
          .catch((error) => {
            expect(error).to.have.property("name", "ChildLimitExceededError");
          });
        // Restore the supervisor behaviour for cleanup to avoid masking other scenarios.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fixture.supervisor.createChild as any) = originalCreateChild;
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

      expect(() => handleStigBatch(context, parsed)).to.throw(StigmergyInvalidTypeError);
      expect(context.stigmergy.fieldSnapshot().points).to.have.lengthOf(0);
    });
  });
});
