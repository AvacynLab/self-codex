import { describe, it } from "mocha";
import { expect } from "chai";

import { buildJsonRpcObservabilityInput } from "../../src/orchestrator/runtime.js";

type ObservabilityBase = Parameters<typeof buildJsonRpcObservabilityInput>[0];

const correlationStub: ObservabilityBase["correlation"] = {
  runId: null,
  opId: null,
  jobId: null,
  childId: null,
};

describe("runtime JSON-RPC observability input", () => {
  it("omits the transport field when the runtime context does not provide one", () => {
    const base = {
      stage: "request" as const,
      method: "tools/call",
      requestId: "req",
      correlation: correlationStub,
      status: "pending" as const,
    };

    const payload = buildJsonRpcObservabilityInput(base, undefined);
    expect(Object.prototype.hasOwnProperty.call(payload, "transport")).to.equal(false);
  });

  it("preserves the transport tag when the runtime context supplies one", () => {
    const base = {
      stage: "response" as const,
      method: "tools/call",
      requestId: "req",
      correlation: correlationStub,
      status: "ok" as const,
      elapsedMs: 42,
    };

    const payload = buildJsonRpcObservabilityInput(base, "http");
    expect(payload.transport).to.equal("http");
    expect(payload.elapsedMs).to.equal(42);
  });

  it("omits the transport field when the runtime context explicitly sends null", () => {
    const base = {
      stage: "error" as const,
      method: "tools/call",
      requestId: null,
      correlation: correlationStub,
      status: "error" as const,
      errorMessage: "boom",
      errorCode: 500,
    };

    const payload = buildJsonRpcObservabilityInput(base, null);
    expect(Object.prototype.hasOwnProperty.call(payload, "transport")).to.equal(false);
    expect(payload.errorMessage).to.equal("boom");
  });
});
