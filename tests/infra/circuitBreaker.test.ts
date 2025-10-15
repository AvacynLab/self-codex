/**
 * Unit tests for the circuit breaker registry. The suite exercises the state
 * machine to guarantee failure streaks open the breaker, cooldown windows allow
 * a single probe execution, and successful probes close the breaker again.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { CircuitBreakerRegistry, withCircuitBreaker } from "../../src/infra/circuitBreaker.js";

describe("infra/circuitBreaker", () => {
  it("opens after consecutive failures and blocks executions during cooldown", () => {
    let now = 0;
    const registry = new CircuitBreakerRegistry({
      failThreshold: 2,
      cooldownMs: 1_000,
      now: () => now,
    });

    const key = "tools/call#artifact_write";
    const first = registry.tryAcquire(key, now);
    expect(first.allowed).to.equal(true);
    expect(first.state).to.equal("closed");
    first.fail();

    const second = registry.tryAcquire(key, now);
    expect(second.allowed).to.equal(true);
    expect(second.state).to.equal("closed");
    second.fail();

    let snapshot = registry.snapshot(key);
    expect(snapshot.state).to.equal("open");
    expect(snapshot.retryAt).to.equal(1_000);

    const rejected = registry.tryAcquire(key, 500);
    expect(rejected.allowed).to.equal(false);
    expect(rejected.state).to.equal("open");
    expect(rejected.retryAt).to.equal(1_000);

    now = 1_000;
    const probe = registry.tryAcquire(key, now);
    expect(probe.allowed).to.equal(true);
    expect(probe.state).to.equal("half-open");
    const concurrent = registry.tryAcquire(key, now);
    expect(concurrent.allowed).to.equal(false);
    expect(concurrent.state).to.equal("half-open");

    probe.fail();
    snapshot = registry.snapshot(key);
    expect(snapshot.state).to.equal("open");
    expect(snapshot.retryAt).to.equal(2_000);
  });

  it("requires successful probes to fully close the breaker", () => {
    let now = 0;
    const registry = new CircuitBreakerRegistry({
      failThreshold: 1,
      cooldownMs: 500,
      halfOpenSuccesses: 2,
      now: () => now,
    });

    const key = "tools/call#graph_patch";
    registry.recordFailure(key, now);
    expect(registry.snapshot(key).state).to.equal("open");

    now = 500;
    const firstProbe = registry.tryAcquire(key, now);
    expect(firstProbe.allowed).to.equal(true);
    expect(firstProbe.state).to.equal("half-open");
    firstProbe.succeed();

    let snapshot = registry.snapshot(key);
    expect(snapshot.state).to.equal("half-open");
    expect(snapshot.halfOpenSuccesses).to.equal(1);

    const secondProbe = registry.tryAcquire(key, now);
    expect(secondProbe.allowed).to.equal(true);
    expect(secondProbe.state).to.equal("half-open");
    secondProbe.succeed();

    snapshot = registry.snapshot(key);
    expect(snapshot.state).to.equal("closed");
    expect(snapshot.consecutiveFailures).to.equal(0);
    expect(snapshot.openedAt).to.equal(null);
  });

  it("exposes a helper that short-circuits open breakers", async () => {
    const registry = new CircuitBreakerRegistry({ failThreshold: 1, cooldownMs: 5_000 });
    const key = "tools/call#child_spawn";

    await withCircuitBreaker(registry, key, async () => {
      throw new Error("spawn failed");
    })
      .then(() => {
        expect.fail("expected failure to trip the breaker");
      })
      .catch((error: unknown) => {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("spawn failed");
      });

    const snapshot = registry.snapshot(key);
    expect(snapshot.state).to.equal("open");

    await withCircuitBreaker(registry, key, async () => "ok")
      .then(() => {
        expect.fail("open breaker must short-circuit the invocation");
      })
      .catch((error: unknown) => {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include("circuit breaker open");
      });
  });
});
