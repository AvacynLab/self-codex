import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  BehaviorTreeCancellationError,
  CancellableNode,
  GuardNode,
  RetryNode,
  TimeoutNode,
} from "../src/executor/bt/nodes.js";
import { OperationCancelledError } from "../src/executor/cancel.js";
import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";

/**
 * Deterministic behaviour node returning scripted results across ticks while tracking
 * invocations and resets for assertions. Each reset advances to the next scripted
 * run so tests can express sequences of outcomes across retries.
 */
class ScriptedNode implements BehaviorNode {
  private runIndex = 0;
  private stepIndex = 0;
  public readonly id: string;
  private readonly runs: BehaviorTickResult[][];
  public readonly calls: BehaviorTickResult[] = [];
  public resets = 0;
  private status: BehaviorNodeSnapshot["status"] = "idle";

  constructor(id: string, runs: BehaviorTickResult[][]) {
    this.id = id;
    this.runs = runs;
  }

  async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
    const run = this.runs[Math.min(this.runIndex, this.runs.length - 1)];
    const currentIndex = Math.min(this.stepIndex, run.length - 1);
    const result = run[currentIndex];
    this.calls.push(result);
    this.stepIndex = Math.min(run.length - 1, this.stepIndex + 1);
    this.status = result.status === "running" ? "running" : result.status;
    return result;
  }

  reset(): void {
    this.stepIndex = 0;
    if (this.runIndex < this.runs.length - 1) {
      this.runIndex += 1;
    }
    this.resets += 1;
    this.status = "idle";
  }

  snapshot(): BehaviorNodeSnapshot {
    return {
      id: this.id,
      type: "scripted-node",
      status: this.status,
      progress: this.getProgress() * 100,
      state: {
        runIndex: this.runIndex,
        stepIndex: this.stepIndex,
        resets: this.resets,
      },
    } satisfies BehaviorNodeSnapshot;
  }

  restore(snapshot: BehaviorNodeSnapshot): void {
    if (snapshot.type !== "scripted-node") {
      throw new Error(`expected scripted-node snapshot for ${this.id}, received ${snapshot.type}`);
    }
    const state = snapshot.state as { runIndex?: number; stepIndex?: number; resets?: number } | undefined;
    this.runIndex = typeof state?.runIndex === "number" ? state.runIndex : 0;
    this.stepIndex = typeof state?.stepIndex === "number" ? state.stepIndex : 0;
    this.resets = typeof state?.resets === "number" ? state.resets : 0;
    this.status = snapshot.status;
  }

  getProgress(): number {
    const run = this.runs[Math.min(this.runIndex, this.runs.length - 1)] ?? [];
    if (run.length === 0) {
      return 1;
    }
    const completed = Math.min(this.stepIndex, run.length);
    return completed / run.length;
  }
}

describe("behaviour tree decorators", () => {
  afterEach(() => {
    sinon.restore();
  });

  describe("RetryNode", () => {
    it("waits with jitter between attempts and resets on success", async () => {
      const child = new ScriptedNode("flaky", [[{ status: "failure" }], [{ status: "success" }]]);
      const waitSpy = sinon.spy(async (_ms: number) => {});
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: waitSpy,
        random: () => 0.4,
        variables: {},
      };
      const node = new RetryNode("retry", 3, child, 10, 5);

      const firstTick = await node.tick(runtime);
      expect(firstTick.status).to.equal("running");
      expect(waitSpy.callCount).to.equal(1);
      expect(waitSpy.firstCall.args[0]).to.equal(12);
      expect(child.resets).to.equal(1);

      const secondTick = await node.tick(runtime);
      expect(secondTick.status).to.equal("success");
      expect(child.resets).to.equal(2);
    });

    it("fails once the attempt budget is exhausted", async () => {
      const child = new ScriptedNode("always-fail", [[{ status: "failure" }]]);
      const waitSpy = sinon.spy(async (_ms: number) => {});
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: waitSpy,
        variables: {},
      };
      const node = new RetryNode("retry-budget", 2, child, 5, 0);

      const firstTick = await node.tick(runtime);
      expect(firstTick.status).to.equal("running");
      expect(waitSpy.callCount).to.equal(1);

      const secondTick = await node.tick(runtime);
      expect(secondTick.status).to.equal("failure");
      expect(waitSpy.callCount).to.equal(1);
      expect(child.resets).to.equal(2);
    });

    it("propagates cancellation raised before the first attempt without rewinding the child", async () => {
      const child = new ScriptedNode("cancel-before", [[{ status: "success" }]]);
      const cancellationError = new OperationCancelledError({
        opId: "op-retry-pre",
        runId: "run-retry",
        jobId: null,
        graphId: null,
        nodeId: null,
        childId: null,
        reason: "pre",
      });
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        wait: async () => {},
        variables: {},
        throwIfCancelled: () => {
          throw cancellationError;
        },
      };
      const node = new RetryNode("retry-cancel-before", 3, child, 0, 0);

      const raised = await node.tick(runtime).then(
        () => {
          expect.fail("RetryNode should surface the cancellation before invoking the child");
          return null as never;
        },
        (error) => {
          expect(error).to.equal(cancellationError);
          return error;
        },
      );

      expect(raised).to.equal(cancellationError);
      expect(child.calls).to.deep.equal([]);
      expect(child.resets).to.equal(0);

      // Remove the cancellation hook to ensure the subsequent tick can run normally.
      const cleanRuntime: TickRuntime = { ...runtime, throwIfCancelled: undefined };
      const result = await node.tick(cleanRuntime);
      expect(result.status).to.equal("success");
    });

    it("resets state when cancellation surfaces from the child during execution", async () => {
      class CancellingChild implements BehaviorNode {
        public readonly id = "cancel-child";
        public resets = 0;
        private attempts = 0;
        private status: BehaviorNodeSnapshot["status"] = "idle";

        async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
          this.attempts += 1;
          if (this.attempts === 1) {
            this.status = "failure";
            throw new OperationCancelledError({
              opId: "op-retry-child",
              runId: "run-retry-child",
              jobId: null,
              graphId: null,
              nodeId: null,
              childId: null,
              reason: "child-cancel",
            });
          }
          this.status = "success";
          return { status: "success" };
        }

        reset(): void {
          this.resets += 1;
          this.status = "idle";
        }

        snapshot(): BehaviorNodeSnapshot {
          return {
            id: this.id,
            type: "retry-cancelling-child",
            status: this.status,
            progress: this.getProgress() * 100,
            state: { attempts: this.attempts, resets: this.resets },
          } satisfies BehaviorNodeSnapshot;
        }

        restore(snapshot: BehaviorNodeSnapshot): void {
          if (snapshot.type !== "retry-cancelling-child") {
            throw new Error(`expected retry-cancelling-child snapshot for ${this.id}, received ${snapshot.type}`);
          }
          const state = snapshot.state as { attempts?: number; resets?: number } | undefined;
          this.attempts = typeof state?.attempts === "number" ? state.attempts : 0;
          this.resets = typeof state?.resets === "number" ? state.resets : 0;
          this.status = snapshot.status;
        }

        getProgress(): number {
          return this.attempts > 1 ? 1 : this.attempts > 0 ? 0.5 : 0;
        }
      }

      const child = new CancellingChild();
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        wait: async () => {},
        variables: {},
      };
      const node = new RetryNode("retry-child-cancel", 2, child, 0, 0);

      await node.tick(runtime).then(
        () => {
          expect.fail("RetryNode should propagate the cancellation error raised by the child");
        },
        (error) => {
          expect(error).to.be.instanceOf(OperationCancelledError);
        },
      );

      expect(child.resets).to.equal(1);

      // After cancellation the retry decorator should restart from a clean slate.
      const second = await node.tick(runtime);
      expect(second.status).to.equal("success");
      expect(child.resets).to.equal(2);
    });

    it("cleans up after cancellation triggered during retry backoff", async () => {
      const child = new ScriptedNode("cancel-wait", [
        [{ status: "failure" }],
        [{ status: "success" }],
      ]);
      const cancellationError = new BehaviorTreeCancellationError("cancel wait");
      let callCount = 0;
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        wait: async () => {},
        variables: {},
        throwIfCancelled: () => {
          callCount += 1;
          // The second cooperative check mimics a cancellation happening during the
          // retry delay, after the child has already been rewound.
          if (callCount === 2) {
            throw cancellationError;
          }
        },
      };
      const node = new RetryNode("retry-wait-cancel", 3, child, 5, 0);

      await node.tick(runtime).then(
        () => {
          expect.fail("RetryNode should propagate cancellation during backoff");
        },
        (error) => {
          expect(error).to.equal(cancellationError);
        },
      );

      expect(child.resets).to.equal(1);

      const resumed = await node.tick({ ...runtime, throwIfCancelled: undefined });
      expect(resumed.status).to.equal("success");
      expect(child.resets).to.equal(2);
    });
  });

  describe("TimeoutNode", () => {
    let clock: sinon.SinonFakeTimers | null = null;

    afterEach(() => {
      if (clock) {
        clock.restore();
        clock = null;
      }
    });

    it("fails when the child execution exceeds the configured budget", async () => {
      clock = sinon.useFakeTimers();
      let resets = 0;
      const telemetry: Array<{ durationMs: number; success: boolean; budgetMs: number }> = [];
      const child: BehaviorNode = {
        id: "slow",
        async tick(runtime: TickRuntime): Promise<BehaviorTickResult> {
          await runtime.wait(100);
          return { status: "success" };
        },
        reset(): void {
          resets += 1;
        },
      };
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => (clock ? clock.now : Date.now()),
        wait: async (ms: number) => {
          if (!clock) {
            return;
          }
          await clock.tickAsync(ms);
        },
        variables: {},
        recordTimeoutOutcome: (_category, payload) => {
          telemetry.push(payload);
        },
      };
      const node = new TimeoutNode("timeout", 50, child, { category: "io" });

      const resultPromise = node.tick(runtime);
      await clock.tickAsync(60);
      const result = await resultPromise;

      expect(result.status).to.equal("failure");
      expect(resets).to.equal(2);
      expect(telemetry).to.deep.equal([{ durationMs: 50, success: false, budgetMs: 50 }]);
    });

    it("rewinds the child and wraps custom cancellation causes before execution", async () => {
      const child = new ScriptedNode("guarded-by-timeout", [[{ status: "success" }]]);
      const cancellationCause = new Error("network stalled");
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => {},
        variables: {},
        throwIfCancelled: () => {
          throw cancellationCause;
        },
      };
      const node = new TimeoutNode("timeout-cancel", 100, child);

      const cancellation = await node.tick(runtime).then(
        () => {
          expect.fail("TimeoutNode should surface cancellation");
          return null as never;
        },
        (error) => {
          expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
          return error as BehaviorTreeCancellationError & { cause?: unknown };
        },
      );
      expect(cancellation.message).to.equal("network stalled");
      expect(cancellation.cause).to.equal(cancellationCause);
      expect(child.calls.length).to.equal(0);
      expect(child.resets).to.equal(1);
    });

    it("propagates OperationCancelledError surfaced by the child while resetting state", async () => {
      let resets = 0;
      let calls = 0;
      const cancellationError = new OperationCancelledError({
        opId: "op-timeout-cancel",
        runId: "run-timeout",
        jobId: null,
        graphId: null,
        nodeId: null,
        childId: null,
        reason: "manual abort",
      });
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => new Promise(() => {}),
        variables: {},
        throwIfCancelled: () => {
          calls += 1;
          if (calls >= 2) {
            throw cancellationError;
          }
        },
      };
      const child: BehaviorNode = {
        id: "cancellable-child",
        async tick(innerRuntime: TickRuntime): Promise<BehaviorTickResult> {
          innerRuntime.throwIfCancelled?.();
          return { status: "success" };
        },
        reset(): void {
          resets += 1;
        },
      };
      const node = new TimeoutNode("timeout-child-cancel", 200, child);

      const cancellation = await node.tick(runtime).then(
        () => {
          expect.fail("TimeoutNode should propagate the cancellation error");
          return null as never;
        },
        (error) => {
          expect(error).to.be.instanceOf(OperationCancelledError);
          return error as OperationCancelledError;
        },
      );
      expect(cancellation).to.equal(cancellationError);
      expect(cancellation.details.reason).to.equal("manual abort");
      expect(resets).to.equal(1);
    });
  });

  describe("GuardNode", () => {
    it("short-circuits when the condition does not hold", async () => {
      const child = new ScriptedNode("guarded", [[{ status: "success" }]]);
      const guard = new GuardNode("guard", "flag", true, child);

      const failingRuntime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => {},
        variables: { flag: false },
      };

      const failure = await guard.tick(failingRuntime);
      expect(failure.status).to.equal("failure");
      expect(child.calls.length).to.equal(0);
      expect(child.resets).to.equal(1);

      const passingRuntime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => {},
        variables: { flag: true },
      };

      const success = await guard.tick(passingRuntime);
      expect(success.status).to.equal("success");
      expect(child.calls.length).to.equal(1);
      expect(child.resets).to.equal(2);
    });

    it("wraps cancellation causes raised before evaluating the guard", async () => {
      const child = new ScriptedNode("guarded", [[{ status: "success" }]]);
      const cancellationCause = new Error("external cancellation");
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => {},
        variables: { flag: true },
        throwIfCancelled: () => {
          throw cancellationCause;
        },
      };
      const guard = new GuardNode("guard-cancel", "flag", true, child);

      const cancellation = await guard.tick(runtime).then(
        () => {
          expect.fail("GuardNode should surface cancellation");
          return null as never;
        },
        (error) => {
          expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
          return error as BehaviorTreeCancellationError & { cause?: unknown };
        },
      );
      expect(cancellation.message).to.equal("external cancellation");
      expect(cancellation.cause).to.equal(cancellationCause);
      expect(child.calls.length).to.equal(0);
      expect(child.resets).to.equal(1);
    });

    it("propagates OperationCancelledError when cancellation triggers after a running tick", async () => {
      const child = new ScriptedNode("guarded-running", [[{ status: "running" }]]);
      const cancellationError = new OperationCancelledError({
        opId: "guard-op",
        runId: "guard-run",
        jobId: null,
        graphId: null,
        nodeId: null,
        childId: null,
        reason: "late cancel",
      });
      const cancellations: Array<Error | undefined> = [undefined, undefined, cancellationError];
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => {},
        variables: { flag: true },
        throwIfCancelled: () => {
          const next = cancellations.shift();
          if (next) {
            throw next;
          }
        },
      };
      const guard = new GuardNode("guard-running-cancel", "flag", true, child);

      const running = await guard.tick(runtime);
      expect(running.status).to.equal("running");
      expect(child.calls.length).to.equal(1);
      expect(child.resets).to.equal(0);

      const cancellation = await guard.tick(runtime).then(
        () => {
          expect.fail("GuardNode should propagate the cancellation error");
          return null as never;
        },
        (error) => {
          expect(error).to.be.instanceOf(OperationCancelledError);
          return error as OperationCancelledError;
        },
      );
      expect(cancellation).to.equal(cancellationError);
      expect(cancellation.details.reason).to.equal("late cancel");
      expect(child.resets).to.equal(1);
    });
  });

  describe("CancellableNode", () => {
    it("propagates cancellations as errors while resetting the child", async () => {
      const child = new ScriptedNode("cancellable", [
        [{ status: "running" }],
        [{ status: "running" }, { status: "success" }],
      ]);
      let cancelled = false;
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => {},
        variables: {},
        isCancelled: () => cancelled,
      };
      const node = new CancellableNode("cancellable-node", child);

      const firstTick = await node.tick(runtime);
      expect(firstTick.status).to.equal("running");
      expect(child.calls.length).to.equal(1);

      cancelled = true;
      let caught: unknown;
      try {
        await node.tick(runtime);
      } catch (error) {
        caught = error;
      }
      expect(caught).to.not.equal(undefined);
      if (caught instanceof OperationCancelledError) {
        expect(caught.code).to.equal("E-CANCEL-OP");
      } else {
        expect(caught).to.be.instanceOf(Error);
        expect((caught as Error).name).to.equal("BehaviorTreeCancellationError");
      }
      expect(child.resets).to.be.at.least(1);

      cancelled = false;
      const resumed = await node.tick(runtime);
      expect(resumed.status).to.equal("running");
      const final = await node.tick(runtime);
      expect(final.status).to.equal("success");
    });

    it("wraps arbitrary throwIfCancelled errors into BehaviorTreeCancellationError", async () => {
      const child = new ScriptedNode("cancellable", [[{ status: "success" }]]);
      const cancellationCause = new Error("custom cancellation");
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => {},
        variables: {},
        throwIfCancelled: () => {
          throw cancellationCause;
        },
      };
      const node = new CancellableNode("cancellable-node", child);

      let caught: unknown;
      try {
        await node.tick(runtime);
      } catch (error) {
        caught = error;
      }

      expect(child.calls.length).to.equal(0);
      expect(child.resets).to.equal(1);
      expect(caught).to.be.instanceOf(BehaviorTreeCancellationError);
      expect((caught as BehaviorTreeCancellationError).cause).to.equal(cancellationCause);
      expect((caught as Error).message).to.equal("custom cancellation");
    });

    it("resets the child when cancellation occurs after a running tick", async () => {
      const child = new ScriptedNode("cancellable", [[{ status: "running" }]]);
      const cancellationCause = new Error("late cancellation");
      let cancelled = false;
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        now: () => 0,
        wait: async () => {},
        variables: {},
        throwIfCancelled: () => {
          if (cancelled) {
            throw cancellationCause;
          }
        },
      };
      const node = new CancellableNode("cancellable-node", child);

      const running = await node.tick(runtime);
      expect(running.status).to.equal("running");
      expect(child.calls.length).to.equal(1);
      expect(child.resets).to.equal(0);

      cancelled = true;

      let caught: unknown;
      try {
        await node.tick(runtime);
      } catch (error) {
        caught = error;
      }

      expect(child.resets).to.equal(1);
      expect(caught).to.be.instanceOf(BehaviorTreeCancellationError);
      expect((caught as BehaviorTreeCancellationError).cause).to.equal(cancellationCause);
      expect((caught as Error).message).to.equal("late cancellation");
    });
  });
});
