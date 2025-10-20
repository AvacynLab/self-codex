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
    type TimeoutParameters = Parameters<typeof globalThis.setTimeout>;
    type TimeoutReturn = ReturnType<typeof globalThis.setTimeout>;

    // Acquire a genuine timeout handle so equality assertions remain type-safe.
    const fakeHandle = originalSetTimeout(() => undefined, 0);
    originalClearTimeout(fakeHandle);

    const override = sinon
      .stub(globalThis, "setTimeout")
      .callsFake((...args: TimeoutParameters): TimeoutReturn => {
        const [handler] = args;
        if (typeof handler === "function") {
          const extraArgs: unknown[] = args.slice(2);
          handler(...extraArgs);
        }
        return fakeHandle;
      });

    const handler = sinon.stub();
    const handle = runtimeTimers.setTimeout(handler, 25, "payload");

    sinon.assert.calledOnce(override);
    sinon.assert.calledWithExactly(override, sinon.match.func, 25, "payload");
    sinon.assert.calledOnceWithExactly(handler, "payload");
    expect(handle).to.equal(fakeHandle);
  });

  it("delegates clearTimeout calls to global overrides", () => {
    const fakeHandle = originalSetTimeout(() => undefined, 0);
    originalClearTimeout(fakeHandle);

    const override = sinon.stub(globalThis, "clearTimeout");

    runtimeTimers.clearTimeout(fakeHandle);

    sinon.assert.calledOnceWithExactly(override, fakeHandle);
  });

  it("delegates setInterval and clearInterval calls to global overrides", () => {
    type IntervalParameters = Parameters<typeof globalThis.setInterval>;
    type IntervalReturn = ReturnType<typeof globalThis.setInterval>;

    const fakeHandle = originalSetInterval(() => undefined, 0);
    originalClearInterval(fakeHandle);

    const setOverride = sinon
      .stub(globalThis, "setInterval")
      .callsFake((...args: IntervalParameters): IntervalReturn => {
        const [handler] = args;
        if (typeof handler === "function") {
          handler();
        }
        return fakeHandle;
      });
    const clearOverride = sinon.stub(globalThis, "clearInterval");

    const handle = runtimeTimers.setInterval(() => undefined, 15);
    runtimeTimers.clearInterval(handle);

    sinon.assert.calledOnceWithExactly(setOverride, sinon.match.func, 15);
    sinon.assert.calledOnceWithExactly(clearOverride, fakeHandle);
  });
});
