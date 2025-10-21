/**
 * Tests validating the correlation-id propagation and mandatory security
 * headers. They exercise the lightweight helpers directly to avoid network
 * round-trips while guaranteeing deterministic outcomes.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { applySecurityHeaders, ensureRequestId } from "../../src/http/headers.js";
import { MemoryHttpResponse, createJsonRpcRequest } from "../helpers/http.js";

describe("http headers", () => {
  it("generates a request id when none is provided", () => {
    const request = createJsonRpcRequest({ ping: true }, {
      "content-type": "application/json",
      accept: "application/json",
    });
    const response = new MemoryHttpResponse();

    const requestId = ensureRequestId(request, response);
    expect(requestId, "generated id").to.be.a("string");
    expect(requestId.length, "non-empty id").to.be.greaterThan(10);
    expect(response.headers["x-request-id"], "response header").to.equal(requestId);
  });

  it("reuses the incoming request id when available", () => {
    const request = createJsonRpcRequest({ ping: true }, {
      "content-type": "application/json",
      accept: "application/json",
      "x-request-id": "abc-123",
    });
    const response = new MemoryHttpResponse();

    const requestId = ensureRequestId(request, response);
    expect(requestId, "forwarded id").to.equal("abc-123");
    expect(response.headers["x-request-id"], "response header").to.equal("abc-123");
  });

  it("applies the standard security headers", () => {
    const response = new MemoryHttpResponse();
    applySecurityHeaders(response);

    expect(response.headers["x-content-type-options"], "nosniff header").to.equal("nosniff");
    expect(response.headers["x-frame-options"], "frame protection").to.equal("DENY");
    expect(response.headers["referrer-policy"], "referrer policy").to.equal("no-referrer");
  });
});
