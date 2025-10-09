import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readdir, rm } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server, logJournal } from "../src/server.js";
import { LogJournal } from "../src/monitor/log.js";

function recordLog(entry: Parameters<LogJournal["record"]>[0]): void {
  const component =
    entry.component ?? (entry.stream === "server" ? "server" : entry.stream === "run" ? "run" : "child");
  const stage = entry.stage ?? entry.message;
  const elapsedMs = entry.elapsedMs ?? null;
  logJournal.record({ ...entry, component, stage, elapsedMs });
}

/**
 * Integration coverage for the `logs_tail` MCP tool. The scenarios prime the journal with
 * deterministic entries and assert that the server enforces stream-specific invariants while
 * honouring pagination cursors.
 */
describe("logs tail tool", () => {
  beforeEach(() => {
    logJournal.reset();
  });

  it("returns orchestrator logs by default", async function () {
    this.timeout(5000);

    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 1,
      ts: Date.now() - 50,
      level: "info",
      message: "runtime_started",
      data: { scope: "test" },
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 2,
      ts: Date.now(),
      level: "warn",
      message: "heartbeat_delayed",
      data: { delay_ms: 42 },
      runId: "run-server-1",
      opId: "op-server-1",
    });
    await logJournal.flush();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-server", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({ name: "logs_tail", arguments: {} });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        stream: string;
        entries: Array<{ seq: number; message: string; run_id: string | null }>;
      };

      expect(structured.stream).to.equal("server");
      expect(structured.entries.length).to.equal(2);
      expect(structured.entries[0].seq).to.equal(1);
      expect(structured.entries[1].run_id).to.equal("run-server-1");
      expect(structured.entries[1].message).to.equal("heartbeat_delayed");
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("applies from_seq filters on run streams", async function () {
    this.timeout(5000);

    recordLog({
      stream: "run",
      bucketId: "run-filter",
      seq: 10,
      ts: Date.now() - 25,
      level: "info",
      message: "run_start",
      runId: "run-filter",
      opId: "op-filter-1",
    });
    recordLog({
      stream: "run",
      bucketId: "run-filter",
      seq: 11,
      ts: Date.now(),
      level: "info",
      message: "run_progress",
      runId: "run-filter",
      opId: "op-filter-1",
    });
    await logJournal.flush();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-run", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "logs_tail",
        arguments: { stream: "run", id: "run-filter", from_seq: 10, limit: 5 },
      });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        entries: Array<{ seq: number; message: string }>;
        next_seq: number;
      };

      expect(structured.entries.length).to.equal(1);
      expect(structured.entries[0].seq).to.equal(11);
      expect(structured.entries[0].message).to.equal("run_progress");
      expect(structured.next_seq).to.equal(11);
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("filters entries by severity levels", async function () {
    this.timeout(5000);

    // Prime the journal with a mix of informational and error level entries so the
    // tool has to apply the severity filter before pagination trims the results.
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 21,
      ts: Date.now() - 20,
      level: "info",
      message: "scheduler_tick",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 22,
      ts: Date.now() - 10,
      level: "error",
      message: "scheduler_failed",
      data: { reason: "timeout" },
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 23,
      ts: Date.now(),
      level: "warn",
      message: "scheduler_recovered",
    });
    await logJournal.flush();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-level", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "logs_tail",
        arguments: { levels: ["error"] },
      });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        entries: Array<{ seq: number; level: string; message: string }>;
        levels: string[] | null;
      };

      expect(structured.levels).to.deep.equal(["error"]);
      expect(structured.entries.length).to.equal(1);
      expect(structured.entries[0].seq).to.equal(22);
      expect(structured.entries[0].level).to.equal("error");
      expect(structured.entries[0].message).to.equal("scheduler_failed");
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("deduplicates normalised severity filters", async function () {
    this.timeout(5000);

    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 31,
      ts: Date.now() - 30,
      level: "debug",
      message: "prelude",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 32,
      ts: Date.now() - 20,
      level: "warn",
      message: "scheduler_warning",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 33,
      ts: Date.now() - 10,
      level: "error",
      message: "scheduler_failure",
    });
    await logJournal.flush();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-level-dedupe", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "logs_tail",
        arguments: { levels: ["ERROR", "warn", "ERROR"] },
      });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        entries: Array<{ seq: number; level: string }>;
        levels: string[] | null;
      };

      expect(structured.levels).to.deep.equal(["error", "warn"]);
      expect(structured.entries.map((entry) => entry.level)).to.deep.equal(["warn", "error"]);
      expect(structured.entries.map((entry) => entry.seq)).to.deep.equal([32, 33]);
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("filters entries by message substrings", async function () {
    this.timeout(5000);

    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 51,
      ts: Date.now() - 40,
      level: "info",
      message: "scheduler_tick_completed",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 52,
      ts: Date.now() - 30,
      level: "warn",
      message: "child failure timed out", // contains both search substrings.
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 53,
      ts: Date.now(),
      level: "error",
      message: "CHILD FAILURE TIMED OUT - escalation", // uppercase variant.
    });
    await logJournal.flush();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-message", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "logs_tail",
        arguments: { filters: { message_contains: [" Failure", "timed"] } },
      });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        entries: Array<{ seq: number; message: string }>;
        filters: { message_contains: string[] | null } | null;
      };

      expect(structured.filters?.message_contains).to.deep.equal(["failure", "timed"]);
      expect(structured.entries.length).to.equal(2);
      expect(structured.entries[0].seq).to.equal(52);
      expect(structured.entries[0].message).to.equal("child failure timed out");
      expect(structured.entries[1].seq).to.equal(53);
      expect(structured.entries[1].message).to.equal("CHILD FAILURE TIMED OUT - escalation");
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("filters entries by correlated identifiers", async function () {
    this.timeout(5000);

    // Insert entries sharing a bucket but exposing distinct correlated
    // identifiers so the tool can exercise every filter predicate at once.
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 41,
      ts: Date.now() - 40,
      level: "info",
      message: "alpha_start",
      runId: "run-alpha",
      jobId: "job-42",
      opId: "op-alpha-1",
      graphId: "graph-shared",
      nodeId: "node-root",
      childId: "child-1",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 42,
      ts: Date.now() - 30,
      level: "info",
      message: "alpha_progress",
      runId: "run-alpha",
      jobId: "job-99",
      opId: "op-alpha-2",
      graphId: "graph-shared",
      nodeId: "node-root",
      childId: "child-1",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 43,
      ts: Date.now(),
      level: "info",
      message: "beta_start",
      runId: "run-beta",
      jobId: "job-42",
      opId: "op-beta-1",
      graphId: "graph-alt",
      nodeId: "node-alt",
      childId: "child-2",
    });
    await logJournal.flush();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-correlated", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "logs_tail",
        arguments: {
          filters: {
            run_ids: ["run-alpha"],
            job_ids: ["job-42"],
            op_ids: ["op-alpha-1"],
            graph_ids: ["graph-shared"],
            node_ids: ["node-root"],
            child_ids: ["child-1"],
          },
        },
      });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        entries: Array<{ seq: number; message: string; run_id: string | null }>;
        filters: {
          run_ids: string[] | null;
          job_ids: string[] | null;
          op_ids: string[] | null;
          graph_ids: string[] | null;
          node_ids: string[] | null;
          child_ids: string[] | null;
          message_contains: string[] | null;
          since_ts: number | null;
          until_ts: number | null;
        } | null;
      };

      expect(structured.entries.length).to.equal(1);
      expect(structured.entries[0].seq).to.equal(41);
      expect(structured.entries[0].message).to.equal("alpha_start");
      expect(structured.entries[0].run_id).to.equal("run-alpha");
      expect(structured.filters).to.deep.equal({
        run_ids: ["run-alpha"],
        job_ids: ["job-42"],
        op_ids: ["op-alpha-1"],
        graph_ids: ["graph-shared"],
        node_ids: ["node-root"],
        child_ids: ["child-1"],
        message_contains: null,
        since_ts: null,
        until_ts: null,
      });
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("limits entries to the requested timestamp window", async function () {
    this.timeout(5000);

    const baseTs = 1_000_000;

    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 51,
      ts: baseTs - 50,
      level: "info",
      message: "before_window",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 52,
      ts: baseTs + 10,
      level: "warn",
      message: "within_window_start",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 53,
      ts: baseTs + 30,
      level: "error",
      message: "within_window_end",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 54,
      ts: baseTs + 60,
      level: "info",
      message: "after_window",
    });
    await logJournal.flush();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-time", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "logs_tail",
        arguments: {
          filters: {
            since_ts: baseTs,
            until_ts: baseTs + 40,
          },
        },
      });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        entries: Array<{ seq: number; message: string; ts: number }>;
        filters: {
          run_ids: string[] | null;
          job_ids: string[] | null;
          op_ids: string[] | null;
          graph_ids: string[] | null;
          node_ids: string[] | null;
          child_ids: string[] | null;
          message_contains: string[] | null;
          since_ts: number | null;
          until_ts: number | null;
        } | null;
      };

      expect(structured.entries.map((entry) => entry.seq)).to.deep.equal([52, 53]);
      expect(structured.entries.map((entry) => entry.message)).to.deep.equal([
        "within_window_start",
        "within_window_end",
      ]);
      expect(structured.filters).to.deep.equal({
        run_ids: null,
        job_ids: null,
        op_ids: null,
        graph_ids: null,
        node_ids: null,
        child_ids: null,
        message_contains: null,
        since_ts: baseTs,
        until_ts: baseTs + 40,
      });
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("accepts case-insensitive level filters", async function () {
    this.timeout(5000);

    // Inject entries spanning multiple severity levels so the tool can prove it
    // normalises the requested filters before delegating to the journal.
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 31,
      ts: Date.now() - 30,
      level: "info",
      message: "dispatcher_idle",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 32,
      ts: Date.now() - 20,
      level: "warn",
      message: "dispatcher_queue_growth",
    });
    recordLog({
      stream: "server",
      bucketId: "orchestrator",
      seq: 33,
      ts: Date.now(),
      level: "error",
      message: "dispatcher_overloaded",
    });
    await logJournal.flush();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-level-case", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "logs_tail",
        arguments: { levels: ["ERROR", "Warn"] },
      });
      expect(response.isError ?? false).to.equal(false);

      const structured = response.structuredContent as {
        entries: Array<{ seq: number; level: string; message: string }>;
        levels: string[] | null;
      };

      expect(structured.levels).to.deep.equal(["error", "warn"]);
      expect(structured.entries.map((entry) => entry.seq)).to.deep.equal([32, 33]);
      expect(structured.entries.map((entry) => entry.level)).to.deep.equal(["warn", "error"]);
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("persists bucket files within the configured root", async () => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "log-journal-sandbox-"));
    const journal = new LogJournal({ rootDir: sandboxRoot, maxEntriesPerBucket: 5 });

    try {
      journal.record({
        stream: "run",
        bucketId: "../escape/..",
        seq: 1,
        ts: Date.now(),
        level: "info",
        message: "sandboxed",
      });
      await journal.flush();

      const runsDirectory = path.join(sandboxRoot, "runs");
      const bucketFiles = await readdir(runsDirectory);
      expect(bucketFiles).to.have.lengthOf(1);
      expect(bucketFiles[0]).to.match(/\.jsonl$/);
      expect(bucketFiles[0].includes(".."), "bucket filename contains traversal markers").to.equal(false);

      const rootEntries = await readdir(sandboxRoot);
      expect(rootEntries).to.include("runs");
      expect(rootEntries.some((entry) => entry.includes(".."))).to.equal(false);
    } finally {
      await journal.flush();
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects run streams without an identifier", async function () {
    this.timeout(5000);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "logs-tail-errors", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({ name: "logs_tail", arguments: { stream: "run" } });
      expect(response.isError ?? true).to.equal(true);
      expect(response.content?.[0]?.type).to.equal("text");
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
