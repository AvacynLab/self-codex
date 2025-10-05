import { afterEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  BehaviorTreeCancellationError,
  SelectorNode,
  SequenceNode,
} from "../src/executor/bt/nodes.js";
import { OperationCancelledError } from "../src/executor/cancel.js";
import type {
  BehaviorNode,
  BehaviorNodeSnapshot,
  BehaviorTickResult,
  TickRuntime,
} from "../src/executor/bt/types.js";

/**
 * Lightweight scripted node used by the composite cancellation tests. Each reset
 * advances to the next scripted run so the scenarios can model retries after
 * cooperative cancellation rewinds the tree.
 */
class ScriptedCompositeChild implements BehaviorNode {
  private runIndex = 0;
  private stepIndex = 0;
  public readonly id: string;
  private readonly runs: BehaviorTickResult[][];
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
      type: "scripted-composite-child",
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
    if (snapshot.type !== "scripted-composite-child") {
      throw new Error(`expected scripted-composite-child snapshot for ${this.id}, received ${snapshot.type}`);
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

describe("behaviour tree composites", () => {
  afterEach(() => {
    sinon.restore();
  });

  describe("SequenceNode", () => {
    it("rewinds all children when cancellation occurs between ticks", async () => {
      const first = new ScriptedCompositeChild("first", [
        [{ status: "success" }],
        [{ status: "success" }],
      ]);
      const second = new ScriptedCompositeChild("second", [
        [{ status: "running" }, { status: "success" }],
        [{ status: "success" }],
      ]);
      const node = new SequenceNode("sequence", [first, second]);

      let cancellationChecks = 0;
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        variables: {},
        throwIfCancelled: () => {
          cancellationChecks += 1;
          if (cancellationChecks === 3) {
            throw new BehaviorTreeCancellationError("sequence cancelled");
          }
        },
      };

      const firstTick = await node.tick(runtime);
      expect(firstTick.status).to.equal("running");
      expect(first.resets).to.equal(0);
      expect(second.resets).to.equal(0);

      await node.tick(runtime).then(
        () => {
          expect.fail("SequenceNode should propagate the cancellation before resuming the running child");
        },
        (error) => {
          expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
        },
      );

      expect(first.resets).to.equal(1);
      expect(second.resets).to.equal(1);

      const cleanRuntime: TickRuntime = {
        ...runtime,
        throwIfCancelled: undefined,
      };
      const completion = await node.tick(cleanRuntime);
      expect(completion.status).to.equal("success");
      expect(first.resets).to.equal(2);
      expect(second.resets).to.equal(2);
    });

    it("resets children when a running child surfaces cancellation", async () => {
      class CancellingChild implements BehaviorNode {
        public readonly id = "cancel";
        public resets = 0;
        private primed = false;
        private status: BehaviorNodeSnapshot["status"] = "idle";

        async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
          if (!this.primed) {
            this.status = "failure";
            throw new OperationCancelledError({
              opId: "op-seq",
              runId: "run-seq",
              jobId: null,
              graphId: null,
              nodeId: null,
              childId: null,
              reason: "sequence child cancel",
            });
          }
          this.status = "success";
          return { status: "success" };
        }

        reset(): void {
          this.resets += 1;
          this.primed = true;
          this.status = "idle";
        }

        snapshot(): BehaviorNodeSnapshot {
          return {
            id: this.id,
            type: "sequence-cancelling-child",
            status: this.status,
            progress: this.getProgress() * 100,
            state: { primed: this.primed, resets: this.resets },
          } satisfies BehaviorNodeSnapshot;
        }

        restore(snapshot: BehaviorNodeSnapshot): void {
          if (snapshot.type !== "sequence-cancelling-child") {
            throw new Error(`expected sequence-cancelling-child snapshot for ${this.id}, received ${snapshot.type}`);
          }
          const state = snapshot.state as { primed?: boolean; resets?: number } | undefined;
          this.primed = state?.primed ?? false;
          this.resets = typeof state?.resets === "number" ? state.resets : 0;
          this.status = snapshot.status;
        }

        getProgress(): number {
          return this.primed ? 1 : 0;
        }
      }

      const child = new CancellingChild();
      const node = new SequenceNode("sequence-cancel", [child]);
      const runtime: TickRuntime = { invokeTool: async () => null, variables: {} };

      await node.tick(runtime).then(
        () => {
          expect.fail("SequenceNode should surface cancellation errors emitted by children");
        },
        (error) => {
          expect(error).to.be.instanceOf(OperationCancelledError);
        },
      );

      expect(child.resets).to.equal(1);

      const completion = await node.tick(runtime);
      expect(completion.status).to.equal("success");
      expect(child.resets).to.equal(2);
    });
  });

  describe("SelectorNode", () => {
    it("rewinds to the first child when cancellation preempts the next candidate", async () => {
      const first = new ScriptedCompositeChild("first-selector", [
        [{ status: "failure" }],
        [{ status: "failure" }],
      ]);
      const second = new ScriptedCompositeChild("second-selector", [
        [{ status: "running" }, { status: "success" }],
        [{ status: "success" }],
      ]);
      const node = new SelectorNode("selector", [first, second]);

      let cancellationChecks = 0;
      const runtime: TickRuntime = {
        invokeTool: async () => null,
        variables: {},
        throwIfCancelled: () => {
          cancellationChecks += 1;
          if (cancellationChecks === 3) {
            throw new BehaviorTreeCancellationError("selector cancelled");
          }
        },
      };

      const firstTick = await node.tick(runtime);
      expect(firstTick.status).to.equal("running");
      expect(first.resets).to.equal(0);
      expect(second.resets).to.equal(0);

      await node.tick(runtime).then(
        () => {
          expect.fail("SelectorNode should propagate cancellation before retrying the running child");
        },
        (error) => {
          expect(error).to.be.instanceOf(BehaviorTreeCancellationError);
        },
      );

      expect(first.resets).to.equal(1);
      expect(second.resets).to.equal(1);

      const cleanRuntime: TickRuntime = {
        ...runtime,
        throwIfCancelled: undefined,
      };
      const completion = await node.tick(cleanRuntime);
      expect(completion.status).to.equal("success");
      expect(first.resets).to.equal(2);
      expect(second.resets).to.equal(2);
    });

    it("resets the failing child when cancellation is thrown mid-execution", async () => {
      class CancellingSelectorChild implements BehaviorNode {
        public readonly id = "selector-cancel";
        public resets = 0;
        private allowSuccess = false;
        private status: BehaviorNodeSnapshot["status"] = "idle";

        async tick(_runtime: TickRuntime): Promise<BehaviorTickResult> {
          if (!this.allowSuccess) {
            this.status = "failure";
            throw new OperationCancelledError({
              opId: "op-selector",
              runId: "run-selector",
              jobId: null,
              graphId: null,
              nodeId: null,
              childId: null,
              reason: "selector child cancel",
            });
          }
          this.status = "success";
          return { status: "success" };
        }

        reset(): void {
          this.resets += 1;
          this.allowSuccess = true;
          this.status = "idle";
        }

        snapshot(): BehaviorNodeSnapshot {
          return {
            id: this.id,
            type: "selector-cancelling-child",
            status: this.status,
            progress: this.getProgress() * 100,
            state: { allowSuccess: this.allowSuccess, resets: this.resets },
          } satisfies BehaviorNodeSnapshot;
        }

        restore(snapshot: BehaviorNodeSnapshot): void {
          if (snapshot.type !== "selector-cancelling-child") {
            throw new Error(`expected selector-cancelling-child snapshot for ${this.id}, received ${snapshot.type}`);
          }
          const state = snapshot.state as { allowSuccess?: boolean; resets?: number } | undefined;
          this.allowSuccess = state?.allowSuccess ?? false;
          this.resets = typeof state?.resets === "number" ? state.resets : 0;
          this.status = snapshot.status;
        }

        getProgress(): number {
          return this.allowSuccess ? 1 : 0;
        }
      }

      const failing = new ScriptedCompositeChild("always-fail", [
        [{ status: "failure" }],
        [{ status: "failure" }],
      ]);
      const cancelling = new CancellingSelectorChild();
      const node = new SelectorNode("selector-cancel", [failing, cancelling]);
      const runtime: TickRuntime = { invokeTool: async () => null, variables: {} };

      await node.tick(runtime).then(
        () => {
          expect.fail("SelectorNode should surface cancellation errors raised by children");
        },
        (error) => {
          expect(error).to.be.instanceOf(OperationCancelledError);
        },
      );

      expect(failing.resets).to.equal(1);
      expect(cancelling.resets).to.equal(1);

      const completion = await node.tick(runtime);
      expect(completion.status).to.equal("success");
      expect(failing.resets).to.equal(2);
      expect(cancelling.resets).to.equal(2);
    });
  });
});

