/**
 * Validation-focused tests for the JSON-RPC middleware. The suite exercises the
 * normalisation helpers to guarantee every transport observes the same error
 * taxonomy and structured metadata when inputs fail validation.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { createJsonRpcError, normaliseJsonRpcRequest, toJsonRpc } from "../../src/rpc/middleware.js";

import type { JsonRpcRequest } from "../../src/server.js";

describe("rpc middleware validation", () => {
  it("applies registered schemas to known methods", () => {
    const request: JsonRpcRequest = { jsonrpc: "2.0", id: "ok", method: "mcp_info", params: {} };
    const normalised = normaliseJsonRpcRequest(request, { requestId: "req-42" });
    expect(normalised.schemaApplied, "schema should be applied").to.equal(true);
    expect(normalised.request.params, "params should be normalised").to.deep.equal({});
    expect(normalised.method).to.equal("mcp_info");
  });

  it("throws a structured error for invalid envelopes", () => {
    try {
      normaliseJsonRpcRequest(null as unknown as JsonRpcRequest, { requestId: "req-invalid" });
      expect.fail("normaliseJsonRpcRequest should throw for invalid bodies");
    } catch (error) {
      const rpcError = error as { code?: number; data?: Record<string, unknown> };
      expect(rpcError).to.have.property("code", -32600);
      expect(rpcError).to.have.nested.property("data.category", "VALIDATION_ERROR");
      expect(rpcError).to.have.nested.property("data.request_id", "req-invalid");
      expect(rpcError).to.have.nested.property("data.hint").that.is.a("string");
    }
  });

  it("surfaces zod issues when method parameters are invalid", () => {
    const badRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: "bad",
      method: "graph_patch",
      params: { graph_id: "", patch: [] },
    };
    try {
      normaliseJsonRpcRequest(badRequest, { requestId: "req-bad" });
      expect.fail("graph_patch without operations should not validate");
    } catch (error) {
      const rpcError = error as { code?: number; data?: Record<string, unknown> };
      expect(rpcError).to.have.property("code", -32602);
      expect(rpcError).to.have.nested.property("data.category", "VALIDATION_ERROR");
      expect(rpcError).to.have.nested.property("data.issues").that.is.an("object");
      expect(rpcError).to.have.nested.property("data.hint").that.includes("patch");
    }
  });

  it("rejects unknown tool calls early", () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "unknown/tool", arguments: {} },
    };
    try {
      normaliseJsonRpcRequest(request, { requestId: "rid-tool" });
      expect.fail("unknown tool should trigger a validation error");
    } catch (error) {
      const rpcError = error as { code?: number; data?: Record<string, unknown> };
      expect(rpcError).to.have.property("code", -32601);
      expect(rpcError).to.have.nested.property("data.category", "VALIDATION_ERROR");
      expect(rpcError).to.have.nested.property("data.hint").that.includes("unknown/tool");
    }
  });

  it("embeds taxonomy metadata when building error responses", () => {
    const jsonError = createJsonRpcError("RATE_LIMITED", undefined, {
      requestId: "rid-json",
      hint: "Too many requests",
    });
    const response = toJsonRpc("rid-json", jsonError);
    expect(response).to.deep.include({ jsonrpc: "2.0", id: "rid-json" });
    expect(response).to.have.nested.property("error.code", jsonError.code);
    expect(response).to.have.nested.property("error.data.category", "RATE_LIMITED");
    expect(response).to.have.nested.property("error.data.hint", "Too many requests");
    expect(response).to.have.nested.property("error.data.request_id", "rid-json");
  });
});
