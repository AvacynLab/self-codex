import { EventEmitter } from "node:events";
import { describe, it } from "mocha";
import { expect } from "chai";
import type { Worker as NodeWorker, WorkerOptions } from "node:worker_threads";

import { computeGraphChangeSet } from "../../src/infra/graphChangeSet.js";
import { GraphWorkerPool } from "../../src/infra/workerPool.js";
import type { NormalisedGraph } from "../../src/graph/types.js";
import type { JsonPatchOperation } from "../../src/graph/diff.js";
import { normaliseGraphPayload } from "../../src/tools/graphTools.js";

/**
 * Lightweight stand-in mirroring the subset of the Worker API exercised by the pool
 * implementation. The behaviour callback lets tests schedule messages, failures or
 * hanging scenarios deterministically.
 */
class FakeWorker extends EventEmitter {
  public readonly options: WorkerOptions;
  public terminated = false;
  private readonly behaviour: (self: FakeWorker) => void;

  constructor(options: WorkerOptions, behaviour: (self: FakeWorker) => void) {
    super();
    this.options = options;
    this.behaviour = behaviour;
    setImmediate(() => this.behaviour(this));
  }

  /** Matches the Worker API surface expected by the pool. */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- compatibility shim
  public postMessage(): void {
    // No-op: the fake worker never needs to message the child side in tests.
  }

  /** Marks the worker as terminated and emits the standard exit event. */
  public async terminate(): Promise<number> {
    this.terminated = true;
    this.emit("exit", 0);
    return 0;
  }
}

/** Provides a serialisable deep clone suitable for deterministic test fixtures. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Builds a compact graph fixture for diff/validate scenarios. */
function buildBaseGraph(): NormalisedGraph {
  return normaliseGraphPayload({
    name: "pool-timeout-fixture",
    graph_id: "pool-timeout",
    graph_version: 1,
    metadata: {},
    nodes: [
      { id: "alpha" },
      { id: "bravo" },
    ],
    edges: [
      { from: "alpha", to: "bravo" },
    ],
  });
}

/** Generates a change-set touching multiple nodes so the pool offload heuristics trigger. */
function buildOperations(): JsonPatchOperation[] {
  return [
    { op: "replace", path: "/nodes/0/label", value: "Alpha" },
    { op: "replace", path: "/nodes/1/label", value: "Bravo" },
    { op: "add", path: "/metadata/stage", value: "test" },
  ];
}

/**
 * Regression suite covering the worker timeout handling and the injectable factory
 * that makes the pool easier to exercise in isolation.
 */
describe("graph worker pool resilience", () => {
  it("offloads tasks when the custom factory returns promptly", async () => {
    const baseGraph = buildBaseGraph();
    const operations = buildOperations();
    const expected = computeGraphChangeSet(clone(baseGraph), clone(operations));
    let spawnCount = 0;

    const pool = new GraphWorkerPool({
      maxWorkers: 1,
      changeSetSizeThreshold: 1,
      workerFactory: (_script, options) => {
        spawnCount += 1;
        return new FakeWorker(options, (worker) => {
          setTimeout(() => {
            worker.emit("message", { ok: true, result: expected });
          }, 5);
        }) as unknown as NodeWorker;
      },
    });

    (pool as unknown as { workerScriptUrl: URL | null }).workerScriptUrl = new URL("file:///graph-worker.js");

    const execution = await pool.execute({
      changeSetSize: operations.length,
      baseGraph,
      operations,
    });

    expect(execution.offloaded).to.equal(true, "the task should use the injected worker");
    expect(execution.result.diff.changed).to.equal(expected.diff.changed);
    expect(spawnCount).to.equal(1, "only one worker instance should be created");

    await pool.destroy();
  });

  it("falls back to inline execution when the worker exceeds the timeout", async () => {
    const baseGraph = buildBaseGraph();
    const operations = buildOperations();
    const inlineResult = computeGraphChangeSet(clone(baseGraph), clone(operations));
    let spawnCount = 0;

    const pool = new GraphWorkerPool({
      maxWorkers: 1,
      changeSetSizeThreshold: 1,
      workerTimeoutMs: 15,
      workerFactory: (_script, options) => {
        spawnCount += 1;
        return new FakeWorker(options, () => {
          // Intentionally keep the worker silent to trigger the timeout handler.
        }) as unknown as NodeWorker;
      },
    });

    (pool as unknown as { workerScriptUrl: URL | null }).workerScriptUrl = new URL("file:///graph-worker.js");

    const first = await pool.execute({
      changeSetSize: operations.length,
      baseGraph,
      operations,
    });

    expect(first.offloaded).to.equal(false, "timeout should force inline fallback");
    expect(first.result.diff.changed).to.equal(inlineResult.diff.changed);
    expect(spawnCount).to.equal(1, "worker spawned exactly once despite timeout");

    const second = await pool.execute({
      changeSetSize: operations.length,
      baseGraph,
      operations,
    });

    expect(second.offloaded).to.equal(false, "unavailable worker should keep running inline");
    expect(spawnCount).to.equal(1, "no additional worker instantiation once marked unavailable");

    await pool.destroy();
  });
});
