import { afterEach, describe, it } from "mocha";
import { expect } from "chai";

import { loadDefaultTimeoutOverride } from "../../src/rpc/timeouts.js";

describe("rpc timeout overrides", () => {
  const originalTimeout = process.env.MCP_RPC_DEFAULT_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.MCP_RPC_DEFAULT_TIMEOUT_MS;
    } else {
      process.env.MCP_RPC_DEFAULT_TIMEOUT_MS = originalTimeout;
    }
  });

  it("returns null when no override is provided", () => {
    delete process.env.MCP_RPC_DEFAULT_TIMEOUT_MS;
    expect(loadDefaultTimeoutOverride()).to.equal(null);
  });

  it("returns the parsed override when it is valid", () => {
    process.env.MCP_RPC_DEFAULT_TIMEOUT_MS = "90000";
    expect(loadDefaultTimeoutOverride()).to.equal(90_000);
  });

  it("ignores invalid overrides", () => {
    process.env.MCP_RPC_DEFAULT_TIMEOUT_MS = "abc";
    expect(loadDefaultTimeoutOverride()).to.equal(null);

    process.env.MCP_RPC_DEFAULT_TIMEOUT_MS = "0";
    expect(loadDefaultTimeoutOverride()).to.equal(null);
  });
});
