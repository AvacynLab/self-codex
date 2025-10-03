import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor, type ChildLogEventSnapshot } from "../src/childSupervisor.js";
import { writeArtifact } from "../src/artifacts.js";

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));
const stubbornRunnerPath = fileURLToPath(new URL("./fixtures/stubborn-runner.js", import.meta.url));

describe("child supervisor", () => {
  it("spawns a child, exchanges messages, collects outputs and recycles the workspace", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-friendly-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath, "--role", "friendly"],
      idleTimeoutMs: 150,
      idleCheckIntervalMs: 25,
    });

    try {
      const created = await supervisor.createChild({
        metadata: { role: "friendly" },
        manifestExtras: { scenario: "unit-test" },
      });

      expect(created.childId).to.match(/^child-\d{13}-[a-f0-9]{6}$/);
      expect(created.readyMessage).to.not.equal(null);
      expect(created.index.state).to.equal("starting");

      const statusAfterReady = supervisor.status(created.childId);
      expect(statusAfterReady.index.state).to.equal("ready");
      expect(statusAfterReady.runtime.lifecycle).to.equal("running");

      const sendResult = await supervisor.send(created.childId, {
        type: "prompt",
        content: "ping supervisor",
      });

      expect(sendResult.messageId).to.include(created.childId);

      const response = await supervisor.waitForMessage(
        created.childId,
        (message) => Boolean(message.parsed && (message.parsed as any).type === "response"),
        1000,
      );

      expect((response.parsed as any).content).to.equal("ping supervisor");

      await writeArtifact({
        childrenRoot,
        childId: created.childId,
        relativePath: "reports/outcome.txt",
        data: "analysis", // The helper recomputes the SHA so we only need deterministic content.
        mimeType: "text/plain",
      });

      const collected = await supervisor.collect(created.childId);
      expect(collected.messages.some((message) => message.receivedAt === response.receivedAt)).to.equal(true);
      expect(collected.artifacts).to.deep.include({
        path: "reports/outcome.txt",
        size: "analysis".length,
        mimeType: "text/plain",
        sha256: collected.artifacts.find((item) => item.path === "reports/outcome.txt")?.sha256 ?? "",
      });

      const shutdown = await supervisor.cancel(created.childId, { signal: "SIGINT", timeoutMs: 500 });
      expect(shutdown.forced).to.equal(false);

      await supervisor.waitForExit(created.childId);
      supervisor.gc(created.childId);

      expect(() => supervisor.status(created.childId)).to.throw(/Unknown child/);
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("forces termination when the child ignores graceful shutdown", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-stubborn-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [stubbornRunnerPath],
      idleTimeoutMs: 150,
      idleCheckIntervalMs: 25,
    });

    try {
      const created = await supervisor.createChild();
      expect(created.readyMessage).to.not.equal(null);

      const shutdown = await supervisor.kill(created.childId, { timeoutMs: 100 });
      expect(shutdown.forced).to.equal(true);
      await supervisor.waitForExit(created.childId);
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("marks children as idle after the configured inactivity window", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-idle-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath, "--role", "friendly"],
      idleTimeoutMs: 80,
      idleCheckIntervalMs: 20,
    });

    try {
      const created = await supervisor.createChild();
      expect(created.readyMessage).to.not.equal(null);

      await new Promise((resolve) => setTimeout(resolve, 120));

      const snapshot = supervisor.childrenIndex.getChild(created.childId);
      expect(snapshot?.lastHeartbeatAt).to.be.a("number");
      expect(snapshot?.state).to.equal("idle");
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("forwards child logs with correlation metadata to the configured recorder", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-logs-"));
    const recorded: Array<{ childId: string; snapshot: ChildLogEventSnapshot }> = [];
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath, "--role", "friendly"],
      recordChildLogEntry: (childId, entry) => {
        recorded.push({ childId, snapshot: { ...entry } });
      },
      resolveChildCorrelation: (context) => {
        if (context.kind === "message" && context.message.parsed && typeof context.message.parsed === "object") {
          const parsed = context.message.parsed as Record<string, unknown>;
          if (parsed.type === "echo") {
            return { jobId: "job-logs", runId: "run-logs", opId: "op-echo" };
          }
        }
        return {};
      },
    });

    try {
      const created = await supervisor.createChild();
      expect(created.readyMessage).to.not.equal(null);

      await supervisor.send(created.childId, { type: "correlated", note: "please echo" });

      const echoed = await supervisor.waitForMessage(
        created.childId,
        (message) => Boolean(message.parsed && (message.parsed as any).type === "echo"),
        500,
      );
      expect(echoed.parsed).to.be.an("object");

      // Allow the async recorder to process the event loop tick.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const echoLog = recorded.find((entry) => entry.childId === created.childId && (entry.snapshot.parsed as any)?.type === "echo");
      expect(echoLog).to.not.equal(undefined);
      expect(echoLog?.snapshot.runId).to.equal("run-logs");
      expect(echoLog?.snapshot.opId).to.equal("op-echo");
      expect(echoLog?.snapshot.jobId).to.equal("job-logs");
      expect(echoLog?.snapshot.childId).to.equal(created.childId);
      expect(echoLog?.snapshot.message).to.include("\"type\":\"echo\"");
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
