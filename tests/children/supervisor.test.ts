/**
 * Integration tests for the process supervision helpers. The scenarios focus on
 * validating the exponential backoff, circuit breaker transitions and the
 * recovery path after the cooldown window elapses.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { ChildCircuitOpenError, OneForOneSupervisor } from "../../src/children/supervisor.js";

/** Simple deterministic clock used to drive the supervisor without real timers. */
function createFakeClock(start = 0) {
  let now = start;
  return {
    /** Returns the current fake timestamp. */
    now(): number {
      return now;
    },
    /** Advances the internal clock by the provided offset. */
    advance(delta: number): void {
      now += delta;
    },
    /** Async helper compatible with the supervisor sleep primitive. */
    async sleep(delta: number): Promise<void> {
      now += delta;
    },
  };
}

describe("process supervision", () => {
  it("applies exponential backoff, opens the breaker and recovers after cooldown", async () => {
    const clock = createFakeClock();
    const supervisor = new OneForOneSupervisor({
      breaker: {
        failThreshold: 3,
        cooldownMs: 500,
        halfOpenMaxInFlight: 1,
      },
      minBackoffMs: 100,
      maxBackoffMs: 400,
      backoffFactor: 2,
      now: () => clock.now(),
      sleep: (ms) => clock.sleep(ms),
    });
    const key = "node::test";

    const attempt1 = await supervisor.acquire(key);
    expect(clock.now(), "first attempt should not wait").to.equal(0);
    attempt1.fail();
    expect(clock.now(), "time does not advance on failure bookkeeping").to.equal(0);

    const attempt2 = await supervisor.acquire(key);
    expect(clock.now(), "second attempt waits for the initial backoff").to.equal(100);
    attempt2.fail();
    expect(clock.now(), "time is preserved after the second failure").to.equal(100);

    const attempt3 = await supervisor.acquire(key);
    expect(clock.now(), "third attempt waits with the doubled backoff").to.equal(300);
    attempt3.fail();
    expect(clock.now(), "clock remains at the last scheduled timestamp").to.equal(300);

    let rejection: unknown;
    try {
      await supervisor.acquire(key);
    } catch (error) {
      rejection = error;
    }
    expect(rejection, "circuit breaker should reject further attempts").to.be.instanceOf(ChildCircuitOpenError);
    const openError = rejection as ChildCircuitOpenError;
    expect(openError.retryAt, "retry timestamp matches cooldown from trip moment").to.equal(800);
    expect(clock.now(), "rejection does not advance the clock").to.equal(300);

    clock.advance(500);

    const halfOpen = await supervisor.acquire(key);
    expect(clock.now(), "probe after cooldown does not wait").to.equal(800);
    halfOpen.succeed();

    const recovered = await supervisor.acquire(key);
    expect(clock.now(), "closed breaker resets the backoff").to.equal(800);
    recovered.succeed();
  });
});
