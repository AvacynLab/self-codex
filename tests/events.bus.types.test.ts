import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";
import { EVENT_MESSAGES, type EventMessage } from "../src/events/types.js";

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
        msg: "unknown_event" as unknown as EventMessage,
      }),
    ).to.throw(TypeError, /unknown event message/i);
  });
});
