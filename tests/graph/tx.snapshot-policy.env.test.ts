/**
 * Verifies that the graph snapshot policy honours environment overrides via the
 * shared parsing helpers. The suite exercises absence, explicit overrides and
 * disabling values to guarantee the refactor keeps the legacy behaviour intact.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { configureGraphSnapshotPolicy, __graphTxInternals } from "../../src/graph/tx.js";

type EnvKey =
  | "MCP_GRAPH_SNAPSHOT_EVERY_COMMITS"
  | "MCP_GRAPH_SNAPSHOT_INTERVAL_MS";

type EnvSnapshot = Partial<Record<EnvKey, string | undefined>>;

const trackedKeys: readonly EnvKey[] = [
  "MCP_GRAPH_SNAPSHOT_EVERY_COMMITS",
  "MCP_GRAPH_SNAPSHOT_INTERVAL_MS",
];

const originalEnv: EnvSnapshot = {};

function setEnv(name: EnvKey, value: string | undefined): void {
  if (!(name in originalEnv)) {
    originalEnv[name] = process.env[name];
  }

  if (typeof value === "string") {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
}

describe("graph snapshot policy env overrides", () => {
  beforeEach(() => {
    configureGraphSnapshotPolicy(null);
    __graphTxInternals.resetSnapshotOverrides();
    for (const key of trackedKeys) {
      if (!(key in originalEnv)) {
        originalEnv[key] = process.env[key];
      }
    }
  });

  afterEach(() => {
    configureGraphSnapshotPolicy(null);
    __graphTxInternals.resetSnapshotOverrides();
    for (const key of trackedKeys) {
      const previous = originalEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
      delete originalEnv[key];
    }
  });

  it("falls back to the default snapshot policy when overrides are absent", () => {
    const policy = __graphTxInternals.resolveSnapshotPolicy();
    expect(policy.commitInterval).to.equal(10);
    expect(policy.timeIntervalMs).to.equal(5 * 60_000);
  });

  it("applies positive overrides from the environment", () => {
    setEnv("MCP_GRAPH_SNAPSHOT_EVERY_COMMITS", "7");
    setEnv("MCP_GRAPH_SNAPSHOT_INTERVAL_MS", "120000");

    const policy = __graphTxInternals.resolveSnapshotPolicy();
    expect(policy.commitInterval).to.equal(7);
    expect(policy.timeIntervalMs).to.equal(120_000);
  });

  it("treats zero or negative overrides as explicit disables", () => {
    setEnv("MCP_GRAPH_SNAPSHOT_EVERY_COMMITS", "0");
    setEnv("MCP_GRAPH_SNAPSHOT_INTERVAL_MS", "-5");

    const policy = __graphTxInternals.resolveSnapshotPolicy();
    expect(policy.commitInterval).to.equal(null);
    expect(policy.timeIntervalMs).to.equal(null);
  });

  it("ignores malformed values and keeps the defaults", () => {
    setEnv("MCP_GRAPH_SNAPSHOT_EVERY_COMMITS", "  not-a-number  ");
    setEnv("MCP_GRAPH_SNAPSHOT_INTERVAL_MS", "");

    const policy = __graphTxInternals.resolveSnapshotPolicy();
    expect(policy.commitInterval).to.equal(10);
    expect(policy.timeIntervalMs).to.equal(5 * 60_000);
  });
});
