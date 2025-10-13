import { describe, it } from "mocha";
import { expect } from "chai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChildSupervisor, type ChildLogEventSnapshot } from "../src/childSupervisor.js";
import { EventBus } from "../src/events/bus.js";
import { writeArtifact } from "../src/artifacts.js";
import type { FileSystemGateway } from "../src/gateways/fs.js";

const mockRunnerPath = fileURLToPath(new URL("./fixtures/mock-runner.js", import.meta.url));
const stubbornRunnerPath = fileURLToPath(new URL("./fixtures/stubborn-runner.js", import.meta.url));
const neverReadyRunnerPath = fileURLToPath(new URL("./fixtures/never-ready-runner.js", import.meta.url));

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

  it("cleans up runtimes when the ready handshake never arrives", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-timeout-"));
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [neverReadyRunnerPath],
      idleTimeoutMs: 50,
      idleCheckIntervalMs: 25,
    });

    const childId = "timeout-child";

    try {
      let failure: unknown;
      try {
        await supervisor.createChild({
          childId,
          waitForReady: true,
          readyTimeoutMs: 200,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure, "createChild should reject when the ready handshake is missing").to.be.instanceOf(Error);
      expect((failure as Error).message).to.match(/Timed out/i);

      // The supervisor should reap the partial runtime before surfacing the error.
      const exit = await supervisor.waitForExit(childId, 1000);
      expect(
        exit.code === 0 || exit.signal !== null,
        "child should exit with either a code or a termination signal",
      ).to.equal(true);

      const snapshot = supervisor.childrenIndex.getChild(childId);
      expect(snapshot?.state, "index should reflect the failed spawn").to.be.oneOf(["error", "terminated", "killed"]);

      expect(() => supervisor.status(childId), "runtime must be detached after cleanup").to.throw(/Unknown child runtime/);
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

  it("preserves inferred correlation hints when the resolver omits identifiers", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-correlation-"));
    const recorded: Array<{ childId: string; snapshot: ChildLogEventSnapshot }> = [];
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath, "--role", "friendly"],
      // Resolver intentionally returns sparse hints with undefined fields to
      // mirror real-world resolvers that only override specific identifiers.
      resolveChildCorrelation: () => ({ childId: undefined, runId: undefined, opId: undefined }),
      recordChildLogEntry: (childId, snapshot) => {
        recorded.push({ childId, snapshot: { ...snapshot } });
      },
    });

    try {
      const created = await supervisor.createChild();
      expect(created.readyMessage).to.not.equal(null);

      await supervisor.send(created.childId, { type: "diagnostic", note: "correlation" });

      await supervisor.waitForMessage(
        created.childId,
        (message) => Boolean(message.parsed && (message.parsed as any).type === "echo"),
        500,
      );

      // Allow the async recorder to flush the captured snapshot before assertions.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const echoed = recorded.find(
        (entry) => entry.childId === created.childId && (entry.snapshot.parsed as any)?.payload?.note === "correlation",
      );
      expect(echoed).to.not.equal(undefined);
      expect(echoed?.snapshot.childId).to.equal(created.childId);
      expect(echoed?.snapshot.runId).to.equal(null);
      expect(echoed?.snapshot.opId).to.equal(null);
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("derives event correlation hints directly from child metadata", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-metadata-"));
    const bus = new EventBus({ historyLimit: 20 });
    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      defaultArgs: [mockRunnerPath, "--role", "friendly"],
      eventBus: bus,
    });

    try {
      const created = await supervisor.createChild({
        metadata: {
          run_id: "run-meta",
          op_id: "op-meta",
          job_id: "job-meta",
          graph_id: "graph-meta",
          node_id: "node-meta",
        },
      });

      expect(created.readyMessage).to.not.equal(null);

      await supervisor.send(created.childId, { type: "prompt", content: "derive" });
      await supervisor.waitForMessage(
        created.childId,
        (message) => Boolean(message.parsed && (message.parsed as any).type === "response"),
        1_000,
      );

      const events = bus.list({ cats: ["child"] });
      const responseEvent = events.find((event) => {
        if (event.msg !== "child_stdout" || !event.data || typeof event.data !== "object") {
          return false;
        }
        const payload = event.data as { stream?: string; parsed?: { type?: string } | null };
        return payload.stream === "stdout" && payload.parsed?.type === "response";
      });

      expect(responseEvent).to.not.equal(undefined);
      expect(responseEvent?.runId).to.equal("run-meta");
      expect(responseEvent?.opId).to.equal("op-meta");
      expect(responseEvent?.jobId).to.equal("job-meta");
      expect(responseEvent?.graphId).to.equal("graph-meta");
      expect(responseEvent?.nodeId).to.equal("node-meta");
      expect(responseEvent?.childId).to.equal(created.childId);
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });

  it("persists logical HTTP manifests through the injected filesystem gateway", async () => {
    const childrenRoot = await mkdtemp(path.join(tmpdir(), "supervisor-loopback-"));
    const calls: Array<{ path: string; data: string }> = [];
    const stubGateway: FileSystemGateway = {
      async writeFileUtf8(pathName, data) {
        calls.push({ path: pathName, data });
      },
    };

    const supervisor = new ChildSupervisor({
      childrenRoot,
      defaultCommand: process.execPath,
      fileSystem: stubGateway,
    });

    try {
      const result = await supervisor.registerHttpChild({
        endpoint: { url: "http://127.0.0.1:1234/mcp", headers: { authorization: "Bearer stub" } },
        metadata: { scenario: "fs-gateway" },
      });

      expect(result.childId).to.be.a("string");
      expect(calls, "filesystem gateway writes").to.have.lengthOf(1);

      const [manifestWrite] = calls;
      expect(manifestWrite.path).to.equal(result.manifestPath);

      const manifest = JSON.parse(manifestWrite.data) as { childId?: string; metadata?: Record<string, unknown> };
      expect(manifest.childId).to.equal(result.childId);
      expect(manifest.metadata?.transport).to.equal("http");
      expect(manifest.metadata?.endpoint).to.deep.equal({ url: "http://127.0.0.1:1234/mcp", headers: { authorization: "Bearer stub" } });
    } finally {
      await supervisor.disposeAll();
      await rm(childrenRoot, { recursive: true, force: true });
    }
  });
});
