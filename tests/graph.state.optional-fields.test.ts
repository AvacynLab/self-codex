import { strict as assert } from "node:assert";

import { GraphState } from "../src/graph/state.js";
import type { ChildRecordSnapshot } from "../src/state/childrenIndex.js";

/**
 * Regressions ensuring the graph state omits optional fields when callers omit
 * them. These checks guard the strict `exactOptionalPropertyTypes` migration by
 * verifying snapshots never persist `undefined` placeholders.
 */
describe("graph state optional fields", () => {
  it("omits absent provenance metadata when rehydrating thought graphs", () => {
    const state = new GraphState();
    state.createJob("job-optional", { createdAt: Date.now() });

    state.setThoughtGraph("job-optional", {
      updatedAt: 1,
      nodes: [
        {
          id: "thought-1",
          parents: [],
          prompt: "prompt",
          tool: null,
          result: null,
          score: null,
          status: "pending",
          startedAt: 1,
          completedAt: null,
          provenance: [
            {
              sourceId: "artifact-1",
              type: "url",
              // Intentionally omit span/confidence so the parser must avoid
              // creating undefined properties during rehydration.
            },
          ],
          depth: 0,
          runId: null,
        },
      ],
    });

    const snapshot = state.getThoughtGraph("job-optional");
    assert.ok(snapshot, "the graph snapshot should be available after hydration");
    const provenance = snapshot!.nodes[0]?.provenance[0];
    assert.ok(provenance, "the provenance entry should be preserved");
    assert.strictEqual(Object.hasOwn(provenance, "confidence"), false);
    assert.strictEqual(Object.hasOwn(provenance, "span"), false);
  });

  it("normalises child index snapshots without undefined exit signals", () => {
    const state = new GraphState();
    state.createJob("job-child", { createdAt: Date.now() });
    state.createChild(
      "job-child",
      "child-optional",
      { name: "optional-child" },
      { createdAt: Date.now() },
    );

    const childSnapshot: ChildRecordSnapshot = {
      childId: "child-optional",
      pid: 42,
      workdir: "/tmp", // Dummy path for the regression.
      state: "running",
      startedAt: Date.now(),
      lastHeartbeatAt: null,
      retries: 0,
      metadata: {},
      endedAt: null,
      exitCode: null,
      exitSignal: undefined,
      forcedTermination: false,
      stopReason: null,
      role: null,
      limits: null,
      attachedAt: null,
    };

    state.syncChildIndexSnapshot(childSnapshot);

    const hydrated = state.getChild("child-optional");
    assert.ok(hydrated, "the child snapshot should be available");
    assert.strictEqual(hydrated!.exitSignal, null);
  });

  it("stores subscription snapshots without undefined wait times", () => {
    const state = new GraphState();
    state.createSubscription({ id: "sub-1", lastSeq: 0, createdAt: 1 });

    const subscriptionNode = state.getNodeRecord("subscription:sub-1");
    assert.ok(subscriptionNode, "the subscription node should exist in the graph");
    assert.strictEqual(Object.hasOwn(subscriptionNode!.attributes, "wait_ms"), false);

    const listed = state.listSubscriptionSnapshots();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(Object.hasOwn(listed[0]!, "waitMs"), false);
  });

  it("rehydrates subscriptions without introducing undefined placeholders", () => {
    const state = new GraphState();
    state.resetFromSnapshot({
      nodes: [
        {
          id: "subscription:rehydrate",
          attributes: {
            type: "subscription",
            last_seq: 4,
            created_at: 99,
          },
        },
      ],
      edges: [],
      directives: {},
    });

    const snapshots = state.listSubscriptionSnapshots();
    assert.strictEqual(snapshots.length, 1);
    assert.strictEqual(Object.hasOwn(snapshots[0]!, "waitMs"), false);
    assert.strictEqual(Object.hasOwn(snapshots[0]!, "jobId"), false);
    assert.strictEqual(Object.hasOwn(snapshots[0]!, "childId"), false);
  });
});
