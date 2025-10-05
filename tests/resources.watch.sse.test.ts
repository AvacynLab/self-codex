/**
 * Validates the SSE serialisation helpers preparing `resources_watch` for
 * streaming endpoints. The scenarios cover newline/Unicode separators so we can
 * guarantee the resulting `data:` lines stay single-line and reversible via
 * `JSON.parse`.
 */
import { describe, it } from "mocha";
import { expect } from "chai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ResourceWatchResult } from "../src/resources/registry.js";
import {
  renderResourceWatchSseMessages,
  serialiseResourceWatchResultForSse,
} from "../src/resources/sse.js";
import { parseSseStream } from "./helpers/sse.js";
import { resources, server } from "../src/server.js";

describe("resources_watch SSE serialisation", () => {
  it("serialises run events with escaped separators", () => {
    const page: ResourceWatchResult = {
      uri: "sc://runs/run-escape/events",
      kind: "run_events",
      nextSeq: 42,
      events: [
        {
          seq: 42,
          ts: 9_000,
          kind: "STATUS",
          level: "info",
          jobId: "job-escape",
          runId: "run-escape",
          opId: "op-escape",
          graphId: "graph-escape",
          nodeId: "node-escape",
          childId: "child-escape",
          payload: {
            note: "line1\nline2\rline3\u2028line4",
          },
        },
      ],
    };

    const messages = serialiseResourceWatchResultForSse(page);
    expect(messages).to.have.length(1);
    expect(messages[0].event).to.equal("resource_run_event");
    expect(messages[0].id).to.equal("sc://runs/run-escape/events:42");

    const stream = renderResourceWatchSseMessages(messages);
    const parsed = parseSseStream(stream);
    expect(parsed).to.have.length(1);
    expect(parsed[0].event).to.equal("resource_run_event");
    expect(parsed[0].id).to.equal("sc://runs/run-escape/events:42");
    expect(parsed[0].data).to.have.length(1);
    expect(parsed[0].data[0]).to.not.include("\n");

    const payload = JSON.parse(parsed[0].data[0]);
    expect(payload).to.deep.equal({
      uri: "sc://runs/run-escape/events",
      kind: "run_events",
      next_seq: 42,
      record: {
        type: "run_event",
        seq: 42,
        ts: 9_000,
        kind: "STATUS",
        level: "info",
        job_id: "job-escape",
        run_id: "run-escape",
        op_id: "op-escape",
        graph_id: "graph-escape",
        node_id: "node-escape",
        child_id: "child-escape",
        payload: {
          note: "line1\nline2\rline3\u2028line4",
        },
      },
    });
  });

  it("serialises child log entries while preserving structured payloads", () => {
    const page: ResourceWatchResult = {
      uri: "sc://children/child-escape/logs",
      kind: "child_logs",
      nextSeq: 7,
      events: [
        {
          seq: 7,
          ts: 5_500,
          stream: "stderr",
          message: "warning line1\nline2\u2029tail",
          jobId: null,
          runId: "run-child",
          opId: null,
          graphId: "graph-child",
          nodeId: null,
          childId: "child-escape",
          raw: "raw line1\nraw line2",
          parsed: { structured: true },
        },
      ],
    };

    const messages = serialiseResourceWatchResultForSse(page);
    expect(messages).to.have.length(1);
    expect(messages[0].event).to.equal("resource_child_log");
    expect(messages[0].id).to.equal("sc://children/child-escape/logs:7");

    const stream = renderResourceWatchSseMessages(messages);
    const parsed = parseSseStream(stream);
    expect(parsed).to.have.length(1);
    expect(parsed[0].event).to.equal("resource_child_log");
    expect(parsed[0].id).to.equal("sc://children/child-escape/logs:7");
    expect(parsed[0].data).to.have.length(1);
    expect(parsed[0].data[0]).to.not.include("\n");

    const payload = JSON.parse(parsed[0].data[0]);
    expect(payload).to.deep.equal({
      uri: "sc://children/child-escape/logs",
      kind: "child_logs",
      next_seq: 7,
      record: {
        type: "child_log",
        seq: 7,
        ts: 5_500,
        stream: "stderr",
        message: "warning line1\nline2\u2029tail",
        job_id: null,
        run_id: "run-child",
        op_id: null,
        graph_id: "graph-child",
        node_id: null,
        child_id: "child-escape",
        raw: "raw line1\nraw line2",
        parsed: { structured: true },
      },
    });
  });

  it("emits keep-alives when a page is empty", () => {
    const page: ResourceWatchResult = {
      uri: "sc://children/idle/logs",
      kind: "child_logs",
      events: [],
      nextSeq: 11,
    };

    const messages = serialiseResourceWatchResultForSse(page);
    expect(messages).to.have.length(1);
    expect(messages[0]).to.include({
      id: "sc://children/idle/logs:11",
      event: "resource_keep_alive",
    });

    const stream = renderResourceWatchSseMessages(messages);
    const parsed = parseSseStream(stream);
    expect(parsed).to.have.length(1);
    expect(parsed[0].event).to.equal("resource_keep_alive");
    expect(parsed[0].id).to.equal("sc://children/idle/logs:11");
    expect(parsed[0].data).to.have.length(1);
    expect(parsed[0].data[0]).to.not.include("\n");

    const payload = JSON.parse(parsed[0].data[0]);
    expect(payload).to.deep.equal({
      uri: "sc://children/idle/logs",
      kind: "child_logs",
      next_seq: 11,
      record: { type: "keep_alive" },
    });
  });
});

describe("resources_watch tool SSE integration", () => {
  it("returns an SSE stream containing escaped run events", async function () {
    this.timeout(5000);

    const runId = `run-sse-${Date.now()}`;
    const now = Date.now();
    // Seed the registry with a run event carrying control characters so the SSE
    // serialisation path must escape them before the tool exposes the stream.
    resources.recordRunEvent(runId, {
      seq: 1,
      ts: now,
      kind: "STATUS",
      level: "info",
      jobId: "job-sse",
      runId,
      childId: null,
      payload: { message: "line1\nline2\rline3\u2028line4" },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resources-watch-sse", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "resources_watch",
        arguments: { uri: `sc://runs/${runId}/events`, format: "sse" },
      });

      expect(response.isError ?? false).to.equal(false);
      const structured = response.structuredContent as {
        format: string;
        stream: string;
        messages: Array<{ id: string; event: string; data: string }>;
        next_seq: number;
      };

      expect(structured.format).to.equal("sse");
      expect(structured.next_seq).to.equal(1);
      expect(structured.messages).to.have.length(1);
      expect(structured.messages[0]?.event).to.equal("resource_run_event");
      expect(structured.messages[0]?.data).to.not.include("\n");

      const parsed = parseSseStream(structured.stream);
      expect(parsed).to.have.length(1);
      expect(parsed[0]?.event).to.equal("resource_run_event");
      expect(parsed[0]?.data).to.have.length(1);
      expect(parsed[0]?.data[0]).to.not.include("\n");

      const payload = JSON.parse(parsed[0]!.data[0]!);
      expect(payload).to.deep.equal({
        uri: `sc://runs/${runId}/events`,
        kind: "run_events",
        next_seq: 1,
        record: {
          type: "run_event",
          seq: 1,
          ts: now,
          kind: "STATUS",
          level: "info",
          job_id: "job-sse",
          run_id: runId,
          op_id: null,
          graph_id: null,
          node_id: null,
          child_id: null,
          payload: { message: "line1\nline2\rline3\u2028line4" },
        },
      });
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
