import { describe, it } from "mocha";
import { expect } from "chai";

import { handleJsonRpc } from "../../src/server.js";

describe("JSON-RPC middleware validation", () => {
  it("rejects invalid jsonrpc envelope", async () => {
    const response = await handleJsonRpc(
      {
        jsonrpc: "1.0" as const,
        id: "invalid-version",
        method: "graph_patch",
        params: {},
      },
      {},
    );

    expect(response.error?.code, "error code").to.equal(-32600);
    expect(response.error?.data, "error data present").to.have.property("hint");
    expect(response.error?.data?.request_id, "request id propagated").to.equal("invalid-version");
  });

  it("rejects invalid params with structured hint", async () => {
    const response = await handleJsonRpc(
      {
        jsonrpc: "2.0" as const,
        id: "invalid-params",
        method: "graph_patch",
        params: {},
      },
      {},
    );

    expect(response.error?.code, "error code").to.equal(-32602);
    expect(response.error?.data?.hint, "hint present").to.be.a("string").and.to.have.length.greaterThan(0);
  });

  it("rejects unknown tools/call", async () => {
    const response = await handleJsonRpc(
      {
        jsonrpc: "2.0" as const,
        id: "unknown-tool",
        method: "tools/call",
        params: { name: "nonexistent_tool", arguments: {} },
      },
      {},
    );

    expect(response.error?.code, "method not found code").to.equal(-32601);
    expect(response.error?.data?.hint, "hint mentions tool").to.include("nonexistent_tool");
  });

  it("allows valid requests to proceed", async () => {
    const response = await handleJsonRpc(
      {
        jsonrpc: "2.0" as const,
        id: "mcp-info",
        method: "mcp_info",
        params: {},
      },
      {},
    );

    expect(response.error, "error payload").to.equal(undefined);
    expect(response.result, "result present").to.not.equal(undefined);
  });
});
