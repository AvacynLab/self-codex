import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor } from "../src/childSupervisor.js";
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

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));
const stubbornRunnerPath = fileURLToPath(new URL("./fixtures/stubborn-runner.js", import.meta.url));

describe("child tool handlers", () => {
  it("creates a cooperative child, exchanges messages and cleans up resources", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-tools-friendly-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath, "--role", "friendly"],
      idleTimeoutMs: 150,
      idleCheckIntervalMs: 25,
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger };

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
        (message) => {
          const parsed = message.parsed as { type?: string; content?: string } | null;
          return parsed?.type === "response" && parsed.content === "hello child";
        },
        1000,
      );
      expect((initialResponse.parsed as any).content).to.equal("hello child");

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

      const response = sendResult.awaited_message!;
      expect(response.stream).to.equal("stdout");
      const parsedResponse = response.parsed as { type?: string; content?: string } | null;
      expect(parsedResponse?.type).to.equal("response");
      expect(parsedResponse?.content).to.equal("ping from test");

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
      const streamMessage = streamSend.awaited_message!;
      const streamParsed = streamMessage.parsed as { type?: string } | null;
      expect(streamParsed?.type).to.equal("pong");

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
        .map((line) => JSON.parse(line) as { message: string });
      const messages = entries.map((entry) => entry.message);
      expect(messages).to.include("child_create_requested");
      expect(messages).to.include("child_send");
      expect(messages).to.include("child_collect");
      expect(messages).to.include("child_cancel");
      expect(messages).to.include("child_gc");
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
      defaultArgs: [stubbornRunnerPath],
      idleTimeoutMs: 100,
      idleCheckIntervalMs: 25,
    });
    const logFile = path.join(childrenRoot, "tmp", "orchestrator.log");
    const logger = new StructuredLogger({ logFile });
    const context: ChildToolContext = { supervisor, logger };

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
});
