import { expect } from "chai";

import { EventBus } from "../../src/events/bus.js";
import type { EventMessage } from "../../src/events/types.js";

/**
 * Builds a minimal child stdout payload matching the discriminated union enforced
 * by the event bus. Tests reuse the helper to keep focus on iterator semantics
 * rather than replicating payload scaffolding inline.
 */
function createChildStdoutPayload(overrides: Partial<ReturnType<typeof buildBasePayload>> = {}) {
  return { ...buildBasePayload(), ...overrides };
}

function buildBasePayload() {
  return {
    childId: "child-test",
    stream: "stdout" as const,
    raw: "payload",
    parsed: null,
    receivedAt: 0,
    sequence: 0,
  };
}

/**
 * Behavioural tests covering the async iterator contract exposed by
 * {@link EventBus.subscribe}. The scenarios make sure stream consumers observe
 * deterministic completion semantics whenever they dispose the iterator or the
 * publisher closes it on their behalf.
 */
describe("events/bus stream iteration", () => {
  it("resolves pending consumers when the stream closes", async () => {
    const bus = new EventBus({ now: () => 10 });
    const stream = bus.subscribe();

    // Trigger a pending read so we can assert the close notification resolves it.
    const pending = stream.next();
    stream.close();

    const result = await pending;
    expect(result.done).to.equal(true);
    expect(result.value).to.equal(undefined);
  });

  it("marks the iterator as completed once return() is invoked", async () => {
    const bus = new EventBus({ now: () => 20 });
    const stream = bus.subscribe();
    const message: EventMessage = "child_stdout";

    // Publish a single event so the iterator yields one envelope before
    // returning the terminal result.
    const firstResultPromise = stream.next();
    bus.publish({ cat: "child", msg: message, data: createChildStdoutPayload() });

    const firstResult = await firstResultPromise;
    expect(firstResult.done).to.equal(false);
    expect(firstResult.value.msg).to.equal(message);

    const completion = await stream.return();
    expect(completion.done).to.equal(true);
    expect(completion.value).to.equal(undefined);

    const tailResult = await stream.next();
    expect(tailResult.done).to.equal(true);
    expect(tailResult.value).to.equal(undefined);
  });
});
