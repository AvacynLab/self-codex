import { after, before, describe, it } from "mocha";
import { expect } from "chai";

import { HttpServerHarness } from "../helpers/httpServerHarness.js";

/**
 * End-to-end coverage for the HTTP bearer authentication layer.  The harness
 * boots the real server in a child process so the checks mirror what a remote
 * client would experience when missing or providing the `Authorization`
 * header.
 */
describe("http bearer authentication", function () {
  this.timeout(15000);

  let harness: HttpServerHarness | null = null;
  const token = process.env.MCP_HTTP_TOKEN ?? "test-token";

  before(async function () {
    const guard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (guard && guard !== "loopback-only") {
      this.skip();
    }

    harness = new HttpServerHarness({
      host: process.env.MCP_HTTP_HOST ?? "127.0.0.1",
      port: Number.parseInt(process.env.MCP_HTTP_PORT ?? "8765", 10),
      path: process.env.MCP_HTTP_PATH ?? "/mcp",
      token,
    });
    await harness.start();
  });

  after(async () => {
    if (harness) {
      await harness.stop();
      harness = null;
    }
  });

  it("returns 401 when the bearer token is missing", async () => {
    if (!harness) {
      throw new Error("HTTP harness not initialised");
    }
    const { status, json } = await harness.request({
      jsonrpc: "2.0",
      id: "auth-missing",
      method: "mcp_info",
      params: {},
    });

    expect(status).to.equal(401);
    expect(json).to.deep.equal({ jsonrpc: "2.0", id: null, error: { code: 401, message: "E-MCP-AUTH" } });
  });

  it("accepts valid bearer tokens", async () => {
    if (!harness) {
      throw new Error("HTTP harness not initialised");
    }
    const { status, json } = await harness.request(
      {
        jsonrpc: "2.0",
        id: "auth-valid",
        method: "mcp_info",
        params: {},
      },
      { authorization: `Bearer ${token}` },
    );

    expect(status).to.equal(200);
    expect(json).to.have.property("result").that.is.an("object");
  });
});
