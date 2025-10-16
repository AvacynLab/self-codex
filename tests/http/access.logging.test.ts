import { describe, it } from "mocha";
import { expect } from "chai";

import { __httpServerInternals } from "../../src/httpServer.js";
import { EventStore } from "../../src/eventStore.js";

/**
 * Verifies that the HTTP transport emits structured access events into the
 * orchestrator event store so operators can correlate requests with latency and
 * outcomes when debugging incidents.
 */
describe("http access logging", function () {
  it("records an HTTP_ACCESS event for successful JSON-RPC calls", async () => {
    const eventStore = new EventStore({ maxHistory: 16 });
    const startedAt = process.hrtime.bigint();
    const completedAt = startedAt + BigInt(5_000_000); // ~5 ms
    __httpServerInternals.publishHttpAccessEvent(
      eventStore,
      "127.0.0.1",
      "/mcp",
      "POST",
      200,
      startedAt,
      completedAt,
    );
    const accessEvents = eventStore.getEventsByKind("HTTP_ACCESS");
    expect(accessEvents.length).to.be.greaterThan(0);
    const lastEvent = accessEvents[accessEvents.length - 1];
    expect(lastEvent.kind).to.equal("HTTP_ACCESS");
    const payload = (lastEvent.payload ?? {}) as Record<string, unknown>;
    expect(payload.route).to.equal("/mcp");
    expect(payload.method).to.equal("POST");
    expect(payload.status).to.equal(200);
    expect(typeof payload.latency_ms).to.equal("number");
    expect(payload.latency_ms as number).to.be.greaterThanOrEqual(0);
    expect(typeof payload.ip).to.equal("string");
  });
});
