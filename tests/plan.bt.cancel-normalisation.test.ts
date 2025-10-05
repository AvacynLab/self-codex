import { describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  PlanRunBTInputSchema,
  handlePlanRunBT,
  type PlanToolContext,
} from "../src/tools/planTools.js";
import { StigmergyField } from "../src/coord/stigmergy.js";
import { OperationCancelledError } from "../src/executor/cancel.js";
import type { EventCorrelationHints } from "../src/events/correlation.js";

interface RecordedEvent {
  readonly kind: string;
  readonly payload: Record<string, unknown> | null;
  readonly correlation: EventCorrelationHints | null;
}

function buildContext(): { context: PlanToolContext; events: RecordedEvent[]; info: sinon.SinonSpy } {
  const info = sinon.spy();
  const logger = {
    info,
    warn: sinon.spy(),
    error: sinon.spy(),
    debug: sinon.spy(),
  } as unknown as PlanToolContext["logger"];

  const events: RecordedEvent[] = [];
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
    },
    stigmergy: new StigmergyField(),
  } satisfies PlanToolContext;

  return { context, events, info };
}

/**
 * Behaviour tree cancellations raised by tool invocations must surface as
 * OperationCancelledError outcomes so orchestrators receive the structured MCP
 * payload with reason codes and correlation identifiers.
 */
describe("plan_run_bt cancellation normalisation", () => {
  it("normalises Behaviour Tree cancellation errors into OperationCancelledError", async () => {
    const { context, events, info } = buildContext();
    const input = PlanRunBTInputSchema.parse({
      tree: {
        id: "bt-cancel-normalisation",
        root: {
          type: "task",
          id: "abort-node",
          node_id: "abort-node",
          tool: "abort",
          input_key: "payload",
        },
      },
      variables: { payload: { attempt: 1 } },
    });

    let caught: unknown;
    try {
      await handlePlanRunBT(context, input);
    } catch (error) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(OperationCancelledError);
    const cancellationError = caught as OperationCancelledError;
    expect(cancellationError.details.reason).to.equal("behaviour tool aborted by test");

    expect(info.calledWithMatch("plan_run_bt_cancelled", { reason: "behaviour tool aborted by test" })).to.equal(true);

    const errorEvent = events.find((event) => {
      if (event.kind !== "BT_RUN" || !event.payload) {
        return false;
      }
      const phase = (event.payload as { phase?: unknown }).phase;
      return phase === "error";
    });
    expect(errorEvent, "expected lifecycle error event").to.exist;
    const payload = (errorEvent?.payload ?? null) as {
      status?: unknown;
      reason?: unknown;
    } | null;
    expect(payload?.status).to.equal("cancelled");
    expect(payload?.reason).to.equal("behaviour tool aborted by test");
  });
});
