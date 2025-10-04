import { describe, it, beforeEach } from "mocha";
import { expect } from "chai";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server, logJournal } from "../src/server.js";

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

    logJournal.record({
      stream: "server",
      bucketId: "orchestrator",
      seq: 1,
      ts: Date.now() - 50,
      level: "info",
      message: "runtime_started",
      data: { scope: "test" },
    });
    logJournal.record({
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

    logJournal.record({
      stream: "run",
      bucketId: "run-filter",
      seq: 10,
      ts: Date.now() - 25,
      level: "info",
      message: "run_start",
      runId: "run-filter",
      opId: "op-filter-1",
    });
    logJournal.record({
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
