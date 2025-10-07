import { describe, it } from "mocha";
import { expect } from "chai";

import { EventBus } from "../src/events/bus.js";

/**
 * Unit coverage for the semantic event kind normalisation logic. The event bus
 * should expose upper-cased identifiers even when publishers send lower-case
 * or padded tokens so downstream filters remain stable across transports.
 */
describe("event bus kind normalisation", () => {
  it("upper-cases explicit kinds while preserving other metadata", () => {
    const bus = new EventBus({ historyLimit: 4, streamBufferSize: 4 });

    bus.publish({
      cat: "child",
      level: "info",
      msg: "child_prompt",
      // Intentionally provide a lower-case kind with surrounding whitespace to
      // verify the normaliser trims and upper-cases the identifier.
      kind: "  prompt  ",
      data: { id: "child-1" },
    });

    const [event] = bus.list();
    expect(event.kind).to.equal("PROMPT");
    expect(event.msg).to.equal("child_prompt");
    expect(event.cat).to.equal("child");
    expect(event.data).to.deep.equal({ id: "child-1" });
  });

  it("omits kind when publishers send empty tokens", () => {
    const bus = new EventBus({ historyLimit: 4, streamBufferSize: 4 });

    bus.publish({
      cat: "child",
      level: "info",
      msg: "child_prompt",
      kind: "   ",
    });

    const [event] = bus.list();
    expect(event.kind).to.equal(undefined);
  });
});
