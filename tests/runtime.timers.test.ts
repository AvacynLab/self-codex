import { expect } from "chai";
import sinon from "sinon";

import { runtimeTimers } from "../src/runtime/timers.js";

/**
 * Runtime timer helpers should honour global overrides (e.g. Sinon fake timers).
 * These tests replace the ambient timers with spies to verify the delegation.
 */
describe("runtimeTimers", () => {
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalClearTimeout: typeof globalThis.clearTimeout;
  let originalSetInterval: typeof globalThis.setInterval;
  let originalClearInterval: typeof globalThis.clearInterval;

  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    sinon.restore();
  });

  it("delegates setTimeout calls to global overrides", () => {
    const fakeHandle = { tag: "timeout" };
    const override = sinon.stub().callsFake(
      (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        handler(...args);
        return fakeHandle as unknown as ReturnType<typeof globalThis.setTimeout>;
      },
    );

    globalThis.setTimeout = override as unknown as typeof globalThis.setTimeout;

    const handler = sinon.stub();
    const handle = runtimeTimers.setTimeout(handler, 25, "payload");

    sinon.assert.calledOnce(override);
    sinon.assert.calledWithExactly(override, sinon.match.func, 25, "payload");
    sinon.assert.calledOnceWithExactly(handler, "payload");
    expect(handle).to.equal(fakeHandle);
  });

  it("delegates clearTimeout calls to global overrides", () => {
    const fakeHandle = { tag: "timeout" };
    const override = sinon.stub();
    globalThis.clearTimeout = override as unknown as typeof globalThis.clearTimeout;

    runtimeTimers.clearTimeout(fakeHandle as unknown as number);

    sinon.assert.calledOnceWithExactly(override, fakeHandle);
  });

  it("delegates setInterval and clearInterval calls to global overrides", () => {
    const fakeHandle = { tag: "interval" };
    const setOverride = sinon
      .stub()
      .callsFake((handler: (...args: unknown[]) => void, ms?: number) => {
        handler();
        return fakeHandle as unknown as ReturnType<typeof globalThis.setInterval>;
      });
    const clearOverride = sinon.stub();

    globalThis.setInterval = setOverride as unknown as typeof globalThis.setInterval;
    globalThis.clearInterval = clearOverride as unknown as typeof globalThis.clearInterval;

    const handle = runtimeTimers.setInterval(() => undefined, 15);
    runtimeTimers.clearInterval(handle as unknown as number);

    sinon.assert.calledOnceWithExactly(setOverride, sinon.match.func, 15);
    sinon.assert.calledOnceWithExactly(clearOverride, fakeHandle);
  });
});
