import { MessageRecord } from "./types.js";
import type { ChildRuntimeLimits } from "./childRuntime.js";
import { ChildRecordSnapshot } from "./state/childrenIndex.js";
import type { Provenance } from "./types/provenance.js";
import type { ThoughtNodeStatus } from "./reasoning/thoughtGraph.js";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
type AttributeValue = string | number | boolean;

type NodeType = "job" | "child" | "message" | "pending" | "subscription" | "event";

type AttributeRecord = Record<string, AttributeValue>;

interface NodeRecord {
  id: string;
  attributes: AttributeRecord;
}

interface EdgeRecord {
  from: string;
  to: string;
  attributes: AttributeRecord;
}

export interface TranscriptItem {
  idx: number;
  role: string;
  content: string;
  ts: number;
  actor: string | null;
}

export interface TranscriptSliceOptions {
  sinceIndex?: number;
  sinceTs?: number;
  limit?: number;
  reverse?: boolean;
}

export interface TranscriptSlice {
  total: number;
  items: TranscriptItem[];
}

export interface ChildSnapshot {
  id: string;
  jobId: string;
  name: string;
  state: string;
  runtime: string;
  waitingFor: string | null;
  pendingId: string | null;
  ttlAt: number | null;
  systemMessage: string | null;
  createdAt: number;
  transcriptSize: number;
  lastTs: number | null;
  /**
   * Millisecond-precision timestamp of the latest heartbeat observed for the
   * child. `null` indicates that the orchestrator never received any
   * heartbeat.
   */
  lastHeartbeatAt: number | null;
  /**
   * Priority assigned by operators or automation to influence scheduling
   * decisions. A higher number indicates a child that should receive more
   * attention from follow-up actions (resends, reviews, etc.). When `null`, the
   * child follows the default priority.
   */
  priority: number | null;
  /** PID reported by the runtime supervisor, or null when unavailable. */
  pid: number | null;
  /** Absolute path of the runtime working directory, or null if undisclosed. */
  workdir: string | null;
  /** Timestamp indicating when the child process actually started. */
  startedAt: number | null;
  /** Timestamp marking when the child terminated, if applicable. */
  endedAt: number | null;
  /** Number of spawn retries recorded by the supervisor index. */
  retries: number;
  /** Exit code captured upon termination, null when the child has not exited. */
  exitCode: number | null;
  /** Exit signal captured upon termination, null when absent. */
  exitSignal: string | number | null;
  /** Whether the supervisor had to forcefully terminate the child. */
  forcedTermination: boolean;
  /** Human-readable reason provided by the supervisor upon termination. */
  stopReason: string | null;
  /** High-level orchestrator role advertised for the child, or null when unset. */
  role: string | null;
  /** Declarative runtime limits attached to the child, if any were configured. */
  limits: ChildRuntimeLimits | null;
  /** Timestamp capturing the last explicit attachment request acknowledged by the supervisor. */
  attachedAt: number | null;
}

export interface JobSnapshot {
  id: string;
  state: string;
  createdAt: number;
  goal: string | null;
  childIds: string[];
}

export interface PendingSnapshot {
  childId: string;
  createdAt: number;
}

export interface SubscriptionSnapshot {
  id: string;
  jobId?: string;
  childId?: string;
  lastSeq: number;
  createdAt: number;
  waitMs?: number;
}

export interface EventSnapshot {
  seq: number;
  ts: number;
  kind: string;
  level: string;
  jobId?: string;
  childId?: string;
  provenance?: Provenance[];
}

/** Normalised snapshot persisted for ThoughtGraph visualisation. */
export interface ThoughtGraphNodeState {
  id: string;
  parents: string[];
  prompt: string;
  tool: string | null;
  result: string | null;
  score: number | null;
  status: ThoughtNodeStatus;
  startedAt: number;
  completedAt: number | null;
  provenance: Provenance[];
  depth: number;
  runId: string | null;
}

/** Payload serialised on job nodes to expose multi-branch reasoning context. */
export interface ThoughtGraphStateSnapshot {
  updatedAt: number;
  nodes: ThoughtGraphNodeState[];
}

export interface ChildInactivityFlag {
  /** Type de l'alerte (idle = aucune activité, pending = attente prolongée d'un pending). */
  type: "idle" | "pending";
  /** Durée mesurée en millisecondes pour l'alerte. */
  valueMs: number;
  /** Seuil configuré ayant déclenché l'alerte. */
  thresholdMs: number;
}

export type ChildInactivityAction = "ping" | "cancel" | "retry";

export interface ChildInactivityReport {
  childId: string;
  jobId: string;
  name: string;
  state: string;
  runtime: string;
  waitingFor: string | null;
  pendingId: string | null;
  createdAt: number;
  lastActivityTs: number | null;
  idleMs: number | null;
  pendingSince: number | null;
  pendingMs: number | null;
  transcriptSize: number;
  flags: ChildInactivityFlag[];
  suggestedActions: ChildInactivityAction[];
}

export interface GraphStateMetrics {
  totalJobs: number;
  activeJobs: number;
  completedJobs: number;
  totalChildren: number;
  activeChildren: number;
  pendingChildren: number;
  eventNodes: number;
  subscriptions: number;
  totalMessages: number;
}

const THOUGHT_GRAPH_ATTRIBUTE_KEY = "thought_graph_json";

function toNullableString(value: AttributeValue | undefined): string | null {
  if (value === undefined) return null;
  const s = String(value);
  return s.length ? s : null;
}

function toNullableNumber(value: AttributeValue | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/**
 * Normalises the supervisor-provided runtime limits so they can be persisted in
 * the graph node attributes without losing ordering determinism.
 */
function serialiseChildLimits(limits: ChildRuntimeLimits | null | undefined): string | undefined {
  if (!limits) {
    return undefined;
  }
  const entries = Object.entries(limits).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return undefined;
  }
  const normalised = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(normalised);
}

/** Rehydrates runtime limits persisted on a graph node back into a typed shape. */
function parseChildLimits(value: AttributeValue | undefined): ChildRuntimeLimits | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return { ...parsed } as ChildRuntimeLimits;
  } catch {
    return null;
  }
}

const VALID_THOUGHT_STATUSES: ReadonlySet<ThoughtNodeStatus> = new Set([
  "pending",
  "running",
  "completed",
  "errored",
  "pruned",
]);

const VALID_PROVENANCE_TYPES: ReadonlySet<Provenance["type"]> = new Set([
  "url",
  "file",
  "db",
  "kg",
  "rag",
]);

function serialiseThoughtGraphState(snapshot: ThoughtGraphStateSnapshot): string {
  const serialisedNodes = snapshot.nodes.map((node) => ({
    id: node.id,
    parents: [...node.parents].sort((a, b) => a.localeCompare(b)),
    prompt: node.prompt,
    tool: node.tool ?? null,
    result: node.result ?? null,
    score: typeof node.score === "number" && Number.isFinite(node.score)
      ? Number(node.score.toFixed(6))
      : null,
    status: node.status,
    started_at: node.startedAt,
    completed_at: node.completedAt ?? null,
    provenance: serialiseThoughtGraphProvenance(node.provenance),
    depth: node.depth,
    run_id: node.runId ?? null,
  }));

  serialisedNodes.sort((a, b) => {
    if (a.started_at !== b.started_at) {
      return a.started_at - b.started_at;
    }
    return a.id.localeCompare(b.id);
  });

  return JSON.stringify({ updated_at: snapshot.updatedAt, nodes: serialisedNodes });
}

function parseThoughtGraphState(serialised: string): ThoughtGraphStateSnapshot | null {
  try {
    const raw = JSON.parse(serialised) as { updated_at?: unknown; nodes?: unknown };
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const updatedAt = typeof raw.updated_at === "number" && Number.isFinite(raw.updated_at)
      ? raw.updated_at
      : 0;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const mapped: ThoughtGraphNodeState[] = [];
    for (const entry of nodes) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const idRaw = record.id;
      if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
        continue;
      }
      const parents = Array.isArray(record.parents)
        ? record.parents
            .map((parent) => (typeof parent === "string" ? parent : String(parent ?? "")))
            .filter((parent) => parent.length > 0)
        : [];
      const prompt = typeof record.prompt === "string" ? record.prompt : String(record.prompt ?? "");
      const tool = record.tool === null || typeof record.tool === "string"
        ? (record.tool ?? null)
        : String(record.tool ?? "");
      const result = record.result === null || typeof record.result === "string"
        ? (record.result ?? null)
        : JSON.stringify(record.result);
      const score = typeof record.score === "number" && Number.isFinite(record.score)
        ? record.score
        : null;
      const status = isThoughtNodeStatus(record.status) ? record.status : "pending";
      const startedAt = typeof record.started_at === "number" && Number.isFinite(record.started_at)
        ? record.started_at
        : 0;
      const completedAt = typeof record.completed_at === "number" && Number.isFinite(record.completed_at)
        ? record.completed_at
        : null;
      const provenance = parseThoughtGraphProvenance(record.provenance);
      const depth = typeof record.depth === "number" && Number.isFinite(record.depth)
        ? record.depth
        : 0;
      const runId = typeof record.run_id === "string" && record.run_id.trim().length > 0
        ? record.run_id
        : null;

      mapped.push({
        id: idRaw,
        parents,
        prompt,
        tool,
        result,
        score,
        status,
        startedAt,
        completedAt,
        provenance,
        depth,
        runId,
      });
    }
    return { updatedAt, nodes: mapped };
  } catch {
    return null;
  }
}

function serialiseThoughtGraphProvenance(entries: Provenance[]): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    const serialised: Record<string, unknown> = {
      source_id: entry.sourceId,
      type: entry.type,
    };
    if (entry.span && Array.isArray(entry.span) && entry.span.length === 2) {
      serialised.span = [entry.span[0], entry.span[1]];
    }
    if (typeof entry.confidence === "number" && Number.isFinite(entry.confidence)) {
      serialised.confidence = entry.confidence;
    }
    return serialised;
  });
}

function parseThoughtGraphProvenance(entries: unknown): Provenance[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const result: Provenance[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const sourceId = typeof record.source_id === "string"
      ? record.source_id
      : typeof record.sourceId === "string"
        ? record.sourceId
        : null;
    const typeCandidate = record.type;
    const type = typeof typeCandidate === "string" && VALID_PROVENANCE_TYPES.has(typeCandidate as Provenance["type"])
      ? (typeCandidate as Provenance["type"])
      : null;
    if (!sourceId || !type) {
      continue;
    }
    const spanRaw = record.span;
    let span: [number, number] | undefined;
    if (Array.isArray(spanRaw) && spanRaw.length === 2) {
      const [start, end] = spanRaw;
      if (typeof start === "number" && typeof end === "number") {
        span = [start, end];
      }
    }
    const confidenceRaw = record.confidence;
    const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? confidenceRaw
      : undefined;
    result.push({ sourceId, type, span, confidence });
  }
  return result;
}

function isThoughtNodeStatus(value: unknown): value is ThoughtNodeStatus {
  return typeof value === "string" && VALID_THOUGHT_STATUSES.has(value as ThoughtNodeStatus);
}

function cloneThoughtGraphState(snapshot: ThoughtGraphStateSnapshot): ThoughtGraphStateSnapshot {
  return {
    updatedAt: snapshot.updatedAt,
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      parents: [...node.parents],
      prompt: node.prompt,
      tool: node.tool,
      result: node.result,
      score: node.score,
      status: node.status,
      startedAt: node.startedAt,
      completedAt: node.completedAt,
      provenance: node.provenance.map((entry) => ({ ...entry })),
      depth: node.depth,
      runId: node.runId,
    })),
  };
}

function normalizeString(value: string | null | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  return value;
}

export class GraphState {
  private readonly nodes = new Map<string, NodeRecord>();
  private edges: EdgeRecord[] = [];
  private readonly adjacency = new Map<string, EdgeRecord[]>();
  private readonly reverseAdjacency = new Map<string, EdgeRecord[]>();
  private readonly directives = new Map<string, AttributeValue>();
  private readonly messageCounters = new Map<string, number>();
  private readonly pendingIndex = new Map<string, PendingSnapshot>();
  private readonly subscriptionIndex = new Map<string, SubscriptionSnapshot>();
  private readonly options = {
    maxTranscriptPerChild: 1000,
    maxEventNodes: 5000
  };

  constructor() {
    this.directives.set("graph", "orchestrator");
  }

  configureRetention(opts: Partial<{ maxTranscriptPerChild: number; maxEventNodes: number }>): void {
    if (typeof opts.maxTranscriptPerChild === "number" && opts.maxTranscriptPerChild > 0) {
      this.options.maxTranscriptPerChild = Math.floor(opts.maxTranscriptPerChild);
    }
    if (typeof opts.maxEventNodes === "number" && opts.maxEventNodes > 0) {
      this.options.maxEventNodes = Math.floor(opts.maxEventNodes);
    }
  }

  createJob(jobId: string, meta: { goal?: string; createdAt: number; state?: string }): void {
    const nodeId = this.jobNodeId(jobId);
    this.nodes.set(nodeId, {
      id: nodeId,
      attributes: {
        type: "job",
        state: normalizeString(meta.state ?? "running"),
        created_at: meta.createdAt,
        goal: normalizeString(meta.goal ?? null)
      }
    });
  }

  patchJob(jobId: string, updates: Partial<{ state: string; goal: string | null }>): void {
    const node = this.nodes.get(this.jobNodeId(jobId));
    if (!node) {
      return;
    }
    const attributes = { ...node.attributes };
    if (updates.state !== undefined) {
      attributes.state = normalizeString(updates.state);
    }
    if (updates.goal !== undefined) {
      attributes.goal = normalizeString(updates.goal);
    }
    this.nodes.set(node.id, { id: node.id, attributes });
  }

  /** Stores the latest ThoughtGraph snapshot associated with a job. */
  setThoughtGraph(jobId: string, snapshot: ThoughtGraphStateSnapshot | null): void {
    const nodeId = this.jobNodeId(jobId);
    const node = this.nodes.get(nodeId);
    if (!node) {
      return;
    }
    const attributes = { ...node.attributes };
    if (!snapshot || snapshot.nodes.length === 0) {
      delete attributes[THOUGHT_GRAPH_ATTRIBUTE_KEY];
      this.nodes.set(nodeId, { id: nodeId, attributes });
      return;
    }
    attributes[THOUGHT_GRAPH_ATTRIBUTE_KEY] = serialiseThoughtGraphState(snapshot);
    this.nodes.set(nodeId, { id: nodeId, attributes });
  }

  /** Returns the persisted ThoughtGraph snapshot for a job, if available. */
  getThoughtGraph(jobId: string): ThoughtGraphStateSnapshot | null {
    const node = this.nodes.get(this.jobNodeId(jobId));
    if (!node) {
      return null;
    }
    const raw = node.attributes[THOUGHT_GRAPH_ATTRIBUTE_KEY];
    if (typeof raw !== "string" || raw.length === 0) {
      return null;
    }
    const parsed = parseThoughtGraphState(raw);
    if (!parsed) {
      return null;
    }
    return cloneThoughtGraphState(parsed);
  }

  getJob(jobId: string): JobSnapshot | undefined {
    const node = this.nodes.get(this.jobNodeId(jobId));
    if (!node) return undefined;
    const childIds = this.getOutgoingEdges(node.id)
      .filter((edge) => edge.attributes.type === "owns")
      .map((edge) => this.extractChildId(edge.to));
    return {
      id: jobId,
      state: normalizeString(String(node.attributes.state ?? "")),
      createdAt: Number(node.attributes.created_at ?? 0),
      goal: toNullableString(node.attributes.goal),
      childIds
    };
  }

  listJobs(): JobSnapshot[] {
    const jobs: JobSnapshot[] = [];
    for (const [id, node] of this.nodes.entries()) {
      if (node.attributes.type === "job") {
        jobs.push(this.getJob(this.extractJobId(id))!);
      }
    }
    return jobs;
  }

  listJobsByState(state: string): JobSnapshot[] {
    return this.listJobs().filter((job) => job.state === state);
  }

  createChild(
    jobId: string,
    childId: string,
    spec: { name: string; system?: string; goals?: string[]; runtime?: string },
    options: { createdAt: number; ttlAt?: number | null }
  ): void {
    const nodeId = this.childNodeId(childId);
    const ttl = options.ttlAt ?? null;
    const attributes: AttributeRecord = {
      type: "child",
      job_id: jobId,
      name: normalizeString(spec.name),
      state: "idle",
      runtime: normalizeString(spec.runtime ?? "codex"),
      waiting_for: "",
      pending_id: "",
      ttl_at: ttl ?? 0,
      system_message: normalizeString(spec.system ?? null),
      created_at: options.createdAt,
      transcript_size: 0,
      last_ts: 0,
      last_heartbeat_at: 0,
      priority: 0,
      pid: 0,
      workdir: "",
      started_at: 0,
      ended_at: 0,
      retries: 0,
      exit_code: 0,
      exit_signal: "",
      forced_termination: false,
      stop_reason: "",
    };
    if (spec.goals?.length) {
      attributes.goals = normalizeString(spec.goals.join("\n"));
    }
    this.nodes.set(nodeId, { id: nodeId, attributes });
    this.messageCounters.set(childId, 0);
    this.addEdge(this.jobNodeId(jobId), nodeId, { type: "owns" });

    if (spec.system) {
      this.appendMessage(childId, {
        role: "system",
        content: spec.system,
        ts: options.createdAt,
        actor: "orchestrator"
      });
    }
    if (spec.goals?.length) {
      const content = `Objectifs:\n- ${spec.goals.join("\n- ")}`;
      this.appendMessage(childId, {
        role: "user",
        content,
        ts: options.createdAt,
        actor: "user"
      });
    }
  }

  patchChild(
    childId: string,
    updates: Partial<{
      state: string;
      waitingFor: string | null;
      pendingId: string | null;
      ttlAt: number | null;
      name: string;
      systemMessage: string | null;
      runtime: string;
      lastTs: number | null;
      lastHeartbeatAt: number | null;
      priority: number | null;
      pid: number | null;
      workdir: string | null;
      startedAt: number | null;
      endedAt: number | null;
      retries: number;
      exitCode: number | null;
      exitSignal: string | number | null;
      forcedTermination: boolean | null;
      stopReason: string | null;
      role: string | null;
      limits: ChildRuntimeLimits | null;
      attachedAt: number | null;
    }>
  ): void {
    const nodeId = this.childNodeId(childId);
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const attributes = { ...node.attributes };
    if (updates.state !== undefined) {
      attributes.state = normalizeString(updates.state);
    }
    if (updates.waitingFor !== undefined) {
      attributes.waiting_for = normalizeString(updates.waitingFor);
    }
    if (updates.pendingId !== undefined) {
      attributes.pending_id = normalizeString(updates.pendingId);
    }
    if (updates.ttlAt !== undefined) {
      attributes.ttl_at = updates.ttlAt ?? 0;
    }
    if (updates.name !== undefined) {
      attributes.name = normalizeString(updates.name);
    }
    if (updates.systemMessage !== undefined) {
      attributes.system_message = normalizeString(updates.systemMessage);
    }
    if (updates.runtime !== undefined) {
      attributes.runtime = normalizeString(updates.runtime);
    }
    if (updates.lastTs !== undefined) {
      attributes.last_ts = updates.lastTs ?? 0;
    }
    if (updates.lastHeartbeatAt !== undefined) {
      attributes.last_heartbeat_at = updates.lastHeartbeatAt ?? 0;
    }
    if (updates.priority !== undefined) {
      if (updates.priority === null) {
        attributes.priority = 0;
      } else {
        const numericPriority = Number(updates.priority);
        attributes.priority = Number.isFinite(numericPriority) ? Math.max(0, Math.floor(numericPriority)) : 0;
      }
    }
    if (updates.pid !== undefined) {
      if (updates.pid === null) {
        attributes.pid = 0;
      } else {
        const numericPid = Number(updates.pid);
        attributes.pid = Number.isFinite(numericPid) && numericPid > 0 ? Math.floor(numericPid) : 0;
      }
    }
    if (updates.workdir !== undefined) {
      attributes.workdir = normalizeString(updates.workdir);
    }
    if (updates.startedAt !== undefined) {
      attributes.started_at = updates.startedAt ?? 0;
    }
    if (updates.endedAt !== undefined) {
      attributes.ended_at = updates.endedAt ?? 0;
    }
    if (updates.retries !== undefined) {
      const numericRetries = Number(updates.retries);
      attributes.retries = Number.isFinite(numericRetries) && numericRetries > 0 ? Math.floor(numericRetries) : 0;
    }
    if (updates.exitCode !== undefined) {
      if (updates.exitCode === null) {
        delete attributes.exit_code;
      } else {
        const numericExit = Number(updates.exitCode);
        if (Number.isFinite(numericExit)) {
          attributes.exit_code = Math.floor(numericExit);
        } else {
          delete attributes.exit_code;
        }
      }
    }
    if (updates.exitSignal !== undefined) {
      const signal = updates.exitSignal;
      attributes.exit_signal =
        typeof signal === "number" ? signal.toString(10) : normalizeString(signal);
    }
    if (updates.forcedTermination !== undefined) {
      attributes.forced_termination = !!updates.forcedTermination;
    }
    if (updates.stopReason !== undefined) {
      attributes.stop_reason = normalizeString(updates.stopReason);
    }
    if (updates.role !== undefined) {
      if (updates.role === null) {
        delete attributes.role;
      } else {
        attributes.role = normalizeString(updates.role);
      }
    }
    if (updates.limits !== undefined) {
      const serialised = serialiseChildLimits(updates.limits);
      if (serialised === undefined) {
        delete attributes.limits_json;
      } else {
        attributes.limits_json = serialised;
      }
    }
    if (updates.attachedAt !== undefined) {
      attributes.attached_at = updates.attachedAt ?? 0;
    }
    this.nodes.set(nodeId, { id: nodeId, attributes });
  }

  /**
   * Synchronises runtime metadata emitted by the supervisor with the graph.
   *
   * The dashboard consumes these enriched fields (PID, workdir, retries…) to
   * contextualise each child. Missing nodes are ignored so the method can be
   * safely invoked even when the graph was not pre-populated (e.g. manual
   * child_create without plan bookkeeping).
   */
  syncChildIndexSnapshot(snapshot: ChildRecordSnapshot): void {
    const nodeId = this.childNodeId(snapshot.childId);
    if (!this.nodes.has(nodeId)) {
      return;
    }

    this.patchChild(snapshot.childId, {
      pid: snapshot.pid,
      workdir: snapshot.workdir,
      startedAt: snapshot.startedAt,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      retries: snapshot.retries,
      endedAt: snapshot.endedAt,
      exitCode: snapshot.exitCode,
      exitSignal: snapshot.exitSignal,
      forcedTermination: snapshot.forcedTermination,
      stopReason: snapshot.stopReason,
      role: snapshot.role,
      limits: snapshot.limits,
      attachedAt: snapshot.attachedAt,
    });
  }

  /**
   * Enregistre un heartbeat provenant d'un enfant. Le timestamp est utilisé
   * par l'autosave et les outils de supervision pour exposer l'activité
   * récente même lorsqu'aucun message n'a été échangé.
   */
  recordChildHeartbeat(childId: string, heartbeatAt?: number): void {
    const nodeId = this.childNodeId(childId);
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const attributes = { ...node.attributes };
    attributes.last_heartbeat_at = heartbeatAt ?? Date.now();
    this.nodes.set(nodeId, { id: nodeId, attributes });
  }

  getChild(childId: string): ChildSnapshot | undefined {
    const node = this.nodes.get(this.childNodeId(childId));
    if (!node) return undefined;
    return this.childFromNode(node);
  }

  listChildren(jobId: string): ChildSnapshot[] {
    const edges = this.getOutgoingEdges(this.jobNodeId(jobId));
    const childIds = edges.filter((edge) => edge.attributes.type === "owns").map((edge) => this.extractChildId(edge.to));
    return childIds
      .map((id) => this.getChild(id))
      .filter((snapshot): snapshot is ChildSnapshot => !!snapshot);
  }

  listChildSnapshots(): ChildSnapshot[] {
    const children: ChildSnapshot[] = [];
    for (const node of this.nodes.values()) {
      if (node.attributes.type === "child") {
        children.push(this.childFromNode(node));
      }
    }
    return children;
  }

  /**
   * Retourne les enfants considérés comme inactifs (aucune activité récente ou pending trop long).
   * Permet d'identifier rapidement les branches du graphe qui nécessitent une intervention humaine.
   */
  findInactiveChildren(options: {
    idleThresholdMs: number;
    pendingThresholdMs?: number;
    now?: number;
    includeChildrenWithoutMessages?: boolean;
  }): ChildInactivityReport[] {
    const now = options.now ?? Date.now();
    const idleThreshold = Math.max(0, options.idleThresholdMs);
    const pendingThreshold = Math.max(0, options.pendingThresholdMs ?? idleThreshold);
    const includeWithoutMessages = options.includeChildrenWithoutMessages ?? true;
    const reports: ChildInactivityReport[] = [];

    for (const child of this.listChildSnapshots()) {
      const flags: ChildInactivityFlag[] = [];
      const heartbeatTs = child.lastHeartbeatAt;
      let lastActivityTs = child.lastTs;
      if (lastActivityTs === null && heartbeatTs !== null) {
        lastActivityTs = heartbeatTs;
      }
      if (lastActivityTs === null && includeWithoutMessages) {
        lastActivityTs = child.createdAt > 0 ? child.createdAt : null;
      }
      let idleMs: number | null = null;
      if (lastActivityTs !== null) {
        idleMs = Math.max(0, now - lastActivityTs);
        if (idleMs >= idleThreshold) {
          flags.push({ type: "idle", valueMs: idleMs, thresholdMs: idleThreshold });
        }
      }

      const pendingSnapshot = child.pendingId ? this.pendingIndex.get(child.pendingId) : undefined;
      const pendingSince = pendingSnapshot?.createdAt ?? null;
      const pendingMs = pendingSince !== null ? Math.max(0, now - pendingSince) : null;
      if (pendingMs !== null && pendingMs >= pendingThreshold) {
        flags.push({ type: "pending", valueMs: pendingMs, thresholdMs: pendingThreshold });
      }

      if (!flags.length) {
        continue;
      }

      const actions = this.suggestActionsForInactivity(child.state, flags);

      reports.push({
        childId: child.id,
        jobId: child.jobId,
        name: child.name,
        state: child.state,
        runtime: child.runtime,
        waitingFor: child.waitingFor,
        pendingId: child.pendingId,
        createdAt: child.createdAt,
        lastActivityTs,
        idleMs,
        pendingSince,
        pendingMs,
        transcriptSize: child.transcriptSize,
        flags,
        suggestedActions: actions
      });
    }

    return reports;
  }

  /**
   * Derives a list of non-destructive actions that the operator can apply to
   * an inactive child. The mapping favours light-touch options first (ping),
   * then recommends cancelling or retrying depending on the reported flags and
   * current runtime state. The result intentionally avoids duplicates to keep
   * JSON responses compact and easy to inspect in dashboards.
   */
  private suggestActionsForInactivity(state: string, flags: ChildInactivityFlag[]): ChildInactivityAction[] {
    const actions = new Set<ChildInactivityAction>();

    for (const flag of flags) {
      if (flag.type === "idle") {
        actions.add("ping");
      }

      if (flag.type === "pending") {
        const lowered = state.toLowerCase();
        if (lowered.includes("error") || lowered.includes("fail")) {
          actions.add("retry");
        } else {
          actions.add("cancel");
        }
      }
    }

    return [...actions];
  }

  /**
   * Collects metrics related to the current in-memory graph. These counters are
   * later surfaced by the dedicated MCP tool.
   */
  collectMetrics(): GraphStateMetrics {
    const jobs = this.listJobs();
    const children = this.listChildSnapshots();
    const subscriptions = this.listSubscriptionSnapshots();
    const messageNodes = this.listNodeRecords().filter((node) => node.attributes.type === "message");
    const eventNodes = this.listNodeRecords().filter((node) => node.attributes.type === "event");

    let pendingChildren = 0;
    for (const child of children) {
      if (child.pendingId) {
        pendingChildren += 1;
      }
    }

    const activeJobs = jobs.filter((job) => job.state === "running").length;
    const completedJobs = jobs.filter((job) => job.state === "completed").length;
    const activeChildren = children.filter((child) => child.state !== "killed" && child.state !== "completed").length;

    return {
      totalJobs: jobs.length,
      activeJobs,
      completedJobs,
      totalChildren: children.length,
      activeChildren,
      pendingChildren,
      eventNodes: eventNodes.length,
      subscriptions: subscriptions.length,
      totalMessages: messageNodes.length
    };
  }

  findJobIdByChild(childId: string): string | undefined {
    const edges = this.getIncomingEdges(this.childNodeId(childId));
    const owningEdge = edges.find((edge) => edge.attributes.type === "owns");
    return owningEdge ? this.extractJobId(owningEdge.from) : undefined;
  }

  appendMessage(childId: string, message: MessageRecord): void {
    const nodeId = this.childNodeId(childId);
    const childNode = this.nodes.get(nodeId);
    if (!childNode) {
      throw new Error(`Child ${childId} not found`);
    }
    const order = this.nextMessageIndex(childId);
    const messageNodeId = this.messageNodeId(childId, order);
    const actor = message.actor ? String(message.actor) : "";
    this.nodes.set(messageNodeId, {
      id: messageNodeId,
      attributes: {
        type: "message",
        order,
        role: message.role,
        content: message.content,
        ts: message.ts,
        actor,
        child_id: childId
      }
    });
    this.addEdge(nodeId, messageNodeId, { type: "message", order });

    const newSize = order + 1;
    const attributes = { ...childNode.attributes, transcript_size: newSize, last_ts: message.ts };
    this.nodes.set(nodeId, { id: nodeId, attributes });

    // Retention: trim earliest messages if exceeding limit
    this.trimChildTranscript(childId);
  }

  getTranscript(childId: string, options: TranscriptSliceOptions = {}): TranscriptSlice {
    const nodeId = this.childNodeId(childId);
    const child = this.nodes.get(nodeId);
    if (!child) {
      return { total: 0, items: [] };
    }
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 1000) : 200;
    const edges = this.getOutgoingEdges(nodeId).filter((edge) => edge.attributes.type === "message");
    edges.sort((a, b) => Number(a.attributes.order ?? 0) - Number(b.attributes.order ?? 0));

    const mapped = edges.map((edge) => {
      const messageNode = this.nodes.get(edge.to);
      if (!messageNode) {
        return null;
      }
      const idx = Number(edge.attributes.order ?? 0);
      const role = String(messageNode.attributes.role ?? "assistant");
      const content = String(messageNode.attributes.content ?? "");
      const ts = Number(messageNode.attributes.ts ?? 0);
      const actorAttr = toNullableString(messageNode.attributes.actor);
      return { idx, role, content, ts, actor: actorAttr } as TranscriptItem;
    });

    let items: TranscriptItem[] = mapped.filter((entry): entry is TranscriptItem => entry !== null);
    if (typeof options.sinceIndex === "number") {
      const start = options.sinceIndex + 1;
      items = items.filter((item) => item.idx >= start);
    } else if (typeof options.sinceTs === "number") {
      items = items.filter((item) => item.ts > options.sinceTs!);
    }

    if (options.reverse) {
      items = items.slice(-limit).reverse();
    } else {
      items = items.slice(0, limit);
    }

    const total = Number(child.attributes.transcript_size ?? items.length);
    return { total, items };
  }

  resetChild(childId: string, opts: { keepSystem: boolean; timestamp: number }): void {
    const nodeId = this.childNodeId(childId);
    const child = this.nodes.get(nodeId);
    if (!child) return;

    const messageEdges = this.getOutgoingEdges(nodeId).filter((edge) => edge.attributes.type === "message");
    for (const edge of messageEdges) {
      this.nodes.delete(edge.to);
    }
    this.removeEdges((edge) => edge.from === nodeId && edge.attributes.type === "message");
    this.messageCounters.set(childId, 0);

    this.clearPendingForChild(childId);
    this.patchChild(childId, {
      state: "idle",
      waitingFor: null,
      pendingId: null,
      lastTs: null
    });
    this.updateChildTranscriptStats(childId, 0, 0);

    if (opts.keepSystem) {
      const systemText = toNullableString(child.attributes.system_message);
      if (systemText) {
        this.appendMessage(childId, {
          role: "system",
          content: systemText,
          ts: opts.timestamp,
          actor: "orchestrator"
        });
      }
    }
  }

  setPending(childId: string, pendingId: string, createdAt: number): void {
    const current = this.getChild(childId);
    if (!current) return;
    if (current.pendingId && current.pendingId !== pendingId) {
      this.clearPending(current.pendingId);
    }
    const nodeId = this.pendingNodeId(pendingId);
    this.nodes.set(nodeId, {
      id: nodeId,
      attributes: { type: "pending", child_id: childId, created_at: createdAt }
    });
    this.pendingIndex.set(pendingId, { childId, createdAt });
    this.addEdge(this.childNodeId(childId), nodeId, { type: "pending" });
    this.patchChild(childId, { pendingId });
  }

  clearPending(pendingId: string): void {
    const snapshot = this.pendingIndex.get(pendingId);
    if (!snapshot) return;
    const nodeId = this.pendingNodeId(pendingId);
    this.pendingIndex.delete(pendingId);
    this.nodes.delete(nodeId);
    this.removeEdges((edge) => edge.to === nodeId || edge.from === nodeId);
    this.patchChild(snapshot.childId, { pendingId: null });
  }

  clearPendingForChild(childId: string): void {
    const child = this.getChild(childId);
    if (child?.pendingId) {
      this.clearPending(child.pendingId);
    }
  }

  getPending(pendingId: string): PendingSnapshot | undefined {
    return this.pendingIndex.get(pendingId);
  }

  createSubscription(snapshot: SubscriptionSnapshot): void {
    const nodeId = this.subscriptionNodeId(snapshot.id);
    this.subscriptionIndex.set(snapshot.id, snapshot);
    this.nodes.set(nodeId, {
      id: nodeId,
      attributes: {
        type: "subscription",
        job_id: normalizeString(snapshot.jobId ?? null),
        child_id: normalizeString(snapshot.childId ?? null),
        last_seq: snapshot.lastSeq,
        created_at: snapshot.createdAt,
        wait_ms: snapshot.waitMs ?? 0
      }
    });
    if (snapshot.jobId) {
      this.addEdge(this.jobNodeId(snapshot.jobId), nodeId, { type: "subscription" });
    }
    if (snapshot.childId) {
      this.addEdge(this.childNodeId(snapshot.childId), nodeId, { type: "subscription" });
    }
  }

  updateSubscription(id: string, updates: Partial<{ lastSeq: number; waitMs: number }>): void {
    const snapshot = this.subscriptionIndex.get(id);
    if (!snapshot) return;
    const merged: SubscriptionSnapshot = { ...snapshot, ...updates };
    this.subscriptionIndex.set(id, merged);
    const nodeId = this.subscriptionNodeId(id);
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const attributes = { ...node.attributes };
    if (updates.lastSeq !== undefined) attributes.last_seq = updates.lastSeq;
    if (updates.waitMs !== undefined) attributes.wait_ms = updates.waitMs;
    this.nodes.set(nodeId, { id: nodeId, attributes });
  }

  deleteSubscription(id: string): void {
    const snapshot = this.subscriptionIndex.get(id);
    if (!snapshot) return;
    this.subscriptionIndex.delete(id);
    const nodeId = this.subscriptionNodeId(id);
    this.nodes.delete(nodeId);
    this.removeEdges((edge) => edge.to === nodeId || edge.from === nodeId);
  }

  recordEvent(event: EventSnapshot): void {
    const nodeId = this.eventNodeId(event.seq);
    this.nodes.set(nodeId, {
      id: nodeId,
      attributes: {
        type: "event",
        seq: event.seq,
        ts: event.ts,
        kind: event.kind,
        level: event.level,
        job_id: normalizeString(event.jobId ?? null),
        child_id: normalizeString(event.childId ?? null),
        provenance: event.provenance ? JSON.stringify(event.provenance) : "[]",
      }
    });
    if (event.jobId) {
      this.addEdge(this.jobNodeId(event.jobId), nodeId, { type: "event" });
    }
    if (event.childId) {
      this.addEdge(this.childNodeId(event.childId), nodeId, { type: "event" });
      if (event.kind === "HEARTBEAT") {
        this.recordChildHeartbeat(event.childId, event.ts);
      }
    }

    // Retention for events
    const events = Array.from(this.nodes.values()).filter((n) => n.attributes.type === "event");
    if (events.length > this.options.maxEventNodes) {
      const excess = events.length - this.options.maxEventNodes;
      const sorted = events
        .map((n) => ({ id: n.id, seq: Number(n.attributes.seq ?? 0) }))
        .sort((a, b) => a.seq - b.seq)
        .slice(0, excess);
      for (const ev of sorted) {
        this.nodes.delete(ev.id);
        this.removeEdges((e) => e.from === ev.id || e.to === ev.id);
      }
    }
  }

  serialize(): { nodes: NodeRecord[]; edges: EdgeRecord[]; directives: Record<string, AttributeValue> } {
    const nodes = Array.from(this.nodes.values(), (node) => ({ id: node.id, attributes: { ...node.attributes } }));
    const edges = this.edges.map((edge) => ({ from: edge.from, to: edge.to, attributes: { ...edge.attributes } }));
    const directives: Record<string, AttributeValue> = {};
    for (const [k, v] of this.directives) directives[k] = v;
    return { nodes, edges, directives };
  }

  resetFromSnapshot(snapshot: { nodes: NodeRecord[]; edges: EdgeRecord[]; directives: Record<string, AttributeValue> }): void {
    this.nodes.clear();
    this.edges = [];
    this.adjacency.clear();
    this.reverseAdjacency.clear();
    this.directives.clear();
    this.messageCounters.clear();
    this.pendingIndex.clear();
    this.subscriptionIndex.clear();

    for (const [k, v] of Object.entries(snapshot.directives ?? {})) this.directives.set(k, v as AttributeValue);
    for (const node of snapshot.nodes ?? []) this.nodes.set(node.id, { id: node.id, attributes: { ...node.attributes } });
    for (const edge of snapshot.edges ?? []) this.addEdge(edge.from, edge.to, { ...edge.attributes });

    const childIds = new Set<string>();
    for (const node of this.nodes.values()) {
      if (node.attributes.type === "child") childIds.add(this.extractChildId(node.id));
      if (node.attributes.type === "pending") {
        const childId = String(node.attributes.child_id ?? "");
        const createdAt = Number(node.attributes.created_at ?? Date.now());
        const pid = this.extractPendingId(node.id);
        this.pendingIndex.set(pid, { childId, createdAt });
      }
      if (node.attributes.type === "subscription") {
        const id = this.extractSubscriptionId(node.id);
        this.subscriptionIndex.set(id, {
          id,
          jobId: node.attributes.job_id ? String(node.attributes.job_id) : undefined,
          childId: node.attributes.child_id ? String(node.attributes.child_id) : undefined,
          lastSeq: Number(node.attributes.last_seq ?? 0),
          createdAt: Number(node.attributes.created_at ?? Date.now()),
          waitMs: Number(node.attributes.wait_ms ?? 0)
        });
      }
    }
    for (const childId of childIds) {
      const edges = this.getOutgoingEdges(this.childNodeId(childId)).filter((e) => e.attributes.type === "message");
      const maxOrder = edges.reduce((m, e) => Math.max(m, Number(e.attributes.order ?? 0)), -1);
      this.messageCounters.set(childId, maxOrder + 1);
    }
  }

  // --- Query helpers ---
  getNodeRecord(id: string): NodeRecord | undefined {
    const n = this.nodes.get(id);
    if (!n) return undefined;
    return { id: n.id, attributes: { ...n.attributes } };
  }

  listNodeRecords(): NodeRecord[] {
    return Array.from(this.nodes.values(), (n) => ({ id: n.id, attributes: { ...n.attributes } }));
  }

  listEdgeRecords(): EdgeRecord[] {
    return this.edges.map((e) => ({ from: e.from, to: e.to, attributes: { ...e.attributes } }));
  }

  listSubscriptionSnapshots(): SubscriptionSnapshot[] {
    return Array.from(this.subscriptionIndex.values()).map((snapshot) => ({ ...snapshot }));
  }

  neighbors(nodeId: string, direction: "out" | "in" | "both" = "both", edgeType?: string): { nodes: NodeRecord[]; edges: EdgeRecord[] } {
    const outEdges = direction === "in" ? [] : this.getOutgoingEdges(nodeId);
    const inEdges = direction === "out" ? [] : this.getIncomingEdges(nodeId);
    let edges = [...outEdges, ...inEdges];
    if (edgeType) edges = edges.filter((e) => String(e.attributes.type ?? "") === edgeType);
    const nodeIds = new Set<string>();
    for (const e of edges) {
      if (e.from !== nodeId) nodeIds.add(e.from);
      if (e.to !== nodeId) nodeIds.add(e.to);
    }
    const nodes: NodeRecord[] = [];
    for (const id of nodeIds) {
      const n = this.nodes.get(id);
      if (n) nodes.push({ id: n.id, attributes: { ...n.attributes } });
    }
    const edgeCopies = edges.map((e) => ({ from: e.from, to: e.to, attributes: { ...e.attributes } }));
    return { nodes, edges: edgeCopies };
  }

  filterNodes(where: Record<string, AttributeValue | string | number | boolean>, limit?: number): NodeRecord[] {
    const results: NodeRecord[] = [];
    for (const n of this.nodes.values()) {
      if (this.matches(n.attributes, where)) {
        results.push({ id: n.id, attributes: { ...n.attributes } });
        if (limit && results.length >= limit) break;
      }
    }
    return results;
  }

  filterEdges(where: Record<string, AttributeValue | string | number | boolean>, limit?: number): EdgeRecord[] {
    const results: EdgeRecord[] = [];
    for (const e of this.edges) {
      if (this.matches(e.attributes, where)) {
        results.push({ from: e.from, to: e.to, attributes: { ...e.attributes } });
        if (limit && results.length >= limit) break;
      }
    }
    return results;
  }

  private updateChildTranscriptStats(childId: string, size: number, lastTs: number): void {
    const nodeId = this.childNodeId(childId);
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const attributes = { ...node.attributes, transcript_size: size, last_ts: lastTs };
    this.nodes.set(nodeId, { id: nodeId, attributes });
  }

  private nextMessageIndex(childId: string): number {
    const current = this.messageCounters.get(childId) ?? 0;
    this.messageCounters.set(childId, current + 1);
    return current;
  }

  private addEdge(from: string, to: string, attributes: AttributeRecord): void {
    const edge: EdgeRecord = { from, to, attributes };
    this.edges.push(edge);
    this.indexEdge(edge);
  }

  private indexEdge(edge: EdgeRecord): void {
    if (!this.adjacency.has(edge.from)) {
      this.adjacency.set(edge.from, []);
    }
    if (!this.reverseAdjacency.has(edge.to)) {
      this.reverseAdjacency.set(edge.to, []);
    }
    this.adjacency.get(edge.from)!.push(edge);
    this.reverseAdjacency.get(edge.to)!.push(edge);
  }

  private removeEdges(predicate: (edge: EdgeRecord) => boolean): void {
    let removed = false;
    const kept: EdgeRecord[] = [];
    for (const edge of this.edges) {
      if (predicate(edge)) {
        removed = true;
      } else {
        kept.push(edge);
      }
    }
    if (!removed) return;
    this.edges = kept;
    this.adjacency.clear();
    this.reverseAdjacency.clear();
    for (const edge of this.edges) {
      this.indexEdge(edge);
    }
  }

  private getOutgoingEdges(id: string): EdgeRecord[] {
    return this.adjacency.get(id) ?? [];
  }

  private getIncomingEdges(id: string): EdgeRecord[] {
    return this.reverseAdjacency.get(id) ?? [];
  }

  private jobNodeId(jobId: string): string {
    return `job:${jobId}`;
  }

  private childNodeId(childId: string): string {
    return `child:${childId}`;
  }

  private messageNodeId(childId: string, order: number): string {
    return `message:${childId}:${order}`;
  }

  private pendingNodeId(pendingId: string): string {
    return `pending:${pendingId}`;
  }

  private subscriptionNodeId(id: string): string {
    return `subscription:${id}`;
  }

  private eventNodeId(seq: number): string {
    return `event:${seq}`;
  }

  private trimChildTranscript(childId: string): void {
    const nodeId = this.childNodeId(childId);
    const edges = this.getOutgoingEdges(nodeId).filter((e) => e.attributes.type === "message");
    const max = this.options.maxTranscriptPerChild;
    if (edges.length <= max) return;
    const toRemove = edges
      .map((e) => ({ edge: e, order: Number(e.attributes.order ?? 0) }))
      .sort((a, b) => a.order - b.order)
      .slice(0, edges.length - max);
    for (const item of toRemove) {
      const msgNodeId = item.edge.to;
      this.nodes.delete(msgNodeId);
      this.removeEdges((e) => e.to === msgNodeId || e.from === msgNodeId);
    }
    const childNode = this.nodes.get(nodeId);
    if (childNode) {
      const remaining = this.getOutgoingEdges(nodeId).filter((e) => e.attributes.type === "message");
      this.nodes.set(nodeId, {
        id: nodeId,
        attributes: { ...childNode.attributes, transcript_size: remaining.length }
      });
    }
  }

  private extractChildId(nodeId: string): string {
    return nodeId.replace(/^child:/, "");
  }

  private extractJobId(nodeId: string): string {
    return nodeId.replace(/^job:/, "");
  }

  private extractPendingId(nodeId: string): string {
    return nodeId.replace(/^pending:/, "");
  }

  private extractSubscriptionId(nodeId: string): string {
    return nodeId.replace(/^subscription:/, "");
  }
  private matches(attrs: AttributeRecord, where: Record<string, AttributeValue | string | number | boolean>): boolean {
    for (const [k, v] of Object.entries(where)) {
      const a = attrs[k as keyof AttributeRecord];
      if (typeof v === "number") {
        if (Number(a) !== v) return false;
      } else if (typeof v === "boolean") {
        if (Boolean(a) !== v) return false;
      } else {
        if (String(a) !== String(v)) return false;
      }
    }
    return true;
  }

  // Public prune helpers
  pruneChildTranscript(childId: string, keepLast: number): void {
    if (keepLast < 0) return;
    const nodeId = this.childNodeId(childId);
    const edges = this.getOutgoingEdges(nodeId).filter((e) => e.attributes.type === "message");
    const sorted = edges
      .map((e) => ({ edge: e, order: Number(e.attributes.order ?? 0) }))
      .sort((a, b) => a.order - b.order);
    const removeCount = Math.max(0, sorted.length - keepLast);
    const toRemove = sorted.slice(0, removeCount);
    for (const item of toRemove) {
      const msgNodeId = item.edge.to;
      this.nodes.delete(msgNodeId);
      this.removeEdges((e) => e.to === msgNodeId || e.from === msgNodeId);
    }
    const remaining = this.getOutgoingEdges(nodeId).filter((e) => e.attributes.type === "message");
    const lastTs = remaining
      .map((e) => this.nodes.get(e.to))
      .filter((n): n is NodeRecord => !!n)
      .reduce((m, n) => Math.max(m, Number(n.attributes.ts ?? 0)), 0);
    this.updateChildTranscriptStats(childId, remaining.length, lastTs);
  }

  pruneEvents(maxEvents: number, jobId?: string, childId?: string): void {
    if (maxEvents <= 0) return;
    const events = Array.from(this.nodes.values()).filter((n) => n.attributes.type === "event");
    const filtered = events.filter((n) => {
      const matchJob = jobId ? String(n.attributes.job_id ?? "") === jobId : true;
      const matchChild = childId ? String(n.attributes.child_id ?? "") === childId : true;
      return matchJob && matchChild;
    });
    if (filtered.length <= maxEvents) return;
    const excess = filtered.length - maxEvents;
    const sorted = filtered
      .map((n) => ({ id: n.id, seq: Number(n.attributes.seq ?? 0) }))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, excess);
    for (const ev of sorted) {
      this.nodes.delete(ev.id);
      this.removeEdges((e) => e.from === ev.id || e.to === ev.id);
    }
  }

  private childFromNode(node: NodeRecord): ChildSnapshot {
    const id = this.extractChildId(node.id);
    const jobId = normalizeString(String(node.attributes.job_id ?? ""));
    const waitingFor = toNullableString(node.attributes.waiting_for);
    const pendingId = toNullableString(node.attributes.pending_id);
    const ttlAt = toNullableNumber(node.attributes.ttl_at);
    const systemMessage = toNullableString(node.attributes.system_message);
    const createdAt = Number(node.attributes.created_at ?? 0);
    const transcriptSize = Number(node.attributes.transcript_size ?? 0);
    const lastTs = toNullableNumber(node.attributes.last_ts);
    const lastHeartbeatAt = toNullableNumber(node.attributes.last_heartbeat_at);
    const priority = toNullableNumber(node.attributes.priority);
    const pid = toNullableNumber(node.attributes.pid);
    const workdir = toNullableString(node.attributes.workdir);
    const startedAt = toNullableNumber(node.attributes.started_at);
    const endedAt = toNullableNumber(node.attributes.ended_at);
    const retries = Number(node.attributes.retries ?? 0);
    let exitCode: number | null = null;
    if (node.attributes.exit_code !== undefined) {
      const numericExit = Number(node.attributes.exit_code);
      exitCode = Number.isFinite(numericExit) ? Math.floor(numericExit) : null;
    }
    const exitSignal = toNullableString(node.attributes.exit_signal);
    const forcedTermination = node.attributes.forced_termination === true;
    const stopReason = toNullableString(node.attributes.stop_reason);
    const role = toNullableString(node.attributes.role);
    const limits = parseChildLimits(node.attributes.limits_json);
    const attachedAt = toNullableNumber(node.attributes.attached_at);
    return {
      id,
      jobId,
      name: normalizeString(String(node.attributes.name ?? id)),
      state: normalizeString(String(node.attributes.state ?? "idle")),
      runtime: normalizeString(String(node.attributes.runtime ?? "codex")),
      waitingFor,
      pendingId,
      ttlAt,
      systemMessage,
      createdAt,
      transcriptSize,
      lastTs,
      lastHeartbeatAt,
      priority,
      pid,
      workdir,
      startedAt,
      endedAt,
      retries: Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0,
      exitCode,
      exitSignal,
      forcedTermination,
      stopReason,
      role,
      limits,
      attachedAt,
    };
  }
}






