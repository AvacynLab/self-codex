import { EventEmitter } from "node:events";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

import type {
  BlackboardStore,
  BlackboardEntrySnapshot,
  BlackboardEvent,
  BlackboardEventKind,
} from "../coord/blackboard.js";
import type { ToolRoutingContext, ToolRouterDecisionRecord } from "../tools/toolRouter.js";
import type { NormalisedGraph } from "../graph/types.js";

/** Maximum number of tool router decisions preserved in memory. */
const TOOL_ROUTER_HISTORY_LIMIT = 200;

/** Supported resource kinds exposed through the registry. */
export type ResourceKind =
  | "graph"
  | "graph_version"
  | "run_events"
  | "child_logs"
  | "snapshot"
  | "blackboard_namespace"
  | "validation_input"
  | "validation_output"
  | "validation_events"
  | "validation_logs"
  | "tool_router_decisions";

/** Options accepted when instantiating the resource registry. */
export interface ResourceRegistryOptions {
  /** Maximum number of events preserved per run (default 500). */
  runHistoryLimit?: number;
  /** Maximum number of log entries preserved per child (default 500). */
  childLogHistoryLimit?: number;
  /** Maximum number of blackboard events preserved per namespace (default 500). */
  blackboardHistoryLimit?: number;
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
  component: string;
  stage: string;
  elapsedMs: number | null;
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

/** Snapshot describing a blackboard mutation event. */
export interface ResourceBlackboardEvent {
  /** Monotonic sequence number derived from the blackboard version. */
  seq: number;
  /** Original blackboard version associated with the mutation. */
  version: number;
  /** Millisecond timestamp recorded by the blackboard store. */
  ts: number;
  /** Kind of mutation that occurred (set/delete/expire). */
  kind: BlackboardEventKind;
  /** Namespace extracted from the blackboard key. */
  namespace: string;
  /** Fully qualified key stored inside the namespace. */
  key: string;
  /** Snapshot describing the new state when applicable. */
  entry: BlackboardEntrySnapshot | null;
  /** Snapshot describing the previous state when applicable. */
  previous: BlackboardEntrySnapshot | null;
  /** Optional reason accompanying expire events (e.g. ttl). */
  reason: string | null;
}

/** Result returned when reading a resource. */
export interface ResourceReadResult extends Record<string, unknown> {
  uri: string;
  kind: ResourceKind;
  payload:
    | ResourceGraphPayload
    | ResourceSnapshotPayload
    | { runId: string; events: ResourceRunEvent[]; jsonl: string }
    | { childId: string; logs: ResourceChildLogEntry[] }
    | { namespace: string; entries: BlackboardEntrySnapshot[] }
    | ValidationResourcePayload
    | ResourceToolRouterPayload;
}

/** Internal representation tracked for validation artefacts. */
type ValidationResourceKind = "validation_input" | "validation_output" | "validation_events" | "validation_logs";

interface ValidationArtifactRecord {
  kind: ValidationResourceKind;
  sessionId: string;
  runId: string | null;
  phase: string | null;
  artifactType: "inputs" | "outputs" | "events" | "logs";
  name: string;
  recordedAt: number;
  mime: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

/** Supported artifact categories tracked for validation campaigns. */
export type ValidationArtifactType = "input" | "output" | "events" | "logs";

/** Payload returned when reading validation artefacts from the registry. */
export interface ValidationResourcePayload {
  sessionId: string;
  runId: string | null;
  phase: string | null;
  artifactType: ValidationArtifactType;
  name: string;
  recordedAt: number;
  mime: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}

/** Snapshot describing a decision emitted by the contextual tool router. */
export interface ResourceToolRouterDecision {
  seq: number;
  ts: number;
  tool: string;
  score: number;
  reason: string;
  candidates: Array<{
    tool: string;
    score: number;
    reliability: number;
    rationale: string;
  }>;
  context: ToolRoutingContext;
  requestId: string | null;
  traceId: string | null;
  runId: string | null;
  jobId: string | null;
  childId: string | null;
  elapsedMs: number | null;
}

/** Payload returned when inspecting router decisions. */
export interface ResourceToolRouterPayload {
  decisions: ResourceToolRouterDecision[];
  latestSeq: number;
  aggregates: {
    decisionCount: number;
    successRate: number | null;
    medianLatencyMs: number | null;
    estimatedCostMs: number | null;
    domains: string[];
  };
}

/** Internal ring buffer tracking router decisions. */
interface ToolRouterHistory {
  decisions: ResourceToolRouterDecision[];
  lastSeq: number;
  emitter: EventEmitter;
  aggregates: ToolRouterAggregates;
}

/** Aggregated statistics derived from router decisions and outcomes. */
interface ToolRouterAggregates {
  decisionCount: number;
  domains: Set<string>;
  successes: number;
  failures: number;
  latencies: number[];
}

/** Maximum number of latency samples preserved for tool router aggregates. */
const TOOL_ROUTER_LATENCY_LIMIT = 100;

/** Options accepted when registering a validation artefact. */
export interface ValidationArtifactInput {
  sessionId: string;
  artifactType: "inputs" | "outputs" | "events" | "logs";
  name: string;
  recordedAt?: number;
  mime?: string;
  runId?: string | null;
  phase?: string | null;
  data: unknown;
  metadata?: Record<string, unknown> | null;
}

/** Options accepted when requesting a watch page. */
export interface ResourceWatchOptions {
  /** Sequence after which events must be returned (exclusive). */
  fromSeq?: number;
  /** Maximum number of events returned in a single page. */
  limit?: number;
  /** Optional set of keys limiting blackboard namespace events to specific entries. */
  keys?: string[];
  /** Optional filters applied when paginating blackboard namespaces. */
  blackboard?: ResourceWatchBlackboardFilters;
  /** Optional filters applied when paginating run events. */
  run?: ResourceWatchRunFilters;
  /** Optional filters applied when paginating child log entries. */
  child?: ResourceWatchChildFilters;
}

/**
 * Extended options accepted when creating an async watch stream. Consumers can
 * attach an {@link AbortSignal} to cancel pending iterations gracefully.
 */
export interface ResourceWatchStreamOptions extends ResourceWatchOptions {
  /** Optional abort signal cancelling the iterator when triggered. */
  signal?: AbortSignal | null;
}

/** Filters applied when collecting run events from the registry. */
export interface ResourceWatchRunFilters {
  /** Optional list of event levels to retain (lowercase). */
  levels?: string[];
  /** Optional list of event kinds to retain (uppercased for determinism). */
  kinds?: string[];
  /** Restrict events to specific job identifiers. */
  jobIds?: string[];
  /** Restrict events to specific operation identifiers. */
  opIds?: string[];
  /** Restrict events to specific graph identifiers. */
  graphIds?: string[];
  /** Restrict events to specific node identifiers. */
  nodeIds?: string[];
  /** Restrict events to specific child identifiers. */
  childIds?: string[];
  /** Restrict events to specific correlated run identifiers. */
  runIds?: string[];
  /** Restrict events to components that emitted them. */
  components?: string[];
  /** Restrict events to specific lifecycle stages. */
  stages?: string[];
  /** Ignore events below the provided duration (milliseconds). */
  minElapsedMs?: number;
  /** Ignore events above the provided duration (milliseconds). */
  maxElapsedMs?: number;
  /** Ignore events that occurred strictly before the provided millisecond timestamp. */
  sinceTs?: number;
  /** Ignore events that occurred strictly after the provided millisecond timestamp. */
  untilTs?: number;
}

/** Filters applied when collecting child runtime logs from the registry. */
export interface ResourceWatchChildFilters {
  /** Restrict log entries to specific streams (stdout/stderr/meta). */
  streams?: Array<ResourceChildLogEntry["stream"]>;
  /** Restrict log entries to specific job identifiers. */
  jobIds?: string[];
  /** Restrict log entries to specific run identifiers. */
  runIds?: string[];
  /** Restrict log entries to specific operation identifiers. */
  opIds?: string[];
  /** Restrict log entries to specific graph identifiers. */
  graphIds?: string[];
  /** Restrict log entries to specific node identifiers. */
  nodeIds?: string[];
  /** Ignore log entries that occurred strictly before the provided millisecond timestamp. */
  sinceTs?: number;
  /** Ignore log entries that occurred strictly after the provided millisecond timestamp. */
  untilTs?: number;
}

/** Filters applied when collecting blackboard mutations from the registry. */
export interface ResourceWatchBlackboardFilters {
  /** Optional set of fully qualified or relative keys to retain. */
  keys?: string[];
  /** Optional subset of mutation kinds (`set`/`delete`/`expire`) to surface. */
  kinds?: BlackboardEventKind[];
  /** Require matching entries to contain every listed tag (case-insensitive). */
  tags?: string[];
  /** Ignore events that occurred strictly before the provided millisecond timestamp. */
  sinceTs?: number;
  /** Ignore events that occurred strictly after the provided millisecond timestamp. */
  untilTs?: number;
}

/** Result returned by {@link ResourceRegistry.watch}. */
export interface ResourceWatchResult {
  uri: string;
  kind: ResourceKind;
  events: Array<ResourceRunEvent | ResourceChildLogEntry | ResourceBlackboardEvent | ResourceToolRouterDecision>;
  nextSeq: number;
  /** Optional filters applied when collecting the page. */
  filters?: {
    keys?: string[];
    blackboard?: ResourceWatchBlackboardFilters;
    run?: ResourceWatchRunFilters;
    child?: ResourceWatchChildFilters;
  };
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

/** Error raised when an async watch stream is aborted via an {@link AbortSignal}. */
export class ResourceWatchAbortedError extends ResourceRegistryError {
  constructor(uri: string) {
    super("E-RES-WATCH_ABORT", `watch for '${uri}' aborted`, "watch_aborted");
    this.name = "ResourceWatchAbortedError";
  }
}

/** Error raised when an async watch stream is disposed via `return()`/`throw()`. */
export class ResourceWatchDisposedError extends ResourceRegistryError {
  constructor(uri: string) {
    super("E-RES-WATCH_DISPOSED", `watch for '${uri}' disposed`);
    this.name = "ResourceWatchDisposedError";
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

/** History tracked for a single blackboard namespace. */
interface BlackboardNamespaceHistory {
  events: ResourceBlackboardEvent[];
  lastSeq: number;
  emitter: EventEmitter;
}

/** Internal context passed when creating an async watch stream. */
interface WatchStreamContext {
  uri: string;
  kind: "run_events" | "child_logs" | "blackboard_namespace" | "tool_router_decisions";
  emitter: EventEmitter;
  fromSeq: number;
  limit: number;
  signal: AbortSignal | null | undefined;
  filters?: ResourceWatchResult["filters"];
  slice: (fromSeq: number, limit: number) => {
    events: Array<ResourceRunEvent | ResourceChildLogEntry | ResourceBlackboardEvent | ResourceToolRouterDecision>;
    nextSeq: number;
  };
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

interface NormalisedRunEventFilter {
  readonly descriptor: ResourceWatchRunFilters;
  readonly levelSet?: ReadonlySet<string>;
  readonly kindSet?: ReadonlySet<string>;
  readonly jobIdSet?: ReadonlySet<string>;
  readonly opIdSet?: ReadonlySet<string>;
  readonly graphIdSet?: ReadonlySet<string>;
  readonly nodeIdSet?: ReadonlySet<string>;
  readonly childIdSet?: ReadonlySet<string>;
  readonly runIdSet?: ReadonlySet<string>;
  readonly componentSet?: ReadonlySet<string>;
  readonly stageSet?: ReadonlySet<string>;
  readonly sinceTs: number | null;
  readonly untilTs: number | null;
  readonly minElapsedMs: number | null;
  readonly maxElapsedMs: number | null;
}

interface NormalisedChildLogFilter {
  readonly descriptor: ResourceWatchChildFilters;
  readonly streamSet?: ReadonlySet<ResourceChildLogEntry["stream"]>;
  readonly jobIdSet?: ReadonlySet<string>;
  readonly runIdSet?: ReadonlySet<string>;
  readonly opIdSet?: ReadonlySet<string>;
  readonly graphIdSet?: ReadonlySet<string>;
  readonly nodeIdSet?: ReadonlySet<string>;
  readonly sinceTs: number | null;
  readonly untilTs: number | null;
}

interface NormalisedBlackboardFilter {
  readonly descriptor: ResourceWatchBlackboardFilters;
  readonly keyMatcher?: (candidate: string) => boolean;
  readonly kindSet?: ReadonlySet<BlackboardEventKind>;
  readonly tagSet?: ReadonlySet<string>;
  readonly sinceTs: number | null;
  readonly untilTs: number | null;
}

/** Permitted event levels captured by the orchestrator. */
const RUN_EVENT_LEVELS = new Set<ResourceRunEvent["level"]>(["debug", "info", "warn", "error"]);

/** Supported child runtime log streams. */
const CHILD_LOG_STREAMS = new Set<ResourceChildLogEntry["stream"]>(["stdout", "stderr", "meta"]);

function normaliseStringArray(
  values: ReadonlyArray<string> | null | undefined,
  options: { transform?: (value: string) => string; limit?: number } = {},
): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  for (const raw of values) {
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const transformed = options.transform ? options.transform(trimmed) : trimmed;
    if (transformed.length === 0 || seen.has(transformed)) {
      continue;
    }
    seen.add(transformed);
    result.push(transformed);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

/**
 * Ensures that a collection of tags contains every required value. Tags are
 * compared case-insensitively to match the normalisation performed by the
 * blackboard store.
 */
function containsAllTags(
  tags: ReadonlyArray<string> | null | undefined,
  required: ReadonlySet<string>,
): boolean {
  if (!tags || tags.length === 0) {
    return false;
  }
  if (required.size === 0) {
    return true;
  }
  const haystack = new Set(tags.map((tag) => tag.toLowerCase()));
  for (const candidate of required) {
    if (!haystack.has(candidate)) {
      return false;
    }
  }
  return true;
}

function normaliseRunEventFilter(
  filters: ResourceWatchRunFilters | null | undefined,
): NormalisedRunEventFilter | null {
  if (!filters) {
    return null;
  }

  const descriptor: ResourceWatchRunFilters = {};
  const levelValues = normaliseStringArray(filters.levels, {
    transform: (value) => value.toLowerCase(),
    limit: 20,
  }).filter((value) => RUN_EVENT_LEVELS.has(value as ResourceRunEvent["level"]));
  const kindValues = normaliseStringArray(filters.kinds, {
    transform: (value) => value.toUpperCase(),
    limit: 50,
  });
  const jobValues = normaliseStringArray(filters.jobIds, { limit: 50 });
  const opValues = normaliseStringArray(filters.opIds, { limit: 50 });
  const graphValues = normaliseStringArray(filters.graphIds, { limit: 50 });
  const nodeValues = normaliseStringArray(filters.nodeIds, { limit: 50 });
  const childValues = normaliseStringArray(filters.childIds, { limit: 50 });
  const runValues = normaliseStringArray(filters.runIds, { limit: 50 });
  const componentValues = normaliseStringArray(filters.components, { limit: 50 });
  const stageValues = normaliseStringArray(filters.stages, { limit: 50 });
  const sinceTs = normaliseOptionalNumber(filters.sinceTs);
  let untilTs = normaliseOptionalNumber(filters.untilTs);
  const minElapsedMs = normaliseOptionalNumber(filters.minElapsedMs);
  let maxElapsedMs = normaliseOptionalNumber(filters.maxElapsedMs);

  if (sinceTs !== null && untilTs !== null && untilTs < sinceTs) {
    untilTs = sinceTs;
  }
  if (minElapsedMs !== null && maxElapsedMs !== null && maxElapsedMs < minElapsedMs) {
    maxElapsedMs = minElapsedMs;
  }

  if (levelValues.length > 0) {
    descriptor.levels = levelValues;
  }
  if (kindValues.length > 0) {
    descriptor.kinds = kindValues;
  }
  if (jobValues.length > 0) {
    descriptor.jobIds = jobValues;
  }
  if (opValues.length > 0) {
    descriptor.opIds = opValues;
  }
  if (graphValues.length > 0) {
    descriptor.graphIds = graphValues;
  }
  if (nodeValues.length > 0) {
    descriptor.nodeIds = nodeValues;
  }
  if (childValues.length > 0) {
    descriptor.childIds = childValues;
  }
  if (runValues.length > 0) {
    descriptor.runIds = runValues;
  }
  if (componentValues.length > 0) {
    descriptor.components = componentValues;
  }
  if (stageValues.length > 0) {
    descriptor.stages = stageValues;
  }
  if (minElapsedMs !== null) {
    descriptor.minElapsedMs = minElapsedMs;
  }
  if (maxElapsedMs !== null) {
    descriptor.maxElapsedMs = maxElapsedMs;
  }
  if (sinceTs !== null) {
    descriptor.sinceTs = sinceTs;
  }
  if (untilTs !== null) {
    descriptor.untilTs = untilTs;
  }

  if (Object.keys(descriptor).length === 0) {
    return null;
  }

  return {
    descriptor,
    levelSet: levelValues.length > 0 ? new Set(levelValues) : undefined,
    kindSet: kindValues.length > 0 ? new Set(kindValues) : undefined,
    jobIdSet: jobValues.length > 0 ? new Set(jobValues) : undefined,
    opIdSet: opValues.length > 0 ? new Set(opValues) : undefined,
    graphIdSet: graphValues.length > 0 ? new Set(graphValues) : undefined,
    nodeIdSet: nodeValues.length > 0 ? new Set(nodeValues) : undefined,
    childIdSet: childValues.length > 0 ? new Set(childValues) : undefined,
    runIdSet: runValues.length > 0 ? new Set(runValues) : undefined,
    componentSet: componentValues.length > 0 ? new Set(componentValues) : undefined,
    stageSet: stageValues.length > 0 ? new Set(stageValues) : undefined,
    sinceTs,
    untilTs,
    minElapsedMs,
    maxElapsedMs,
  };
}

function normaliseChildLogFilter(
  filters: ResourceWatchChildFilters | null | undefined,
): NormalisedChildLogFilter | null {
  if (!filters) {
    return null;
  }

  const descriptor: ResourceWatchChildFilters = {};
  const streams = (filters.streams ?? [])
    .map((stream) => (typeof stream === "string" ? stream.trim() : ""))
    .filter((stream): stream is ResourceChildLogEntry["stream"] =>
      CHILD_LOG_STREAMS.has(stream as ResourceChildLogEntry["stream"]),
    );
  const uniqueStreams = Array.from(new Set(streams));
  if (uniqueStreams.length > 0) {
    descriptor.streams = uniqueStreams;
  }

  const jobValues = normaliseStringArray(filters.jobIds, { limit: 50 });
  const runValues = normaliseStringArray(filters.runIds, { limit: 50 });
  const opValues = normaliseStringArray(filters.opIds, { limit: 50 });
  const graphValues = normaliseStringArray(filters.graphIds, { limit: 50 });
  const nodeValues = normaliseStringArray(filters.nodeIds, { limit: 50 });
  const sinceTs = normaliseOptionalNumber(filters.sinceTs);
  let untilTs = normaliseOptionalNumber(filters.untilTs);

  if (sinceTs !== null && untilTs !== null && untilTs < sinceTs) {
    untilTs = sinceTs;
  }

  if (jobValues.length > 0) {
    descriptor.jobIds = jobValues;
  }
  if (runValues.length > 0) {
    descriptor.runIds = runValues;
  }
  if (opValues.length > 0) {
    descriptor.opIds = opValues;
  }
  if (graphValues.length > 0) {
    descriptor.graphIds = graphValues;
  }
  if (nodeValues.length > 0) {
    descriptor.nodeIds = nodeValues;
  }
  if (sinceTs !== null) {
    descriptor.sinceTs = sinceTs;
  }
  if (untilTs !== null) {
    descriptor.untilTs = untilTs;
  }

  if (Object.keys(descriptor).length === 0) {
    return null;
  }

  return {
    descriptor,
    streamSet: uniqueStreams.length > 0 ? new Set(uniqueStreams) : undefined,
    jobIdSet: jobValues.length > 0 ? new Set(jobValues) : undefined,
    runIdSet: runValues.length > 0 ? new Set(runValues) : undefined,
    opIdSet: opValues.length > 0 ? new Set(opValues) : undefined,
    graphIdSet: graphValues.length > 0 ? new Set(graphValues) : undefined,
    nodeIdSet: nodeValues.length > 0 ? new Set(nodeValues) : undefined,
    sinceTs,
    untilTs,
  };
}

function matchRunEvent(filter: NormalisedRunEventFilter | null, event: ResourceRunEvent): boolean {
  if (!filter) {
    return true;
  }
  if (filter.sinceTs !== null && event.ts < filter.sinceTs) {
    return false;
  }
  if (filter.untilTs !== null && event.ts > filter.untilTs) {
    return false;
  }
  if (filter.levelSet && !filter.levelSet.has(event.level.toLowerCase() as ResourceRunEvent["level"])) {
    return false;
  }
  if (filter.kindSet && !filter.kindSet.has((event.kind ?? "").toUpperCase())) {
    return false;
  }
  if (filter.jobIdSet && (!event.jobId || !filter.jobIdSet.has(event.jobId))) {
    return false;
  }
  if (filter.opIdSet && (!event.opId || !filter.opIdSet.has(event.opId))) {
    return false;
  }
  if (filter.graphIdSet && (!event.graphId || !filter.graphIdSet.has(event.graphId))) {
    return false;
  }
  if (filter.nodeIdSet && (!event.nodeId || !filter.nodeIdSet.has(event.nodeId))) {
    return false;
  }
  if (filter.childIdSet && (!event.childId || !filter.childIdSet.has(event.childId))) {
    return false;
  }
  if (filter.runIdSet && (!event.runId || !filter.runIdSet.has(event.runId))) {
    return false;
  }
  if (filter.componentSet && !filter.componentSet.has(event.component)) {
    return false;
  }
  if (filter.stageSet && !filter.stageSet.has(event.stage)) {
    return false;
  }
  if (filter.minElapsedMs !== null) {
    if (event.elapsedMs === null || event.elapsedMs < filter.minElapsedMs) {
      return false;
    }
  }
  if (filter.maxElapsedMs !== null) {
    if (event.elapsedMs === null || event.elapsedMs > filter.maxElapsedMs) {
      return false;
    }
  }
  return true;
}

function matchChildLogEntry(filter: NormalisedChildLogFilter | null, entry: ResourceChildLogEntry): boolean {
  if (!filter) {
    return true;
  }
  if (filter.sinceTs !== null && entry.ts < filter.sinceTs) {
    return false;
  }
  if (filter.untilTs !== null && entry.ts > filter.untilTs) {
    return false;
  }
  if (filter.streamSet && !filter.streamSet.has(entry.stream)) {
    return false;
  }
  if (filter.jobIdSet && (!entry.jobId || !filter.jobIdSet.has(entry.jobId))) {
    return false;
  }
  if (filter.runIdSet && (!entry.runId || !filter.runIdSet.has(entry.runId))) {
    return false;
  }
  if (filter.opIdSet && (!entry.opId || !filter.opIdSet.has(entry.opId))) {
    return false;
  }
  if (filter.graphIdSet && (!entry.graphId || !filter.graphIdSet.has(entry.graphId))) {
    return false;
  }
  if (filter.nodeIdSet && (!entry.nodeId || !filter.nodeIdSet.has(entry.nodeId))) {
    return false;
  }
  return true;
}

/** Determines whether a blackboard mutation satisfies the active filters. */
function matchBlackboardEvent(
  filter: NormalisedBlackboardFilter | null,
  event: ResourceBlackboardEvent,
): boolean {
  if (!filter) {
    return true;
  }
  if (filter.sinceTs !== null && event.ts < filter.sinceTs) {
    return false;
  }
  if (filter.untilTs !== null && event.ts > filter.untilTs) {
    return false;
  }
  if (filter.kindSet && !filter.kindSet.has(event.kind)) {
    return false;
  }
  if (filter.keyMatcher && !filter.keyMatcher(event.key)) {
    return false;
  }
  if (filter.tagSet) {
    const tags = event.entry?.tags ?? event.previous?.tags ?? null;
    if (!containsAllTags(tags, filter.tagSet)) {
      return false;
    }
  }
  return true;
}

function cloneRunFilterDescriptor(
  filter: NormalisedRunEventFilter | null | undefined,
): ResourceWatchRunFilters | undefined {
  if (!filter) {
    return undefined;
  }
  const snapshot: ResourceWatchRunFilters = {};
  const descriptor = filter.descriptor;
  if (descriptor.levels && descriptor.levels.length > 0) {
    snapshot.levels = descriptor.levels.map((level) => level);
  }
  if (descriptor.kinds && descriptor.kinds.length > 0) {
    snapshot.kinds = descriptor.kinds.map((kind) => kind);
  }
  if (descriptor.jobIds && descriptor.jobIds.length > 0) {
    snapshot.jobIds = descriptor.jobIds.map((jobId) => jobId);
  }
  if (descriptor.opIds && descriptor.opIds.length > 0) {
    snapshot.opIds = descriptor.opIds.map((opId) => opId);
  }
  if (descriptor.graphIds && descriptor.graphIds.length > 0) {
    snapshot.graphIds = descriptor.graphIds.map((graphId) => graphId);
  }
  if (descriptor.nodeIds && descriptor.nodeIds.length > 0) {
    snapshot.nodeIds = descriptor.nodeIds.map((nodeId) => nodeId);
  }
  if (descriptor.childIds && descriptor.childIds.length > 0) {
    snapshot.childIds = descriptor.childIds.map((childId) => childId);
  }
  if (descriptor.runIds && descriptor.runIds.length > 0) {
    snapshot.runIds = descriptor.runIds.map((runId) => runId);
  }
  if (descriptor.components && descriptor.components.length > 0) {
    snapshot.components = descriptor.components.map((component) => component);
  }
  if (descriptor.stages && descriptor.stages.length > 0) {
    snapshot.stages = descriptor.stages.map((stage) => stage);
  }
  if (typeof descriptor.sinceTs === "number") {
    snapshot.sinceTs = descriptor.sinceTs;
  }
  if (typeof descriptor.untilTs === "number") {
    snapshot.untilTs = descriptor.untilTs;
  }
  if (typeof descriptor.minElapsedMs === "number") {
    snapshot.minElapsedMs = descriptor.minElapsedMs;
  }
  if (typeof descriptor.maxElapsedMs === "number") {
    snapshot.maxElapsedMs = descriptor.maxElapsedMs;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function cloneChildFilterDescriptor(
  filter: NormalisedChildLogFilter | null | undefined,
): ResourceWatchChildFilters | undefined {
  if (!filter) {
    return undefined;
  }
  const snapshot: ResourceWatchChildFilters = {};
  const descriptor = filter.descriptor;
  if (descriptor.streams && descriptor.streams.length > 0) {
    snapshot.streams = descriptor.streams.map((stream) => stream);
  }
  if (descriptor.jobIds && descriptor.jobIds.length > 0) {
    snapshot.jobIds = descriptor.jobIds.map((jobId) => jobId);
  }
  if (descriptor.runIds && descriptor.runIds.length > 0) {
    snapshot.runIds = descriptor.runIds.map((runId) => runId);
  }
  if (descriptor.opIds && descriptor.opIds.length > 0) {
    snapshot.opIds = descriptor.opIds.map((opId) => opId);
  }
  if (descriptor.graphIds && descriptor.graphIds.length > 0) {
    snapshot.graphIds = descriptor.graphIds.map((graphId) => graphId);
  }
  if (descriptor.nodeIds && descriptor.nodeIds.length > 0) {
    snapshot.nodeIds = descriptor.nodeIds.map((nodeId) => nodeId);
  }
  if (typeof descriptor.sinceTs === "number") {
    snapshot.sinceTs = descriptor.sinceTs;
  }
  if (typeof descriptor.untilTs === "number") {
    snapshot.untilTs = descriptor.untilTs;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function cloneWatchFilters(
  filters: ResourceWatchResult["filters"] | undefined,
): ResourceWatchResult["filters"] | undefined {
  if (!filters) {
    return undefined;
  }
  const snapshot: ResourceWatchResult["filters"] = {};
  if (filters.keys && filters.keys.length > 0) {
    snapshot.keys = filters.keys.map((key) => key);
  }
  if (filters.run) {
    snapshot.run = {
      ...(filters.run.levels ? { levels: filters.run.levels.map((level) => level) } : {}),
      ...(filters.run.kinds ? { kinds: filters.run.kinds.map((kind) => kind) } : {}),
      ...(filters.run.jobIds ? { jobIds: filters.run.jobIds.map((id) => id) } : {}),
      ...(filters.run.opIds ? { opIds: filters.run.opIds.map((id) => id) } : {}),
      ...(filters.run.graphIds ? { graphIds: filters.run.graphIds.map((id) => id) } : {}),
      ...(filters.run.nodeIds ? { nodeIds: filters.run.nodeIds.map((id) => id) } : {}),
      ...(filters.run.childIds ? { childIds: filters.run.childIds.map((id) => id) } : {}),
      ...(filters.run.runIds ? { runIds: filters.run.runIds.map((id) => id) } : {}),
      ...(typeof filters.run.sinceTs === "number" ? { sinceTs: filters.run.sinceTs } : {}),
      ...(typeof filters.run.untilTs === "number" ? { untilTs: filters.run.untilTs } : {}),
    };
  }
  if (filters.child) {
    snapshot.child = {
      ...(filters.child.streams ? { streams: filters.child.streams.map((stream) => stream) } : {}),
      ...(filters.child.jobIds ? { jobIds: filters.child.jobIds.map((id) => id) } : {}),
      ...(filters.child.runIds ? { runIds: filters.child.runIds.map((id) => id) } : {}),
      ...(filters.child.opIds ? { opIds: filters.child.opIds.map((id) => id) } : {}),
      ...(filters.child.graphIds ? { graphIds: filters.child.graphIds.map((id) => id) } : {}),
      ...(filters.child.nodeIds ? { nodeIds: filters.child.nodeIds.map((id) => id) } : {}),
      ...(typeof filters.child.sinceTs === "number" ? { sinceTs: filters.child.sinceTs } : {}),
      ...(typeof filters.child.untilTs === "number" ? { untilTs: filters.child.untilTs } : {}),
    };
  }
  if (filters.blackboard) {
    snapshot.blackboard = {
      ...(filters.blackboard.keys ? { keys: filters.blackboard.keys.map((key) => key) } : {}),
      ...(filters.blackboard.kinds ? { kinds: filters.blackboard.kinds.map((kind) => kind) } : {}),
      ...(filters.blackboard.tags ? { tags: filters.blackboard.tags.map((tag) => tag) } : {}),
      ...(typeof filters.blackboard.sinceTs === "number" ? { sinceTs: filters.blackboard.sinceTs } : {}),
      ...(typeof filters.blackboard.untilTs === "number" ? { untilTs: filters.blackboard.untilTs } : {}),
    };
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
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

const VALIDATION_CATEGORY_KIND_MAP = {
  inputs: "validation_input",
  outputs: "validation_output",
  events: "validation_events",
  logs: "validation_logs",
} as const satisfies Record<ValidationArtifactInput["artifactType"], ValidationResourceKind>;

const VALIDATION_KIND_PAYLOAD_TYPE: Record<ValidationResourceKind, ValidationArtifactType> = {
  validation_input: "input",
  validation_output: "output",
  validation_events: "events",
  validation_logs: "logs",
};

function normaliseResourceSegment(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new ResourceRegistryError("E-RES-INVALID", `Invalid ${label}`, "invalid_segment");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ResourceRegistryError("E-RES-INVALID", `Invalid ${label}`, "invalid_segment");
  }
  if (trimmed.includes("/")) {
    throw new ResourceRegistryError("E-RES-INVALID", `Invalid ${label}`, "invalid_segment");
  }
  return trimmed;
}

function normaliseValidationArtifactCategory(
  category: ValidationArtifactInput["artifactType"],
): ValidationArtifactInput["artifactType"] {
  if (category === "inputs" || category === "outputs" || category === "events" || category === "logs") {
    return category;
  }
  throw new ResourceRegistryError(
    "E-RES-INVALID",
    `Unsupported validation artefact category: ${String(category)}`,
    "invalid_category",
  );
}

function validationCategoryToKind(
  category: ValidationArtifactInput["artifactType"],
): ValidationResourceKind {
  return VALIDATION_CATEGORY_KIND_MAP[category];
}

function validationKindToPayloadType(kind: ValidationResourceKind): ValidationArtifactType {
  return VALIDATION_KIND_PAYLOAD_TYPE[kind];
}

function normaliseValidationMime(candidate: string | null | undefined): string {
  if (typeof candidate !== "string") {
    return "application/json";
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : "application/json";
}

function normaliseValidationMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof key !== "string" || key.trim().length === 0) {
      continue;
    }
    snapshot[key] = clone(value as unknown);
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/** Extract the namespace portion of a blackboard key. */
const BLACKBOARD_NAMESPACE_SEPARATORS = [":", "/", "|"] as const;

/** Enumerates the mutation kinds a blackboard namespace can emit. */
const BLACKBOARD_EVENT_KINDS = new Set<BlackboardEventKind>(["set", "delete", "expire"]);

function extractNamespace(key: string): string {
  for (const separator of BLACKBOARD_NAMESPACE_SEPARATORS) {
    const index = key.indexOf(separator);
    if (index > 0) {
      return key.slice(0, index);
    }
  }
  return key;
}

interface NormalisedBlackboardKeyFilter {
  readonly keys: readonly string[];
  readonly matcher: (key: string) => boolean;
}

function stripNamespacePrefix(key: string, namespace: string): string | null {
  if (!key.startsWith(namespace)) {
    return null;
  }
  const remainder = key.slice(namespace.length);
  if (remainder.length === 0) {
    return "";
  }
  const separator = remainder[0]!;
  if (!BLACKBOARD_NAMESPACE_SEPARATORS.includes(separator as typeof BLACKBOARD_NAMESPACE_SEPARATORS[number])) {
    return null;
  }
  return remainder.slice(1);
}

function normaliseBlackboardKeyFilter(
  namespace: string,
  keys: ReadonlyArray<string> | null | undefined,
): NormalisedBlackboardKeyFilter | null {
  if (!keys || keys.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const suffixes = new Set<string>();
  const normalised: string[] = [];

  for (const rawKey of keys) {
    if (typeof rawKey !== "string") {
      continue;
    }
    const trimmed = rawKey.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalised.push(trimmed);

    const suffix = stripNamespacePrefix(trimmed, namespace);
    if (suffix !== null) {
      suffixes.add(suffix);
    } else {
      suffixes.add(trimmed);
    }
  }

  if (normalised.length === 0) {
    return null;
  }

  const fullKeys = new Set(normalised);
  return {
    keys: normalised,
    matcher: (candidate: string) => {
      if (fullKeys.has(candidate)) {
        return true;
      }
      const suffix = stripNamespacePrefix(candidate, namespace);
      if (suffix === null) {
        return false;
      }
      return suffixes.has(suffix);
    },
  };
}

/**
 * Normalises the key/timestamp constraints applied to blackboard watch
 * operations so pagination logic can consistently filter mutations.
 */
function normaliseBlackboardFilter(
  namespace: string,
  keys: ReadonlyArray<string> | null | undefined,
  filters: ResourceWatchBlackboardFilters | null | undefined,
): NormalisedBlackboardFilter | null {
  const combinedKeys = [
    ...(keys ?? []),
    ...(filters?.keys ?? []),
  ];
  const keyFilter = normaliseBlackboardKeyFilter(namespace, combinedKeys);
  const kindValues = normaliseStringArray(filters?.kinds ?? [], {
    transform: (kind) => kind.toLowerCase(),
    limit: BLACKBOARD_EVENT_KINDS.size,
  });
  const tagValues = normaliseStringArray(filters?.tags ?? [], {
    transform: (tag) => tag.toLowerCase(),
    limit: 50,
  });
  const validKinds: BlackboardEventKind[] = [];
  for (const candidate of kindValues) {
    if (BLACKBOARD_EVENT_KINDS.has(candidate as BlackboardEventKind)) {
      validKinds.push(candidate as BlackboardEventKind);
    }
  }
  const sinceTs = normaliseOptionalNumber(filters?.sinceTs);
  let untilTs = normaliseOptionalNumber(filters?.untilTs);

  if (sinceTs !== null && untilTs !== null && untilTs < sinceTs) {
    untilTs = sinceTs;
  }

  const descriptor: ResourceWatchBlackboardFilters = {};
  if (keyFilter) {
    descriptor.keys = keyFilter.keys.map((key) => key);
  }
  if (validKinds.length > 0) {
    descriptor.kinds = validKinds.map((kind) => kind);
  }
  if (tagValues.length > 0) {
    descriptor.tags = tagValues.map((tag) => tag);
  }
  if (sinceTs !== null) {
    descriptor.sinceTs = sinceTs;
  }
  if (untilTs !== null) {
    descriptor.untilTs = untilTs;
  }

  if (Object.keys(descriptor).length === 0) {
    return null;
  }

  return {
    descriptor,
    keyMatcher: keyFilter?.matcher,
    kindSet: validKinds.length > 0 ? new Set(validKinds) : undefined,
    tagSet: tagValues.length > 0 ? new Set(tagValues) : undefined,
    sinceTs,
    untilTs,
  };
}

/** Clones the user-visible blackboard filter descriptor for metadata echoes. */
function cloneBlackboardFilterDescriptor(
  filter: NormalisedBlackboardFilter | null | undefined,
): ResourceWatchBlackboardFilters | undefined {
  if (!filter) {
    return undefined;
  }
  const snapshot: ResourceWatchBlackboardFilters = {};
  const descriptor = filter.descriptor;
  if (descriptor.keys && descriptor.keys.length > 0) {
    snapshot.keys = descriptor.keys.map((key) => key);
  }
  if (descriptor.kinds && descriptor.kinds.length > 0) {
    snapshot.kinds = descriptor.kinds.map((kind) => kind);
  }
  if (descriptor.tags && descriptor.tags.length > 0) {
    snapshot.tags = descriptor.tags.map((tag) => tag);
  }
  if (typeof descriptor.sinceTs === "number") {
    snapshot.sinceTs = descriptor.sinceTs;
  }
  if (typeof descriptor.untilTs === "number") {
    snapshot.untilTs = descriptor.untilTs;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

/** Normalises heterogeneous metadata fields into lowercase domain labels. */
function extractRouterDomains(context: ToolRoutingContext): string[] {
  const domains = new Set<string>();
  const append = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed.length > 0) {
      domains.add(trimmed);
    }
  };

  if (context.category) {
    append(context.category);
  }
  if (context.metadata) {
    const metadata = context.metadata as Record<string, unknown>;
    if (metadata.category !== undefined) {
      append(metadata.category);
    }
    if (Array.isArray(metadata.categories)) {
      for (const value of metadata.categories) {
        append(value);
      }
    }
    if (metadata.domain !== undefined) {
      append(metadata.domain);
    }
    if (Array.isArray(metadata.domains)) {
      for (const value of metadata.domains) {
        append(value);
      }
    }
  }
  return Array.from(domains);
}

/** Computes the integer median of the provided samples. */
function computeMedian(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  const lower = sorted[mid - 1]!;
  const upper = sorted[mid]!;
  return Math.round((lower + upper) / 2);
}

/** Computes the rounded arithmetic mean of the provided samples. */
function computeAverage(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return Math.round(sum / values.length);
}

/** Maintains deterministic MCP resource metadata and snapshots. */
export class ResourceRegistry {
  private readonly graphHistories = new Map<string, GraphHistory>();

  private readonly graphSnapshots = new Map<string, Map<string, GraphSnapshotRecord>>();

  private readonly runHistories = new Map<string, RunHistory>();

  private readonly childHistories = new Map<string, ChildLogHistory>();

  private readonly blackboardHistories = new Map<string, BlackboardNamespaceHistory>();

  private readonly validationArtifacts = new Map<string, ValidationArtifactRecord>();

  private readonly toolRouterHistory: ToolRouterHistory = {
    decisions: [],
    lastSeq: 0,
    emitter: new EventEmitter(),
    aggregates: {
      decisionCount: 0,
      domains: new Set<string>(),
      successes: 0,
      failures: 0,
      latencies: [],
    },
  };

  private readonly runHistoryLimit: number;

  private readonly childLogHistoryLimit: number;

  private readonly blackboardHistoryLimit: number;

  private readonly blackboard: BlackboardStore | null;

  constructor(options: ResourceRegistryOptions = {}) {
    this.runHistoryLimit = clampPositive(options.runHistoryLimit, 500);
    this.childLogHistoryLimit = clampPositive(options.childLogHistoryLimit, 500);
    this.blackboardHistoryLimit = clampPositive(options.blackboardHistoryLimit, 500);
    this.blackboard = options.blackboard ?? null;
    if (this.blackboard) {
      this.blackboard.watch({
        fromVersion: 0,
        listener: (event) => {
          this.recordBlackboardEvent(event);
        },
      });
    }
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
    component?: string | null;
    stage?: string | null;
    elapsedMs?: number | null;
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
      component: (event.component ?? null) && typeof event.component === "string"
        ? event.component
        : "run",
      stage: (event.stage ?? null) && typeof event.stage === "string" ? event.stage : event.kind.toLowerCase(),
      elapsedMs: typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs)
        ? Math.max(0, Math.round(event.elapsedMs))
        : null,
      payload: clone(event.payload ?? null),
    };
    history.events.push(payload);
    history.lastSeq = Math.max(history.lastSeq, payload.seq);
    if (history.events.length > this.runHistoryLimit) {
      history.events.splice(0, history.events.length - this.runHistoryLimit);
    }
    history.emitter.emit("event", payload);
  }

  /** Records a decision emitted by the contextual tool router. */
  recordToolRouterDecision(record: ToolRouterDecisionRecord): void {
    const history = this.toolRouterHistory;
    const seq = history.lastSeq + 1;
    const entry: ResourceToolRouterDecision = {
      seq,
      ts: record.decision.decidedAt ?? Date.now(),
      tool: record.decision.tool,
      score: record.decision.score,
      reason: record.decision.reason,
      candidates: record.decision.candidates.map((candidate) => clone(candidate)),
      context: clone(record.context),
      requestId: record.requestId ?? null,
      traceId: record.traceId ?? null,
      runId: record.runId ?? null,
      jobId: record.jobId ?? null,
      childId: record.childId ?? null,
      elapsedMs: record.elapsedMs ?? null,
    };
    history.decisions.push(entry);
    if (history.decisions.length > TOOL_ROUTER_HISTORY_LIMIT) {
      history.decisions.splice(0, history.decisions.length - TOOL_ROUTER_HISTORY_LIMIT);
    }
    history.lastSeq = seq;
    const aggregates = history.aggregates;
    aggregates.decisionCount += 1;
    for (const domain of extractRouterDomains(record.context)) {
      aggregates.domains.add(domain);
    }
    history.emitter.emit("event", entry);
  }

  /** Records an outcome emitted by the contextual tool router. */
  recordToolRouterOutcome(outcome: { tool: string; success: boolean; latencyMs?: number | null }): void {
    const aggregates = this.toolRouterHistory.aggregates;
    if (outcome.success) {
      aggregates.successes += 1;
    } else {
      aggregates.failures += 1;
    }
    if (Number.isFinite(outcome.latencyMs)) {
      const latency = Math.max(0, Math.round(outcome.latencyMs as number));
      aggregates.latencies.push(latency);
      if (aggregates.latencies.length > TOOL_ROUTER_LATENCY_LIMIT) {
        aggregates.latencies.splice(0, aggregates.latencies.length - TOOL_ROUTER_LATENCY_LIMIT);
      }
    }
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

  /** Registers a validation artefact so campaigns can persist deterministic evidence. */
  registerValidationArtifact(input: ValidationArtifactInput): string {
    const sessionId = normaliseResourceSegment(input.sessionId, "sessionId");
    const category = normaliseValidationArtifactCategory(input.artifactType);
    const name = normaliseResourceSegment(input.name, "name");
    const runId = normaliseOptionalString(input.runId ?? null);
    const phase = normaliseOptionalString(input.phase ?? null);
    const recordedAt =
      normaliseOptionalNumber(input.recordedAt ?? Date.now()) ?? Math.floor(Date.now());
    const mime = normaliseValidationMime(input.mime);
    const metadata = normaliseValidationMetadata(input.metadata);
    const kind = validationCategoryToKind(category);
    const uri = `sc://validation/${sessionId}/${category}/${name}`;

    const record: ValidationArtifactRecord = {
      kind,
      sessionId,
      runId,
      phase,
      artifactType: category,
      name,
      recordedAt,
      mime,
      data: clone(input.data),
      metadata,
    };

    this.validationArtifacts.set(uri, record);
    return uri;
  }

  /**
   * Clears validation artefacts tracked by the registry. When a session
   * identifier is provided only the matching artefacts are removed so test
   * suites can isolate their state without interfering with concurrent
   * campaigns.
   */
  clearValidationArtifacts(sessionId?: string | null): void {
    if (!sessionId) {
      this.validationArtifacts.clear();
      return;
    }

    const normalised = sessionId.trim();
    if (!normalised) {
      this.validationArtifacts.clear();
      return;
    }

    for (const [uri, artifact] of this.validationArtifacts.entries()) {
      if (artifact.sessionId === normalised) {
        this.validationArtifacts.delete(uri);
      }
    }
  }

  /** Tracks a mutation emitted by the blackboard store. */
  private recordBlackboardEvent(event: BlackboardEvent): void {
    const namespace = extractNamespace(event.key);
    const history = this.getOrCreateBlackboardHistory(namespace);
    const record: ResourceBlackboardEvent = {
      seq: event.version,
      version: event.version,
      ts: event.timestamp,
      kind: event.kind,
      namespace,
      key: event.key,
      entry: event.entry ? clone(event.entry) : null,
      previous: event.previous ? clone(event.previous) : null,
      reason: normaliseOptionalString(event.reason ?? null),
    };
    history.events.push(record);
    if (history.events.length > this.blackboardHistoryLimit) {
      history.events.splice(0, history.events.length - this.blackboardHistoryLimit);
    }
    history.lastSeq = Math.max(history.lastSeq, record.seq);
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
    for (const [runId, history] of this.runHistories.entries()) {
      entries.push({
        uri: `sc://runs/${runId}/events`,
        kind: "run_events",
        metadata: {
          event_count: history.events.length,
          latest_seq: history.lastSeq,
          available_formats: ["structured", "jsonl"],
        },
      });
    }
    for (const childId of this.childHistories.keys()) {
      entries.push({ uri: `sc://children/${childId}/logs`, kind: "child_logs" });
    }
    for (const summary of this.summariseBlackboardNamespaces()) {
      entries.push({
        uri: `sc://blackboard/${summary.namespace}`,
        kind: "blackboard_namespace",
        metadata: {
          entry_count: summary.entryCount,
          latest_version: summary.latestVersion,
        },
      });
    }

    for (const [uri, artifact] of this.validationArtifacts.entries()) {
      const metadata: Record<string, unknown> = {
        session_id: artifact.sessionId,
        artifact_type: artifact.artifactType,
        recorded_at: artifact.recordedAt,
        mime: artifact.mime,
      };
      if (artifact.runId) {
        metadata.run_id = artifact.runId;
      }
      if (artifact.phase) {
        metadata.phase = artifact.phase;
      }
      if (artifact.metadata) {
        Object.assign(metadata, clone(artifact.metadata));
      }
      entries.push({ uri, kind: artifact.kind, metadata });
    }

    if (this.toolRouterHistory.decisions.length > 0) {
      const aggregates = this.toolRouterHistory.aggregates;
      const outcomeCount = aggregates.successes + aggregates.failures;
      const successRate = outcomeCount > 0 ? aggregates.successes / outcomeCount : null;
      const medianLatency = computeMedian(aggregates.latencies);
      const averageLatency = computeAverage(aggregates.latencies);
      entries.push({
        uri: "sc://tool-router/decisions",
        kind: "tool_router_decisions",
        metadata: {
          decision_count: this.toolRouterHistory.decisions.length,
          latest_seq: this.toolRouterHistory.lastSeq,
          domains: aggregates.domains.size > 0 ? Array.from(aggregates.domains).sort() : [],
          success_rate: successRate !== null ? Math.round(successRate * 1000) / 1000 : null,
          median_latency_ms: medianLatency,
          estimated_cost_ms: averageLatency,
        },
      });
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
        const events = history.events.map((evt) => clone(evt));
        const jsonl =
          events.length === 0 ? "" : `${events.map((evt) => JSON.stringify(evt)).join("\n")}\n`;
        return {
          uri,
          kind: "run_events",
          payload: { runId: parsed.runId!, events, jsonl },
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
        const namespace = parsed.namespace;
        if (!namespace) {
          throw new ResourceNotFoundError(uri);
        }

        const history = this.blackboardHistories.get(namespace);
        if (!this.blackboard) {
          if (!history) {
            throw new ResourceNotFoundError(uri);
          }
          return { uri, kind: "blackboard_namespace", payload: { namespace, entries: [] } };
        }

        const entries = this.blackboard
          .query()
          .filter((entry) => extractNamespace(entry.key) === namespace)
          .map((entry) => clone(entry));

        if (entries.length === 0 && !history) {
          throw new ResourceNotFoundError(uri);
        }

        return {
          uri,
          kind: "blackboard_namespace",
          payload: { namespace, entries },
        };
      }
      case "validation_input":
      case "validation_output":
      case "validation_events":
      case "validation_logs": {
        const artifact = this.getValidationArtifactOrThrow(uri, parsed.kind);
        const payload: ValidationResourcePayload = {
          sessionId: artifact.sessionId,
          runId: artifact.runId,
          phase: artifact.phase,
          artifactType: validationKindToPayloadType(artifact.kind),
          name: artifact.name,
          recordedAt: artifact.recordedAt,
          mime: artifact.mime,
          data: clone(artifact.data),
          ...(artifact.metadata ? { metadata: clone(artifact.metadata) } : {}),
        };
        return { uri, kind: parsed.kind, payload };
      }
      case "tool_router_decisions": {
        const decisions = this.toolRouterHistory.decisions.map((entry) => clone(entry));
        const aggregates = this.toolRouterHistory.aggregates;
        const outcomeCount = aggregates.successes + aggregates.failures;
        const successRate = outcomeCount > 0 ? aggregates.successes / outcomeCount : null;
        const medianLatency = computeMedian(aggregates.latencies);
        const averageLatency = computeAverage(aggregates.latencies);
        return {
          uri,
          kind: "tool_router_decisions",
          payload: {
            decisions,
            latestSeq: this.toolRouterHistory.lastSeq,
            aggregates: {
              decisionCount: aggregates.decisionCount,
              successRate: successRate !== null ? Math.round(successRate * 1000) / 1000 : null,
              medianLatencyMs: medianLatency,
              estimatedCostMs: averageLatency,
              domains: aggregates.domains.size > 0 ? Array.from(aggregates.domains).sort() : [],
            },
          },
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
        const history = this.getRunHistoryOrThrow(uri, parsed.runId);
        const runFilter = normaliseRunEventFilter(options.run);
        const page = this.sliceRunHistory(history, fromSeq, limit, runFilter);
        const result: ResourceWatchResult = {
          uri,
          kind: "run_events",
          events: page.events,
          nextSeq: page.nextSeq,
        };
        const filters: ResourceWatchResult["filters"] = {};
        const runDescriptor = cloneRunFilterDescriptor(runFilter);
        if (runDescriptor) {
          filters.run = runDescriptor;
        }
        if (filters.run) {
          result.filters = filters;
        }
        return result;
      }
      case "child_logs": {
        const history = this.getChildHistoryOrThrow(uri, parsed.childId);
        const childFilter = normaliseChildLogFilter(options.child);
        const page = this.sliceChildHistory(history, fromSeq, limit, childFilter);
        const result: ResourceWatchResult = {
          uri,
          kind: "child_logs",
          events: page.events,
          nextSeq: page.nextSeq,
        };
        const filters: ResourceWatchResult["filters"] = {};
        const childDescriptor = cloneChildFilterDescriptor(childFilter);
        if (childDescriptor) {
          filters.child = childDescriptor;
        }
        if (filters.child) {
          result.filters = filters;
        }
        return result;
      }
      case "blackboard_namespace": {
        const history = this.getBlackboardHistoryOrThrow(uri, parsed.namespace);
        const filter = normaliseBlackboardFilter(parsed.namespace, options.keys, options.blackboard);
        const page = this.sliceBlackboardHistory(history, fromSeq, limit, filter);
        const result: ResourceWatchResult = {
          uri,
          kind: "blackboard_namespace",
          events: page.events,
          nextSeq: page.nextSeq,
        };
        const blackboardDescriptor = cloneBlackboardFilterDescriptor(filter);
        if (blackboardDescriptor) {
          result.filters = {};
          if (blackboardDescriptor.keys && blackboardDescriptor.keys.length > 0) {
            result.filters.keys = blackboardDescriptor.keys.map((key) => key);
          }
          result.filters.blackboard = blackboardDescriptor;
        }
        return result;
      }
      case "tool_router_decisions": {
        const page = this.sliceToolRouterHistory(this.toolRouterHistory, fromSeq, limit);
        return { uri, kind: "tool_router_decisions", events: page.events, nextSeq: page.nextSeq };
      }
      default:
        throw new ResourceWatchUnsupportedError(uri);
    }
  }

  /**
   * Creates an async iterator that yields watch pages as soon as new events or
   * log entries become available. Consumers can terminate the iterator by
   * calling `return()` or by aborting the provided {@link AbortSignal}.
   */
  watchStream(uri: string, options: ResourceWatchStreamOptions = {}): AsyncIterable<ResourceWatchResult> {
    const fromSeq = options.fromSeq ?? 0;
    const limit = clampPositive(options.limit, 250);
    const parsed = this.parseUri(uri);
    switch (parsed.kind) {
      case "run_events": {
        const history = this.getRunHistoryOrThrow(uri, parsed.runId);
        const runFilter = normaliseRunEventFilter(options.run);
        const runFilters = cloneRunFilterDescriptor(runFilter);
        return this.createWatchStream({
          uri,
          kind: "run_events",
          emitter: history.emitter,
          fromSeq,
          limit,
          signal: options.signal ?? null,
          filters: runFilters ? { run: runFilters } : undefined,
          slice: (cursor, pageLimit) => this.sliceRunHistory(history, cursor, pageLimit, runFilter),
        });
      }
      case "child_logs": {
        const history = this.getChildHistoryOrThrow(uri, parsed.childId);
        const childFilter = normaliseChildLogFilter(options.child);
        const childFilters = cloneChildFilterDescriptor(childFilter);
        return this.createWatchStream({
          uri,
          kind: "child_logs",
          emitter: history.emitter,
          fromSeq,
          limit,
          signal: options.signal ?? null,
          filters: childFilters ? { child: childFilters } : undefined,
          slice: (cursor, pageLimit) => this.sliceChildHistory(history, cursor, pageLimit, childFilter),
        });
      }
      case "blackboard_namespace": {
        const history = this.getBlackboardHistoryOrThrow(uri, parsed.namespace);
        const filter = normaliseBlackboardFilter(parsed.namespace, options.keys, options.blackboard);
        const descriptor = cloneBlackboardFilterDescriptor(filter);
        return this.createWatchStream({
          uri,
          kind: "blackboard_namespace",
          emitter: history.emitter,
          fromSeq,
          limit,
          signal: options.signal ?? null,
          filters:
            descriptor
              ? {
                  ...(descriptor.keys && descriptor.keys.length > 0
                    ? { keys: descriptor.keys.map((key) => key) }
                    : {}),
                  blackboard: descriptor,
                }
              : undefined,
          slice: (cursor, pageLimit) => this.sliceBlackboardHistory(history, cursor, pageLimit, filter),
        });
      }
      case "tool_router_decisions": {
        const history = this.toolRouterHistory;
        return this.createWatchStream({
          uri,
          kind: "tool_router_decisions",
          emitter: history.emitter,
          fromSeq,
          limit,
          signal: options.signal ?? null,
          slice: (cursor, pageLimit) => this.sliceToolRouterHistory(history, cursor, pageLimit),
        });
      }
      default:
        throw new ResourceWatchUnsupportedError(uri);
    }
  }

  private getRunHistoryOrThrow(uri: string, runId: string): RunHistory {
    const history = this.runHistories.get(runId);
    if (!history) {
      throw new ResourceNotFoundError(uri);
    }
    return history;
  }

  private getValidationArtifactOrThrow(
    uri: string,
    kind: ValidationResourceKind,
  ): ValidationArtifactRecord {
    const record = this.validationArtifacts.get(uri);
    if (!record || record.kind !== kind) {
      throw new ResourceNotFoundError(uri);
    }
    return record;
  }

  private getChildHistoryOrThrow(uri: string, childId: string): ChildLogHistory {
    const history = this.childHistories.get(childId);
    if (!history) {
      throw new ResourceNotFoundError(uri);
    }
    return history;
  }

  private sliceRunHistory(
    history: RunHistory,
    fromSeq: number,
    limit: number,
    filter: NormalisedRunEventFilter | null = null,
  ) {
    const sorted = history.events
      .filter((event) => event.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq);
    const events: ResourceRunEvent[] = [];
    let lastProcessedSeq = fromSeq;
    let processedAny = false;
    for (const event of sorted) {
      processedAny = true;
      lastProcessedSeq = event.seq;
      if (matchRunEvent(filter, event)) {
        events.push(clone(event));
        if (events.length >= limit) {
          break;
        }
      }
    }
    let nextSeq: number;
    if (events.length > 0) {
      nextSeq = Math.max(events[events.length - 1]!.seq, fromSeq);
    } else if (processedAny) {
      nextSeq = Math.max(lastProcessedSeq, fromSeq, history.lastSeq);
    } else {
      nextSeq = Math.max(fromSeq, history.lastSeq);
    }
    return { events, nextSeq };
  }

  private sliceChildHistory(
    history: ChildLogHistory,
    fromSeq: number,
    limit: number,
    filter: NormalisedChildLogFilter | null = null,
  ) {
    const sorted = history.entries
      .filter((entry) => entry.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq);
    const events: ResourceChildLogEntry[] = [];
    let lastProcessedSeq = fromSeq;
    let processedAny = false;
    for (const entry of sorted) {
      processedAny = true;
      lastProcessedSeq = entry.seq;
      if (matchChildLogEntry(filter, entry)) {
        events.push(clone(entry));
        if (events.length >= limit) {
          break;
        }
      }
    }
    let nextSeq: number;
    if (events.length > 0) {
      nextSeq = Math.max(events[events.length - 1]!.seq, fromSeq);
    } else if (processedAny) {
      nextSeq = Math.max(lastProcessedSeq, fromSeq, history.lastSeq);
    } else {
      nextSeq = Math.max(fromSeq, history.lastSeq);
    }
    return { events, nextSeq };
  }

  private sliceToolRouterHistory(history: ToolRouterHistory, fromSeq: number, limit: number) {
    const sorted = history.decisions
      .filter((entry) => entry.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq);
    const events: ResourceToolRouterDecision[] = [];
    let lastProcessedSeq = fromSeq;
    let processedAny = false;
    for (const entry of sorted) {
      processedAny = true;
      lastProcessedSeq = entry.seq;
      events.push(clone(entry));
      if (events.length >= limit) {
        break;
      }
    }
    let nextSeq: number;
    if (events.length > 0) {
      nextSeq = Math.max(events[events.length - 1]!.seq, fromSeq);
    } else if (processedAny) {
      nextSeq = Math.max(lastProcessedSeq, fromSeq, history.lastSeq);
    } else {
      nextSeq = Math.max(fromSeq, history.lastSeq);
    }
    return { events, nextSeq };
  }

  private createWatchStream(context: WatchStreamContext): AsyncIterable<ResourceWatchResult> {
    return {
      [Symbol.asyncIterator]: () => {
        let currentSeq = context.fromSeq;
        let disposed = false;
        let pendingReject: ((error: Error) => void) | null = null;

        const computePage = () => context.slice(currentSeq, context.limit);

        const waitForUpdate = () =>
          new Promise<void>((resolve, reject) => {
            const listener = () => {
              cleanup();
              resolve();
            };

            const cleanup = () => {
              if (typeof context.emitter.off === "function") {
                context.emitter.off("event", listener);
              } else {
                context.emitter.removeListener("event", listener);
              }
              if (context.signal) {
                context.signal.removeEventListener("abort", onAbort);
              }
              pendingReject = null;
            };

            const onAbort = () => {
              cleanup();
              reject(new ResourceWatchAbortedError(context.uri));
            };

            pendingReject = (error: Error) => {
              cleanup();
              reject(error);
            };

            if (context.signal?.aborted) {
              cleanup();
              reject(new ResourceWatchAbortedError(context.uri));
              return;
            }

            context.emitter.once("event", listener);
            if (context.signal) {
              context.signal.addEventListener("abort", onAbort, { once: true });
            }
          });

        const dispose = () => {
          if (disposed) {
            return;
          }
          disposed = true;
          const reject = pendingReject;
          pendingReject = null;
          if (reject) {
            reject(new ResourceWatchDisposedError(context.uri));
          }
        };

        const buildResult = (
          page: {
            events: Array<ResourceRunEvent | ResourceChildLogEntry | ResourceBlackboardEvent>;
            nextSeq: number;
          },
        ): ResourceWatchResult => {
          const result: ResourceWatchResult = {
            uri: context.uri,
            kind: context.kind,
            events: page.events,
            nextSeq: page.nextSeq,
          };
          const filters = cloneWatchFilters(context.filters);
          if (filters) {
            result.filters = filters;
          }
          return result;
        };

        return {
          next: async () => {
            if (disposed) {
              return { value: undefined, done: true };
            }

            while (true) {
              const page = computePage();
              if (page.events.length > 0) {
                currentSeq = page.nextSeq;
                return { value: buildResult(page), done: false };
              }

              try {
                await waitForUpdate();
              } catch (error) {
                if (error instanceof ResourceWatchDisposedError) {
                  disposed = true;
                  return { value: undefined, done: true };
                }
                disposed = true;
                throw error;
              }

              if (disposed) {
                return { value: undefined, done: true };
              }
            }
          },
          return: async () => {
            dispose();
            return { value: undefined, done: true };
          },
          throw: async (error) => {
            dispose();
            throw error;
          },
        };
      },
    };
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

  private getOrCreateBlackboardHistory(namespace: string): BlackboardNamespaceHistory {
    const existing = this.blackboardHistories.get(namespace);
    if (existing) {
      return existing;
    }
    const history: BlackboardNamespaceHistory = { events: [], lastSeq: 0, emitter: new EventEmitter() };
    this.blackboardHistories.set(namespace, history);
    return history;
  }

  /**
   * Summarises the active blackboard namespaces along with basic statistics used when listing
   * MCP resources. The helper keeps the registry deterministic by pre-computing the number of
   * live entries and the latest version observed (including history-only mutations such as
   * deletes). Consumers rely on those figures to seed paginated watches efficiently.
   */
  private summariseBlackboardNamespaces(): Array<{
    namespace: string;
    entryCount: number;
    latestVersion: number;
  }> {
    if (!this.blackboard) {
      return [];
    }

    const summary = new Map<string, { entryCount: number; latestVersion: number }>();
    for (const entry of this.blackboard.query()) {
      const namespace = extractNamespace(entry.key);
      const stats = summary.get(namespace) ?? { entryCount: 0, latestVersion: 0 };
      stats.entryCount += 1;
      stats.latestVersion = Math.max(stats.latestVersion, entry.version);
      summary.set(namespace, stats);
    }

    for (const [namespace, history] of this.blackboardHistories.entries()) {
      const stats = summary.get(namespace) ?? { entryCount: 0, latestVersion: 0 };
      stats.latestVersion = Math.max(stats.latestVersion, history.lastSeq);
      summary.set(namespace, stats);
    }

    return Array.from(summary.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([namespace, stats]) => ({
        namespace,
        entryCount: stats.entryCount,
        latestVersion: stats.latestVersion,
      }));
  }

  private getBlackboardHistoryOrThrow(uri: string, namespace: string | undefined): BlackboardNamespaceHistory {
    if (!namespace) {
      throw new ResourceNotFoundError(uri);
    }
    const existing = this.blackboardHistories.get(namespace);
    if (existing) {
      return existing;
    }
    if (!this.blackboard) {
      throw new ResourceNotFoundError(uri);
    }
    const hasNamespace = this.blackboard
      .query()
      .some((entry) => extractNamespace(entry.key) === namespace);
    if (!hasNamespace) {
      throw new ResourceNotFoundError(uri);
    }
    const history = this.getOrCreateBlackboardHistory(namespace);
    history.lastSeq = Math.max(history.lastSeq, this.blackboard.getCurrentVersion());
    return history;
  }

  private sliceBlackboardHistory(
    history: BlackboardNamespaceHistory,
    fromSeq: number,
    limit: number,
    filter: NormalisedBlackboardFilter | null = null,
  ) {
    const sorted = history.events
      .filter((event) => event.seq > fromSeq)
      .sort((a, b) => a.seq - b.seq);
    const events: ResourceBlackboardEvent[] = [];
    let lastProcessedSeq = fromSeq;
    let processedCount = 0;
    for (const event of sorted) {
      processedCount += 1;
      lastProcessedSeq = event.seq;
      if (matchBlackboardEvent(filter, event)) {
        events.push(clone(event));
        if (events.length >= limit) {
          break;
        }
      }
    }
    const processedAllEvents = processedCount === sorted.length;
    let nextSeq: number;
    if (processedAllEvents) {
      if (events.length === 0) {
        nextSeq = Math.max(lastProcessedSeq, fromSeq, history.lastSeq);
      } else {
        nextSeq = Math.max(lastProcessedSeq, fromSeq);
      }
    } else if (events.length > 0) {
      nextSeq = Math.max(events[events.length - 1]!.seq, fromSeq);
    } else {
      nextSeq = Math.max(lastProcessedSeq, fromSeq);
    }
    return { events, nextSeq };
  }

  private parseUri(uri: string):
    | { kind: "graph"; graphId: string }
    | { kind: "graph_version"; graphId: string; version: number }
    | { kind: "snapshot"; graphId: string; txId: string }
    | { kind: "run_events"; runId: string }
    | { kind: "child_logs"; childId: string }
    | { kind: "tool_router_decisions" }
    | { kind: "blackboard_namespace"; namespace: string }
    | {
        kind: ValidationResourceKind;
        sessionId: string;
        artifactType: ValidationArtifactInput["artifactType"];
        name: string;
      } {
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
    if (body === "tool-router/decisions") {
      return { kind: "tool_router_decisions" };
    }
    if (body.startsWith("blackboard/")) {
      const namespace = body.slice("blackboard/".length);
      if (!namespace) {
        throw new ResourceNotFoundError(uri);
      }
      return { kind: "blackboard_namespace", namespace };
    }
    if (body.startsWith("validation/")) {
      const remainder = body.slice("validation/".length);
      const segments = remainder.split("/");
      if (segments.length !== 3) {
        throw new ResourceNotFoundError(uri);
      }
      const [sessionId, category, name] = segments;
      if (!sessionId || !category || !name) {
        throw new ResourceNotFoundError(uri);
      }
      if (category !== "inputs" && category !== "outputs" && category !== "events" && category !== "logs") {
        throw new ResourceNotFoundError(uri);
      }
      const artifactType = category as ValidationArtifactInput["artifactType"];
      return {
        kind: validationCategoryToKind(artifactType),
        sessionId,
        artifactType,
        name,
      };
    }
    throw new ResourceNotFoundError(uri);
  }
}
