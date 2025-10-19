/**
 * Focused coverage for the child runtime environment overrides. The suite
 * relies on the orchestrator internals exported solely for testing so the
 * centralised helpers can be exercised without spawning real child processes.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import { resolve } from "node:path";

import { __envRuntimeInternals } from "../src/orchestrator/runtime.js";

const watchedKeys = [
  "MCP_CHILDREN_ROOT",
  "MCP_CHILD_COMMAND",
  "MCP_CHILD_ARGS",
  "MCP_CHILD_SANDBOX_PROFILE",
  "MCP_CHILD_ENV_ALLOW",
  "MCP_REQUEST_BUDGET_TIME_MS",
  "MCP_REQUEST_BUDGET_TOKENS",
  "MCP_REQUEST_BUDGET_TOOL_CALLS",
  "MCP_REQUEST_BUDGET_BYTES_IN",
  "MCP_REQUEST_BUDGET_BYTES_OUT",
] as const;

type WatchedKey = (typeof watchedKeys)[number];

const originalEnv: Partial<Record<WatchedKey, string | undefined>> = {};

function restoreEnv(): void {
  for (const key of watchedKeys) {
    const original = originalEnv[key];
    if (typeof original === "string") {
      process.env[key] = original;
    } else if (original === undefined) {
      delete process.env[key];
    }
  }
}

describe("orchestrator child env overrides", () => {
  beforeEach(() => {
    for (const key of watchedKeys) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv();
  });

  it("derives the children root from MCP_CHILDREN_ROOT", () => {
    const { resolveChildrenRootFromEnv } = __envRuntimeInternals;
    const baseDir = resolve("/tmp", "orchestrator-root");

    expect(resolveChildrenRootFromEnv(baseDir)).to.equal(resolve(baseDir, "children"));

    process.env.MCP_CHILDREN_ROOT = "relative/custom";
    expect(resolveChildrenRootFromEnv(baseDir)).to.equal(resolve(baseDir, "relative/custom"));

    process.env.MCP_CHILDREN_ROOT = "/var/lib/codex/children";
    expect(resolveChildrenRootFromEnv(baseDir)).to.equal("/var/lib/codex/children");
  });

  it("falls back to process.execPath when MCP_CHILD_COMMAND is absent", () => {
    const { resolveDefaultChildCommand } = __envRuntimeInternals;

    expect(resolveDefaultChildCommand()).to.equal(process.execPath);

    process.env.MCP_CHILD_COMMAND = "/usr/local/bin/custom-child";
    expect(resolveDefaultChildCommand()).to.equal("/usr/local/bin/custom-child");

    process.env.MCP_CHILD_COMMAND = "   ";
    expect(resolveDefaultChildCommand()).to.equal(process.execPath);
  });

  it("parses MCP_CHILD_ARGS as a JSON array", () => {
    const { resolveDefaultChildArgs } = __envRuntimeInternals;

    expect(resolveDefaultChildArgs()).to.deep.equal([]);

    process.env.MCP_CHILD_ARGS = '["--inspect", "--trace-warnings"]';
    expect(resolveDefaultChildArgs()).to.deep.equal(["--inspect", "--trace-warnings"]);

    process.env.MCP_CHILD_ARGS = '{"invalid":true}';
    expect(resolveDefaultChildArgs()).to.deep.equal([]);
  });

  it("collects sandbox defaults from MCP_CHILD_SANDBOX_PROFILE and MCP_CHILD_ENV_ALLOW", () => {
    const { resolveSandboxDefaults } = __envRuntimeInternals;

    let defaults = resolveSandboxDefaults();
    expect(defaults.profile).to.equal(null);
    expect(defaults.allowEnv).to.deep.equal([]);

    process.env.MCP_CHILD_SANDBOX_PROFILE = "STRICT";
    process.env.MCP_CHILD_ENV_ALLOW = "API_TOKEN,API_TOKEN,GRAPH_ENV";
    defaults = resolveSandboxDefaults();
    expect(defaults.profile).to.equal("strict");
    expect(defaults.allowEnv).to.deep.equal(["API_TOKEN", "GRAPH_ENV"]);

    process.env.MCP_CHILD_SANDBOX_PROFILE = "unknown";
    defaults = resolveSandboxDefaults();
    expect(defaults.profile).to.equal("standard");
  });

  it("derives request budget limits from the environment", () => {
    const { resolveRequestBudgetLimits } = __envRuntimeInternals;

    let limits = resolveRequestBudgetLimits();
    expect(limits).to.deep.equal({
      timeMs: null,
      tokens: null,
      toolCalls: null,
      bytesIn: null,
      bytesOut: null,
    });

    process.env.MCP_REQUEST_BUDGET_TIME_MS = "60000";
    process.env.MCP_REQUEST_BUDGET_TOKENS = "12000";
    process.env.MCP_REQUEST_BUDGET_TOOL_CALLS = "8";
    process.env.MCP_REQUEST_BUDGET_BYTES_IN = "4096";
    process.env.MCP_REQUEST_BUDGET_BYTES_OUT = "8192";
    limits = resolveRequestBudgetLimits();
    expect(limits).to.deep.equal({
      timeMs: 60000,
      tokens: 12000,
      toolCalls: 8,
      bytesIn: 4096,
      bytesOut: 8192,
    });

    process.env.MCP_REQUEST_BUDGET_TOKENS = "-5";
    process.env.MCP_REQUEST_BUDGET_BYTES_OUT = "garbage";
    limits = resolveRequestBudgetLimits();
    expect(limits).to.deep.equal({
      timeMs: 60000,
      tokens: null,
      toolCalls: 8,
      bytesIn: 4096,
      bytesOut: null,
    });
  });
});
