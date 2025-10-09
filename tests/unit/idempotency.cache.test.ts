import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { IdempotencyRegistry, buildIdempotencyCacheKey } from "../../src/infra/idempotency.js";

describe("idempotency cache", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("computes identical keys for semantically equivalent payloads", () => {
    const keyA = buildIdempotencyCacheKey("child_create", "alpha", { args: ["--foo"], env: { FOO: "1", BAR: "2" } });
    const keyB = buildIdempotencyCacheKey("child_create", "alpha", { env: { BAR: "2", FOO: "1" }, args: ["--foo"] });
    const keyC = buildIdempotencyCacheKey("child_create", "alpha", { env: { BAR: "3", FOO: "1" }, args: ["--foo"] });

    expect(keyA).to.equal(keyB);
    expect(keyC).to.not.equal(keyA);
  });

  it("replays cached results when the same composite key is reused", async () => {
    const registry = new IdempotencyRegistry({ defaultTtlMs: 5_000, clock: () => clock.now });
    const payload = { op_id: "tx-op", graph_id: "graph-1" };
    const cacheKey = buildIdempotencyCacheKey("tx_begin", "tx-key", payload);

    const first = await registry.remember(cacheKey, async () => ({ token: "first" }));
    const second = await registry.remember(cacheKey, async () => ({ token: "second" }));

    expect(first.idempotent).to.equal(false);
    expect(second.idempotent).to.equal(true);
    expect(second.value).to.deep.equal({ token: "first" });
    expect(second.entry.hits).to.equal(2);
  });

  it("expires entries once the TTL elapses", async () => {
    const registry = new IdempotencyRegistry({ defaultTtlMs: 1_000, clock: () => clock.now });
    const cacheKey = buildIdempotencyCacheKey("child_spawn_codex", "spawn-key", { role: "builder" });

    const first = await registry.remember(cacheKey, async () => ({ runId: "one" }));
    clock.tick(1_500);
    const second = await registry.remember(cacheKey, async () => ({ runId: "two" }));

    expect(first.idempotent).to.equal(false);
    expect(second.idempotent).to.equal(false);
    expect(second.value).to.deep.equal({ runId: "two" });
  });
});
