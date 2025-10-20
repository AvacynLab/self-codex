import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { PlanRunReactiveInputSchema, handlePlanRunReactive, type PlanToolContext } from "../src/tools/planTools.js";
import {
  OperationCancelledError,
  getCancellation,
  requestCancellation,
  resetCancellationRegistry,
} from "../src/executor/cancel.js";
import type { BehaviorNodeDefinition } from "../src/executor/bt/types.js";
import { createPlanToolContext } from "./helpers/planContext.js";

interface RecordedEvent {
  readonly kind: string;
  readonly payload: Record<string, unknown> | null;
}

interface StartEventInfo {
  readonly opId: string;
  readonly runId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Build a minimal plan tool context that records lifecycle breadcrumbs so tests
 * can synchronise with the Behaviour Tree execution without depending on
 * internal implementation details.
 */
function buildReactivePlanContext(): {
  context: PlanToolContext;
  events: RecordedEvent[];
  waitForStart: () => Promise<StartEventInfo>;
} {
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

  const context = createPlanToolContext({
    emitEvent: (event) => {
      const payload =
        event.payload && typeof event.payload === "object"
          ? (structuredClone(event.payload) as Record<string, unknown>)
          : null;
      events.push({ kind: event.kind, payload });
      if (event.kind === "BT_RUN" && payload?.phase === "start") {
        const opId = String(payload.op_id ?? event.correlation?.opId ?? "");
        const runId = String(payload.run_id ?? event.correlation?.runId ?? "");
        const info: StartEventInfo = { opId, runId, payload };
        startInfo = info;
        if (resolveStart) {
          resolveStart(info);
          resolveStart = null;
        }
      }
    },
  });

  return { context, events, waitForStart };
}

/**
 * Helper building a retrying Behaviour Tree branch that keeps the reactive loop
 * alive until cancellation. The guard intentionally fails so the retry decorator
 * waits using the runtime backoff utilities, mirroring long-running workloads.
 */
function buildRetryingTree(idSuffix: string): BehaviorNodeDefinition {
  return {
    type: "retry",
    id: `retry-${idSuffix}`,
    max_attempts: 10,
    backoff_ms: 1_000,
    child: {
      type: "guard",
      id: `guard-${idSuffix}`,
      condition_key: "ready",
      expected: true,
      child: {
        type: "task",
        id: `task-${idSuffix}`,
        node_id: `task-${idSuffix}`,
        tool: "noop",
        input_key: "payload",
      },
    },
  } satisfies BehaviorNodeDefinition;
}

/**
 * Deterministic offsets (in milliseconds) used to inject cancellation at
 * pseudo-random points during the scheduler loop. The sequence exercises
 * different wait durations and ensures cleanup logic runs repeatedly.
 */
const cancellationOffsets = [35, 120, 275];

describe("random cancellation injection", () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    resetCancellationRegistry();
  });

  afterEach(() => {
    clock.restore();
    resetCancellationRegistry();
  });

  it("cancels reactive runs at random offsets and cleans up state", async () => {
    for (const [index, offset] of cancellationOffsets.entries()) {
      const harness = buildReactivePlanContext();
      const input = PlanRunReactiveInputSchema.parse({
        tree: {
          id: `cancel-random-${index}`,
          root: buildRetryingTree(String(index)),
        },
        variables: {
          ready: false,
          payload: { attempt: index },
        },
        tick_ms: 25,
        budget_ms: 500,
      });

      const execution = handlePlanRunReactive(harness.context, input);
      // Convert the execution promise into an always-fulfilled outcome so Node does not
      // warn about late rejection handlers while the fake timer advances deterministically.
      type ExecutionOutcome =
        | { type: "fulfilled"; value: Awaited<ReturnType<typeof handlePlanRunReactive>> }
        | { type: "rejected"; reason: unknown };
      const outcomePromise: Promise<ExecutionOutcome> = execution.then(
        (value) => ({ type: "fulfilled", value }),
        (reason) => ({ type: "rejected", reason }),
      );
      const start = await harness.waitForStart();
      expect(start.opId).to.have.length.greaterThan(0);

      const handleBefore = getCancellation(start.opId);
      expect(handleBefore, "expected cancellation handle to be registered").to.not.be.undefined;

      const reason = `random-cancel-${index}`;
      setTimeout(() => {
        requestCancellation(start.opId, { reason });
      }, offset);

      // Advance the fake clock past the cancellation offset and give the
      // scheduler additional time slices so the reactive loop can unwind and
      // propagate the cancellation through its cleanup hooks.
      await clock.tickAsync(offset + 20);
      await clock.tickAsync(200);
      await clock.tickAsync(500);

      const outcome = await outcomePromise;
      if (outcome.type === "fulfilled") {
        expect.fail("plan_run_reactive should surface OperationCancelledError");
      }
      const caught = outcome.reason;

      expect(caught).to.be.instanceOf(OperationCancelledError);
      const cancellationError = caught as OperationCancelledError;
      expect(cancellationError.details.opId).to.equal(start.opId);
      expect(cancellationError.details.reason).to.equal(reason);

      const handleAfter = getCancellation(start.opId);
      expect(handleAfter, "cancellation handle should be released after cleanup").to.be.undefined;

      const cancelEvents = harness.events.filter(
        (event) => event.kind === "BT_RUN" && event.payload?.phase === "cancel",
      );
      expect(cancelEvents, "expected a single cancel lifecycle event").to.have.lengthOf(1);
      expect(cancelEvents[0]?.payload?.reason ?? null).to.equal(reason);

      const errorEvent = harness.events.find(
        (event) => event.kind === "BT_RUN" && event.payload?.phase === "error",
      );
      expect(errorEvent?.payload?.status).to.equal("cancelled");
    }

    const finalHarness = buildReactivePlanContext();
    const finalInput = PlanRunReactiveInputSchema.parse({
      tree: {
        id: "cancel-random-final",
        root: {
          type: "task",
          id: "final-task",
          node_id: "final-task",
          tool: "noop",
          input_key: "payload",
        },
      },
      variables: {
        payload: { message: "final" },
      },
      tick_ms: 25,
    });

    const finalExecution = handlePlanRunReactive(finalHarness.context, finalInput);
    await clock.tickAsync(25);
    const finalResult = await finalExecution;

    expect(finalResult.status).to.equal("success");
    const completionEvents = finalHarness.events.filter(
      (event) => event.kind === "BT_RUN" && event.payload?.phase === "complete",
    );
    expect(completionEvents).to.have.lengthOf(1);
  });
});
