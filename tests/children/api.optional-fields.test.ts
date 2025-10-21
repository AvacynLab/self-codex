import { describe, it } from "mocha";
import { expect } from "chai";

import {
  handleChildCreate,
  handleChildStream,
  handleChildCancel,
  handleChildKill,
  type ChildToolContext,
} from "../../src/children/api.js";
import type {
  ChildSupervisorContract,
  CreateChildOptions,
} from "../../src/children/supervisor.js";
import type { ChildRecordSnapshot } from "../../src/state/childrenIndex.js";
import type {
  ChildMessageStreamResult,
  ChildRuntimeMessage,
  ChildRuntimeStatus,
  ChildShutdownResult,
} from "../../src/childRuntime.js";
import type { StructuredLogger } from "../../src/logger.js";

class StubLogger {
  info(): void {}
  warn(): void {}
  error(): void {}
}

function buildRuntimeStatus(): ChildRuntimeStatus {
  return {
    childId: "child-1",
    pid: 123,
    command: "node",
    args: [],
    workdir: "/tmp/child-1",
    startedAt: Date.now(),
    lastHeartbeatAt: null,
    lifecycle: "running",
    closed: false,
    exit: null,
    resourceUsage: null,
  };
}

function buildRecordSnapshot(): ChildRecordSnapshot {
  return {
    childId: "child-1",
    pid: 123,
    workdir: "/tmp/child-1",
    state: "running",
    startedAt: Date.now(),
    lastHeartbeatAt: null,
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
}

describe("children API optional field sanitisation", () => {
  it("omits undefined creation options when spawning a child", async () => {
    let capturedOptions: CreateChildOptions | undefined;
    const supervisor = {
      id: "stub-supervisor",
      childrenIndex: {
        list: () => [buildRecordSnapshot()],
        getChild: () => buildRecordSnapshot(),
      },
      async createChild(options?: CreateChildOptions) {
        capturedOptions = options;
        const runtimeStatus = buildRuntimeStatus();
        return {
          childId: runtimeStatus.childId,
          runtime: {
            manifestPath: "/tmp/child-1/manifest.json",
            logPath: "/tmp/child-1/log.txt",
            getStatus: () => runtimeStatus,
          } as unknown,
          index: buildRecordSnapshot(),
          readyMessage: null,
        };
      },
      createChildId: () => "child-1",
      async registerHttpChild() {
        return { childId: "child-1", workdir: "/tmp/child-1" };
      },
      getHttpEndpoint: () => null,
      status: () => ({ runtime: buildRuntimeStatus(), index: buildRecordSnapshot() }),
      async send() {
        return { messageId: "msg-1", sentAt: Date.now() };
      },
      async waitForMessage(_childId: string, predicate: (message: ChildRuntimeMessage) => boolean) {
        const message = {
          receivedAt: Date.now(),
          raw: "",
          stream: "stdout",
        } as unknown as ChildRuntimeMessage;
        predicate(message);
        return message;
      },
      async collect() {
        return {
          childId: "child-1",
          manifestPath: "/tmp/child-1/manifest.json",
          logPath: "/tmp/child-1/log.txt",
          messages: [],
          artifacts: [],
        };
      },
      stream: () => ({
        childId: "child-1",
        totalMessages: 0,
        matchedMessages: 0,
        hasMore: false,
        nextCursor: null,
        messages: [],
      }),
      attachChild: async () => ({ runtime: buildRuntimeStatus(), index: buildRecordSnapshot() }),
      setChildRole: async () => ({ runtime: buildRuntimeStatus(), index: buildRecordSnapshot() }),
      setChildLimits: async () => ({ runtime: buildRuntimeStatus(), index: buildRecordSnapshot(), limits: null }),
      async cancel() {
        return { code: null, signal: null, forced: false, durationMs: 0 };
      },
      async kill() {
        return { code: null, signal: null, forced: true, durationMs: 0 };
      },
      async waitForExit() {
        return { code: 0, signal: null, forced: false, durationMs: 0 };
      },
      gc: () => {},
      getAllowedTools: () => [],
    } as unknown as ChildSupervisorContract;

    const context: ChildToolContext = {
      supervisor,
      logger: new StubLogger() as unknown as StructuredLogger,
    };

    const result = await handleChildCreate(context, {});
    expect(result.child_id).to.equal("child-1");
    expect(capturedOptions).to.not.equal(undefined);
    const optionKeys = Object.keys(capturedOptions ?? {});
    expect(optionKeys).to.not.include("readyTimeoutMs");
    expect(optionKeys).to.not.include("waitForReady");
    expect(optionKeys).to.not.include("childId");
    expect(optionKeys).to.not.include("manifestExtras");
    expect(optionKeys).to.not.include("readyType");
    expect(optionKeys).to.not.include("toolsAllow");
  });

  it("omits undefined stream, cancel and kill parameters", async () => {
    let capturedStreamOptions: Record<string, unknown> | undefined;
    let capturedCancelOptions: Record<string, unknown> | undefined;
    let capturedKillOptions: Record<string, unknown> | undefined;

    const supervisor: Pick<ChildSupervisorContract, "stream" | "cancel" | "kill"> & {
      stream: ChildSupervisorContract["stream"];
      cancel: ChildSupervisorContract["cancel"];
      kill: ChildSupervisorContract["kill"];
    } = {
      stream: (_childId, options) => {
        capturedStreamOptions = options ?? {};
        const result: ChildMessageStreamResult = {
          childId: "child-1",
          totalMessages: 0,
          matchedMessages: 0,
          hasMore: false,
          nextCursor: null,
          messages: [],
        };
        return result;
      },
      cancel: async (_childId, options) => {
        capturedCancelOptions = options ?? {};
        const shutdown: ChildShutdownResult = { code: null, signal: null, forced: false, durationMs: 0 };
        return shutdown;
      },
      kill: async (_childId, options) => {
        capturedKillOptions = options ?? {};
        const shutdown: ChildShutdownResult = { code: null, signal: null, forced: true, durationMs: 0 };
        return shutdown;
      },
    };

    const context: ChildToolContext = {
      supervisor: supervisor as unknown as ChildSupervisorContract,
      logger: new StubLogger() as unknown as StructuredLogger,
    };

    handleChildStream(context, { child_id: "child-1" });
    await handleChildCancel(context, { child_id: "child-1" });
    await handleChildKill(context, { child_id: "child-1" });

    expect(Object.keys(capturedStreamOptions ?? {})).to.deep.equal([]);
    expect(Object.keys(capturedCancelOptions ?? {})).to.deep.equal([]);
    expect(Object.keys(capturedKillOptions ?? {})).to.deep.equal([]);
  });
});
