/**
 * Validates the async streaming iterator exposed by the resource registry. The
 * scenarios ensure snapshots are cloned defensively, pages wake up when new
 * entries are recorded and abort signals short-circuit pending iterations.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../src/coord/blackboard.js";
import {
  ResourceRegistry,
  ResourceWatchAbortedError,
  type ResourceWatchResult,
} from "../src/resources/registry.js";

function collectRunEvent(seq: number, overrides: Partial<ResourceWatchResult["events"][number]> = {}) {
  return {
    seq,
    ts: 1_000 + seq,
    kind: "STATUS",
    level: "info",
    jobId: "job-stream",
    runId: "run-stream",
    opId: null,
    graphId: null,
    nodeId: null,
    childId: null,
    component: "graph",
    stage: "status",
    elapsedMs: null,
    payload: { note: `step-${seq}` },
    ...overrides,
  } satisfies ResourceWatchResult["events"][number];
}

describe("ResourceRegistry.watchStream", () => {
  it("yields existing run events and clones snapshots defensively", async () => {
    const registry = new ResourceRegistry();
    const runId = "run-stream-clone";
    registry.recordRunEvent(runId, collectRunEvent(1, { runId }));
    registry.recordRunEvent(runId, collectRunEvent(2, { runId }));

    const iterable = registry.watchStream(`sc://runs/${runId}/events`);
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const page = await iterator.next();
      expect(page.done).to.equal(false);
      expect(page.value.uri).to.equal(`sc://runs/${runId}/events`);
      expect(page.value.kind).to.equal("run_events");
      expect(page.value.events).to.have.length(2);

      // Mutate the returned snapshot and ensure the registry retains pristine data.
      page.value.events[0].kind = "MUTATED";
      const replay = registry.watch(`sc://runs/${runId}/events`);
      expect(replay.events[0].kind).to.equal("STATUS");
    } finally {
      await iterator.return?.();
    }
  });

  it("waits for subsequent run events before yielding the next page", async () => {
    const registry = new ResourceRegistry();
    const runId = "run-stream-wakeup";
    registry.recordRunEvent(runId, collectRunEvent(1, { runId }));

    const iterable = registry.watchStream(`sc://runs/${runId}/events`, { limit: 1 });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).to.equal(false);
      expect(first.value.events[0].seq).to.equal(1);

      const pending = iterator.next();
      queueMicrotask(() => {
        registry.recordRunEvent(runId, collectRunEvent(2, { runId }));
      });

      const second = await pending;
      expect(second.done).to.equal(false);
      expect(second.value.events).to.have.length(1);
      expect(second.value.events[0].seq).to.equal(2);
      expect(second.value.nextSeq).to.equal(2);
    } finally {
      await iterator.return?.();
    }
  });

  it("streams run events that match the provided filters", async () => {
    const registry = new ResourceRegistry();
    const runId = "run-stream-filter";
    registry.recordRunEvent(runId, collectRunEvent(1, { runId, kind: "PLAN", level: "info" }));
    registry.recordRunEvent(runId, collectRunEvent(2, { runId, kind: "STATUS", level: "warn", opId: "op-keep" }));

    const iterable = registry.watchStream(`sc://runs/${runId}/events`, {
      limit: 1,
      run: { kinds: ["status"], levels: ["warn"], opIds: ["op-keep"] },
    });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).to.equal(false);
      expect(first.value.events).to.have.length(1);
      expect(first.value.events[0]?.seq).to.equal(2);
      expect(first.value.filters?.run).to.deep.equal({ kinds: ["STATUS"], levels: ["warn"], opIds: ["op-keep"] });
      expect(first.value.nextSeq).to.equal(2);

      const pending = iterator.next();
      queueMicrotask(() => {
        registry.recordRunEvent(runId, collectRunEvent(3, { runId, kind: "STATUS", level: "warn", opId: "op-keep" }));
      });

      const second = await pending;
      expect(second.done).to.equal(false);
      expect(second.value.events).to.have.length(1);
      expect(second.value.events[0]?.seq).to.equal(3);
      expect(second.value.filters?.run).to.deep.equal({ kinds: ["STATUS"], levels: ["warn"], opIds: ["op-keep"] });
      expect(second.value.nextSeq).to.equal(3);
    } finally {
      await iterator.return?.();
    }
  });

  it("streams run events constrained by timestamp filters", async () => {
    const registry = new ResourceRegistry();
    const runId = "run-stream-ts";
    registry.recordRunEvent(runId, collectRunEvent(1, { runId, kind: "STATUS", level: "info", ts: 1_000 }));
    registry.recordRunEvent(runId, collectRunEvent(2, { runId, kind: "STATUS", level: "info", ts: 2_000 }));

    const iterable = registry.watchStream(`sc://runs/${runId}/events`, {
      limit: 5,
      // Only events with timestamps >= 1_500 should surface through the stream.
      run: { sinceTs: 1_500 },
    });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).to.equal(false);
      expect(first.value.events).to.have.length(1);
      expect(first.value.events[0]?.seq).to.equal(2);
      expect(first.value.filters?.run).to.deep.equal({ sinceTs: 1_500 });

      const pending = iterator.next();
      queueMicrotask(() => {
        registry.recordRunEvent(runId, collectRunEvent(3, { runId, kind: "STATUS", level: "info", ts: 3_000 }));
      });

      const second = await pending;
      expect(second.done).to.equal(false);
      expect(second.value.events[0]?.seq).to.equal(3);
      expect(second.value.filters?.run).to.deep.equal({ sinceTs: 1_500 });
    } finally {
      await iterator.return?.();
    }
  });

  it("streams child log entries as they arrive", async () => {
    const registry = new ResourceRegistry();
    const childId = "child-stream";
    registry.recordChildLogEntry(childId, {
      ts: 5_000,
      stream: "stdout",
      message: "boot",
    });

    const iterable = registry.watchStream(`sc://children/${childId}/logs`, { limit: 1 });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).to.equal(false);
      expect(first.value.kind).to.equal("child_logs");
      expect(first.value.events[0]).to.include({ message: "boot", stream: "stdout" });

      const pending = iterator.next();
      queueMicrotask(() => {
        registry.recordChildLogEntry(childId, {
          ts: 5_500,
          stream: "stderr",
          message: "warn",
          runId: "run-child",
        });
      });

      const second = await pending;
      expect(second.done).to.equal(false);
      expect(second.value.events[0]).to.include({ message: "warn", runId: "run-child" });
    } finally {
      await iterator.return?.();
    }
  });

  it("streams blackboard events as namespaces mutate", async () => {
    let now = 2_000;
    const blackboard = new BlackboardStore({ now: () => now });
    blackboard.set("core:pending", { task: "triage" });

    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 5 });
    const iterable = registry.watchStream("sc://blackboard/core", { limit: 1 });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).to.equal(false);
      expect(first.value.kind).to.equal("blackboard_namespace");
      expect(first.value.events[0]).to.include({ key: "core:pending", kind: "set" });

      const pending = iterator.next();
      now += 100;
      queueMicrotask(() => {
        blackboard.set("core:active", { task: "review" });
      });

      const second = await pending;
      expect(second.done).to.equal(false);
      expect(second.value.events[0]).to.include({ key: "core:active", kind: "set" });
      expect(second.value.nextSeq).to.equal(2);

      const thirdPending = iterator.next();
      now += 200;
      queueMicrotask(() => {
        blackboard.delete("core:pending");
      });

      const third = await thirdPending;
      expect(third.done).to.equal(false);
      expect(third.value.events[0]).to.include({ key: "core:pending", kind: "delete" });
      expect(third.value.nextSeq).to.equal(3);
    } finally {
      await iterator.return?.();
    }
  });

  it("filters blackboard watch streams by keys and skips unrelated mutations", async () => {
    const blackboard = new BlackboardStore({ historyLimit: 10 });
    blackboard.set("core:alpha", { value: "seed" });

    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });
    const iterable = registry.watchStream("sc://blackboard/core", { keys: ["alpha"] });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const initial = await iterator.next();
      expect(initial.done).to.equal(false);
      expect(initial.value.filters).to.deep.equal({
        keys: ["alpha"],
        blackboard: { keys: ["alpha"] },
      });
      expect(initial.value.events).to.have.length(1);
      expect(initial.value.events[0]).to.include({ key: "core:alpha", kind: "set" });
      expect(initial.value.nextSeq).to.equal(1);

      const pending = iterator.next();
      queueMicrotask(() => {
        blackboard.set("core:beta", { value: "ignored" });
        blackboard.set("core:alpha", { value: "updated" });
      });

      const filtered = await pending;
      expect(filtered.done).to.equal(false);
      expect(filtered.value.events).to.have.length(1);
      expect(filtered.value.events[0]).to.include({ key: "core:alpha", kind: "set" });
      expect(filtered.value.nextSeq).to.equal(3);
      expect(filtered.value.filters).to.deep.equal({
        keys: ["alpha"],
        blackboard: { keys: ["alpha"] },
      });
    } finally {
      await iterator.return?.();
    }
  });

  it("streams blackboard pages constrained by timestamp filters", async () => {
    let now = 1_000;
    const blackboard = new BlackboardStore({ now: () => now, historyLimit: 10 });
    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });
    blackboard.set("core:outside", { value: "seed" });
    const iterable = registry.watchStream("sc://blackboard/core", {
      blackboard: { sinceTs: 1_200, untilTs: 1_500 },
    });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const pending = iterator.next();
      queueMicrotask(() => {
        now = 1_300;
        blackboard.set("core:mid", { value: "keep" });
        now = 1_700;
        blackboard.set("core:late", { value: "skip" });
      });

      const result = await pending;
      expect(result.done).to.equal(false);
      expect(result.value.events.map((event) => event.key)).to.deep.equal(["core:mid"]);
      expect(result.value.nextSeq).to.equal(3);
      expect(result.value.filters?.blackboard).to.deep.equal({ sinceTs: 1_200, untilTs: 1_500 });
    } finally {
      await iterator.return?.();
    }
  });

  it("streams blackboard events filtered by tags", async () => {
    let now = 1_000;
    const blackboard = new BlackboardStore({ now: () => now, historyLimit: 10 });
    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });

    blackboard.set("core:alpha", { note: "seed" }, { tags: ["Urgent", "Focus"] });
    blackboard.set("core:beta", { note: "background" }, { tags: ["backlog"] });
    blackboard.set("core:gamma", { note: "mix" }, { tags: ["urgent"] });
    blackboard.delete("core:beta");
    now += 300;
    blackboard.set("core:ttl", { note: "ephemeral" }, { tags: ["urgent"], ttlMs: 200 });
    now += 300;
    blackboard.evictExpired();

    const iterable = registry.watchStream("sc://blackboard/core", {
      limit: 2,
      blackboard: { tags: ["urgent"] },
    });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.done).to.equal(false);
      expect(first.value.events.map((event) => event.key)).to.deep.equal([
        "core:alpha",
        "core:gamma",
      ]);
      expect(first.value.filters?.blackboard).to.deep.equal({ tags: ["urgent"] });

      const second = await iterator.next();
      expect(second.done).to.equal(false);
      expect(second.value.events.map((event) => ({ key: event.key, kind: event.kind }))).to.deep.equal([
        { key: "core:ttl", kind: "set" },
        { key: "core:ttl", kind: "expire" },
      ]);
      expect(second.value.filters?.blackboard).to.deep.equal({ tags: ["urgent"] });

      const pending = iterator.next();
      queueMicrotask(() => {
        now += 200;
        blackboard.set("core:new", { note: "fresh" }, { tags: ["urgent"] });
      });

      const third = await pending;
      expect(third.done).to.equal(false);
      expect(third.value.events.map((event) => event.key)).to.deep.equal(["core:new"]);
      expect(third.value.filters?.blackboard).to.deep.equal({ tags: ["urgent"] });
    } finally {
      await iterator.return?.();
    }
  });

  it("streams blackboard events filtered by mutation kinds", async () => {
    let now = 1_000;
    const blackboard = new BlackboardStore({ now: () => now, historyLimit: 10 });
    blackboard.set("core:seed", { task: "bootstrap" });
    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });

    const iterable = registry.watchStream("sc://blackboard/core", {
      limit: 1,
      blackboard: { kinds: ["delete", "expire"] },
    });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      const firstPending = iterator.next();
      queueMicrotask(() => {
        blackboard.delete("core:seed");
      });

      const first = await firstPending;
      expect(first.done).to.equal(false);
      expect(first.value.events.map((event) => event.kind)).to.deep.equal(["delete"]);
      expect(first.value.filters?.blackboard).to.deep.equal({ kinds: ["delete", "expire"] });

      const secondPending = iterator.next();
      queueMicrotask(() => {
        blackboard.set("core:ttl", { task: "transient" }, { ttlMs: 50 });
        now += 100;
        blackboard.evictExpired();
      });

      const second = await secondPending;
      expect(second.done).to.equal(false);
      expect(second.value.events.map((event) => event.kind)).to.deep.equal(["expire"]);
      expect(second.value.filters?.blackboard).to.deep.equal({ kinds: ["delete", "expire"] });
    } finally {
      await iterator.return?.();
    }
  });

  it("propagates abort signals to pending iterations", async () => {
    const registry = new ResourceRegistry();
    const runId = "run-stream-abort";
    registry.recordRunEvent(runId, collectRunEvent(1, { runId }));

    const controller = new AbortController();
    const iterable = registry.watchStream(`sc://runs/${runId}/events`, {
      fromSeq: 1,
      signal: controller.signal,
    });
    const iterator = iterable[Symbol.asyncIterator]();

    const pending = iterator.next();
    controller.abort();

    try {
      await pending;
      expect.fail("expected the watch stream to abort");
    } catch (error) {
      expect(error).to.be.instanceOf(ResourceWatchAbortedError);
      expect((error as ResourceWatchAbortedError).code).to.equal("E-RES-WATCH_ABORT");
    } finally {
      await iterator.return?.();
    }
  });
});
