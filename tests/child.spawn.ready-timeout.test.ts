import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import { ChildRuntime, type ChildRuntimeStatus } from "../src/childRuntime.js";
import type { ChildRecordSnapshot } from "../src/state/childrenIndex.js";
import { ChildSupervisor, type CreateChildOptions } from "../src/children/supervisor.js";
import { StructuredLogger } from "../src/logger.js";
import { handleChildSpawnCodex, type ChildToolContext } from "../src/tools/childTools.js";

/**
 * Ensures `child_spawn_codex` honours the caller-provided ready timeout while
 * also falling back to the extended default that keeps CI executions stable.
 */
describe("child_spawn_codex ready timeout", () => {
  let originalStateless: string | undefined;

  beforeEach(() => {
    originalStateless = process.env.MCP_HTTP_STATELESS;
    delete process.env.MCP_HTTP_STATELESS;
  });

  afterEach(() => {
    sinon.restore();
    if (originalStateless === undefined) {
      delete process.env.MCP_HTTP_STATELESS;
    } else {
      process.env.MCP_HTTP_STATELESS = originalStateless;
    }
  });

  /**
   * Builds a lightweight {@link ChildRuntime} double backed by the class
   * prototype so the supervisor stub can expose a fully typed handle without
   * relying on structural casts. Only the properties exercised by the test are
   * initialised which keeps the implementation straightforward while still
   * honouring the runtime contract.
   */
  function createRuntimeStub(status: ChildRuntimeStatus): ChildRuntime {
    const runtime = Object.create<ChildRuntime>(ChildRuntime.prototype);
    Object.assign(runtime, {
      manifestPath: `/tmp/${status.childId}/manifest.json`,
      logPath: `/tmp/${status.childId}/child.log`,
      workdir: status.workdir,
      getStatus: () => status,
    });
    return runtime;
  }

  it("forwards overrides and applies the extended default", async () => {
    const recordedTimeouts: Array<number | undefined> = [];
    let counter = 0;

    const createChild = sinon.stub().callsFake(async (options?: CreateChildOptions) => {
      recordedTimeouts.push(options?.readyTimeoutMs);

      const childId = `child-test-${counter}`;
      counter += 1;

      const runtimeStatus: ChildRuntimeStatus = {
        childId,
        pid: 4242,
        command: "node",
        args: ["mock-child.js"],
        workdir: `/tmp/${childId}`,
        startedAt: 1_690_000_000_000,
        lastHeartbeatAt: null,
        lifecycle: "running",
        closed: false,
        exit: { code: null, signal: null, forced: false, at: 1_690_000_000_500 },
        resourceUsage: null,
      };

      const runtime = createRuntimeStub(runtimeStatus);

      const indexSnapshot: ChildRecordSnapshot = {
        childId,
        pid: runtimeStatus.pid,
        workdir: runtimeStatus.workdir,
        state: "ready",
        startedAt: runtimeStatus.startedAt,
        lastHeartbeatAt: runtimeStatus.lastHeartbeatAt,
        retries: 0,
        metadata: {},
        endedAt: null,
        exitCode: null,
        exitSignal: null,
        forcedTermination: false,
        stopReason: null,
        role: null,
        limits: null,
        attachedAt: null,
      };

      return { childId, runtime, index: indexSnapshot, readyMessage: null };
    });

    const supervisor = new ChildSupervisor({
      childrenRoot: "/tmp/child-ready-timeout",
      defaultCommand: "node",
    });
    sinon.replace(supervisor, "createChild", createChild);
    const context: ChildToolContext = { supervisor, logger: new StructuredLogger() };

    await handleChildSpawnCodex(context, {
      prompt: { system: ["Ready override"] },
      ready_timeout_ms: 7_500,
    });

    await handleChildSpawnCodex(context, {
      prompt: { system: ["Ready default"] },
    });

    expect(createChild.callCount).to.equal(2);
    expect(recordedTimeouts[0]).to.equal(7_500);
    expect(recordedTimeouts[1]).to.equal(8_000);
  });
});

