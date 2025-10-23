import { expect } from "chai";
import { describe, it } from "mocha";
import type {
  RequestHandlerExtra,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/shared/protocol.js";

import type { ChildSupervisorContract, CreateChildOptions } from "../../src/children/supervisor.js";
import { StructuredLogger } from "../../src/logger.js";
import { createChildOrchestrateHandler } from "../../src/tools/child_orchestrate.js";
import type { Signal } from "../../src/nodePrimitives.js";

/**
 * Minimal supervisor double capturing the spawn options handed to
 * `createChild`. The stub exercises the façade without launching a real child
 * runtime while ensuring optional fields stay omitted unless explicitly
 * provided by the caller.
 */
class StubSupervisor {
  public capturedOptions: CreateChildOptions | undefined;

  public readonly cancelCalls: Array<{ childId: string; options?: { signal?: Signal; timeoutMs?: number } }> = [];

  public readonly killCalls: Array<{ childId: string; options?: { timeoutMs?: number } }> = [];

  public readonly childrenIndex = { list: () => [], getChild: () => undefined };

  createChildId(): string {
    return "stub-generated";
  }

  async createChild(options: CreateChildOptions = {}) {
    this.capturedOptions = options;
    const childId = options.childId ?? "stub-child";
    const runtime = {
      childId,
      manifestPath: `/tmp/${childId}/manifest.json`,
      logPath: `/tmp/${childId}/runtime.log`,
      toolsAllow: [],
      getStatus: () => ({
        childId,
        pid: 0,
        command: options.command ?? "stub-command",
        args: options.args ?? [],
        workdir: `/tmp/${childId}`,
        startedAt: 0,
        lastHeartbeatAt: null,
        lifecycle: "running",
        closed: false,
        exit: null,
        resourceUsage: null,
      }),
      collectOutputs: async () => ({
        childId,
        manifestPath: `/tmp/${childId}/manifest.json`,
        logPath: `/tmp/${childId}/runtime.log`,
        messages: [],
        artifacts: [],
      }),
      streamMessages: () => ({
        childId,
        totalMessages: 0,
        matchedMessages: 0,
        hasMore: false,
        nextCursor: null,
        iterator: (async function* () {})(),
        close: () => {},
      }),
      waitForMessage: async () => {
        throw new Error("waitForMessage not expected in optional-field sanitiser tests");
      },
      waitForExit: async () => ({
        code: null,
        signal: null,
        forced: false,
        at: Date.now(),
      }),
      shutdown: async () => ({ code: null, signal: null, forced: false, durationMs: 0 }),
      send: async () => {
        throw new Error("send not expected in optional-field sanitiser tests");
      },
      setRole: async () => {},
      setLimits: async () => {},
      attach: async () => {},
    };

    return {
      childId,
      index: {
        childId,
        pid: 0,
        workdir: `/tmp/${childId}`,
        state: "ready",
        startedAt: 0,
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
      },
      runtime,
      readyMessage: null,
    };
  }

  async registerHttpChild() {
    throw new Error("registerHttpChild not expected in optional-field sanitiser tests");
  }

  getHttpEndpoint() {
    return null;
  }

  status() {
    throw new Error("status not expected in optional-field sanitiser tests");
  }

  async send() {
    throw new Error("send not expected in optional-field sanitiser tests");
  }

  async waitForMessage() {
    throw new Error("waitForMessage not expected in optional-field sanitiser tests");
  }

  async collect() {
    throw new Error("collect not expected in optional-field sanitiser tests");
  }

  stream() {
    return {
      childId: "stub",
      totalMessages: 0,
      matchedMessages: 0,
      hasMore: false,
      nextCursor: null,
      iterator: (async function* () {})(),
      close: () => {},
    };
  }

  async attachChild() {
    throw new Error("attachChild not expected in optional-field sanitiser tests");
  }

  async setChildRole() {
    throw new Error("setChildRole not expected in optional-field sanitiser tests");
  }

  async setChildLimits() {
    throw new Error("setChildLimits not expected in optional-field sanitiser tests");
  }

  async cancel(childId: string, options?: { signal?: Signal; timeoutMs?: number }) {
    this.cancelCalls.push({ childId, options });
    return { code: null, signal: null, forced: false, durationMs: 1 };
  }

  async kill(childId: string, options?: { timeoutMs?: number }) {
    this.killCalls.push({ childId, options });
    return { code: null, signal: null, forced: true, durationMs: 1 };
  }

  async waitForExit() {
    return { code: null, signal: null, forced: false, durationMs: 1 };
  }

  gc(): void {}

  getAllowedTools(): readonly string[] {
    return [];
  }
}

function createRequestExtras(
  requestId: string,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    requestId,
    requestInfo: { headers: {} },
    sendNotification: async () => undefined,
    sendRequest: async () => {
      throw new Error("nested requests not expected in optional-field sanitiser tests");
    },
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

const logger = new StructuredLogger({ logFile: null });

describe("child_orchestrate optional field sanitisation", () => {
  it("omits defaulted spawn options when the caller relies on façade defaults", async () => {
    const stub = new StubSupervisor();
    const handler = createChildOrchestrateHandler({
      supervisor: stub as unknown as ChildSupervisorContract,
      logger,
    });

    const response = await handler(
      {
        followup_payloads: [],
        collect: { include_messages: false, include_artifacts: false },
      },
      createRequestExtras("child-optional-defaults"),
    );

    expect(response.isError).to.equal(false, "the façade should succeed with default payloads");
    expect(stub.capturedOptions, "the supervisor should receive spawn options").to.not.be.undefined;

    const options = stub.capturedOptions as Record<string, unknown>;
    expect(options).to.not.have.property("childId");
    expect(options).to.not.have.property("command");
    expect(options).to.not.have.property("args");
    expect(options).to.not.have.property("env");
    expect(options).to.not.have.property("metadata");
    expect(options).to.not.have.property("manifestExtras");
    expect(options).to.not.have.property("limits");
    expect(options).to.not.have.property("role");
    expect(options).to.not.have.property("toolsAllow");
    expect(options).to.not.have.property("waitForReady");
    expect(options).to.not.have.property("readyType");
    expect(options).to.not.have.property("readyTimeoutMs");
    expect(options).to.not.have.property("sandbox");
    expect(options).to.not.have.property("spawnRetry");

    expect(stub.cancelCalls, "the façade should perform a graceful cancel").to.have.lengthOf(1);
    expect(stub.killCalls, "no forced termination should occur").to.have.lengthOf(0);
    expect(stub.cancelCalls[0]?.options, "no cancel options should leak undefined placeholders").to.equal(undefined);
  });

  it("propagates explicit spawn customisations without leaking undefined fields", async () => {
    const stub = new StubSupervisor();
    const handler = createChildOrchestrateHandler({
      supervisor: stub as unknown as ChildSupervisorContract,
      logger,
    });

    const response = await handler(
      {
        child_id: "child-explicit",
        command: "node",
        args: ["--version"],
        env: { MODE: "test" },
        metadata: { origin: "optional-field-suite" },
        manifest_extras: { test: true },
        limits: { time_ms: 12_000 },
        role: "observer",
        tools_allow: ["shell"],
        wait_for_ready: false,
        ready_type: "custom_ready",
        ready_timeout_ms: 3_200,
        sandbox: { profile: "perm", allow_env: ["SAFE"], inherit_default_env: false },
        spawn_retry: { attempts: 2, max_delay_ms: 1_500 },
        followup_payloads: [],
        collect: { include_messages: false, include_artifacts: false },
      },
      createRequestExtras("child-optional-explicit"),
    );

    expect(response.isError).to.equal(false, "the façade should succeed with explicit overrides");
    expect(stub.capturedOptions, "spawn options should be captured").to.not.be.undefined;

    const options = stub.capturedOptions as Record<string, any>;
    expect(options.childId).to.equal("child-explicit");
    expect(options.command).to.equal("node");
    expect(options.args).to.deep.equal(["--version"]);
    expect(options.env).to.deep.equal({ MODE: "test" });
    expect(options.metadata).to.be.an("object");
    expect(options.metadata.origin).to.equal("optional-field-suite");
    const runtimeHeaders = options.metadata.runtime_headers as Record<string, string> | undefined;
    expect(runtimeHeaders).to.be.an("object");
    for (const value of Object.values(runtimeHeaders ?? {})) {
      expect(value).to.be.a("string");
    }
    expect(options.manifestExtras).to.deep.equal({ test: true });
    expect(options.limits).to.deep.equal({ time_ms: 12_000 });
    expect(options.role).to.equal("observer");
    expect(options.toolsAllow).to.deep.equal(["shell"]);
    expect(options.waitForReady).to.equal(false);
    expect(options.readyType).to.equal("custom_ready");
    expect(options.readyTimeoutMs).to.equal(3_200);
    expect(options.sandbox).to.deep.equal({
      profile: "permissive",
      allowEnv: ["SAFE"],
      inheritDefaultEnv: false,
    });
    expect(options.spawnRetry).to.deep.equal({ attempts: 2, maxDelayMs: 1_500 });

    expect(options).to.not.have.property("spawnRetry", undefined);
    expect(Object.values(options.spawnRetry)).to.not.include(undefined);
  });

  it("propagates shutdown cancel options without introducing undefined fields", async () => {
    const stub = new StubSupervisor();
    const handler = createChildOrchestrateHandler({
      supervisor: stub as unknown as ChildSupervisorContract,
      logger,
    });

    const response = await handler(
      {
        followup_payloads: [],
        collect: { include_messages: false, include_artifacts: false },
        shutdown: { mode: "cancel", signal: "SIGTERM", timeout_ms: 1_250 },
      },
      createRequestExtras("child-optional-shutdown-cancel"),
    );

    expect(response.isError).to.equal(false, "shutdown configuration should succeed");
    expect(stub.cancelCalls).to.have.lengthOf(1);
    expect(stub.killCalls).to.have.lengthOf(0);
    expect(stub.cancelCalls[0]?.options).to.deep.equal({ signal: "SIGTERM", timeoutMs: 1_250 });
  });

  it("propagates shutdown kill timeouts only when specified", async () => {
    const stub = new StubSupervisor();
    const handler = createChildOrchestrateHandler({
      supervisor: stub as unknown as ChildSupervisorContract,
      logger,
    });

    const response = await handler(
      {
        followup_payloads: [],
        collect: { include_messages: false, include_artifacts: false },
        shutdown: { mode: "kill", timeout_ms: 640 },
      },
      createRequestExtras("child-optional-shutdown-kill"),
    );

    expect(response.isError).to.equal(false, "kill configuration should succeed");
    expect(stub.cancelCalls).to.have.lengthOf(0);
    expect(stub.killCalls).to.have.lengthOf(1);
    expect(stub.killCalls[0]?.options).to.deep.equal({ timeoutMs: 640 });
  });

  it("omits shutdown kill options when the timeout is absent", async () => {
    const stub = new StubSupervisor();
    const handler = createChildOrchestrateHandler({
      supervisor: stub as unknown as ChildSupervisorContract,
      logger,
    });

    const response = await handler(
      {
        followup_payloads: [],
        collect: { include_messages: false, include_artifacts: false },
        shutdown: { mode: "kill" },
      },
      createRequestExtras("child-optional-shutdown-kill-no-timeout"),
    );

    expect(response.isError).to.equal(false, "kill without timeout should succeed");
    expect(stub.cancelCalls).to.have.lengthOf(0);
    expect(stub.killCalls).to.have.lengthOf(1);
    expect(stub.killCalls[0]?.options).to.equal(undefined);
  });
});
