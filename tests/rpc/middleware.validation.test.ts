/**
 * Focused tests ensuring the JSON-RPC middleware rejects malformed payloads
 * with typed `VALIDATION_ERROR` responses instead of bubbling generic failures
 * to the transport layer. The suite exercises both schema-based validation and
 * routing errors to guarantee clients can rely on consistent error envelopes.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import {
  createJsonRpcError,
  createRpcHandler,
  JSON_RPC_ERROR_TAXONOMY,
  type NormalisedJsonRpcRequest,
} from "../../src/rpc/middleware.js";
import type { JsonRpcRequest } from "../../src/server.js";

describe("rpc middleware validation", () => {
  it("maps malformed payloads to validation errors without routing", async () => {
    let routed = false;
    const handler = createRpcHandler({
      async route(): Promise<never> {
        routed = true;
        throw new Error("should not reach router");
      },
    });

    const response = await handler(123 as unknown as JsonRpcRequest);

    expect(routed, "router must not be invoked on malformed payload").to.equal(false);
    expect(response.error, "error payload must exist").to.exist;
    expect(response.error?.code, "invalid request must surface the schema code").to.equal(-32600);
    expect((response.error?.data as { category?: string })?.category).to.equal("VALIDATION_ERROR");
  });

  it("rejects schema violations with VALIDATION_ERROR responses", async () => {
    let routed = false;
    const handler = createRpcHandler({
      async route(): Promise<never> {
        routed = true;
        throw new Error("should not route invalid payload");
      },
    });

    const response = await handler({
      jsonrpc: "2.0",
      id: "req-1",
      method: "tools_list",
      params: { names: "invalid" },
    });

    expect(routed, "schema failure must short-circuit before routing").to.equal(false);
    expect(response.id).to.equal("req-1");
    expect(response.error?.code).to.equal(JSON_RPC_ERROR_TAXONOMY.VALIDATION_ERROR.code);
    const issues = (response.error?.data as { issues?: Record<string, unknown> })?.issues ?? {};
    expect(issues, "issues payload must reference the invalid field").to.have.property("names");
  });

  it("forwards valid requests to the router", async () => {
    let routed = false;
    const handler = createRpcHandler({
      async route(request: NormalisedJsonRpcRequest) {
        routed = true;
        expect(request.schemaApplied, "validation should run before routing").to.equal(true);
        return { jsonrpc: "2.0", id: request.request.id ?? null, result: { ok: true } };
      },
    });

    const response = await handler({
      jsonrpc: "2.0",
      id: 42,
      method: "tools_list",
      params: {},
    });

    expect(routed, "router must receive a validated payload").to.equal(true);
    expect(response.result).to.deep.equal({ ok: true });
  });

  it("maps router-level JsonRpcErrors back to JSON-RPC responses", async () => {
    const handler = createRpcHandler({
      async route(request: NormalisedJsonRpcRequest) {
        throw createJsonRpcError("VALIDATION_ERROR", "synthetic failure", {
          requestId: request.request.id,
          hint: "router rejected payload",
        });
      },
    });

    const response = await handler({
      jsonrpc: "2.0",
      id: "req-router",
      method: "tools_list",
      params: {},
    });

    expect(response.id).to.equal("req-router");
    expect(response.error?.code).to.equal(JSON_RPC_ERROR_TAXONOMY.VALIDATION_ERROR.code);
    expect((response.error?.data as { hint?: string })?.hint).to.equal("router rejected payload");
  });
});
