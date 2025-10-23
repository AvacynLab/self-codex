import { describe, it } from "mocha";
import { expect } from "chai";

import { serialiseGraphWorkerError } from "../../src/infra/graphWorkerThread.js";

/**
 * Regression suite ensuring the graph worker serialises errors without emitting
 * optional fields when the runtime omits them. The behaviour keeps the worker
 * compliant with `exactOptionalPropertyTypes` while preserving informative
 * telemetry for debugging.
 */
describe("infra/graph worker thread optional fields", () => {
  it("omits stack traces when the error does not expose one", () => {
    const error = new Error("failed");
    (error as Error & { stack?: string | undefined }).stack = undefined;

    const serialised = serialiseGraphWorkerError(error);

    expect(serialised).to.deep.equal({ name: "Error", message: "failed" });
    expect("stack" in serialised).to.equal(false);
  });

  it("preserves stack traces when the runtime provides them", () => {
    const error = new Error("boom");
    (error as Error & { stack?: string }).stack = "trace";

    const serialised = serialiseGraphWorkerError(error);

    expect(serialised).to.deep.equal({ name: "Error", message: "boom", stack: "trace" });
  });

  it("normalises blank error names and non-Error payloads", () => {
    const error = new Error("bad request");
    error.name = "   ";
    (error as Error & { stack?: string | undefined }).stack = "   ";

    const serialisedFromError = serialiseGraphWorkerError(error);
    expect(serialisedFromError).to.deep.equal({ name: "Error", message: "bad request" });

    const serialisedFromString = serialiseGraphWorkerError("raw failure");
    expect(serialisedFromString).to.deep.equal({ name: "Error", message: "raw failure" });
  });
});
