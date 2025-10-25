import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";

import {
  resolveDashboardHost,
  resolveDashboardPort,
  resolveDashboardStreamInterval,
  resolveDashboardKeepAliveInterval,
} from "../../src/monitor/dashboard.js";

describe("monitor/dashboard env helpers", () => {
  const envKeys = [
    "MCP_DASHBOARD_HOST",
    "MCP_DASHBOARD_PORT",
    "MCP_DASHBOARD_INTERVAL_MS",
    "MCP_SSE_KEEPALIVE_MS",
  ] as const;
  const originalEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("falls back to documented defaults when no overrides are provided", () => {
    expect(resolveDashboardHost()).to.equal("127.0.0.1");
    expect(resolveDashboardPort()).to.equal(4100);
    expect(resolveDashboardStreamInterval()).to.equal(2_000);
    expect(resolveDashboardKeepAliveInterval(2_000)).to.equal(2_000);
  });

  it("reads overrides from the environment when explicit values are omitted", () => {
    process.env.MCP_DASHBOARD_HOST = "0.0.0.0";
    process.env.MCP_DASHBOARD_PORT = "42000";
    process.env.MCP_DASHBOARD_INTERVAL_MS = "750";
    process.env.MCP_SSE_KEEPALIVE_MS = "1200";

    expect(resolveDashboardHost()).to.equal("0.0.0.0");
    expect(resolveDashboardPort()).to.equal(42_000);
    expect(resolveDashboardStreamInterval()).to.equal(750);
    expect(resolveDashboardKeepAliveInterval(750)).to.equal(1_200);
  });

  it("clamps explicit stream interval overrides to the minimum threshold", () => {
    expect(resolveDashboardStreamInterval(100)).to.equal(250);
  });

  it("ignores invalid environment overrides and retains defaults", () => {
    process.env.MCP_DASHBOARD_HOST = "   ";
    process.env.MCP_DASHBOARD_PORT = "not-a-number";
    process.env.MCP_DASHBOARD_INTERVAL_MS = "-5";
    process.env.MCP_SSE_KEEPALIVE_MS = "-10";

    expect(resolveDashboardHost()).to.equal("127.0.0.1");
    expect(resolveDashboardPort()).to.equal(4100);
    expect(resolveDashboardStreamInterval()).to.equal(2_000);
    expect(resolveDashboardKeepAliveInterval(60_000)).to.equal(15_000);
  });

  it("clamps explicit keep-alive overrides to the minimum threshold", () => {
    expect(resolveDashboardKeepAliveInterval(2_000, 100)).to.equal(1_000);
  });

  it("rejects environment overrides below the documented floor", () => {
    process.env.MCP_SSE_KEEPALIVE_MS = "750";

    expect(resolveDashboardKeepAliveInterval(5_000)).to.equal(5_000);
  });
});
