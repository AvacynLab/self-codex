import { afterEach, describe, it } from "mocha";
import { expect } from "chai";

import {
  resolveChildForceShutdownTimeout,
  resolveChildGracefulShutdownTimeout,
  resolveChildReadyTimeout,
  resolveChildSpawnTimeout,
} from "../../src/children/timeouts.js";

const ORIGINAL_ENV = {
  spawn: process.env.MCP_CHILD_SPAWN_TIMEOUT_MS,
  ready: process.env.MCP_CHILD_READY_TIMEOUT_MS,
  grace: process.env.MCP_CHILD_SHUTDOWN_GRACE_MS,
  force: process.env.MCP_CHILD_SHUTDOWN_FORCE_MS,
};

function restoreEnv(name: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[name];
  if (value === undefined) {
    delete process.env[`MCP_CHILD_${
      name === "spawn"
        ? "SPAWN_TIMEOUT_MS"
        : name === "ready"
          ? "READY_TIMEOUT_MS"
          : name === "grace"
            ? "SHUTDOWN_GRACE_MS"
            : "SHUTDOWN_FORCE_MS"
    }`];
    return;
  }
  process.env[`MCP_CHILD_${
    name === "spawn"
      ? "SPAWN_TIMEOUT_MS"
      : name === "ready"
        ? "READY_TIMEOUT_MS"
        : name === "grace"
          ? "SHUTDOWN_GRACE_MS"
          : "SHUTDOWN_FORCE_MS"
  }`] = value;
}

describe("child timeout resolvers", () => {
  afterEach(() => {
    restoreEnv("spawn");
    restoreEnv("ready");
    restoreEnv("grace");
    restoreEnv("force");
  });

  it("falls back to defaults when environment overrides are absent", () => {
    delete process.env.MCP_CHILD_SPAWN_TIMEOUT_MS;
    delete process.env.MCP_CHILD_READY_TIMEOUT_MS;
    delete process.env.MCP_CHILD_SHUTDOWN_GRACE_MS;
    delete process.env.MCP_CHILD_SHUTDOWN_FORCE_MS;

    expect(resolveChildReadyTimeout()).to.equal(2_000);
    expect(resolveChildGracefulShutdownTimeout()).to.equal(2_000);
    expect(resolveChildSpawnTimeout()).to.equal(undefined);
    expect(resolveChildForceShutdownTimeout()).to.equal(undefined);
  });

  it("honours environment overrides for readiness, shutdown and spawn timeouts", () => {
    process.env.MCP_CHILD_READY_TIMEOUT_MS = "3500";
    process.env.MCP_CHILD_SHUTDOWN_GRACE_MS = "4500";
    process.env.MCP_CHILD_SHUTDOWN_FORCE_MS = "600";
    process.env.MCP_CHILD_SPAWN_TIMEOUT_MS = "12000";

    expect(resolveChildReadyTimeout()).to.equal(3_500);
    expect(resolveChildGracefulShutdownTimeout()).to.equal(4_500);
    expect(resolveChildForceShutdownTimeout()).to.equal(600);
    expect(resolveChildSpawnTimeout()).to.equal(12_000);
  });

  it("prefers explicit overrides even when environment values are configured", () => {
    process.env.MCP_CHILD_READY_TIMEOUT_MS = "3000";
    process.env.MCP_CHILD_SPAWN_TIMEOUT_MS = "9000";

    expect(resolveChildReadyTimeout(1_500)).to.equal(1_500);
    expect(resolveChildGracefulShutdownTimeout(3_250)).to.equal(3_250);
    expect(resolveChildSpawnTimeout(100)).to.equal(100);
    expect(resolveChildForceShutdownTimeout(750)).to.equal(750);
  });

  it("treats zero spawn/force overrides as disabling the timeout", () => {
    process.env.MCP_CHILD_SPAWN_TIMEOUT_MS = "0";
    process.env.MCP_CHILD_SHUTDOWN_FORCE_MS = "0";

    expect(resolveChildSpawnTimeout()).to.equal(undefined);
    expect(resolveChildForceShutdownTimeout()).to.equal(undefined);

    expect(resolveChildSpawnTimeout(0)).to.equal(undefined);
    expect(resolveChildForceShutdownTimeout(0)).to.equal(undefined);
  });

  it("rejects invalid overrides by falling back to safe defaults", () => {
    process.env.MCP_CHILD_READY_TIMEOUT_MS = "-5";
    process.env.MCP_CHILD_SHUTDOWN_GRACE_MS = "NaN";

    expect(resolveChildReadyTimeout()).to.equal(2_000);
    expect(resolveChildGracefulShutdownTimeout()).to.equal(2_000);
  });

  it("ignores invalid spawn and force shutdown overrides", () => {
    process.env.MCP_CHILD_SPAWN_TIMEOUT_MS = "-10";
    process.env.MCP_CHILD_SHUTDOWN_FORCE_MS = "NaN";

    expect(resolveChildSpawnTimeout()).to.equal(undefined);
    expect(resolveChildForceShutdownTimeout()).to.equal(undefined);

    expect(resolveChildSpawnTimeout(-5)).to.equal(undefined);
    expect(resolveChildForceShutdownTimeout(Number.NaN)).to.equal(undefined);
  });
});
