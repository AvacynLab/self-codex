import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  configureRuntimeFeatures,
  configureRuntimeTimings,
  getRuntimeFeatures,
  getRuntimeTimings,
  graphState,
  startHeartbeat,
  stopHeartbeat,
} from "../src/server.js";

/**
 * Helper returning the heartbeat event timestamps recorded in the graph state.
 * Sorting keeps assertions deterministic even if future emitters interleave
 * additional events while tests drive the fake clock.
 */
function listHeartbeatTimestamps(): number[] {
  const snapshot = graphState.serialize();
  return snapshot.nodes
    .filter((node) => node.attributes.type === "event" && node.attributes.kind === "HEARTBEAT")
    .map((node) => Number(node.attributes.ts ?? 0))
    .sort((left, right) => left - right);
}

/**
 * Unit coverage ensuring the runtime timings configuration controls the
 * heartbeat scheduler cadence and that reconfiguration restarts the timer with
 * the new interval without leaving dangling timers behind.
 */
describe("heartbeat scheduler", () => {
  it("applique l'intervalle configuré et relance le timer lors des mises à jour", async () => {
    const originalFeatures = getRuntimeFeatures();
    const originalTimings = getRuntimeTimings();
    const baselineGraph = graphState.serialize();
    const clock = sinon.useFakeTimers({ now: 0 });

    try {
      stopHeartbeat();
      configureRuntimeFeatures({ ...originalFeatures, enableEventsBus: true });
      configureRuntimeTimings({ ...originalTimings, heartbeatIntervalMs: 500 });
      graphState.resetFromSnapshot({ nodes: [], edges: [], directives: { graph: "heartbeat-interval" } });
      // Seed a running job so each heartbeat emission produces a correlated event snapshot.
      graphState.createJob("job-heartbeat-interval", { createdAt: clock.now, goal: "monitor heartbeat", state: "running" });

      startHeartbeat();

      await clock.tickAsync(500);
      const firstPass = listHeartbeatTimestamps();
      expect(firstPass, "heartbeat tick should be emitted after 500ms").to.have.length(1);
      expect(firstPass[0]).to.equal(500);

      configureRuntimeTimings({ ...originalTimings, heartbeatIntervalMs: 750 });

      await clock.tickAsync(750);
      const secondPass = listHeartbeatTimestamps();
      expect(secondPass, "second heartbeat should be emitted after reconfiguration").to.have.length(2);
      expect(secondPass[1] - secondPass[0]).to.equal(750);
    } finally {
      stopHeartbeat();
      configureRuntimeTimings(originalTimings);
      configureRuntimeFeatures(originalFeatures);
      graphState.resetFromSnapshot(baselineGraph);
      clock.restore();
    }
  });
});
