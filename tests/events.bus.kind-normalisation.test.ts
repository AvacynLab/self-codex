import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";

/**
 * Supplies a typed child runtime payload so the normalisation tests can focus
 * on the `kind` behaviour without repeating the event structure.
 */
function createChildMessagePayload(
  overrides: Partial<ReturnType<typeof baseChildPayload>> = {},
) {
  return { ...baseChildPayload(), ...overrides };
}

function baseChildPayload() {
  return {
    childId: "child-1",
    stream: "stdout" as const,
    raw: "line",
    parsed: null,
    receivedAt: 0,
    sequence: 0,
  };
}

/**
 * Unit coverage for the semantic event kind normalisation logic. The event bus
 * should expose upper-cased identifiers even when publishers send lower-case
 * or padded tokens so downstream filters remain stable across transports.
 */
describe("event bus kind normalisation", () => {
  it("upper-cases explicit kinds while preserving other metadata", () => {
    const bus = new EventBus({ historyLimit: 4, streamBufferSize: 4 });

    const expectedPayload = createChildMessagePayload({
      // The structured payload mirrors the bridge output when emitting stdout
      // lines, including the parsed form surfaced by the Contract-Net helpers.
      parsed: { id: "child-1" },
      raw: "{\"id\":\"child-1\"}",
    });

    bus.publish({
      cat: "child",
      level: "info",
      msg: "child_stdout",
      // Intentionally provide a lower-case kind with surrounding whitespace to
      // verify the normaliser trims and upper-cases the identifier.
      kind: "  prompt  ",
      data: expectedPayload,
    });

    const [event] = bus.list();
    expect(event.kind).to.equal("PROMPT");
    expect(event.msg).to.equal("child_stdout");
    expect(event.cat).to.equal("child");
    expect(event.data).to.deep.equal(expectedPayload);
  });

  it("omits kind when publishers send empty tokens", () => {
    const bus = new EventBus({ historyLimit: 4, streamBufferSize: 4 });

    bus.publish({
      cat: "child",
      level: "info",
      msg: "child_stdout",
      kind: "   ",
    });

    const [event] = bus.list();
    expect(event.kind).to.equal(undefined);
  });
});
