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

import type {
  ResourceBlackboardEvent,
  ResourceChildLogEntry,
  ResourceRunEvent,
  ResourceWatchResult,
} from "../src/resources/registry.js";
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
          component: "graph",
          stage: "status",
          elapsedMs: 12,
          payload: {
            note: "line1\nline2\rline3\u2028line4",
          },
        } satisfies ResourceRunEvent,
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
        component: "graph",
        stage: "status",
        elapsed_ms: 12,
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
        } satisfies ResourceChildLogEntry,
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

  it("serialises blackboard events with namespace metadata", () => {
    const page: ResourceWatchResult = {
      uri: "sc://blackboard/core",
      kind: "blackboard_namespace",
      nextSeq: 5,
      events: [
        {
          seq: 5,
          version: 5,
          ts: 8_500,
          kind: "set",
          namespace: "core",
          key: "core:pending",
          entry: {
            key: "core:pending",
            value: { task: "triage" },
            tags: ["priority"],
            createdAt: 7_000,
            updatedAt: 8_500,
            expiresAt: null,
            version: 5,
          },
          previous: null,
          reason: null,
        } satisfies ResourceBlackboardEvent,
      ],
    };

    const messages = serialiseResourceWatchResultForSse(page);
    expect(messages).to.have.length(1);
    expect(messages[0].event).to.equal("resource_blackboard_event");
    expect(messages[0].id).to.equal("sc://blackboard/core:5");

    const stream = renderResourceWatchSseMessages(messages);
    const parsed = parseSseStream(stream);
    expect(parsed).to.have.length(1);
    expect(parsed[0].event).to.equal("resource_blackboard_event");
    expect(parsed[0].id).to.equal("sc://blackboard/core:5");
    expect(parsed[0].data).to.have.length(1);
    expect(parsed[0].data[0]).to.not.include("\n");

    const payload = JSON.parse(parsed[0].data[0]);
    expect(payload).to.deep.equal({
      uri: "sc://blackboard/core",
      kind: "blackboard_namespace",
      next_seq: 5,
      record: {
        type: "blackboard_event",
        seq: 5,
        version: 5,
        ts: 8_500,
        kind: "set",
        namespace: "core",
        key: "core:pending",
        entry: {
          key: "core:pending",
          value: { task: "triage" },
          tags: ["priority"],
          createdAt: 7_000,
          updatedAt: 8_500,
          expiresAt: null,
          version: 5,
        },
        previous: null,
        reason: null,
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

    const filteredPage: ResourceWatchResult = {
      uri: "sc://blackboard/core",
      kind: "blackboard_namespace",
      events: [],
      nextSeq: 9,
      filters: { keys: ["alpha"], blackboard: { keys: ["alpha"] } },
    };

    const filteredMessages = serialiseResourceWatchResultForSse(filteredPage);
    expect(filteredMessages).to.have.length(1);
    expect(filteredMessages[0].event).to.equal("resource_keep_alive");

    const filteredStream = renderResourceWatchSseMessages(filteredMessages);
    const filteredParsed = parseSseStream(filteredStream);
    expect(filteredParsed).to.have.length(1);
    expect(filteredParsed[0].event).to.equal("resource_keep_alive");

    const filteredPayload = JSON.parse(filteredParsed[0].data[0]!);
    expect(filteredPayload).to.deep.equal({
      uri: "sc://blackboard/core",
      kind: "blackboard_namespace",
      next_seq: 9,
      filters: { keys: ["alpha"], blackboard: { keys: ["alpha"] } },
      record: { type: "keep_alive" },
    });

    const timestampFiltered: ResourceWatchResult = {
      uri: "sc://blackboard/core",
      kind: "blackboard_namespace",
      events: [],
      nextSeq: 10,
      filters: { blackboard: { sinceTs: 1_000, untilTs: 2_000 } },
    };

    const timestampMessages = serialiseResourceWatchResultForSse(timestampFiltered);
    expect(timestampMessages).to.have.length(1);
    const timestampStream = renderResourceWatchSseMessages(timestampMessages);
    const timestampParsed = parseSseStream(timestampStream);
    const timestampPayload = JSON.parse(timestampParsed[0].data[0]!);
    expect(timestampPayload.filters).to.deep.equal({ blackboard: { sinceTs: 1_000, untilTs: 2_000 } });

    const tagFiltered: ResourceWatchResult = {
      uri: "sc://blackboard/core",
      kind: "blackboard_namespace",
      events: [],
      nextSeq: 10,
      filters: { blackboard: { tags: ["urgent"] } },
    };

    const tagMessages = serialiseResourceWatchResultForSse(tagFiltered);
    expect(tagMessages).to.have.length(1);
    const tagStream = renderResourceWatchSseMessages(tagMessages);
    const tagParsed = parseSseStream(tagStream);
    const tagPayload = JSON.parse(tagParsed[0].data[0]!);
    expect(tagPayload.filters).to.deep.equal({ blackboard: { tags: ["urgent"] } });

    const kindFiltered: ResourceWatchResult = {
      uri: "sc://blackboard/core",
      kind: "blackboard_namespace",
      events: [],
      nextSeq: 11,
      filters: { blackboard: { kinds: ["delete"] } },
    };

    const kindMessages = serialiseResourceWatchResultForSse(kindFiltered);
    expect(kindMessages).to.have.length(1);
    const kindStream = renderResourceWatchSseMessages(kindMessages);
    const kindParsed = parseSseStream(kindStream);
    const kindPayload = JSON.parse(kindParsed[0].data[0]!);
    expect(kindPayload.filters).to.deep.equal({ blackboard: { kinds: ["delete"] } });

    const runFilteredPage: ResourceWatchResult = {
      uri: "sc://runs/run-filter/events",
      kind: "run_events",
      events: [],
      nextSeq: 12,
      filters: { run: { kinds: ["STATUS"], levels: ["warn"], opIds: ["op-keep"] } },
    };

    const runMessages = serialiseResourceWatchResultForSse(runFilteredPage);
    expect(runMessages).to.have.length(1);
    expect(runMessages[0].event).to.equal("resource_keep_alive");

    const runStream = renderResourceWatchSseMessages(runMessages);
    const runParsed = parseSseStream(runStream);
    expect(runParsed).to.have.length(1);
    const runPayload = JSON.parse(runParsed[0].data[0]!);
    expect(runPayload).to.deep.equal({
      uri: "sc://runs/run-filter/events",
      kind: "run_events",
      next_seq: 12,
      filters: { run: { kinds: ["STATUS"], levels: ["warn"], opIds: ["op-keep"] } },
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
      component: "graph",
      stage: "status",
      elapsedMs: null,
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
          component: "graph",
          stage: "status",
          elapsed_ms: null,
          payload: { message: "line1\nline2\rline3\u2028line4" },
        },
      });
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("propagates run filters in SSE responses", async function () {
    this.timeout(5000);

    const runId = `run-sse-filter-${Date.now()}`;
    const now = Date.now();

    resources.recordRunEvent(runId, {
      seq: 1,
      ts: now,
      kind: "STATUS",
      level: "info",
      runId,
      opId: "op-filter",
      childId: null,
      component: "graph",
      stage: "status",
      elapsedMs: null,
      payload: { marker: "filter" },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resources-watch-sse-filter", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "resources_watch",
        arguments: {
          uri: `sc://runs/${runId}/events`,
          format: "sse",
          run: { kinds: ["status"], levels: ["info"], op_ids: ["op-filter"] },
        },
      });

      expect(response.isError ?? false).to.equal(false);
      const structured = response.structuredContent as {
        format: string;
        stream: string;
        messages: Array<{ id: string; event: string; data: string }>;
        next_seq: number;
        filters?: {
          run?: {
            kinds?: string[];
            levels?: string[];
            opIds?: string[];
            sinceTs?: number;
            untilTs?: number;
          };
        };
      };

      expect(structured.filters).to.deep.equal({ run: { kinds: ["STATUS"], levels: ["info"], opIds: ["op-filter"] } });
      const parsed = parseSseStream(structured.stream);
      expect(parsed).to.have.length(1);
      const payload = JSON.parse(parsed[0]!.data[0]!);
      expect(payload.filters).to.deep.equal({ run: { kinds: ["STATUS"], levels: ["info"], opIds: ["op-filter"] } });
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("propagates timestamp filters in SSE responses", async function () {
    this.timeout(5000);

    const runId = `run-sse-ts-${Date.now()}`;
    const now = Date.now();

    resources.recordRunEvent(runId, {
      seq: 1,
      ts: now,
      kind: "STATUS",
      level: "info",
      runId,
      opId: null,
      childId: null,
      component: "graph",
      stage: "status",
      elapsedMs: null,
      payload: { snapshot: "ts" },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resources-watch-sse-ts", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: "resources_watch",
        arguments: {
          uri: `sc://runs/${runId}/events`,
          format: "sse",
          run: { since_ts: now - 100, until_ts: now + 100 },
        },
      });

      expect(response.isError ?? false).to.equal(false);
      const structured = response.structuredContent as {
        format: string;
        stream: string;
        messages: Array<{ id: string; event: string; data: string }>;
        next_seq: number;
        filters?: { run?: { sinceTs?: number; untilTs?: number } };
      };

      // Timestamp constraints must be echoed verbatim so reconnecting clients can reuse them.
      expect(structured.filters).to.deep.equal({ run: { sinceTs: now - 100, untilTs: now + 100 } });

      const parsed = parseSseStream(structured.stream);
      expect(parsed).to.have.length(1);
      const payload = JSON.parse(parsed[0]!.data[0]!);
      expect(payload.filters).to.deep.equal({ run: { sinceTs: now - 100, untilTs: now + 100 } });
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("propagates blackboard kind filters in SSE responses", async function () {
    this.timeout(5000);

    const namespace = `bb-sse-${Date.now()}`;
    const key = `${namespace}:entry`;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resources-watch-bb-kinds", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const seed = await client.callTool({
        name: "bb_set",
        arguments: { key, value: { note: "seed" } },
      });
      expect(seed.isError ?? false).to.equal(false);

      const response = await client.callTool({
        name: "resources_watch",
        arguments: {
          uri: `sc://blackboard/${namespace}`,
          format: "sse",
          blackboard: { kinds: ["set"] },
        },
      });

      expect(response.isError ?? false).to.equal(false);
      const structured = response.structuredContent as {
        format: string;
        stream: string;
        messages: Array<{ id: string; event: string; data: string }>;
        next_seq: number;
        filters?: { blackboard?: { kinds?: string[]; tags?: string[] } };
      };

      expect(structured.filters).to.deep.equal({ blackboard: { kinds: ["set"] } });
      expect(structured.messages).to.have.length(1);

      const parsed = parseSseStream(structured.stream);
      expect(parsed).to.have.length(1);
      const payload = JSON.parse(parsed[0]!.data[0]!);
      expect(payload.filters).to.deep.equal({ blackboard: { kinds: ["set"] } });
      expect(payload.record).to.include({ type: "blackboard_event", kind: "set", key });
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });

  it("propagates blackboard tag filters in SSE responses", async function () {
    this.timeout(5000);

    const namespace = `bb-sse-tags-${Date.now()}`;
    const key = `${namespace}:entry`;

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resources-watch-bb-tags", version: "1.0.0-test" });

    await server.close().catch(() => {});
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const seed = await client.callTool({
        name: "bb_set",
        arguments: { key, value: { note: "seed" }, tags: ["Urgent", "Focus"] },
      });
      expect(seed.isError ?? false).to.equal(false);

      const response = await client.callTool({
        name: "resources_watch",
        arguments: {
          uri: `sc://blackboard/${namespace}`,
          format: "sse",
          blackboard: { tags: ["urgent"] },
        },
      });

      expect(response.isError ?? false).to.equal(false);
      const structured = response.structuredContent as {
        format: string;
        stream: string;
        messages: Array<{ id: string; event: string; data: string }>;
        next_seq: number;
        filters?: { blackboard?: { tags?: string[]; kinds?: string[] } };
      };

      expect(structured.filters).to.deep.equal({ blackboard: { tags: ["urgent"] } });
      expect(structured.messages).to.have.length(1);

      const parsed = parseSseStream(structured.stream);
      expect(parsed).to.have.length(1);
      const payload = JSON.parse(parsed[0]!.data[0]!);
      expect(payload.filters).to.deep.equal({ blackboard: { tags: ["urgent"] } });
      expect(payload.record).to.include({ type: "blackboard_event", kind: "set", key });
    } finally {
      await client.close();
      await server.close().catch(() => {});
    }
  });
});
