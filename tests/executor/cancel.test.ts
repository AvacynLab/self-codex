import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";

import {
  registerCancellation,
  getCancellation,
  unregisterCancellation,
  requestCancellation,
  resetCancellationRegistry,
  CancellationNotFoundError,
} from "../../src/executor/cancel.js";

/**
 * Regression tests ensuring the cancellation registry always exposes
 * fully-initialised handles. The suite guards against regressions where the
 * underlying bookkeeping entry could leak a `null` handle to callers that use
 * {@link getCancellation} immediately after registration.
 */
describe("executor cancellation registry handle exposure", () => {
  beforeEach(() => {
    // Each test starts from a clean state so handles registered elsewhere do
    // not influence the expectations below.
    resetCancellationRegistry();
  });

  afterEach(() => {
    // The registry is reset after every test to keep follow-up suites isolated
    // from the side effects triggered here.
    resetCancellationRegistry();
  });

  it("exposes a non-null handle through getCancellation once registered", () => {
    const opId = "op-handle-ready";
    const runId = "run-handle-ready";

    // Register a cancellation handle and immediately fetch it from the
    // registry. The lookup must return the same object reference so runtime
    // code never observes partially initialised entries.
    const handle = registerCancellation(opId, { createdAt: 0, runId });
    const lookup = getCancellation(opId);

    expect(lookup).to.equal(handle);
    expect(lookup?.runId).to.equal(runId);

    unregisterCancellation(opId);
  });

  it("returns undefined once a handle has been unregistered", () => {
    const opId = "op-handle-cleanup";

    // Register then immediately dispose of the handle so the registry no
    // longer retains it for subsequent lookups.
    registerCancellation(opId, { createdAt: 0 });
    unregisterCancellation(opId);

    expect(getCancellation(opId)).to.equal(undefined);

    // Follow-up cancellation requests should surface the structured
    // not-found error to mirror the production behaviour.
    expect(() => requestCancellation(opId)).to.throw(CancellationNotFoundError);
  });
});
