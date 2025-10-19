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
    // Capture the structured log emitted through the main logger so we can
    // assert that both the logger and event store observe the same payload.
    const logEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = {
      info(event: string, payload: Record<string, unknown>) {
        logEntries.push({ event, payload });
      },
      warn() {},
      error() {},
    };
    __httpServerInternals.publishHttpAccessEvent(
      logger as any,
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
    expect(logEntries).to.have.lengthOf(1);
    expect(logEntries[0]?.event).to.equal("http_access");
    expect(logEntries[0]?.payload).to.deep.equal(payload);
  });

  it("logs requests even when no event store is wired", () => {
    const startedAt = process.hrtime.bigint();
    const completedAt = startedAt + BigInt(2_000_000); // ~2 ms
    // Without an event store, the helper must still emit the canonical
    // `http_access` log so operators retain visibility in development setups.
    const logEntries: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const logger = {
      info(event: string, payload: Record<string, unknown>) {
        logEntries.push({ event, payload });
      },
      warn() {},
      error() {},
    };

    __httpServerInternals.publishHttpAccessEvent(
      logger as any,
      undefined,
      "127.0.0.1",
      "/readyz",
      "GET",
      200,
      startedAt,
      completedAt,
    );

    expect(logEntries).to.have.lengthOf(1);
    expect(logEntries[0]?.event).to.equal("http_access");
    expect(logEntries[0]?.payload).to.deep.equal({
      ip: "127.0.0.1",
      route: "/readyz",
      method: "GET",
      status: 200,
      latency_ms: 2,
    });
  });
});
