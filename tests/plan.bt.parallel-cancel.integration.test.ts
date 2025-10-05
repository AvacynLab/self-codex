import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  PlanRunBTInputSchema,
  handlePlanRunBT,
  type PlanToolContext,
} from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import {
  OperationCancelledError,
  requestCancellation,
  resetCancellationRegistry,
} from "../src/executor/cancel.js";
import type { BehaviorNodeDefinition, ParallelPolicy } from "../src/executor/bt/types.js";
import type { EventCorrelationHints } from "../src/events/correlation.js";

/**
 * Policies exercised by the parallel cancellation integration tests. Each entry
 * includes the human-readable label used in assertions and the runtime policy
 * forwarded to the behaviour tree interpreter.
 */
const parallelPolicies: Array<{ label: string; policy: ParallelPolicy }> = [
  { label: "quota", policy: { mode: "quota", threshold: 2 } },
  { label: "all", policy: "all" },
  { label: "any", policy: "any" },
];

interface RecordedEvent {
  readonly kind: string;
  readonly payload: Record<string, unknown> | null;
  readonly correlation: EventCorrelationHints | null;
}

interface StartEventInfo {
  readonly opId: string;
  readonly runId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Build a retry-based branch that initially fails its guard so the parallel
 * node observes a running status. The guard is retried with a short backoff so
 * tests can trigger cancellation while the runtime is waiting on the delay.
 */
function buildRetryBranch(name: string): BehaviorNodeDefinition {
  return {
    type: "retry",
    id: `${name}-retry`,
    max_attempts: 3,
    backoff_ms: 100,
    child: {
      type: "guard",
      id: `${name}-guard`,
      condition_key: `${name}_ready`,
      expected: true,
      child: {
        type: "task",
        id: `${name}-task`,
        node_id: `${name}-task`,
        tool: "noop",
        input_key: `${name}_payload`,
      },
    },
  } satisfies BehaviorNodeDefinition;
}

/**
 * Assemble the root parallel definition shared across the cancellation
 * scenarios so the tests can swap policies without duplicating the structure.
 */
function buildParallelRoot(label: string, policy: ParallelPolicy): BehaviorNodeDefinition {
  return {
    type: "parallel",
    id: `parallel-${label}`,
    policy,
    children: [buildRetryBranch("alpha"), buildRetryBranch("beta"), buildRetryBranch("gamma")],
  } satisfies BehaviorNodeDefinition;
}

function buildPlanContext(): {
  context: PlanToolContext;
  events: RecordedEvent[];
  waitForStart: () => Promise<StartEventInfo>;
} {
  const logger = {
    info: sinon.spy(),
    warn: sinon.spy(),
    error: sinon.spy(),
    debug: sinon.spy(),
  } as unknown as PlanToolContext["logger"];

  const events: RecordedEvent[] = [];
  let startInfo: StartEventInfo | null = null;
  let resolveStart: ((info: StartEventInfo) => void) | null = null;
  const startPromise = new Promise<StartEventInfo>((resolve) => {
    resolveStart = resolve;
  });

  const waitForStart = async () => {
    if (startInfo) {
      return startInfo;
    }
    return startPromise;
  };

  const context: PlanToolContext = {
    supervisor: {} as PlanToolContext["supervisor"],
    graphState: {} as PlanToolContext["graphState"],
    logger,
    childrenRoot: "/tmp",
    defaultChildRuntime: "codex",
    emitEvent: (event) => {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : null;
      const correlation = event.correlation ?? null;
      events.push({ kind: event.kind, payload, correlation });
      if (event.kind === "BT_RUN" && payload?.phase === "start") {
        const opId = String(payload.op_id ?? "");
        const runId = String(payload.run_id ?? "");
        startInfo = { opId, runId, payload };
        if (resolveStart) {
          resolveStart(startInfo);
          resolveStart = null;
        }
      }
    },
    stigmergy: new StigmergyField(),
  } satisfies PlanToolContext;

  return { context, events, waitForStart };
}

/**
 * Integration coverage ensuring `plan_run_bt` surfaces cancellation across the
 * different parallel aggregation policies and that the tree can recover cleanly
 * once the cancellation is lifted.
 */
describe("plan_run_bt parallel cancellation integration", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    resetCancellationRegistry();
  });

  afterEach(() => {
    clock.restore();
  });

  for (const { label, policy } of parallelPolicies) {
    it(`cancels and recovers cleanly for the ${label} policy`, async () => {
      const firstRun = buildPlanContext();
      const initialInput = PlanRunBTInputSchema.parse({
        tree: {
          id: `parallel-cancel-${label}`,
          root: buildParallelRoot(label, policy),
        },
        variables: {
          alpha_payload: { branch: "alpha" },
          beta_payload: { branch: "beta" },
          gamma_payload: { branch: "gamma" },
          alpha_ready: false,
          beta_ready: false,
          gamma_ready: false,
        },
      });

      const execution = handlePlanRunBT(firstRun.context, initialInput);
      const start = await firstRun.waitForStart();
      expect(start.opId).to.have.length.greaterThan(0);

      const cancellationReason = `integration cancel ${label}`;
      setTimeout(() => {
        requestCancellation(start.opId, { reason: cancellationReason });
      }, 10);

      await clock.tickAsync(10);

      let caught: unknown;
      try {
        await execution;
      } catch (error) {
        caught = error;
      }

      expect(caught).to.be.instanceOf(OperationCancelledError);
      const cancellationError = caught as OperationCancelledError;
      expect(cancellationError.details.reason).to.equal(cancellationReason);

      const cancelEvent = firstRun.events.find(
        (event) => event.kind === "BT_RUN" && event.payload?.phase === "cancel",
      );
      expect(cancelEvent, "expected cancel lifecycle event").to.exist;
      expect(cancelEvent?.payload?.reason ?? null).to.equal(cancellationReason);

      const errorEvent = firstRun.events.find(
        (event) => event.kind === "BT_RUN" && event.payload?.phase === "error",
      );
      expect(errorEvent, "expected cancellation error lifecycle event").to.exist;
      expect(errorEvent?.payload?.status).to.equal("cancelled");

      const recoveryRun = buildPlanContext();
      const recoveryInput = PlanRunBTInputSchema.parse({
        tree: {
          id: `parallel-recovery-${label}`,
          root: buildParallelRoot(label, policy),
        },
        variables: {
          alpha_payload: { branch: "alpha" },
          beta_payload: { branch: "beta" },
          gamma_payload: { branch: "gamma" },
          alpha_ready: true,
          beta_ready: true,
          gamma_ready: true,
        },
      });

      const recoveryResult = await handlePlanRunBT(recoveryRun.context, recoveryInput);

      expect(recoveryResult.status).to.equal("success");
      expect(recoveryResult.invocations).to.have.length(3);
      expect(recoveryResult.invocations.every((entry) => entry.executed)).to.equal(true);
      expect(recoveryResult.invocations.map((entry) => entry.tool)).to.deep.equal([
        "noop",
        "noop",
        "noop",
      ]);

      const completionEvent = recoveryRun.events.find(
        (event) => event.kind === "BT_RUN" && event.payload?.phase === "complete",
      );
      expect(completionEvent, "expected completion lifecycle event").to.exist;
      expect(completionEvent?.payload?.status).to.equal("success");
    });
  }
});
