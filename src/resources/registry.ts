import { EventEmitter } from "node:events";

import type { BlackboardStore, BlackboardEntrySnapshot } from "../coord/blackboard.js";
import type { NormalisedGraph } from "../graph/types.js";

/** Supported resource kinds exposed through the registry. */
export type ResourceKind =
  | "graph"
  | "graph_version"
  | "run_events"
  | "child_logs"
  | "snapshot"
  | "blackboard_namespace";

/** Options accepted when instantiating the resource registry. */
export interface ResourceRegistryOptions {
  /** Maximum number of events preserved per run (default 500). */
  runHistoryLimit?: number;
  /** Maximum number of log entries preserved per child (default 500). */
  childLogHistoryLimit?: number;
  /** Optional blackboard store used to resolve namespace resources. */
  blackboard?: BlackboardStore | null;
}

/** Metadata returned when listing resources. */
export interface ResourceListEntry {
  /** Fully qualified MCP URI. */
  uri: string;
  /** Kind of resource surfaced at the URI. */
  kind: ResourceKind;
  /** Optional metadata providing additional hints. */
  metadata?: Record<string, unknown>;
}

/** Payload returned when reading a graph resource. */
export interface ResourceGraphPayload {
  graphId: string;
  version: number;
  committedAt: number | null;
  graph: NormalisedGraph;
}

/** Payload returned when reading a snapshot entry. */
export interface ResourceSnapshotPayload {
  graphId: string;
  txId: string;
  baseVersion: number;
  startedAt: number;
  state: "pending" | "committed" | "rolled_back";
  committedAt: number | null;
  finalVersion: number | null;
  baseGraph: NormalisedGraph;
  finalGraph: NormalisedGraph | null;
  owner: string | null;
  note: string | null;
  expiresAt: number | null;
}

/** Snapshot describing a run event delivered by the registry. */
export interface ResourceRunEvent {
  seq: number;
  ts: number;
  kind: string;
  level: string;
  jobId: string | null;
  /** Run identifier correlated to the event (mirrors the registry bucket). */
  runId: string;
  /** Optional operation identifier allowing clients to group sub-steps. */
  opId: string | null;
  /** Optional graph identifier when the event pertains to a graph lifecycle. */
  graphId: string | null;
  /** Optional node identifier (behaviour tree node, graph node, …). */
  nodeId: string | null;
  childId: string | null;
  payload: unknown;
}

/** Snapshot describing a child log entry. */
export interface ResourceChildLogEntry {
  seq: number;
  ts: number;
  stream: "stdout" | "stderr" | "meta";
  /** Human readable representation of the entry (usually the raw line). */
  message: string;
  /** Optional job identifier correlated with the log entry. */
  jobId: string | null;
  /** Optional run identifier propagated from the orchestrator. */
  runId: string | null;
  /** Optional operation identifier for fine-grained tracing. */
  opId: string | null;
  /** Optional graph identifier associated with the log emission. */
  graphId: string | null;
  /** Optional node identifier (behaviour tree node, graph node, ...). */
  nodeId: string | null;
  /** Child identifier echoed to keep the snapshot self-describing. */
  childId: string;
  /** Raw message emitted by the runtime, if any. */
  raw: string | null;
  /** Structured payload decoded from the runtime output when available. */
  parsed: unknown;
}

/** Result returned when reading a resource. */
export interface ResourceReadResult extends Record<string, unknown> {
  uri: string;
  kind: ResourceKind;
  payload:
    | ResourceGraphPayload
    | ResourceSnapshotPayload
    | { runId: string; events: ResourceRunEvent[] }
    | { childId: string; logs: ResourceChildLogEntry[] }
    | { namespace: string; entries: BlackboardEntrySnapshot[] };
}

/** Options accepted when requesting a watch page. */
export interface ResourceWatchOptions {
  /** Sequence after which events must be returned (exclusive). */
  fromSeq?: number;
  /** Maximum number of events returned in a single page. */
  limit?: number;
}

/** Result returned by {@link ResourceRegistry.watch}. */
export interface ResourceWatchResult {
  uri: string;
  kind: ResourceKind;
  events: Array<ResourceRunEvent | ResourceChildLogEntry>;
  nextSeq: number;
}

/** Base error emitted by the resource registry. */
export class ResourceRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ResourceRegistryError";
  }
}

/** Error raised when attempting to resolve an unknown resource. */
export class ResourceNotFoundError extends ResourceRegistryError {
  constructor(uri: string) {
    super("E-RES-NOT_FOUND", `resource '${uri}' does not exist`);
    this.name = "ResourceNotFoundError";
  }
}

/** Error raised when a watch operation is not supported for the URI. */
export class ResourceWatchUnsupportedError extends ResourceRegistryError {
  constructor(uri: string) {
    super("E-RES-UNSUPPORTED", `resource '${uri}' cannot be watched`, "watch_not_supported");
    this.name = "ResourceWatchUnsupportedError";
  }
}

/**
 * Internal representation of a committed graph version. Only serialisable data
 * is retained so the registry remains side-effect free.
 */
interface GraphVersionRecord {
  version: number;
  committedAt: number;
  graph: NormalisedGraph;
}

/** State tracked for a graph identifier. */
interface GraphHistory {
  latestVersion: number;
  versions: Map<number, GraphVersionRecord>;
}

/** Snapshot registered when opening a transaction. */
interface GraphSnapshotRecord {
  txId: string;
  graphId: string;
  baseVersion: number;
  startedAt: number;
  state: "pending" | "committed" | "rolled_back";
  committedAt: number | null;
  finalVersion: number | null;
  baseGraph: NormalisedGraph;
  finalGraph: NormalisedGraph | null;
  owner: string | null;
  note: string | null;
  expiresAt: number | null;
}

/** History tracked for a single plan/run identifier. */
interface RunHistory {
  events: ResourceRunEvent[];
  lastSeq: number;
  emitter: EventEmitter;
}

/** History tracked for a single child identifier. */
interface ChildLogHistory {
  entries: ResourceChildLogEntry[];
  lastSeq: number;
  emitter: EventEmitter;
}

/** Utility ensuring limits remain sane. */
function clampPositive(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

/** Creates a defensive deep clone so callers cannot mutate stored state. */
function clone<T>(value: T): T {
  return structuredClone(value) as T;
}

function normaliseOptionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normaliseOptionalNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.floor(value);
}

/** Extract the namespace portion of a blackboard key. */
function extractNamespace(key: string): string {
  const separators = [":", "/", "|"]; // keep flexible to accommodate multiple conventions
  for (const separator of separators) {
    const index = key.indexOf(separator);
    if (index > 0) {
      return key.slice(0, index);
    }
  }
  return key;
}

/** Maintains deterministic MCP resource metadata and snapshots. */
export class ResourceRegistry {
  private readonly graphHistories = new Map<string, GraphHistory>();

  private readonly graphSnapshots = new Map<string, Map<string, GraphSnapshotRecord>>();

  private readonly runHistories = new Map<string, RunHistory>();

  private readonly childHistories = new Map<string, ChildLogHistory>();

  private readonly runHistoryLimit: number;

  private readonly childLogHistoryLimit: number;

  private readonly blackboard: BlackboardStore | null;

  constructor(options: ResourceRegistryOptions = {}) {
    this.runHistoryLimit = clampPositive(options.runHistoryLimit, 500);
    this.childLogHistoryLimit = clampPositive(options.childLogHistoryLimit, 500);
    this.blackboard = options.blackboard ?? null;
  }

  /**
   * Records a transaction snapshot so clients can inspect the base version even
   * if the transaction later aborts.
   */
  recordGraphSnapshot(input: {
    graphId: string;
    txId: string;
    baseVersion: number;
    startedAt: number;
    graph: NormalisedGraph;
    owner?: string | null;
    note?: string | null;
    expiresAt?: number | null;
  }): void {
    const normalised = this.getOrCreateSnapshotBucket(input.graphId);
    const snapshot: GraphSnapshotRecord = {
      txId: input.txId,
      graphId: input.graphId,
      baseVersion: input.baseVersion,
      startedAt: input.startedAt,
      state: "pending",
      committedAt: null,
      finalVersion: null,
      baseGraph: clone(input.graph),
      finalGraph: null,
      owner: normaliseOptionalString(input.owner),
      note: normaliseOptionalString(input.note),
      expiresAt: normaliseOptionalNumber(input.expiresAt),
    };
    normalised.set(input.txId, snapshot);
  }

  /** Marks a transaction snapshot as committed and stores the resulting graph. */
  markGraphSnapshotCommitted(input: {
    graphId: string;
    txId: string;
    committedAt: number;
    finalVersion: number;
    finalGraph: NormalisedGraph;
  }): void {
    const bucket = this.graphSnapshots.get(input.graphId);
    if (!bucket) {
      return;
    }
    const snapshot = bucket.get(input.txId);
    if (!snapshot) {
      return;
    }
    snapshot.state = "committed";
    snapshot.committedAt = input.committedAt;
    snapshot.finalVersion = input.finalVersion;
    snapshot.finalGraph = clone(input.finalGraph);
    bucket.set(input.txId, snapshot);
  }

  /** Marks a transaction snapshot as rolled back. */
  markGraphSnapshotRolledBack(graphId: string, txId: string): void {
    const bucket = this.graphSnapshots.get(graphId);
    if (!bucket) {
      return;
    }
    const snapshot = bucket.get(txId);
    if (!snapshot) {
      return;
    }
    snapshot.state = "rolled_back";
    snapshot.committedAt = null;
    snapshot.finalVersion = null;
    snapshot.finalGraph = null;
    bucket.set(txId, snapshot);
  }

  /** Records a committed graph version. */
  recordGraphVersion(input: {
    graphId: string;
    version: number;
    committedAt: number;
    graph: NormalisedGraph;
  }): void {
    if (!input.graphId) {
      return;
    }
    const history = this.getOrCreateGraphHistory(input.graphId);
    const record: GraphVersionRecord = {
      version: input.version,
      committedAt: input.committedAt,
      graph: clone(input.graph),
    };
    history.versions.set(input.version, record);
    if (input.version >= history.latestVersion) {
      history.latestVersion = input.version;
    }
    this.graphHistories.set(input.graphId, history);
  }

  /** Records an orchestrator event correlated with a run identifier. */
  recordRunEvent(runId: string, event: {
    seq: number;
    ts: number;
    kind: string;
    level: string;
    jobId?: string | null;
    runId?: string | null;
    opId?: string | null;
    graphId?: string | null;
    nodeId?: string | null;
    childId?: string | null;
    payload?: unknown;
  }): void {
    if (!runId.trim()) {
      return;
    }
    const history = this.getOrCreateRunHistory(runId);
    // Even though histories are bucketed per run, materialise the identifier so
    // downstream clients consuming the snapshots can reason about cross-run
    // correlations without relying on the URI they queried.
    const correlatedRunId = event.runId && event.runId.trim() ? event.runId : runId;

    const payload: ResourceRunEvent = {
      seq: event.seq,
      ts: event.ts,
      kind: event.kind,
      level: event.level,
      jobId: event.jobId ?? null,
      runId: correlatedRunId,
      opId: event.opId ?? null,
      graphId: event.graphId ?? null,
      nodeId: event.nodeId ?? null,
      childId: event.childId ?? null,
      payload: clone(event.payload ?? null),
    };
    history.events.push(payload);
    history.lastSeq = Math.max(history.lastSeq, payload.seq);
    if (history.events.length > this.runHistoryLimit) {
      history.events.splice(0, history.events.length - this.runHistoryLimit);
    }
    history.emitter.emit("event", payload);
  }

  /** Records a log entry produced by a child runtime. */
  recordChildLogEntry(
    childId: string,
    entry: {
      ts: number;
      stream: "stdout" | "stderr" | "meta";
      message: string;
      childId?: string | null;
      jobId?: string | null;
      runId?: string | null;
      opId?: string | null;
      graphId?: string | null;
      nodeId?: string | null;
      raw?: string | null;
      parsed?: unknown;
    },
  ): void {
    if (!childId.trim()) {
      return;
    }
    const history = this.getOrCreateChildHistory(childId);
    const seq = history.lastSeq + 1;
    const record: ResourceChildLogEntry = {
      seq,
      ts: entry.ts,
      stream: entry.stream,
      message: entry.message,
      jobId: entry.jobId ?? null,
      runId: entry.runId ?? null,
      opId: entry.opId ?? null,
      graphId: entry.graphId ?? null,
      nodeId: entry.nodeId ?? null,
      childId: entry.childId?.trim() ? entry.childId : childId,
      raw: entry.raw ?? null,
      parsed: clone(entry.parsed ?? null),
    };
    history.entries.push(record);
    history.lastSeq = seq;
    if (history.entries.length > this.childLogHistoryLimit) {
      history.entries.splice(0, history.entries.length - this.childLogHistoryLimit);
    }
    history.emitter.emit("event", record);
  }

  /**
   * Returns a deterministic list of URIs. The entries are sorted to guarantee a
   * stable contract for clients performing prefix scans.
   */
  list(prefix?: string): ResourceListEntry[] {
    const entries: ResourceListEntry[] = [];
    for (const [graphId, history] of this.graphHistories.entries()) {
      entries.push({
        uri: `sc://graphs/${graphId}`,
        kind: "graph",
        metadata: { latest_version: history.latestVersion },
      });
      for (const version of history.versions.keys()) {
        entries.push({
          uri: `sc://graphs/${graphId}@v${version}`,
          kind: "graph_version",
        });
      }
    }
    for (const [graphId, bucket] of this.graphSnapshots.entries()) {
      for (const snapshot of bucket.values()) {
        const metadata: Record<string, unknown> = {
          state: snapshot.state,
          base_version: snapshot.baseVersion,
        };
        if (snapshot.owner) {
          metadata.owner = snapshot.owner;
        }
        if (snapshot.note) {
          metadata.note = snapshot.note;
        }
        if (snapshot.expiresAt !== null) {
          metadata.expires_at = snapshot.expiresAt;
        }
        entries.push({
          uri: `sc://snapshots/${graphId}/${snapshot.txId}`,
          kind: "snapshot",
          metadata,
        });
      }
    }
    for (const runId of this.runHistories.keys()) {
      entries.push({ uri: `sc://runs/${runId}/events`, kind: "run_events" });
    }
    for (const childId of this.childHistories.keys()) {
      entries.push({ uri: `sc://children/${childId}/logs`, kind: "child_logs" });
    }
    for (const namespace of this.listBlackboardNamespaces()) {
      entries.push({ uri: `sc://blackboard/${namespace}`, kind: "blackboard_namespace" });
    }

    const filtered = prefix ? entries.filter((entry) => entry.uri.startsWith(prefix)) : entries;
    return filtered.sort((a, b) => a.uri.localeCompare(b.uri));
  }

  /** Returns the materialised payload for the requested URI. */
  read(uri: string): ResourceReadResult {
    const parsed = this.parseUri(uri);
    switch (parsed.kind) {
      case "graph": {
        const history = this.graphHistories.get(parsed.graphId);
        if (!history || history.latestVersion === 0) {
          throw new ResourceNotFoundError(uri);
        }
        const record = history.versions.get(history.latestVersion);
        if (!record) {
          throw new ResourceNotFoundError(uri);
        }
        return {
          uri,
          kind: "graph",
          payload: {
            graphId: parsed.graphId,
            version: record.version,
            committedAt: record.committedAt,
            graph: clone(record.graph),
          },
        };
      }
      case "graph_version": {
        const history = this.graphHistories.get(parsed.graphId);
        const record = history?.versions.get(parsed.version ?? -1);
        if (!record) {
          throw new ResourceNotFoundError(uri);
        }
        return {
          uri,
          kind: "graph_version",
          payload: {
            graphId: parsed.graphId,
            version: record.version,
            committedAt: record.committedAt,
            graph: clone(record.graph),
          },
        };
      }
      case "snapshot": {
        const bucket = this.graphSnapshots.get(parsed.graphId);
        const snapshot = bucket?.get(parsed.txId ?? "");
        if (!snapshot) {
          throw new ResourceNotFoundError(uri);
        }
        return {
          uri,
          kind: "snapshot",
          payload: clone(snapshot),
        };
      }
      case "run_events": {
        const history = this.runHistories.get(parsed.runId ?? "");
        if (!history) {
          throw new ResourceNotFoundError(uri);
        }
        return {
          uri,
          kind: "run_events",
          payload: { runId: parsed.runId!, events: history.events.map((evt) => clone(evt)) },
        };
      }
      case "child_logs": {
        const history = this.childHistories.get(parsed.childId ?? "");
        if (!history) {
          throw new ResourceNotFoundError(uri);
        }
        return {
          uri,
          kind: "child_logs",
          payload: { childId: parsed.childId!, logs: history.entries.map((entry) => clone(entry)) },
        };
      }
      case "blackboard_namespace": {
        if (!this.blackboard) {
          throw new ResourceNotFoundError(uri);
        }
        const entries = this.blackboard
          .query()
          .filter((entry) => extractNamespace(entry.key) === parsed.namespace)
          .map((entry) => clone(entry));
        if (entries.length === 0) {
          throw new ResourceNotFoundError(uri);
        }
        return {
          uri,
          kind: "blackboard_namespace",
          payload: { namespace: parsed.namespace!, entries },
        };
      }
      default:
        throw new ResourceNotFoundError(uri);
    }
  }

  /**
   * Returns a monotonic slice of events/logs associated with the resource.
   * Unsupported resources raise {@link ResourceWatchUnsupportedError}.
   */
  watch(uri: string, options: ResourceWatchOptions = {}): ResourceWatchResult {
    const fromSeq = options.fromSeq ?? 0;
    const limit = clampPositive(options.limit, 250);
    const parsed = this.parseUri(uri);
    switch (parsed.kind) {
      case "run_events": {
        const history = this.runHistories.get(parsed.runId ?? "");
        if (!history) {
          throw new ResourceNotFoundError(uri);
        }
        const events = history.events
          .filter((event) => event.seq > fromSeq)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map((event) => clone(event));
        const nextSeq = events.length > 0 ? events[events.length - 1].seq : Math.max(fromSeq, history.lastSeq);
        return { uri, kind: "run_events", events, nextSeq };
      }
      case "child_logs": {
        const history = this.childHistories.get(parsed.childId ?? "");
        if (!history) {
          throw new ResourceNotFoundError(uri);
        }
        const events = history.entries
          .filter((entry) => entry.seq > fromSeq)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit)
          .map((entry) => clone(entry));
        const nextSeq = events.length > 0 ? events[events.length - 1].seq : Math.max(fromSeq, history.lastSeq);
        return { uri, kind: "child_logs", events, nextSeq };
      }
      default:
        throw new ResourceWatchUnsupportedError(uri);
    }
  }

  private getOrCreateGraphHistory(graphId: string): GraphHistory {
    const existing = this.graphHistories.get(graphId);
    if (existing) {
      return existing;
    }
    const history: GraphHistory = { latestVersion: 0, versions: new Map() };
    this.graphHistories.set(graphId, history);
    return history;
  }

  private getOrCreateSnapshotBucket(graphId: string): Map<string, GraphSnapshotRecord> {
    const existing = this.graphSnapshots.get(graphId);
    if (existing) {
      return existing;
    }
    const bucket = new Map<string, GraphSnapshotRecord>();
    this.graphSnapshots.set(graphId, bucket);
    return bucket;
  }

  private getOrCreateRunHistory(runId: string): RunHistory {
    const existing = this.runHistories.get(runId);
    if (existing) {
      return existing;
    }
    const history: RunHistory = { events: [], lastSeq: 0, emitter: new EventEmitter() };
    this.runHistories.set(runId, history);
    return history;
  }

  private getOrCreateChildHistory(childId: string): ChildLogHistory {
    const existing = this.childHistories.get(childId);
    if (existing) {
      return existing;
    }
    const history: ChildLogHistory = { entries: [], lastSeq: 0, emitter: new EventEmitter() };
    this.childHistories.set(childId, history);
    return history;
  }

  private listBlackboardNamespaces(): string[] {
    if (!this.blackboard) {
      return [];
    }
    const namespaces = new Set<string>();
    for (const entry of this.blackboard.query()) {
      namespaces.add(extractNamespace(entry.key));
    }
    return Array.from(namespaces.values());
  }

  private parseUri(uri: string):
    | { kind: "graph"; graphId: string }
    | { kind: "graph_version"; graphId: string; version: number }
    | { kind: "snapshot"; graphId: string; txId: string }
    | { kind: "run_events"; runId: string }
    | { kind: "child_logs"; childId: string }
    | { kind: "blackboard_namespace"; namespace: string } {
    if (!uri.startsWith("sc://")) {
      throw new ResourceNotFoundError(uri);
    }
    const body = uri.slice("sc://".length);
    if (body.startsWith("graphs/")) {
      const remainder = body.slice("graphs/".length);
      const [identifier, versionSuffix] = remainder.split("@v");
      if (!identifier) {
        throw new ResourceNotFoundError(uri);
      }
      if (versionSuffix !== undefined) {
        const version = Number(versionSuffix);
        if (!Number.isInteger(version) || version <= 0) {
          throw new ResourceNotFoundError(uri);
        }
        return { kind: "graph_version", graphId: identifier, version };
      }
      return { kind: "graph", graphId: identifier };
    }
    if (body.startsWith("snapshots/")) {
      const remainder = body.slice("snapshots/".length);
      const [graphId, txId] = remainder.split("/");
      if (!graphId || !txId) {
        throw new ResourceNotFoundError(uri);
      }
      return { kind: "snapshot", graphId, txId };
    }
    if (body.startsWith("runs/") && body.endsWith("/events")) {
      const runId = body.slice("runs/".length, body.length - "/events".length);
      if (!runId) {
        throw new ResourceNotFoundError(uri);
      }
      return { kind: "run_events", runId };
    }
    if (body.startsWith("children/") && body.endsWith("/logs")) {
      const childId = body.slice("children/".length, body.length - "/logs".length);
      if (!childId) {
        throw new ResourceNotFoundError(uri);
      }
      return { kind: "child_logs", childId };
    }
    if (body.startsWith("blackboard/")) {
      const namespace = body.slice("blackboard/".length);
      if (!namespace) {
        throw new ResourceNotFoundError(uri);
      }
      return { kind: "blackboard_namespace", namespace };
    }
    throw new ResourceNotFoundError(uri);
  }
}
