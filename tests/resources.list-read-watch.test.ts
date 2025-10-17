/**
 * Validates the MCP resource registry by exercising listing, reading and
 * watching capabilities. The tests seed graphs, run events, child logs and
 * blackboard entries to ensure URIs resolve deterministically and sequences are
 * strictly monotonic for watch pagination.
 */
import { describe, it } from "mocha";
import { expect } from "chai";

import { BlackboardStore } from "../src/coord/blackboard.js";
import type { NormalisedGraph } from "../src/graph/types.js";
import {
  ResourceNotFoundError,
  ResourceRegistry,
  ResourceWatchUnsupportedError,
} from "../src/resources/registry.js";

function createGraph(graphId: string, version: number): NormalisedGraph {
  return {
    name: "workflow",
    graphId,
    graphVersion: version,
    nodes: [
      {
        id: "root",
        label: "root",
        attributes: { order: version },
      },
    ],
    edges: [],
    metadata: { revision: version },
  };
}

function recordRun(
  registry: ResourceRegistry,
  runId: string,
  event: Parameters<ResourceRegistry["recordRunEvent"]>[1],
): void {
  const component = (event.component ?? null) && typeof event.component === "string" ? event.component : "graph";
  const stage = event.stage ?? event.kind.toLowerCase();
  const elapsedMs =
    typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs)
      ? Math.max(0, Math.round(event.elapsedMs))
      : null;
  registry.recordRunEvent(runId, { ...event, component, stage, elapsedMs });
}

describe("resources registry", () => {
  it("lists and reads committed graphs, snapshots, runs, children and blackboard namespaces", () => {
    const blackboard = new BlackboardStore();
    blackboard.set("core:pending", { task: "triage" });
    blackboard.set("core:active", { task: "review" });

    const registry = new ResourceRegistry({ blackboard, runHistoryLimit: 20, childLogHistoryLimit: 20 });

    registry.recordGraphSnapshot({
      graphId: "demo",
      txId: "tx-1",
      baseVersion: 1,
      startedAt: 1_000,
      graph: createGraph("demo", 1),
    });
    registry.markGraphSnapshotCommitted({
      graphId: "demo",
      txId: "tx-1",
      committedAt: 1_500,
      finalVersion: 2,
      finalGraph: createGraph("demo", 2),
    });

    registry.recordGraphVersion({ graphId: "demo", version: 1, committedAt: 900, graph: createGraph("demo", 1) });
    registry.recordGraphVersion({ graphId: "demo", version: 2, committedAt: 1_500, graph: createGraph("demo", 2) });

    recordRun(registry, "run-77", {
      seq: 1,
      ts: 2_000,
      kind: "PLAN",
      level: "info",
      jobId: "job-1",
      childId: null,
      payload: { run_id: "run-77", note: "start" },
    });
    recordRun(registry, "run-77", {
      seq: 2,
      ts: 2_100,
      kind: "STATUS",
      level: "info",
      jobId: "job-1",
      childId: "child-9",
      payload: { run_id: "run-77", step: "fanout" },
    });

    registry.recordChildLogEntry("child-9", { ts: 2_050, stream: "stdout", message: "ready" });
    registry.recordChildLogEntry("child-9", {
      ts: 2_120,
      stream: "stderr",
      message: "warning",
      jobId: "job-1",
      runId: "run-77",
      opId: "op-1",
    });

    const entries = registry.list();
    const uris = entries.map((entry) => entry.uri);
    expect(uris).to.deep.equal([
      "sc://blackboard/core",
      "sc://children/child-9/logs",
      "sc://graphs/demo",
      "sc://graphs/demo@v1",
      "sc://graphs/demo@v2",
      "sc://runs/run-77/events",
      "sc://snapshots/demo/tx-1",
    ]);

    // Ensure the blackboard namespace surfaces deterministic metadata for pagination hints.
    const blackboardEntry = entries.find((entry) => entry.uri === "sc://blackboard/core");
    expect(blackboardEntry?.metadata).to.deep.equal({ entry_count: 2, latest_version: 2 });

    const graphsOnly = registry.list("sc://graphs/").map((entry) => entry.uri);
    expect(graphsOnly).to.deep.equal(["sc://graphs/demo", "sc://graphs/demo@v1", "sc://graphs/demo@v2"]);

    const latest = registry.read("sc://graphs/demo");
    expect(latest.kind).to.equal("graph");
    expect(latest.payload).to.deep.include({ graphId: "demo", version: 2, committedAt: 1_500 });

    const v1 = registry.read("sc://graphs/demo@v1");
    expect(v1.kind).to.equal("graph_version");
    expect(v1.payload).to.deep.include({ graphId: "demo", version: 1, committedAt: 900 });

    const snapshot = registry.read("sc://snapshots/demo/tx-1");
    expect(snapshot.kind).to.equal("snapshot");
    expect(snapshot.payload).to.deep.include({ state: "committed", baseVersion: 1, finalVersion: 2 });

    const run = registry.read("sc://runs/run-77/events");
    expect(run.kind).to.equal("run_events");
    const expectedRunEvents = [
      {
        seq: 1,
        ts: 2_000,
        kind: "PLAN",
        level: "info",
        jobId: "job-1",
        runId: "run-77",
        opId: null,
        graphId: null,
        nodeId: null,
        childId: null,
        component: "graph",
        stage: "plan",
        elapsedMs: null,
        payload: { run_id: "run-77", note: "start" },
      },
      {
        seq: 2,
        ts: 2_100,
        kind: "STATUS",
        level: "info",
        jobId: "job-1",
        runId: "run-77",
        opId: null,
        graphId: null,
        nodeId: null,
        childId: "child-9",
        component: "graph",
        stage: "status",
        elapsedMs: null,
        payload: { run_id: "run-77", step: "fanout" },
      },
    ];
    expect(run.payload).to.deep.equal({
      runId: "run-77",
      events: expectedRunEvents,
      jsonl: `${expectedRunEvents.map((evt) => JSON.stringify(evt)).join("\n")}\n`,
    });

    const childLogs = registry.read("sc://children/child-9/logs");
    expect(childLogs.kind).to.equal("child_logs");
    expect(childLogs.payload).to.deep.equal({
      childId: "child-9",
      logs: [
        {
          seq: 1,
          ts: 2_050,
          stream: "stdout",
          message: "ready",
          jobId: null,
          runId: null,
          opId: null,
          graphId: null,
          nodeId: null,
          childId: "child-9",
          raw: null,
          parsed: null,
        },
        {
          seq: 2,
          ts: 2_120,
          stream: "stderr",
          message: "warning",
          jobId: "job-1",
          runId: "run-77",
          opId: "op-1",
          graphId: null,
          nodeId: null,
          childId: "child-9",
          raw: null,
          parsed: null,
        },
      ],
    });

    const namespace = registry.read("sc://blackboard/core");
    expect(namespace.kind).to.equal("blackboard_namespace");
    expect(namespace.payload.namespace).to.equal("core");
    expect(namespace.payload.entries).to.have.length(2);
  });

  it("paginates watches with monotonic sequence numbers", () => {
    const registry = new ResourceRegistry();
    recordRun(registry, "run-123", {
      seq: 10,
      ts: 5_000,
      kind: "PLAN",
      level: "info",
      jobId: "job-xyz",
      payload: { run_id: "run-123" },
    });
    recordRun(registry, "run-123", {
      seq: 11,
      ts: 5_100,
      kind: "STATUS",
      level: "info",
      childId: "child-a",
      payload: { run_id: "run-123", state: "running" },
    });
    recordRun(registry, "run-123", {
      seq: 12,
      ts: 5_200,
      kind: "REPLY",
      level: "info",
      childId: "child-a",
      payload: { run_id: "run-123", reply: "ok" },
    });

    recordRun(registry, "run-123", {
      seq: 13,
      ts: 5_250,
      kind: "STATUS",
      level: "info",
      jobId: "job-xyz",
      runId: "run-123",
      opId: "op-7",
      graphId: "graph-42",
      nodeId: "node-beta",
      childId: "child-b",
      payload: { run_id: "run-123", op_id: "op-7", graph_id: "graph-42", node_id: "node-beta" },
    });

    const firstPage = registry.watch("sc://runs/run-123/events", { fromSeq: 0, limit: 2 });
    expect(firstPage.events.map((event) => event.seq)).to.deep.equal([10, 11]);
    expect(firstPage.nextSeq).to.equal(11);

    const secondPage = registry.watch("sc://runs/run-123/events", { fromSeq: firstPage.nextSeq, limit: 2 });
    expect(secondPage.events.map((event) => event.seq)).to.deep.equal([12, 13]);
    expect(secondPage.nextSeq).to.equal(13);

    const correlatedEvent = secondPage.events[1];
    expect(correlatedEvent).to.deep.equal({
      seq: 13,
      ts: 5_250,
      kind: "STATUS",
      level: "info",
      jobId: "job-xyz",
      runId: "run-123",
      opId: "op-7",
      graphId: "graph-42",
      nodeId: "node-beta",
      childId: "child-b",
      component: "graph",
      stage: "status",
      elapsedMs: null,
      payload: {
        run_id: "run-123",
        op_id: "op-7",
        graph_id: "graph-42",
        node_id: "node-beta",
      },
    });

    registry.recordChildLogEntry("child-a", { ts: 5_050, stream: "stdout", message: "tick" });
    registry.recordChildLogEntry("child-a", {
      ts: 5_060,
      stream: "stdout",
      message: "tock",
      runId: "run-123",
      opId: "op-8",
    });

    const logPage = registry.watch("sc://children/child-a/logs", { fromSeq: 0 });
    expect(logPage.events).to.deep.equal([
      {
        seq: 1,
        ts: 5_050,
        stream: "stdout",
        message: "tick",
        jobId: null,
        runId: null,
        opId: null,
        graphId: null,
        nodeId: null,
        childId: "child-a",
        raw: null,
        parsed: null,
      },
      {
        seq: 2,
        ts: 5_060,
        stream: "stdout",
        message: "tock",
        jobId: null,
        runId: "run-123",
        opId: "op-8",
        graphId: null,
        nodeId: null,
        childId: "child-a",
        raw: null,
        parsed: null,
      },
    ]);
    expect(logPage.nextSeq).to.equal(2);
  });

  it("filters run event pages using kinds, levels and correlation identifiers", () => {
    const registry = new ResourceRegistry();
    const runId = "run-filter";

    recordRun(registry, runId, {
      seq: 1,
      ts: 9_000,
      kind: "STATUS",
      level: "info",
      jobId: "job-a",
      opId: "op-a",
      graphId: "graph-a",
      nodeId: "node-a",
      childId: "child-a",
      payload: { stage: "bootstrap" },
    });

    recordRun(registry, runId, {
      seq: 2,
      ts: 9_100,
      kind: "METRIC",
      level: "debug",
      jobId: "job-b",
      opId: "op-b",
      graphId: "graph-b",
      nodeId: "node-b",
      childId: null,
      payload: { metric: 42 },
    });

    recordRun(registry, runId, {
      seq: 3,
      ts: 9_200,
      kind: "STATUS",
      level: "warn",
      jobId: "job-a",
      opId: "op-c",
      graphId: "graph-a",
      nodeId: "node-a",
      childId: "child-b",
      payload: { stage: "completion" },
    });

    const filtered = registry.watch(`sc://runs/${runId}/events`, {
      run: {
        kinds: ["status"],
        levels: ["warn"],
        jobIds: ["job-a"],
        opIds: ["op-c"],
        graphIds: ["graph-a"],
        nodeIds: ["node-a"],
        childIds: ["child-b"],
      },
    });

    expect(filtered.events).to.have.length(1);
    expect(filtered.events[0]).to.deep.include({
      seq: 3,
      kind: "STATUS",
      level: "warn",
      jobId: "job-a",
      opId: "op-c",
      graphId: "graph-a",
      nodeId: "node-a",
      childId: "child-b",
    });
    expect(filtered.nextSeq).to.equal(3);
    expect(filtered.filters?.run).to.deep.equal({
      kinds: ["STATUS"],
      levels: ["warn"],
      jobIds: ["job-a"],
      opIds: ["op-c"],
      graphIds: ["graph-a"],
      nodeIds: ["node-a"],
      childIds: ["child-b"],
    });

    const empty = registry.watch(`sc://runs/${runId}/events`, {
      run: {
        kinds: ["status"],
        childIds: ["missing-child"],
      },
    });

    expect(empty.events).to.have.length(0);
    expect(empty.nextSeq).to.equal(3);
    expect(empty.filters?.run).to.deep.equal({ kinds: ["STATUS"], childIds: ["missing-child"] });

    registry.recordChildLogEntry("child-filter", {
      ts: 9_050,
      stream: "stdout",
      message: "ignore",
      runId: runId,
      opId: "op-skip",
    });
    registry.recordChildLogEntry("child-filter", {
      ts: 9_060,
      stream: "stderr",
      message: "keep",
      runId: runId,
      opId: "op-keep",
      jobId: "job-a",
    });

    const childFiltered = registry.watch("sc://children/child-filter/logs", {
      child: { streams: ["stderr"], runIds: [runId], opIds: ["op-keep"], jobIds: ["job-a"] },
    });

    expect(childFiltered.events).to.have.length(1);
    expect(childFiltered.events[0]).to.include({
      stream: "stderr",
      message: "keep",
      runId,
      opId: "op-keep",
      jobId: "job-a",
    });
    expect(childFiltered.filters?.child).to.deep.equal({
      streams: ["stderr"],
      runIds: [runId],
      opIds: ["op-keep"],
      jobIds: ["job-a"],
    });

    const childEmpty = registry.watch("sc://children/child-filter/logs", {
      child: { streams: ["stderr"], runIds: ["other-run"] },
    });

    expect(childEmpty.events).to.have.length(0);
    expect(childEmpty.nextSeq).to.equal(2);
    expect(childEmpty.filters?.child).to.deep.equal({ streams: ["stderr"], runIds: ["other-run"] });
  });

  it("filters run event pages using timestamp boundaries", () => {
    const registry = new ResourceRegistry();
    const runId = "run-ts";

    recordRun(registry, runId, { seq: 1, ts: 1_000, kind: "STATUS", level: "info", payload: { step: 1 } });
    recordRun(registry, runId, { seq: 2, ts: 2_000, kind: "STATUS", level: "info", payload: { step: 2 } });
    recordRun(registry, runId, { seq: 3, ts: 3_000, kind: "STATUS", level: "info", payload: { step: 3 } });

    const filtered = registry.watch(`sc://runs/${runId}/events`, {
      // The range keeps the middle event only, validating strict timestamp gating.
      run: { sinceTs: 1_500, untilTs: 2_500 },
    });

    expect(filtered.events.map((event) => event.seq)).to.deep.equal([2]);
    expect(filtered.filters?.run).to.deep.equal({ sinceTs: 1_500, untilTs: 2_500 });
    expect(filtered.nextSeq).to.equal(2);
  });

  it("filters child log pages using timestamp boundaries", () => {
    const registry = new ResourceRegistry();
    const childId = "child-ts";

    registry.recordChildLogEntry(childId, { ts: 5_000, stream: "stdout", message: "early" });
    registry.recordChildLogEntry(childId, { ts: 6_000, stream: "stdout", message: "within" });
    registry.recordChildLogEntry(childId, { ts: 7_000, stream: "stdout", message: "late" });

    const filtered = registry.watch(`sc://children/${childId}/logs`, {
      // Timestamp window should retain only the entry within the inclusive bounds.
      child: { sinceTs: 5_500, untilTs: 6_500 },
    });

    expect(filtered.events.map((entry) => entry.message)).to.deep.equal(["within"]);
    expect(filtered.filters?.child).to.deep.equal({ sinceTs: 5_500, untilTs: 6_500 });
    expect(filtered.nextSeq).to.equal(2);
  });

  it("watches blackboard namespaces with version-derived cursors", () => {
    let now = 1_000;
    const blackboard = new BlackboardStore({ now: () => now });
    blackboard.set("core:pending", { task: "triage" });
    now += 100;
    blackboard.set("core:active", { task: "review" });

    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });

    // Listing exposes metadata reflecting both the number of live entries and the latest version.
    const listedNamespaces = registry.list();
    const listedBlackboard = listedNamespaces.find((entry) => entry.uri === "sc://blackboard/core");
    expect(listedBlackboard?.metadata).to.deep.equal({ entry_count: 2, latest_version: 2 });

    const firstPage = registry.watch("sc://blackboard/core", { fromSeq: 0 });
    expect(firstPage.kind).to.equal("blackboard_namespace");
    expect(firstPage.events.map((event) => event.seq)).to.deep.equal([1, 2]);
    expect(firstPage.nextSeq).to.equal(2);

    const firstEvent = firstPage.events[0];
    expect(firstEvent).to.deep.include({
      seq: 1,
      version: 1,
      ts: 1_000,
      kind: "set",
      namespace: "core",
      key: "core:pending",
      reason: null,
    });
    expect(firstEvent.entry).to.deep.include({
      key: "core:pending",
      value: { task: "triage" },
      version: 1,
    });

    // Mutate the returned snapshot to ensure the registry retains an immutable copy.
    firstEvent.entry!.value = { mutated: true };
    const replay = registry.watch("sc://blackboard/core", { fromSeq: 0 });
    expect(replay.events[0].entry?.value).to.deep.equal({ task: "triage" });

    now += 200;
    expect(blackboard.delete("core:pending")).to.equal(true);

    const secondPage = registry.watch("sc://blackboard/core", { fromSeq: firstPage.nextSeq });
    expect(secondPage.events).to.have.length(1);
    expect(secondPage.events[0]).to.deep.include({
      seq: 3,
      version: 3,
      ts: 1_300,
      kind: "delete",
      namespace: "core",
      key: "core:pending",
      reason: null,
    });
    expect(secondPage.events[0].previous).to.deep.include({ key: "core:pending" });
    expect(secondPage.nextSeq).to.equal(3);

    // After the deletion the namespace still advertises the highest version observed.
    const refreshedList = registry.list();
    const refreshedBlackboard = refreshedList.find((entry) => entry.uri === "sc://blackboard/core");
    expect(refreshedBlackboard?.metadata).to.deep.equal({ entry_count: 1, latest_version: 3 });

    now += 150;
    expect(blackboard.delete("core:active")).to.equal(true);

    const drainedList = registry.list();
    const drainedBlackboard = drainedList.find((entry) => entry.uri === "sc://blackboard/core");
    expect(drainedBlackboard?.metadata).to.deep.equal({ entry_count: 0, latest_version: 4 });

    const drainedRead = registry.read("sc://blackboard/core");
    expect(drainedRead.kind).to.equal("blackboard_namespace");
    expect(drainedRead.payload).to.deep.equal({ namespace: "core", entries: [] });

    const terminalPage = registry.watch("sc://blackboard/core", { fromSeq: secondPage.nextSeq });
    expect(terminalPage.events).to.have.length(1);
    expect(terminalPage.events[0]).to.deep.include({
      seq: 4,
      version: 4,
      kind: "delete",
      key: "core:active",
      namespace: "core",
    });
    expect(terminalPage.nextSeq).to.equal(4);
  });

  it("filters blackboard namespaces by keys while advancing the cursor", () => {
    let timestamp = 0;
    const now = () => {
      timestamp += 1_000;
      return timestamp;
    };

    const blackboard = new BlackboardStore({ now, historyLimit: 10 });
    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });

    blackboard.set("tasks:alpha", { note: "bootstrap" });
    blackboard.set("tasks:beta", { note: "sidequest" });
    blackboard.delete("tasks:beta");

    const uri = "sc://blackboard/tasks";

    const relative = registry.watch(uri, { keys: ["alpha"] });
    expect(relative.events.map((event) => event.key)).to.deep.equal(["tasks:alpha"]);
    expect(relative.nextSeq).to.equal(3);
    expect(relative.filters).to.deep.equal({
      keys: ["alpha"],
      blackboard: { keys: ["alpha"] },
    });

    const absolute = registry.watch(uri, { keys: ["tasks:beta"] });
    expect(absolute.events.map((event) => event.kind)).to.deep.equal(["set", "delete"]);
    expect(absolute.nextSeq).to.equal(3);
    expect(absolute.filters).to.deep.equal({
      keys: ["tasks:beta"],
      blackboard: { keys: ["tasks:beta"] },
    });

    const unmatched = registry.watch(uri, { keys: ["gamma"] });
    expect(unmatched.events).to.have.length(0);
    expect(unmatched.nextSeq).to.equal(3);
    expect(unmatched.filters).to.deep.equal({
      keys: ["gamma"],
      blackboard: { keys: ["gamma"] },
    });
  });

  it("filters blackboard namespaces by timestamp windows", () => {
    let current = 1_000;
    const blackboard = new BlackboardStore({ now: () => current, historyLimit: 10 });
    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });

    blackboard.set("tasks:alpha", { note: "start" });
    current += 500;
    blackboard.set("tasks:beta", { note: "mid" });
    current += 500;
    blackboard.delete("tasks:alpha");

    const uri = "sc://blackboard/tasks";

    const windowed = registry.watch(uri, {
      blackboard: { sinceTs: 1_200, untilTs: 1_700 },
    });
    expect(windowed.events.map((event) => event.key)).to.deep.equal(["tasks:beta"]);
    expect(windowed.nextSeq).to.equal(3);
    expect(windowed.filters?.blackboard).to.deep.equal({ sinceTs: 1_200, untilTs: 1_700 });

    const sinceOnly = registry.watch(uri, { blackboard: { sinceTs: 1_900 } });
    expect(sinceOnly.events.map((event) => event.kind)).to.deep.equal(["delete"]);
    expect(sinceOnly.nextSeq).to.equal(3);
    expect(sinceOnly.filters?.blackboard).to.deep.equal({ sinceTs: 1_900 });
  });

  it("filters blackboard namespaces by tags", () => {
    let now = 1_000;
    const clock = () => now;
    const blackboard = new BlackboardStore({ now: clock, historyLimit: 10 });
    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });

    blackboard.set("tasks:alpha", { note: "seed" }, { tags: ["Urgent", "Focus"] });
    blackboard.set("tasks:beta", { note: "background" }, { tags: ["backlog"] });
    blackboard.set("tasks:gamma", { note: "mix" }, { tags: ["urgent"] });
    blackboard.delete("tasks:beta");
    now += 400;
    blackboard.set("tasks:ttl", { note: "ephemeral" }, { tags: ["urgent"], ttlMs: 200 });
    now += 400;
    blackboard.evictExpired();

    const uri = "sc://blackboard/tasks";

    const urgentOnly = registry.watch(uri, { blackboard: { tags: ["urgent"] } });
    expect(urgentOnly.events.map((event) => ({ key: event.key, kind: event.kind }))).to.deep.equal([
      { key: "tasks:alpha", kind: "set" },
      { key: "tasks:gamma", kind: "set" },
      { key: "tasks:ttl", kind: "set" },
      { key: "tasks:ttl", kind: "expire" },
    ]);
    expect(urgentOnly.nextSeq).to.equal(6);
    expect(urgentOnly.filters?.blackboard).to.deep.equal({ tags: ["urgent"] });

    const focused = registry.watch(uri, { blackboard: { tags: ["Focus", "urgent"] } });
    expect(focused.events.map((event) => event.key)).to.deep.equal(["tasks:alpha"]);
    expect(focused.filters?.blackboard).to.deep.equal({ tags: ["focus", "urgent"] });

    const unmatched = registry.watch(uri, { blackboard: { tags: ["unknown"] } });
    expect(unmatched.events).to.have.length(0);
    expect(unmatched.nextSeq).to.equal(6);
    expect(unmatched.filters?.blackboard).to.deep.equal({ tags: ["unknown"] });
  });

  it("filters blackboard namespaces by mutation kinds", () => {
    let current = 1_000;
    const blackboard = new BlackboardStore({ now: () => current, historyLimit: 10 });
    const registry = new ResourceRegistry({ blackboard, blackboardHistoryLimit: 10 });

    blackboard.set("tasks:alpha", { note: "seed" });
    blackboard.set("tasks:beta", { note: "keep" });
    blackboard.delete("tasks:beta");
    blackboard.set("tasks:ttl", { note: "transient" }, { ttlMs: 150 });
    current += 200;
    blackboard.evictExpired();

    const uri = "sc://blackboard/tasks";

    const deletesOnly = registry.watch(uri, { blackboard: { kinds: ["delete"] } });
    expect(deletesOnly.events.map((event) => event.kind)).to.deep.equal(["delete"]);
    expect(deletesOnly.filters?.blackboard).to.deep.equal({ kinds: ["delete"] });

    const deleteAndExpire = registry.watch(uri, { blackboard: { kinds: ["delete", "expire"] } });
    expect(deleteAndExpire.events.map((event) => event.kind)).to.deep.equal(["delete", "expire"]);
    expect(deleteAndExpire.filters?.blackboard).to.deep.equal({ kinds: ["delete", "expire"] });

    const invalidKinds = registry.watch(uri, { blackboard: { kinds: ["noop", "invalid"] } });
    expect(invalidKinds.events.map((event) => event.kind)).to.deep.equal(["set", "set", "delete", "set", "expire"]);
    expect(invalidKinds.filters?.blackboard).to.equal(undefined);
  });

  it("records tool router decisions and exposes them through read and watch APIs", async () => {
    const registry = new ResourceRegistry();

    registry.recordToolRouterDecision({
      context: {
        goal: "évaluer une suggestion",
        category: "plan",
        tags: ["analysis"],
        preferredTools: ["graph_apply_change_set"],
        metadata: { source: "test" },
      },
      decision: {
        tool: "tools_help",
        score: 0.5,
        reason: "fallback:tools_help",
        candidates: [
          { tool: "tools_help", score: 0.5, reliability: 1, rationale: "fallback" },
          { tool: "artifact_search", score: 0.45, reliability: 1, rationale: "fallback" },
        ],
        decidedAt: 1_234,
      },
      requestId: "req-router-1",
      traceId: "trace-router-1",
      runId: null,
      jobId: null,
      childId: "child-router",
      elapsedMs: 12,
    });

    const entries = registry.list("sc://tool-router");
    expect(entries).to.deep.equal([
      {
        uri: "sc://tool-router/decisions",
        kind: "tool_router_decisions",
        metadata: {
          decision_count: 1,
          latest_seq: 1,
          domains: ["plan"],
          success_rate: null,
          median_latency_ms: null,
          estimated_cost_ms: null,
        },
      },
    ]);

    const read = registry.read("sc://tool-router/decisions");
    expect(read.kind).to.equal("tool_router_decisions");
    expect(read.payload).to.deep.equal({
      decisions: [
        {
          seq: 1,
          ts: 1_234,
          tool: "tools_help",
          score: 0.5,
          reason: "fallback:tools_help",
          candidates: [
            { tool: "tools_help", score: 0.5, reliability: 1, rationale: "fallback" },
            { tool: "artifact_search", score: 0.45, reliability: 1, rationale: "fallback" },
          ],
          context: {
            goal: "évaluer une suggestion",
            category: "plan",
            tags: ["analysis"],
            preferredTools: ["graph_apply_change_set"],
            metadata: { source: "test" },
          },
          requestId: "req-router-1",
          traceId: "trace-router-1",
          runId: null,
          jobId: null,
          childId: "child-router",
          elapsedMs: 12,
        },
      ],
      latestSeq: 1,
      aggregates: {
        decisionCount: 1,
        successRate: null,
        medianLatencyMs: null,
        estimatedCostMs: null,
        domains: ["plan"],
      },
    });

    const watch = registry.watch("sc://tool-router/decisions", { fromSeq: 0 });
    expect(watch.events).to.have.length(1);
    expect(watch.events[0]).to.include({ tool: "tools_help", seq: 1 });
    expect(watch.nextSeq).to.equal(1);

    const stream = registry.watchStream("sc://tool-router/decisions", { fromSeq: 0, limit: 5 });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).to.equal(false);
    expect(first.value.events).to.have.length(1);
    await iterator.return?.();

    registry.recordToolRouterOutcome({ tool: "tools_help", success: true, latencyMs: 120 });
    registry.recordToolRouterOutcome({ tool: "artifact_search", success: false, latencyMs: 260 });

    const entriesWithOutcomes = registry.list("sc://tool-router");
    expect(entriesWithOutcomes[0]?.metadata).to.deep.equal({
      decision_count: 1,
      latest_seq: 1,
      domains: ["plan"],
      success_rate: 0.5,
      median_latency_ms: 190,
      estimated_cost_ms: 190,
    });

    const readAfterOutcomes = registry.read("sc://tool-router/decisions");
    expect(readAfterOutcomes.payload.aggregates).to.deep.equal({
      decisionCount: 1,
      successRate: 0.5,
      medianLatencyMs: 190,
      estimatedCostMs: 190,
      domains: ["plan"],
    });
  });

  it("raises domain errors for unsupported operations", () => {
    const registry = new ResourceRegistry();
    expect(() => registry.read("sc://graphs/unknown")).to.throw(ResourceNotFoundError);
    expect(() => registry.watch("sc://graphs/demo", { fromSeq: 0 })).to.throw(ResourceWatchUnsupportedError);
  });
});
