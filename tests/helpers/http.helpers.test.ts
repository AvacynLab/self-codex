import { expect } from "chai";
import { text } from "node:stream/consumers";

import { createHttpRequest, createJsonRpcRequest } from "./http";

describe("helpers/http", () => {
  it("creates a JSON-RPC request stream with the provided payload", async () => {
    const payload = { jsonrpc: "2.0", id: "req-1", method: "ping" } as const;

    const request = createJsonRpcRequest(payload, {
      "Content-Type": "application/json",
      Authorization: "Bearer token",
    });

    expect(request.method).to.equal("POST");
    expect(request.url).to.equal("/mcp");
    expect(request.headers["content-type"]).to.equal("application/json");
    expect(request.headers["authorization"]).to.equal("Bearer token");

    const body = await text(request);
    expect(body).to.equal(JSON.stringify(payload));
    expect(request.socket.destroyed).to.equal(true);
  });

  it("normalises headers for generic HTTP requests", async () => {
    const request = createHttpRequest("get", "/health", {
      Accept: "application/json",
      "X-Custom": "value",
    });

    expect(request.method).to.equal("GET");
    expect(request.url).to.equal("/health");
    expect(request.headers["accept"]).to.equal("application/json");
    expect(request.headers["x-custom"]).to.equal("value");

    const body = await text(request);
    expect(body).to.equal("");
    expect(request.socket.destroyed).to.equal(true);
  });
});
