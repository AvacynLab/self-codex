import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "mocha";

import {
  ChildSupervisor,
  ChildCircuitOpenError,
  OneForOneSupervisor,
  type SupervisorEvent,
} from "../../src/children/supervisor.js";
import { EventBus } from "../../src/events/bus.js";
import type { ChildSupervisorEventPayload } from "../../src/events/types.js";

/**
 * Helper constructing a supervisor with deterministic timing primitives so the
 * tests can assert precise delays without waiting in real time.
 */
function buildSupervisor(
  overrides: Partial<{
    failThreshold: number;
    cooldownMs: number;
    halfOpenMax: number;
    minBackoffMs: number;
    maxBackoffMs: number;
    backoffFactor: number;
    maxRestartsPerMinute: number | null;
  }> = {},
  onEvent?: (event: SupervisorEvent) => void,
) {
  let now = 0;
  const sleeps: number[] = [];
  const supervisor = new OneForOneSupervisor({
    breaker: {
      failThreshold: overrides.failThreshold ?? 2,
      cooldownMs: overrides.cooldownMs ?? 1_000,
      halfOpenMaxInFlight: overrides.halfOpenMax ?? 1,
      now: () => now,
    },
    minBackoffMs: overrides.minBackoffMs ?? 10,
    maxBackoffMs: overrides.maxBackoffMs ?? 160,
    backoffFactor: overrides.backoffFactor ?? 2,
    maxRestartsPerMinute: overrides.maxRestartsPerMinute ?? null,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    onEvent,
  });
  return { supervisor, advance: (ms: number) => (now += ms), getNow: () => now, sleeps };
}

describe("OneForOneSupervisor", () => {
  it("opens the breaker after repeated failures and emits lifecycle events", async () => {
    const events: SupervisorEvent[] = [];
    const { supervisor, advance, getNow, sleeps } = buildSupervisor({}, (event) => {
      events.push(event);
    });

    const first = await supervisor.acquire("worker");
    assert.equal(first.state, "closed", "first probe should see a closed breaker");
    first.fail();

    const second = await supervisor.acquire("worker");
    assert.equal(second.state, "closed", "second probe still sees a closed breaker before tripping");
    second.fail();

    await assert.rejects(
      supervisor.acquire("worker"),
      (error: unknown) => {
        assert.ok(error instanceof ChildCircuitOpenError, "error should reflect an open breaker");
        assert.equal(error.state, "open");
        assert.equal(
          error.retryAt,
          getNow() + 1_000,
          "retryAt should be derived from the configured cooldown",
        );
        return true;
      },
    );

    advance(1_000);

    const third = await supervisor.acquire("worker");
    assert.equal(third.state, "half-open", "third attempt should probe the half-open state");
    third.succeed();

    const types = events.map((event) => event.type);
    const openEvents = types.filter((type) => type === "breaker_open");
    assert.ok(
      openEvents.length >= 2,
      "open events should be emitted when tripping and when rejecting",
    );
    assert.ok(types.includes("breaker_half_open"), "half-open transition should be surfaced");
    assert.ok(types.includes("breaker_closed"), "closing the breaker should be surfaced");

    const restartEvents = events.filter((event) => event.type === "child_restart");
    assert.equal(restartEvents.length, 3, "three restart events expected");
    assert.deepEqual(
      restartEvents.map((event) => event.at),
      restartEvents.map((event) => event.at).slice().sort((a, b) => a - b),
      "restart events should be ordered chronologically",
    );
    assert.deepEqual(
      restartEvents.map((event) => event.attempt),
      [1, 2, 3],
      "attempt counters should increment across retries",
    );
    assert.deepEqual(
      restartEvents.map((event) => event.delayMs),
      [0, 10, 0],
      "backoff scheduling should surface on restart events",
    );
    assert.deepEqual(
      restartEvents.map((event) => event.backoffWaitMs),
      [0, 10, 0],
      "backoff wait metadata should mirror the recorded delays",
    );
    assert.deepEqual(
      restartEvents.map((event) => event.quotaWaitMs),
      [0, 0, 0],
      "quota waits remain inactive without a configured limit",
    );
    assert.deepEqual(sleeps, [10], "only the second attempt should incur a backoff sleep");
  });

  it("enforces restart quotas within a one-minute window", async () => {
    const events: SupervisorEvent[] = [];
    const { supervisor, sleeps } = buildSupervisor(
      {
        failThreshold: 99,
        minBackoffMs: 0,
        maxBackoffMs: 0,
        backoffFactor: 1,
        maxRestartsPerMinute: 2,
      },
      (event) => {
        events.push(event);
      },
    );

    const first = await supervisor.acquire("throttled");
    first.fail();
    const second = await supervisor.acquire("throttled");
    second.fail();

    const third = await supervisor.acquire("throttled");
    third.succeed();

    assert.ok(
      sleeps.some((value) => value >= 60_000),
      "a one-minute sleep should enforce the rate limit",
    );

    const quotaWaits = events
      .filter((event): event is Extract<SupervisorEvent, { type: "child_restart" }> => event.type === "child_restart")
      .map((event) => event.quotaWaitMs);
    assert.ok(
      quotaWaits.some((wait) => wait >= 60_000),
      "restart events should record the quota-imposed delay",
    );
  });

  it("propagates null retryAt when half-open concurrency saturates", async () => {
    const { supervisor, advance } = buildSupervisor({ failThreshold: 1, cooldownMs: 5, halfOpenMax: 1 });

    const initial = await supervisor.acquire("worker");
    initial.fail();

    advance(5);

    const halfOpen = await supervisor.acquire("worker");

    await assert.rejects(
      supervisor.acquire("worker"),
      (error: unknown) => {
        assert.ok(error instanceof ChildCircuitOpenError, "half-open saturation should raise ChildCircuitOpenError");
        assert.equal(error.retryAt, null, "retryAt should normalise to null when half-open capacity blocks retries");
        return true;
      },
    );

    halfOpen.fail();
  });
});

describe("ChildSupervisor optional fields", () => {
  it("emits breaker events with explicit null retryAt and no undefined payloads", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-events-"));
    const bus = new EventBus({ now: () => 0 });
    const published: Array<ReturnType<typeof bus.publish>> = [];
    const originalPublish = bus.publish.bind(bus);
    bus.publish = ((input) => {
      const envelope = originalPublish(input);
      published.push(envelope);
      return envelope;
    }) as typeof bus.publish;

    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [],
      eventBus: bus,
    });

    try {
      const dispatch = supervisor as unknown as { handleSupervisionEvent(event: SupervisorEvent): void };
      dispatch.handleSupervisionEvent({ type: "breaker_open", key: "worker", retryAt: null });

      assert.equal(published.length, 1, "the supervisor should publish the breaker transition");
      const envelope = published[0];
      assert.equal(envelope.childId, null, "childId defaults to null without a single related runtime");
      const payload = envelope.data as ChildSupervisorEventPayload & {
        event: Extract<SupervisorEvent, { type: "breaker_open" }>;
      };
      assert.ok(payload, "structured payload should be attached to the bus message");
      assert.equal(payload.event.retryAt, null, "retryAt should remain a null sentinel on the published event");
      assert.equal(
        Object.prototype.hasOwnProperty.call(payload.event, "retryAt"),
        true,
        "retryAt should be explicitly present on the event payload",
      );
      assert.notEqual(payload.maxRestartsPerMinute, undefined, "restart quotas should surface as a defined field");
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
