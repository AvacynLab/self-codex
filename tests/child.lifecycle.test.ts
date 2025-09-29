import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ChildRuntime,
  startChildRuntime,
  ChildRuntimeMessage,
  type ChildCollectedOutputs,
  type ChildRuntimeStatus,
} from "../src/childRuntime.js";
import {
  ChildrenIndex,
  UnknownChildError,
} from "../src/state/childrenIndex.js";
import { childWorkspacePath } from "../src/paths.js";
import { writeArtifact } from "../src/artifacts.js";

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));
const stubbornRunnerPath = fileURLToPath(new URL("./fixtures/stubborn-runner.js", import.meta.url));

describe("child runtime lifecycle", () => {
  it("spawns a child, exchanges messages, logs activity and updates the index", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-runtime-"));
    const index = new ChildrenIndex();
    const childId = "child-lifecycle";

    let runtime: ChildRuntime | null = null;

    try {
      runtime = await startChildRuntime({
        childId,
        childrenRoot,
        command: process.execPath,
        args: [mockRunnerPath, "--role", "tester"],
        metadata: { role: "tester" },
        manifestExtras: { runner: "mock" },
      });

      index.registerChild({ childId, pid: runtime.pid, workdir: runtime.workdir });

      const readyMessage = await runtime.waitForMessage(
        (message: ChildRuntimeMessage) =>
          message.stream === "stdout" && Boolean(message.parsed && (message.parsed as any).type === "ready"),
      );
      const readyStatus: ChildRuntimeStatus = runtime.getStatus();
      expect(readyStatus.lifecycle).to.equal("running");
      expect(readyStatus.lastHeartbeatAt).to.be.a("number");

      index.updateState(childId, "ready");
      index.updateHeartbeat(childId, readyStatus.lastHeartbeatAt ?? readyMessage.receivedAt);

      await runtime.send({ type: "prompt", content: "hello orchestrator" });
      index.updateState(childId, "running");

      const response = await runtime.waitForMessage(
        (message: ChildRuntimeMessage) =>
          message.stream === "stdout" && Boolean(message.parsed && (message.parsed as any).type === "response"),
      );

      expect((response.parsed as any).content).to.equal("hello orchestrator");

      await writeArtifact({
        childrenRoot,
        childId,
        relativePath: "reports/summary.txt",
        data: "analysis-complete",
        mimeType: "text/plain",
      });

      const collected: ChildCollectedOutputs = await runtime.collectOutputs();
      expect(collected.childId).to.equal(childId);
      expect(collected.messages.some((msg) => msg.receivedAt === response.receivedAt)).to.equal(true);
      const collectedArtifact = collected.artifacts.find((item) => item.path === "reports/summary.txt");
      expect(collectedArtifact).to.not.equal(undefined);
      expect(collectedArtifact).to.include({
        path: "reports/summary.txt",
        size: "analysis-complete".length,
        mimeType: "application/octet-stream",
      });
      expect(collectedArtifact?.sha256).to.be.a("string");

      const statusAfterCollect = runtime.getStatus();
      expect(statusAfterCollect.lifecycle).to.equal("running");
      expect(statusAfterCollect.resourceUsage === null || typeof statusAfterCollect.resourceUsage === "object").to.equal(true);

      const shutdown = await runtime.shutdown({ signal: "SIGINT", timeoutMs: 1500 });
      expect(shutdown.forced).to.equal(false);

      const manifestPath = runtime.manifestPath;
      const logPath = runtime.logPath;

      const manifestRaw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(manifestRaw);

      expect(manifest.childId).to.equal(childId);
      expect(manifest.command).to.equal(process.execPath);
      expect(manifest.args).to.deep.equal([mockRunnerPath, "--role", "tester"]);
      expect(manifest.metadata).to.deep.equal({ role: "tester" });
      expect(manifest.runner).to.equal("mock");
      expect(Array.isArray(manifest.envKeys)).to.equal(true);
      expect(manifest.logs.child).to.equal(logPath);

      const logContents = await readFile(logPath, "utf8");
      const logLines = logContents
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      expect(logLines.some((entry) => entry.kind === "stdin")).to.equal(true);
      expect(logLines.some((entry) => entry.kind === "stdout")).to.equal(true);
      expect(logLines.some((entry) => entry.kind === "lifecycle" && entry.data.startsWith("exit:"))).to.equal(true);

      const workspaceLogsDir = childWorkspacePath(childrenRoot, childId, "logs");
      const workspaceOutboxDir = childWorkspacePath(childrenRoot, childId, "outbox");
      await stat(workspaceLogsDir);
      await stat(workspaceOutboxDir);

      const exitSnapshot = index.recordExit(childId, {
        code: shutdown.code,
        signal: shutdown.signal,
        at: Date.now(),
      });

      expect(exitSnapshot.state).to.equal("terminated");
      expect(exitSnapshot.forcedTermination).to.equal(false);

      const serialised = index.serialize();
      expect(serialised[childId]).to.include({ state: "terminated" });

      index.removeChild(childId);
      expect(index.getChild(childId)).to.equal(undefined);
    } finally {
      if (runtime) {
        try {
          await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 500 });
        } catch {
          // Best-effort cleanup for the tests.
        }
      }
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("forces termination when the child ignores graceful signals", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "child-stubborn-"));
    const childId = "child-stubborn";

    let runtime: ChildRuntime | null = null;

    try {
      runtime = await startChildRuntime({
        childId,
        childrenRoot,
        command: process.execPath,
        args: [stubbornRunnerPath],
        metadata: { role: "stubborn" },
      });

      await runtime.waitForMessage(
        (message: ChildRuntimeMessage) =>
          message.stream === "stdout" && Boolean(message.parsed && (message.parsed as any).type === "ready"),
      );

      const shutdown = await runtime.shutdown({ signal: "SIGTERM", timeoutMs: 100 });
      expect(shutdown.forced).to.equal(true);
      expect(shutdown.signal === "SIGKILL" || shutdown.code !== 0).to.equal(true);
    } finally {
      if (runtime) {
        try {
          await runtime.shutdown({ signal: "SIGKILL", timeoutMs: 200 });
        } catch {
          // already terminated
        }
      }
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});

describe("children index", () => {
  it("tracks state, retries, metadata and supports serialisation", () => {
    const index = new ChildrenIndex();
    const now = Date.now();

    const registered = index.registerChild({
      childId: "child-a",
      pid: 1234,
      workdir: "/tmp/child-a",
      state: "starting",
      createdAt: now,
      metadata: { role: "planner" },
    });

    expect(registered.state).to.equal("starting");
    expect(registered.retries).to.equal(0);

    index.updateHeartbeat("child-a", now + 50);
    index.incrementRetries("child-a");
    index.incrementRetries("child-a");
    index.mergeMetadata("child-a", { task: "analysis" });
    index.updateState("child-a", "running");

    const exit = index.recordExit("child-a", {
      code: 1,
      signal: "SIGTERM",
      forced: true,
      at: now + 120,
      reason: "timeout",
    });

    expect(exit.state).to.equal("killed");
    expect(exit.retries).to.equal(2);
    expect(exit.stopReason).to.equal("timeout");
    expect(exit.metadata).to.deep.equal({ role: "planner", task: "analysis" });

    const snapshot = index.serialize();
    expect(snapshot["child-a"]).to.include({ retries: 2, forcedTermination: true });

    index.clear();
    expect(index.list()).to.have.length(0);
    index.restore(snapshot as Record<string, unknown>);
    const restored = index.getChild("child-a");
    expect(restored).to.not.equal(undefined);
    expect(restored?.retries).to.equal(2);

    expect(() => index.updateState("missing", "idle")).to.throw(UnknownChildError);
  });
});
