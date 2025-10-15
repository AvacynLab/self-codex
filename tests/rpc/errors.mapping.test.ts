/**
 * Focused tests ensuring the typed JSON-RPC errors serialise to protocol
 * responses with the expected codes, messages and metadata. The suite also
 * verifies that the legacy factory returns specialised subclasses to maintain
 * ergonomic guards in the rest of the codebase.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import {
  AuthError,
  IdempotencyConflict,
  InternalError,
  JSON_RPC_ERROR_TAXONOMY,
  TimeoutError,
  ValidationError,
  createJsonRpcError,
  toJsonRpc,
} from "../../src/rpc/errors.js";

describe("rpc errors mapping", () => {
  it("maps validation errors with hints and issues", () => {
    const error = new ValidationError("Invalid payload", {
      requestId: "req-validation",
      hint: "field `name` is required",
      issues: { name: ["Required"] },
      meta: { severity: "user" },
    });

    const response = toJsonRpc("req-validation", error);

    expect(response).to.deep.include({ jsonrpc: "2.0", id: "req-validation" });
    expect(response).to.have.nested.property(
      "error.code",
      JSON_RPC_ERROR_TAXONOMY.VALIDATION_ERROR.code,
    );
    expect(response).to.have.nested.property("error.message", "Invalid payload");
    expect(response).to.have.nested.property("error.data.category", "VALIDATION_ERROR");
    expect(response).to.have.nested.property("error.data.hint", "field `name` is required");
    expect(response).to.have.nested.property("error.data.issues").that.deep.equals({ name: ["Required"] });
    expect(response).to.have.nested.property("error.data.meta.severity", "user");
  });

  it("creates specialised subclasses for common categories", () => {
    const auth = createJsonRpcError("AUTH_REQUIRED");
    const timeout = createJsonRpcError("TIMEOUT");
    const conflict = createJsonRpcError("IDEMPOTENCY_CONFLICT");
    const internal = createJsonRpcError("INTERNAL");

    expect(auth).to.be.instanceOf(AuthError);
    expect(timeout).to.be.instanceOf(TimeoutError);
    expect(conflict).to.be.instanceOf(IdempotencyConflict);
    expect(internal).to.be.instanceOf(InternalError);
  });

  it("allows overriding protocol codes when necessary", () => {
    const error = createJsonRpcError("INTERNAL", "Upstream failure", {
      code: -32099,
      requestId: "override-1",
      status: 503,
    });

    const response = toJsonRpc("override-1", error);

    expect(response).to.have.nested.property("error.code", -32099);
    expect(response).to.have.nested.property("error.message", "Upstream failure");
    expect(response).to.have.nested.property("error.data.status", 503);
    expect(response).to.have.nested.property("error.data.request_id", "override-1");
  });
});
