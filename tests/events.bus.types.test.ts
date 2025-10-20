import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";
import { EVENT_MESSAGES, type EventMessage } from "../src/events/types.js";

/**
 * Coerces a raw string into an {@link EventMessage}. The helper is only used
 * inside tests to emulate untyped JavaScript callers that bypass the catalogued
 * union at compile time while still exercising the runtime guard.
 */
function coerceToEventMessage(value: string): EventMessage {
  return value as EventMessage;
}

/**
 * Verifies that the event bus enforces the curated {@link EventMessage} catalog both at compile time
 * and at runtime. The suite exercises the happy path with every known token and ensures that
 * unrecognised identifiers are rejected defensively so dashboards do not observe fragmented feeds.
 */
describe("event bus message typing", () => {
  it("accepts every catalogued event message", () => {
    const bus = new EventBus({ historyLimit: 1 });
    for (const token of EVENT_MESSAGES) {
      expect(() => bus.publish({ cat: "graph", msg: token })).not.to.throw();
    }
  });

  it("rejects unknown message tokens", () => {
    const bus = new EventBus({ historyLimit: 1 });
    expect(() =>
      bus.publish({
        cat: "graph",
        msg: coerceToEventMessage("unknown_event"),
      }),
    ).to.throw(TypeError, /unknown event message/i);
  });
});
