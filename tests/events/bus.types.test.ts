import { expect } from "chai";

import { EventBus } from "../../src/events/bus.js";
import {
  EVENT_MESSAGES,
  assertValidEventMessage,
  isEventMessage,
  type EventMessage,
} from "../../src/events/types.js";

/**
 * Regression tests covering the typed event bus contract. The suite exercises the
 * runtime guards that prevent publishers from emitting ad-hoc message tokens so
 * downstream dashboards only observe the curated catalogue declared in
 * {@link EVENT_MESSAGES}.
 */
describe("events/bus type safety", () => {
  it("exposes a non-empty catalogue of allowed event messages", () => {
    expect(EVENT_MESSAGES.length, "known event message count").to.be.greaterThan(0);
  });

  it("recognises every canonical event message token", () => {
    for (const token of EVENT_MESSAGES) {
      expect(isEventMessage(token), `isEventMessage(${token})`).to.equal(true);
      expect(() => assertValidEventMessage(token), `assertValidEventMessage(${token})`).not.to.throw();
    }
  });

  it("rejects unknown message tokens", () => {
    const invalidToken = "made_up_event";

    expect(isEventMessage(invalidToken)).to.equal(false);
    expect(() => assertValidEventMessage(invalidToken)).to.throw(TypeError, /unknown event message/);
  });

  it("prevents publishing events with unknown message identifiers", () => {
    const bus = new EventBus({ now: () => 42 });

    expect(() =>
      bus.publish({
        cat: "child",
        // Cast to emulate untyped JavaScript callers. The runtime guard must still throw.
        msg: "totally_unknown_message" as unknown as EventMessage,
      }),
    ).to.throw(TypeError, /unknown event message/);
  });

  it("normalises valid message tokens before storing envelopes", () => {
    const bus = new EventBus({ now: () => 42 });

    const envelope = bus.publish({
      cat: "child",
      msg: "  child_stdout  " as unknown as EventMessage,
    });

    expect(envelope.msg).to.equal("child_stdout");
    expect(bus.list()).to.have.lengthOf(1);
    expect(bus.list()[0].msg).to.equal("child_stdout");
  });
});
