import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ChildSupervisor } from "../src/children/supervisor.js";
import {
  ChildCancelInputSchema,
  ChildCollectInputSchema,
  ChildCreateInputSchema,
  ChildGcInputSchema,
  ChildKillInputSchema,
  ChildSendInputSchema,
  ChildStreamInputSchema,
  ChildStatusInputSchema,
  handleChildCancel,
  handleChildCollect,
  handleChildCreate,
  handleChildGc,
  handleChildKill,
  handleChildSend,
  handleChildStream,
  handleChildStatus,
  ChildToolContext,
} from "../src/tools/childTools.js";
import { StructuredLogger } from "../src/logger.js";
import { writeArtifact } from "../src/artifacts.js";
import { SandboxRegistry, setSandboxRegistry } from "../src/sim/sandbox.js";
import { LoopDetector } from "../src/guard/loopDetector.js";
import { ContractNetCoordinator } from "../src/coord/contractNet.js";
import { resolveFixture, runnerArgs } from "./helpers/childRunner.js";
import { expectChildRuntimeMessageType, hasChildRuntimeMessageType } from "./helpers/childRuntime.js";

const mockRunnerPath = resolveFixture(import.meta.url, "./fixtures/mock-runner.ts");
const stubbornRunnerPath = resolveFixture(import.meta.url, "./fixtures/stubborn-runner.ts");
const silentRunnerPath = resolveFixture(import.meta.url, "./fixtures/silent-runner.ts");

const mockRunnerArgs = (...extra: string[]): string[] => runnerArgs(mockRunnerPath, ...extra);
const stubbornRunnerArgs = (...extra: string[]): string[] => runnerArgs(stubbornRunnerPath, ...extra);
const silentRunnerArgs = (...extra: string[]): string[] => runnerArgs(silentRunnerPath, ...extra);

describe("child tool handlers", function () {
  this.timeout(20_000);

  it("creates a cooperative child, exchanges messages and cleans up resources", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-friendly-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs("--role", "friendly"),
      idleTimeoutMs: 150,
      idleCheckIntervalMs: 25,
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger, loopDetector: new LoopDetector() };

    try {
      const createInput = ChildCreateInputSchema.parse({
        prompt: {
          system: "Tu es un clone coopératif.",
          user: ["Analyse", "Résume"],
        },
        tools_allow: ["graph_generate"],
        timeouts: { ready_ms: 1500, idle_ms: 2500 },
        budget: { messages: 5 },
        metadata: { scenario: "friendly" },
        initial_payload: { type: "prompt", content: "hello child" },
      });
      const created = await handleChildCreate(context, createInput);

      expect(created.op_id).to.be.a("string");
      expect(created.child_id).to.match(/^child-\d{13}-[a-f0-9]{6}$/);
      expect(created.runtime_status.lifecycle).to.equal("running");
      expect(created.index_snapshot.state).to.equal("starting");
      expect(created.sent_initial_payload).to.equal(true);
      expect(created.workdir).to.be.a("string");
      expect(created.started_at).to.be.a("number");

      const manifestRaw = await readFile(created.manifest_path, "utf8");
      const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
      expect(manifest.prompt).to.deep.equal({
        system: "Tu es un clone coopératif.",
        user: ["Analyse", "Résume"],
      });
      expect(manifest.tools_allow).to.deep.equal(["graph_generate"]);
      expect(manifest.timeouts).to.deep.equal({ ready_ms: 1500, idle_ms: 2500 });
      expect(manifest.budget).to.deep.equal({ messages: 5 });

      const initialResponse = await supervisor.waitForMessage(
        created.child_id,
        (message) =>
          message.stream === "stdout" &&
          hasChildRuntimeMessageType(message, "response") &&
          typeof message.parsed.content === "string" &&
          message.parsed.content === "hello child",
        1000,
      );
      const initialPayload = expectChildRuntimeMessageType(initialResponse, "response");
      const initialContent = initialPayload.parsed.content;
      if (typeof initialContent !== "string") {
        throw new Error("initial response did not expose textual content");
      }
      expect(initialContent).to.equal("hello child");

      const statusAfterReady = handleChildStatus(
        context,
        ChildStatusInputSchema.parse({ child_id: created.child_id }),
      );
      expect(statusAfterReady.index_snapshot.state).to.be.oneOf(["ready", "idle", "running"]);

      const sendInput = ChildSendInputSchema.parse({
        child_id: created.child_id,
        payload: { type: "prompt", content: "ping from test" },
        expect: "final",
        timeout_ms: 1500,
      });
      const sendResult = await handleChildSend(context, sendInput);
      expect(sendResult.message.messageId).to.include(created.child_id);
      expect(sendResult.awaited_message).to.not.equal(null);
      expect(sendResult.loop_alert).to.equal(null);

      const response = sendResult.awaited_message!;
      expect(response.stream).to.equal("stdout");
      const awaitedResponse = expectChildRuntimeMessageType(response, "response");
      const awaitedContent = awaitedResponse.parsed.content;
      if (typeof awaitedContent !== "string") {
        throw new Error("awaited response did not expose textual content");
      }
      expect(awaitedContent).to.equal("ping from test");

      const streamSend = await handleChildSend(
        context,
        ChildSendInputSchema.parse({
          child_id: created.child_id,
          payload: { type: "ping" },
          expect: "stream",
          timeout_ms: 1500,
        }),
      );
      expect(streamSend.awaited_message).to.not.equal(null);
      expect(streamSend.loop_alert).to.equal(null);
      const streamMessage = streamSend.awaited_message!;
      const streamPayload = expectChildRuntimeMessageType(streamMessage, "pong");
      expect(streamPayload.parsed.type).to.equal("pong");

      await writeArtifact({
        childrenRoot,
        childId: created.child_id,
        relativePath: "reports/outcome.txt",
        data: "result:ok",
        mimeType: "text/plain",
      });

      const collected = await handleChildCollect(
        context,
        ChildCollectInputSchema.parse({ child_id: created.child_id }),
      );
      expect(
        collected.outputs.messages.some((msg) => msg.receivedAt === response.receivedAt),
      ).to.equal(true);
      expect(collected.outputs.artifacts.map((item) => item.path)).to.include("reports/outcome.txt");

      const streamPageOne = handleChildStream(
        context,
        ChildStreamInputSchema.parse({ child_id: created.child_id, limit: 1 }),
      );
      expect(streamPageOne.slice.matchedMessages).to.equal(1);
      expect(streamPageOne.slice.hasMore).to.equal(true);
      expect(streamPageOne.slice.messages[0].sequence).to.equal(0);

      const streamPageTwo = handleChildStream(
        context,
        ChildStreamInputSchema.parse({ child_id: created.child_id, after_sequence: streamPageOne.slice.nextCursor ?? 0 }),
      );
      expect(streamPageTwo.slice.matchedMessages).to.be.greaterThan(0);
      expect(streamPageTwo.slice.messages.every((msg) => msg.sequence > 0)).to.equal(true);

      const cancelResult = await handleChildCancel(
        context,
        ChildCancelInputSchema.parse({ child_id: created.child_id, signal: "SIGINT", timeout_ms: 500 }),
      );
      expect(cancelResult.shutdown.forced).to.equal(false);

      await supervisor.waitForExit(created.child_id, 1000);

      const gcResult = handleChildGc(
        context,
        ChildGcInputSchema.parse({ child_id: created.child_id }),
      );
      expect(gcResult.removed).to.equal(true);
      expect(supervisor.childrenIndex.getChild(created.child_id)).to.equal(undefined);

      await logger.flush();
      const raw = await readFile(logFile, "utf8");
      const entries = raw
        .split(/\n+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { message: string; payload?: Record<string, unknown> });
      const messages = entries.map((entry) => entry.message);
      expect(messages).to.include("child_create_requested");
      expect(messages).to.include("child_send");
      expect(messages).to.include("child_collect");
      expect(messages).to.include("child_cancel");
      expect(messages).to.include("child_gc");
      const createEntry = entries.find((entry) => entry.message === "child_create_requested");
      expect(createEntry?.payload?.op_id).to.be.a("string");
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("routes child_send through the Contract-Net coordinator when available", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-cnp-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs("--role", "friendly"),
      idleTimeoutMs: 200,
      idleCheckIntervalMs: 25,
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const contractNet = new ContractNetCoordinator();
    const context: ChildToolContext = { supervisor, logger, loopDetector: new LoopDetector(), contractNet };

    try {
      const first = await handleChildCreate(
        context,
        ChildCreateInputSchema.parse({ wait_for_ready: true, metadata: { label: "alpha" } }),
      );
      const second = await handleChildCreate(
        context,
        ChildCreateInputSchema.parse({ wait_for_ready: true, metadata: { label: "beta" } }),
      );

      const announcement = contractNet.announce({ taskId: "alloc-1", autoBid: false });
      contractNet.bid(announcement.callId, first.child_id, 6);
      contractNet.bid(announcement.callId, second.child_id, 3);

      const sendResult = await handleChildSend(
        context,
        ChildSendInputSchema.parse({
          child_id: "auto",
          payload: { type: "prompt", content: "contract-net" },
          expect: "final",
          timeout_ms: 1500,
          contract_net: { call_id: announcement.callId },
        }),
      );

      expect(sendResult.child_id).to.equal(second.child_id);
      expect(sendResult.contract_net).to.not.equal(null);
      expect(sendResult.contract_net?.agent_id).to.equal(second.child_id);
      expect(sendResult.contract_net?.cost).to.equal(3);
      expect(contractNet.getAgent(second.child_id)?.activeAssignments).to.equal(0);

      await handleChildKill(context, ChildKillInputSchema.parse({ child_id: first.child_id, timeout_ms: 250 }));
      await handleChildKill(context, ChildKillInputSchema.parse({ child_id: second.child_id, timeout_ms: 250 }));
      await supervisor.waitForExit(first.child_id, 1_000);
      await supervisor.waitForExit(second.child_id, 1_000);
      handleChildGc(context, ChildGcInputSchema.parse({ child_id: first.child_id }));
      handleChildGc(context, ChildGcInputSchema.parse({ child_id: second.child_id }));
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("forces termination when the child ignores cancellation", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-stubborn-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: stubbornRunnerArgs(),
      idleTimeoutMs: 100,
      idleCheckIntervalMs: 25,
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger, loopDetector: new LoopDetector() };

    try {
      const created = await handleChildCreate(context, ChildCreateInputSchema.parse({ wait_for_ready: true }));
      expect(created.child_id).to.match(/^child-\d{13}-[a-f0-9]{6}$/);

      const killResult = await handleChildKill(
        context,
        ChildKillInputSchema.parse({ child_id: created.child_id, timeout_ms: 100 }),
      );
      expect(killResult.shutdown.forced).to.equal(true);

      await supervisor.waitForExit(created.child_id, 1000);

      const gcResult = handleChildGc(
        context,
        ChildGcInputSchema.parse({ child_id: created.child_id }),
      );
      expect(gcResult.removed).to.equal(true);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("runs a sandbox dry-run before dispatching high-risk payloads", async () => {
    const sandboxRegistry = new SandboxRegistry();
    sandboxRegistry.register("dry-run", async (request) => ({
      outcome: "success",
      preview: { simulated: request.payload },
      metrics: { tokens: 2 },
    }));
    const previousRegistry = setSandboxRegistry(sandboxRegistry);

    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-sandbox-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs("--role", "guardian"),
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger, loopDetector: new LoopDetector() };

    try {
      const created = await handleChildCreate(
        context,
        ChildCreateInputSchema.parse({
          metadata: { risk: "high", tags: ["analysis", "high-risk"] },
          wait_for_ready: true,
        }),
      );

      const sendResult = await handleChildSend(
        context,
        ChildSendInputSchema.parse({
          child_id: created.child_id,
          payload: { type: "prompt", content: "validate sandbox" },
          expect: "final",
          timeout_ms: 1500,
          sandbox: { metadata: { scenario: "unit" } },
        }),
      );

      expect(sendResult.sandbox_result).to.not.equal(null);
      expect(sendResult.sandbox_result?.status).to.equal("ok");
      expect(sendResult.sandbox_result?.preview).to.deep.equal({ simulated: { type: "prompt", content: "validate sandbox" } });
      expect(sendResult.sandbox_result?.metadata).to.include({ child_id: created.child_id, high_risk: true });
      expect(sendResult.sandbox_result?.metadata).to.include({ scenario: "unit" });
      expect(sendResult.awaited_message).to.not.equal(null);
      expect(sendResult.loop_alert).to.equal(null);
      const parsed = sendResult.awaited_message?.parsed as { type?: string; content?: string } | null;
      expect(parsed?.type).to.equal("response");
      expect(parsed?.content).to.equal("validate sandbox");
    } finally {
      setSandboxRegistry(previousRegistry);
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("surfaces loop alerts when alternating exchanges repeat too quickly", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-loop-"));
    const loopDetector = new LoopDetector({
      loopWindowMs: 10_000,
      maxAlternations: 2,
      warnAtAlternations: 1,
      defaultTimeoutMs: 1_000,
      taskTimeouts: {
        analysis: { baseMs: 1_000, minMs: 250, maxMs: 4_000, complexityMultiplier: 1.1 },
      },
    });
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs("--role", "friendly"),
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger, loopDetector };

    try {
      const created = await handleChildCreate(
        context,
        ChildCreateInputSchema.parse({
          metadata: { task_id: "analysis-001", task_type: "analysis" },
          wait_for_ready: true,
        }),
      );

      const payload = { type: "prompt", content: "loop please" };

      const first = await handleChildSend(
        context,
        ChildSendInputSchema.parse({
          child_id: created.child_id,
          payload,
          expect: "final",
          timeout_ms: 1_500,
        }),
      );
      expect(first.loop_alert).to.not.equal(null);
      expect(first.loop_alert?.recommendation).to.equal("warn");

      const second = await handleChildSend(
        context,
        ChildSendInputSchema.parse({
          child_id: created.child_id,
          payload,
          expect: "final",
          timeout_ms: 1_500,
        }),
      );
      expect(second.loop_alert).to.not.equal(null);
      expect(second.loop_alert?.recommendation).to.equal("kill");

      const suggested = loopDetector.recommendTimeout("analysis", 1);
      expect(suggested).to.be.greaterThan(200);
      expect(suggested).to.be.at.most(4_000);

      await handleChildKill(context, ChildKillInputSchema.parse({ child_id: created.child_id, timeout_ms: 250 }));
      await supervisor.waitForExit(created.child_id, 1_000);
      const gcResult = handleChildGc(context, ChildGcInputSchema.parse({ child_id: created.child_id }));
      expect(gcResult.removed).to.equal(true);
    } finally {
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("aborts child_send when the sandbox reports a failure", async () => {
    const sandboxRegistry = new SandboxRegistry();
    sandboxRegistry.register("dry-run", async () => ({
      outcome: "failure",
      error: "detected risk",
    }));
    const previousRegistry = setSandboxRegistry(sandboxRegistry);

    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-sandbox-fail-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs("--role", "guardian"),
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger, loopDetector: new LoopDetector() };

    try {
      const created = await handleChildCreate(
        context,
        ChildCreateInputSchema.parse({ metadata: { risk: "high" }, wait_for_ready: true }),
      );

      const before = supervisor.stream(created.child_id, { limit: 100 }).totalMessages;

      let caught: Error | null = null;
      try {
        await handleChildSend(
          context,
          ChildSendInputSchema.parse({
            child_id: created.child_id,
            payload: { type: "prompt", content: "danger" },
            expect: "stream",
            timeout_ms: 1000,
          }),
        );
      } catch (error) {
        caught = error as Error;
      }

      expect(caught).to.be.instanceOf(Error);
      expect(caught?.message).to.match(/Sandbox action "dry-run" failed/);
      const after = supervisor.stream(created.child_id, { limit: 100 }).totalMessages;
      expect(after).to.equal(before);
    } finally {
      setSandboxRegistry(previousRegistry);
      await logger.flush();
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid prompt templates when creating a child", () => {
    const result = ChildCreateInputSchema.safeParse({ prompt: {} });
    expect(result.success).to.equal(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((message) => message.includes("must define at least one segment"))).to.equal(true);
    }
  });

  it("fails child_send when awaiting a response times out", async function () {
    this.timeout(10_000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-timeout-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: silentRunnerArgs(),
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger, loopDetector: new LoopDetector() };
    let created: Awaited<ReturnType<typeof handleChildCreate>> | null = null;

    try {
      created = await handleChildCreate(context, ChildCreateInputSchema.parse({ wait_for_ready: true }));

      let caught: Error | null = null;
      try {
        await handleChildSend(
          context,
          ChildSendInputSchema.parse({
            child_id: created.child_id,
            payload: { type: "prompt", content: "no response expected" },
            expect: "final",
            timeout_ms: 300,
          }),
        );
      } catch (error) {
        caught = error as Error;
      }

      expect(caught).to.be.instanceOf(Error);
      expect(caught?.message).to.include("failed after 300ms");
    } finally {
      try {
        if (created) {
          await handleChildKill(
            context,
            ChildKillInputSchema.parse({ child_id: created.child_id, timeout_ms: 100 }),
          ).catch(() => undefined);
          await supervisor.waitForExit(created.child_id, 500).catch(() => undefined);
          handleChildGc(context, ChildGcInputSchema.parse({ child_id: created.child_id }));
        }
      } finally {
        await logger.flush();
        await supervisor.disposeAll();
        await rm(childrenRoot, { recursive: true, force: true });
      }
    }
  });

  it("rejects tool invocations that are not in the allowlist", async function () {
    this.timeout(10_000);
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-allowlist-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: mockRunnerArgs("--role", "allowlist"),
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger, loopDetector: new LoopDetector() };
    let created: Awaited<ReturnType<typeof handleChildCreate>> | null = null;

    try {
      created = await handleChildCreate(
        context,
        ChildCreateInputSchema.parse({ tools_allow: ["graph_generate"], wait_for_ready: true }),
      );

      await handleChildSend(
        context,
        ChildSendInputSchema.parse({
          child_id: created.child_id,
          payload: { type: "tool", tool: "graph_generate", arguments: { probe: true } },
        }),
      );

      let caught: Error | null = null;
      try {
        await handleChildSend(
          context,
          ChildSendInputSchema.parse({
            child_id: created.child_id,
            payload: { type: "tool", tool: "graph_optimize", arguments: {} },
          }),
        );
      } catch (error) {
        caught = error as Error;
      }

      expect(caught).to.be.instanceOf(Error);
      expect(caught?.message).to.include("graph_optimize");
      expect(caught?.message.toLowerCase()).to.include("not allowed");
    } finally {
      try {
        if (created) {
          await handleChildKill(
            context,
            ChildKillInputSchema.parse({ child_id: created.child_id, timeout_ms: 150 }),
          ).catch(() => undefined);
          await supervisor.waitForExit(created.child_id, 500).catch(() => undefined);
          handleChildGc(context, ChildGcInputSchema.parse({ child_id: created.child_id }));
        }
      } finally {
        await logger.flush();
        await supervisor.disposeAll();
        await rm(childrenRoot, { recursive: true, force: true });
      }
    }
  });
});
