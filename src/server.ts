import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "url";
import { GraphState } from "./graphState.js";
import { StructuredLogger } from "./logger.js";
import { EventStore, OrchestratorEvent } from "./eventStore.js";
import { startHttpServer } from "./httpServer.js";
import { MessageRecord, Role } from "./types.js";
import { parseOrchestratorRuntimeOptions } from "./serverOptions.js";

/*
v1.3 - Orchestrateur MCP self-fork avec:
- Streaming par subscriptions/poll (wait_ms)
- Partiels de reponse (child_push_partial)
- Consultation live par enfant (child_info, child_transcript)
- Chat multi-tour orchestrateur <-> enfant (child_chat)
Toutes les reponses tools renvoient du texte JSON: { type: "text", text: JSON.stringify(...) }
*/

// ---------------------------
// Types de domaine
// ---------------------------

interface SpawnChildSpec {
  name: string;
  system?: string;
  goals?: string[];
  runtime?: string;
}

// ---------------------------
// Stores en memoire
// ---------------------------

const graphState = new GraphState();
let logger = new StructuredLogger();
const eventStore = new EventStore({ maxHistory: 5000, logger });
let lastInactivityThresholdMs = 120_000;

let DEFAULT_CHILD_RUNTIME = "codex";

function setDefaultChildRuntime(runtime: string) {
  DEFAULT_CHILD_RUNTIME = runtime.trim() || "codex";
}

interface Subscription {
  id: string;
  jobId?: string;
  childId?: string;
  lastSeq: number;
  createdAt: number;
}
const SUBS = new Map<string, Subscription>();

// ---------------------------
// Utils
// ---------------------------

const now = () => Date.now();
const j = (o: unknown) => JSON.stringify(o, null, 2);

function pushEvent(
  event: Omit<OrchestratorEvent, "seq" | "ts" | "source" | "level"> &
    Partial<Pick<OrchestratorEvent, "source" | "level">>
): OrchestratorEvent {
  const emitted = eventStore.emit({
    kind: event.kind,
    level: event.level,
    source: event.source,
    jobId: event.jobId,
    childId: event.childId,
    payload: event.payload
  });
  graphState.recordEvent({
    seq: emitted.seq,
    ts: emitted.ts,
    kind: emitted.kind,
    level: emitted.level,
    jobId: emitted.jobId,
    childId: emitted.childId
  });
  return emitted;
}

function listEventsSince(lastSeq: number, jobId?: string, childId?: string): OrchestratorEvent[] {
  return eventStore.list({ minSeq: lastSeq, jobId, childId });
}

function buildLiveEvents(input: { job_id?: string; child_id?: string; limit?: number; order?: "asc" | "desc"; min_seq?: number }) {
  const base = eventStore.list({ jobId: input.job_id, childId: input.child_id });
  const filtered = base.filter((evt) =>
    typeof input.min_seq === "number" ? evt.seq >= input.min_seq : true
  );
  const ordered = [...filtered].sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq));
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 500) : 100;
  return ordered.slice(0, limit).map((evt) => {
    const deepLink = evt.childId ? `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(evt.childId)}` : null;
    const commandUri = evt.childId
      ? `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: evt.childId }))}`
      : null;
    return { ...evt, vscode_deeplink: deepLink, vscode_command: commandUri };
  });
}

// Heartbeat
let HEARTBEAT_TIMER: NodeJS.Timeout | null = null;
function startHeartbeat() {
  if (HEARTBEAT_TIMER) return;
  HEARTBEAT_TIMER = setInterval(() => {
    for (const job of graphState.listJobsByState("running")) {
      pushEvent({ kind: "HEARTBEAT", jobId: job.id, payload: { msg: "alive" } });
    }
  }, 2000);
}

// ---------------------------
// Orchestrateur (jobs/enfants)
// ---------------------------


function createJob(goal?: string): string {
  const jobId = `job_${randomUUID()}`;
  graphState.createJob(jobId, { goal, createdAt: now(), state: "running" });
  return jobId;
}

function createChild(jobId: string, spec: SpawnChildSpec, ttl_s?: number): string {
  const childId = `child_${randomUUID()}`;
  const createdAt = now();
  const ttlAt = ttl_s ? createdAt + ttl_s * 1000 : null;
  const normalizedSpec: SpawnChildSpec = { ...spec, runtime: spec.runtime ?? DEFAULT_CHILD_RUNTIME };
  graphState.createChild(jobId, childId, normalizedSpec, { createdAt, ttlAt });
  return childId;
}

function findJobIdByChild(childId: string): string | undefined {
  return graphState.findJobIdByChild(childId);
}

function pruneExpired() {
  const t = now();
  for (const child of graphState.listChildSnapshots()) {
    if (child.ttlAt && t > child.ttlAt && child.state !== "killed") {
      graphState.clearPendingForChild(child.id);
      graphState.patchChild(child.id, { state: "killed", waitingFor: null, pendingId: null, ttlAt: null });
      const jobId = child.jobId ?? findJobIdByChild(child.id);
      pushEvent({ kind: "KILL", jobId, childId: child.id, level: "warn", payload: { reason: "ttl" } });
    }
  }
}

// ---------------------------
// Aggregation
// ---------------------------

function aggregateConcat(jobId: string, opts?: { includeSystem?: boolean; includeGoals?: boolean }) {
  const job = graphState.getJob(jobId);
  if (!job) {
    throw new Error(`Unknown job '${jobId}'`);
  }
  const transcripts = job.childIds.map((cid) => {
    const child = graphState.getChild(cid);
    const slice = graphState.getTranscript(cid, { limit: 1000 });
    const items = slice.items.filter((m) => {
      if (m.role === "system" && opts?.includeSystem === false) return false;
      if (m.role === "user" && child?.name && m.content.startsWith("Objectifs:") && opts?.includeGoals === false) return false;
      return true;
    });
    return {
      child_id: cid,
      name: child?.name ?? cid,
      transcript: items.map((m) => ({
        idx: m.idx,
        role: m.role as Role,
        content: m.content,
        ts: m.ts,
        actor: m.actor
      }))
    };
  });
  const summary = transcripts
    .map((t) => `# ${t.name}\n` + t.transcript.map((m) => `- [${m.role}] ${m.content}`).join("\n"))
    .join("\n\n");



  return { summary, transcripts, artifacts: [] as any[] };
}

function aggregateCompact(jobId: string, opts?: { includeSystem?: boolean; includeGoals?: boolean }) {
  const base = aggregateConcat(jobId, opts);
  const compactLines: string[] = [];
  for (const t of base.transcripts) {
    compactLines.push(`# ${t.name}`);
    const merged: { role: string; content: string }[] = [];
    for (const m of t.transcript) {
      if (m.role === "assistant") {
        const prev = merged[merged.length - 1];
        if (prev && prev.role === "assistant") {
          prev.content = `${prev.content} ${m.content}`.replace(/\s+/g, " ").trim();
        } else {
          merged.push({ role: m.role, content: m.content });
        }
      } else {
        merged.push({ role: m.role, content: m.content });
      }
    }
    for (const m of merged) compactLines.push(`- [${m.role}] ${m.content}`);
    compactLines.push("");
  }
  const summary = compactLines.join("\n").trim();
  return { summary, transcripts: base.transcripts, artifacts: [] as any[] };
}

function aggregateJsonl(jobId: string) {
  const job = graphState.getJob(jobId);
  if (!job) throw new Error(`Unknown job '${jobId}'`);
  const lines: string[] = [];
  for (const cid of job.childIds) {
    const child = graphState.getChild(cid);
    const slice = graphState.getTranscript(cid, { limit: 5000 });
    for (const m of slice.items) {
      lines.push(JSON.stringify({ child_id: cid, child_name: child?.name ?? cid, idx: m.idx, role: m.role, content: m.content, ts: m.ts, actor: m.actor ?? null }));
    }
  }
  const summary = `jsonl_count=${lines.length}`;
  return { summary, transcripts: [], artifacts: lines };
}

function aggregate(jobId: string, strategy?: "concat" | "json_merge" | "vote" | "markdown_compact" | "jsonl", opts?: { includeSystem?: boolean; includeGoals?: boolean }) {
  switch (strategy) {
    case "markdown_compact":
      return aggregateCompact(jobId, opts);
    case "jsonl":
      return aggregateJsonl(jobId);
    case "json_merge":
    case "vote":
      return aggregateConcat(jobId, opts);
    case "concat":
    default:
      return aggregateConcat(jobId, opts);
  }
}

// ---------------------------
// Zod shapes et types
// ---------------------------

const ChildSpecShape = {
  name: z.string(),
  system: z.string().optional(),
  goals: z.array(z.string()).optional(),
  runtime: z.string().optional()
} as const;

const PlanFanoutShape = {
  goal: z.string().optional(),
  children: z.array(z.object(ChildSpecShape)).optional(),
  ttl_s: z.number().optional(),
  max_children: z.number().optional()
} as const;
const PlanFanoutSchema = z.object(PlanFanoutShape);
type PlanFanoutInput = z.infer<typeof PlanFanoutSchema>;

const StartShape = {
  job_id: z.string(),
  children: z.array(z.object(ChildSpecShape)).optional()
} as const;
const StartSchema = z.object(StartShape);
type StartInput = z.infer<typeof StartSchema>;

const ChildPromptShape = {
  child_id: z.string(),
  messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
} as const;
const ChildPromptSchema = z.object(ChildPromptShape);
type ChildPromptInput = z.infer<typeof ChildPromptSchema>;

const ChildPushReplyShape = { pending_id: z.string(), content: z.string() } as const;
const ChildPushReplySchema = z.object(ChildPushReplyShape);
type ChildPushReplyInput = z.infer<typeof ChildPushReplySchema>;

const ChildPushPartialShape = { pending_id: z.string(), delta: z.string(), done: z.boolean().optional() } as const;
const ChildPushPartialSchema = z.object(ChildPushPartialShape);
type ChildPushPartialInput = z.infer<typeof ChildPushPartialSchema>;

const StatusShape = { job_id: z.string().optional() } as const;
const StatusSchema = z.object(StatusShape);
type StatusInput = z.infer<typeof StatusSchema>;

const AggregateShape = {
  job_id: z.string(),
  // Accept any string to allow client wrappers with custom strategies; server falls back gracefully.
  strategy: z.string().optional(),
  include_system: z.boolean().optional(),
  include_goals: z.boolean().optional()
} as const;
const AggregateSchema = z.object(AggregateShape);
type AggregateInput = z.infer<typeof AggregateSchema>;

const KillShape = { child_id: z.string().optional(), job_id: z.string().optional() } as const;
const KillSchema = z.object(KillShape);
type KillInput = z.infer<typeof KillSchema>;

const ChildInfoShape = { child_id: z.string() } as const;
const ChildInfoSchema = z.object(ChildInfoShape);
type ChildInfoInput = z.infer<typeof ChildInfoSchema>;

const ChildTranscriptShape = {
  child_id: z.string(),
  since_index: z.number().int().min(0).optional(),
  since_ts: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  reverse: z.boolean().optional()
} as const;
const ChildTranscriptSchema = z.object(ChildTranscriptShape);
type ChildTranscriptInput = z.infer<typeof ChildTranscriptSchema>;

const ChildChatShape = {
  child_id: z.string(),
  content: z.string(),
  role: z.enum(["user", "system"]).optional()
} as const;
const ChildChatSchema = z.object(ChildChatShape);
type ChildChatInput = z.infer<typeof ChildChatSchema>;

const ChildRenameShape = { child_id: z.string(), name: z.string().min(1) } as const;
const ChildRenameSchema = z.object(ChildRenameShape);
type ChildRenameInput = z.infer<typeof ChildRenameSchema>;

const ChildResetShape = { child_id: z.string(), keep_system: z.boolean().optional() } as const;
const ChildResetSchema = z.object(ChildResetShape);
type ChildResetInput = z.infer<typeof ChildResetSchema>;

const GraphForgeAnalysisShape = {
  name: z.string().min(1),
  args: z.array(z.string()).optional(),
  weight_key: z.string().optional()
} as const;
const GraphForgeAnalysisSchema = z.object(GraphForgeAnalysisShape);
type GraphForgeAnalysisInput = z.infer<typeof GraphForgeAnalysisSchema>;

const GraphForgeShape = {
  source: z.string().optional(),
  path: z.string().optional(),
  entry_graph: z.string().optional(),
  weight_key: z.string().optional(),
  use_defined_analyses: z.boolean().optional(),
  analyses: z.array(GraphForgeAnalysisSchema).optional()
} as const;
const GraphForgeSchemaBase = z.object(GraphForgeShape);
const GraphForgeSchema = GraphForgeSchemaBase.refine(
  (input) => Boolean(input.source) || Boolean(input.path),
  { message: "Provide 'source' or 'path'", path: ["source"] }
);
type GraphForgeInput = z.infer<typeof GraphForgeSchema>;

const SubscribeShape = { job_id: z.string().optional(), child_id: z.string().optional(), last_seq: z.number().optional() } as const;
const SubscribeSchema = z.object(SubscribeShape);
type SubscribeInput = z.infer<typeof SubscribeSchema>;

const PollShape = {
  subscription_id: z.string(),
  since_seq: z.number().optional(),
  max_events: z.number().optional(),
  wait_ms: z.number().optional(),
  suppress: z.array(z.enum([
    "PLAN",
    "START",
    "PROMPT",
    "PENDING",
    "REPLY_PART",
    "REPLY",
    "STATUS",
    "AGGREGATE",
    "KILL",
    "HEARTBEAT",
    "INFO",
    "WARN",
    "ERROR"
  ])).optional()
} as const;
const PollSchema = z.object(PollShape);
type PollInput = z.infer<typeof PollSchema>;

const UnsubscribeShape = { subscription_id: z.string() } as const;
const UnsubscribeSchema = z.object(UnsubscribeShape);
type UnsubscribeInput = z.infer<typeof UnsubscribeSchema>;

// Graph export/save/load
const GraphExportShape = { format: z.enum(["json"]).optional() } as const;
const GraphExportSchema = z.object(GraphExportShape);
type GraphExportInput = z.infer<typeof GraphExportSchema>;

const GraphSaveShape = { path: z.string() } as const;
const GraphSaveSchema = z.object(GraphSaveShape);
type GraphSaveInput = z.infer<typeof GraphSaveSchema>;

const GraphLoadShape = { path: z.string() } as const;
const GraphLoadSchema = z.object(GraphLoadShape);
type GraphLoadInput = z.infer<typeof GraphLoadSchema>;

const GraphRuntimeShape = { runtime: z.string().optional(), reset: z.boolean().optional() } as const;
const GraphRuntimeSchema = z.object(GraphRuntimeShape);
type GraphRuntimeInput = z.infer<typeof GraphRuntimeSchema>;

const GraphStatsShape = {} as const;
const GraphStatsSchema = z.object(GraphStatsShape);
type GraphStatsInput = z.infer<typeof GraphStatsSchema>;

const GraphInactivityShape = {
  idle_threshold_ms: z.number().min(0).optional(),
  pending_threshold_ms: z.number().min(0).optional(),
  inactivity_threshold_sec: z.number().min(0).optional(),
  inactivityThresholdSec: z.number().min(0).optional(),
  job_id: z.string().optional(),
  runtime: z.string().optional(),
  state: z.string().optional(),
  include_children_without_messages: z.boolean().optional(),
  limit: z.number().optional(),
  format: z.enum(["json", "text"]).optional()
} as const;
const GraphInactivitySchema = z.object(GraphInactivityShape);
type GraphInactivityInput = z.infer<typeof GraphInactivitySchema>;

// job_view
const JobViewShape = { job_id: z.string(), per_child_limit: z.number().optional(), format: z.enum(["json", "text"]).optional(), include_system: z.boolean().optional() } as const;
const JobViewSchema = z.object(JobViewShape);
type JobViewInput = z.infer<typeof JobViewSchema>;

const EventsViewLiveShape = {
  job_id: z.string().optional(),
  child_id: z.string().optional(),
  limit: z.number().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  min_seq: z.number().optional()
} as const;
const EventsViewLiveSchema = z.object(EventsViewLiveShape);
type EventsViewLiveInput = z.infer<typeof EventsViewLiveSchema>;

const GraphPruneShape = {
  action: z.enum(["transcript", "events"]),
  child_id: z.string().optional(),
  keep_last: z.number().optional(),
  job_id: z.string().optional(),
  max_events: z.number().optional()
} as const;
const GraphPruneSchema = z.object(GraphPruneShape);
type GraphPruneInput = z.infer<typeof GraphPruneSchema>;

// ---------------------------
// Serveur MCP + Tools
// ---------------------------

interface GraphForgeGraph {
  name: string;
  directives: Map<string, unknown>;
  listNodes(): { id: string; attributes: Record<string, unknown> }[];
  listEdges(): { from: string; to: string; attributes: Record<string, unknown> }[];
  getNode(id: string): { id: string; attributes: Record<string, unknown> } | undefined;
  getOutgoing(id: string): { from: string; to: string; attributes: Record<string, unknown> }[];
  getDirective?(name: string): unknown;
}

interface GraphForgeCompiledAnalysisArg {
  value: unknown;
  tokenLine: number;
  tokenColumn: number;
}

interface GraphForgeCompiledAnalysis {
  name: string;
  tokenLine: number;
  tokenColumn: number;
  args: GraphForgeCompiledAnalysisArg[];
}

interface GraphForgeCompiled {
  graph: GraphForgeGraph;
  analyses: GraphForgeCompiledAnalysis[];
}

interface GraphForgeModule {
  compileSource(source: string, options?: { entryGraph?: string }): GraphForgeCompiled;
  shortestPath(graph: GraphForgeGraph, start: string, goal: string, options?: { weightAttribute?: string }): unknown;
  criticalPath(graph: GraphForgeGraph, options?: { weightAttribute?: string }): unknown;
  tarjanScc(graph: GraphForgeGraph): unknown;
}

type GraphForgeTaskSource = "dsl" | "request";

interface GraphForgeTask {
  name: string;
  args: string[];
  weightKey?: string;
  source: GraphForgeTaskSource;
}

let graphForgeModulePromise: Promise<GraphForgeModule> | null = null;

async function loadGraphForge(): Promise<GraphForgeModule> {
  if (!graphForgeModulePromise) {
    graphForgeModulePromise = (async () => {
      const distUrl = new URL("../graph-forge/dist/index.js", import.meta.url);
      try {
        return (await import(distUrl.href)) as GraphForgeModule;
      } catch (distError) {
        const srcUrl = new URL("../graph-forge/src/index.ts", import.meta.url);
        try {
          return (await import(srcUrl.href)) as GraphForgeModule;
        } catch {
          throw distError;
        }
      }
    })();
  }
  return graphForgeModulePromise;
}

function describeError(err: unknown) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "UnknownError", message: String(err) };
}

function toStringArg(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function runGraphForgeAnalysis(
  mod: GraphForgeModule,
  compiled: GraphForgeCompiled,
  task: GraphForgeTask,
  defaultWeightKey?: string
): unknown {
  const weightAttribute = task.weightKey ?? defaultWeightKey;
  switch (task.name) {
    case "shortestPath": {
      if (task.args.length < 2) {
        throw new Error("shortestPath requires <start> and <goal>");
      }
      const [start, goal] = task.args;
      return mod.shortestPath(compiled.graph, start, goal, { weightAttribute });
    }
    case "criticalPath":
      return mod.criticalPath(compiled.graph, { weightAttribute });
    case "stronglyConnected": {
      if (task.args.length) {
        throw new Error("stronglyConnected does not accept arguments");
      }
      return mod.tarjanScc(compiled.graph);
    }
    default:
      throw new Error(`Unknown analysis '${task.name}'`);
  }
}

const server = new McpServer({ name: "mcp-self-fork-orchestrator", version: "1.3.0" });

// job_view (apercu d'un job avec previsualisation transcript + liens VS Code)
server.registerTool(
  "job_view",
  { title: "Job view", description: "Vue d'ensemble d'un job avec un extrait par enfant.", inputSchema: JobViewShape },
  async (input: JobViewInput) => {
    const job = graphState.getJob(input.job_id);
    if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };
    const perChild = Math.max(1, Math.min(input.per_child_limit ?? 20, 200));
    const includeSystem = input.include_system ?? true;
    const children = graphState.listChildren(job.id).map((child) => {
      const slice = graphState.getTranscript(child.id, { limit: perChild });
      const items = slice.items.filter((m) => (m.role === "system" ? includeSystem : true));
      const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(child.id)}`;
      const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: child.id }))}`;
      return {
        id: child.id,
        name: child.name,
        state: child.state,
        runtime: child.runtime,
        waiting_for: child.waitingFor,
        pending_id: child.pendingId,
        transcript_preview: items,
        vscode_deeplink: deepLink,
        vscode_command: commandUri
      };
    });
    if ((input.format ?? "json") === "text") {
      const lines: string[] = [`# Job ${job.id} (${children.length} enfants)`];
      for (const c of children) {
        lines.push(`\n## ${c.name} (${c.id}) [${c.state}] runtime=${c.runtime}`);
        for (const m of c.transcript_preview) lines.push(`- [${m.role}] ${m.content}`);
        lines.push(`(open) ${c.vscode_deeplink}`);
      }
      return { content: [{ type: "text", text: j({ format: "text", render: lines.join("\n") }) }] };
    }
    return { content: [{ type: "text", text: j({ format: "json", job: { id: job.id, state: job.state }, children }) }] };
  }
);

// graph_export
server.registerTool(
  "graph_export",
  { title: "Graph export", description: "Exporte l'etat graphe en JSON.", inputSchema: GraphExportShape },
  async (_input: GraphExportInput) => {
    const snap = graphState.serialize();
    return { content: [{ type: "text", text: j({ format: "json", data: snap }) }] };
  }
);

// graph_state_save
server.registerTool(
  "graph_state_save",
  { title: "Graph save", description: "Sauvegarde l'etat graphe dans un fichier JSON.", inputSchema: GraphSaveShape },
  async (input: GraphSaveInput) => {
    const cwd = process.cwd();
    const abs = resolvePath(cwd, input.path);
    if (!abs.toLowerCase().startsWith(cwd.toLowerCase())) {
      return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
    }
    const snap = graphState.serialize();
    await writeFile(abs, JSON.stringify(snap, null, 2), "utf8");
    return { content: [{ type: "text", text: j({ format: "json", ok: true, path: abs }) }] };
  }
);

// graph_state_load
server.registerTool(
  "graph_state_load",
  { title: "Graph load", description: "Recharge l'etat graphe depuis un fichier JSON.", inputSchema: GraphLoadShape },
  async (input: GraphLoadInput) => {
    const cwd = process.cwd();
    const abs = resolvePath(cwd, input.path);
    if (!abs.toLowerCase().startsWith(cwd.toLowerCase())) {
      return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
    }
    const data = await readFile(abs, "utf8");
    const snap = JSON.parse(data);
    graphState.resetFromSnapshot(snap);
    return { content: [{ type: "text", text: j({ format: "json", ok: true, path: abs }) }] };
  }
);

// conversation_view (vue conviviale de la discussion orchestrateur<->enfant)
server.registerTool(
  "conversation_view",
  { title: "Conversation view", description: "Affiche la conversation d'un enfant (texte ou JSON).", inputSchema: { child_id: z.string(), since_index: z.number().optional(), since_ts: z.number().optional(), limit: z.number().optional(), format: z.enum(["text", "json"]).optional(), include_system: z.boolean().optional() } },
  async (input: { child_id: string; since_index?: number; since_ts?: number; limit?: number; format?: "text" | "json"; include_system?: boolean }) => {
    const child = graphState.getChild(input.child_id);
    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    const slice = graphState.getTranscript(child.id, { sinceIndex: input.since_index, sinceTs: input.since_ts, limit: input.limit });
    const items = slice.items.filter((m) => (m.role === "system" ? (input.include_system ?? true) : true));
    const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(child.id)}`;
    const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: child.id }))}`;
    if ((input.format ?? "text") === "json") {
      return { content: [{ type: "text", text: j({ format: "json", child: { id: child.id, name: child.name }, total: slice.total, items, vscode_deeplink: deepLink, vscode_command: commandUri }) }] };
    }
    const lines: string[] = [
      `# ${child.name} (${child.id})`,
      ...items.map((m) => `- [${m.role}] ${m.content}`)
    ];
    return { content: [{ type: "text", text: j({ format: "text", render: lines.join("\n"), vscode_deeplink: deepLink, vscode_command: commandUri }) }] };
  }
);

// events_view (liste des evenements recents ou pending)
server.registerTool(
  "events_view",
  { title: "Events view", description: "Affiche les evenements (recent/pending/live)", inputSchema: { mode: z.enum(["recent", "pending", "live"]).optional(), job_id: z.string().optional(), child_id: z.string().optional(), limit: z.number().optional(), order: z.enum(["asc", "desc"]).optional(), min_seq: z.number().optional() } },
  async (input: { mode?: "recent" | "pending" | "live"; job_id?: string; child_id?: string; limit?: number; order?: "asc" | "desc"; min_seq?: number }) => {
    const mode = input.mode ?? "recent";
    if (mode === "pending") {
      const nodes = graphState.filterNodes({ type: "pending" }, undefined);
      const items = nodes
        .filter((n) => (input.child_id ? String(n.attributes.child_id ?? "") === input.child_id : true))
        .map((n) => {
          const childId = String(n.attributes.child_id ?? "");
          const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(childId)}`;
          const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: childId }))}`;
          return { id: n.id, child_id: childId, created_at: Number(n.attributes.created_at ?? 0), vscode_deeplink: deepLink, vscode_command: commandUri };
        });
      return { content: [{ type: "text", text: j({ format: "json", mode: "pending", pending: items }) }] };
    }
    if (mode === "live") {
      const events = buildLiveEvents({ job_id: input.job_id, child_id: input.child_id, limit: input.limit, order: input.order, min_seq: input.min_seq });
      return { content: [{ type: "text", text: j({ format: "json", mode: "live", events, via: "events_view" }) }] };
    }
    const limit = input.limit && input.limit > 0 ? input.limit : 100;
    const events = graphState
      .filterNodes({ type: "event" }, undefined)
      .filter((n) => (input.job_id ? String(n.attributes.job_id ?? "") === input.job_id : true))
      .filter((n) => (input.child_id ? String(n.attributes.child_id ?? "") === input.child_id : true))
      .map((n) => {
        const childId = String(n.attributes.child_id ?? "");
        const deepLink = childId ? `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(childId)}` : null;
        const commandUri = childId ? `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: childId }))}` : null;
        return {
          id: n.id,
          seq: Number(n.attributes.seq ?? 0),
          ts: Number(n.attributes.ts ?? 0),
          kind: String(n.attributes.kind ?? ""),
          level: String(n.attributes.level ?? "info"),
          job_id: String(n.attributes.job_id ?? ""),
          child_id: childId,
          vscode_deeplink: deepLink,
          vscode_command: commandUri
        };
      })
      .sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq))
      .slice(0, limit);
    return { content: [{ type: "text", text: j({ format: "json", mode: "recent", events, live_hint: { tool: "events_view_live", suggested_input: { job_id: input.job_id ?? null, child_id: input.child_id ?? null, limit: input.limit ?? null, order: input.order ?? null, min_seq: input.min_seq ?? null } } }) }] };
  }
);

// events_view_live (liste les evenements du bus live, sans dependre du graphe ni des suppressions cote client)
server.registerTool(
  "events_view_live",
  { title: "Events view (live)", description: "Affiche les evenements issus du bus live.", inputSchema: EventsViewLiveShape },
  async (input: EventsViewLiveInput) => {
    const events = buildLiveEvents(input);
    return { content: [{ type: "text", text: j({ format: "json", mode: "live", events, via: "events_view_live" }) }] };
  }
);

// Autosave (start/stop)
let AUTOSAVE_TIMER: NodeJS.Timeout | null = null;
let AUTOSAVE_PATH: string | null = null;
server.registerTool(
  "graph_state_autosave",
  { title: "Graph autosave", description: "Demarre/arrete la sauvegarde periodique du graphe.", inputSchema: { action: z.enum(["start", "stop"]), path: z.string().optional(), interval_ms: z.number().optional() } },
  async (input: { action: "start" | "stop"; path?: string; interval_ms?: number }) => {
    if (input.action === "stop") {
      if (AUTOSAVE_TIMER) clearInterval(AUTOSAVE_TIMER);
      AUTOSAVE_TIMER = null;
      AUTOSAVE_PATH = null;
      return { content: [{ type: "text", text: j({ format: "json", ok: true, status: "stopped" }) }] };
    }
    const cwd = process.cwd();
    const p = input.path ? resolvePath(cwd, input.path) : resolvePath(cwd, "graph-autosave.json");
    if (!p.toLowerCase().startsWith(cwd.toLowerCase())) {
      return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
    }
    const interval = Math.min(Math.max(input.interval_ms ?? 5000, 1000), 600000);
    if (AUTOSAVE_TIMER) clearInterval(AUTOSAVE_TIMER);
    AUTOSAVE_PATH = p;
    AUTOSAVE_TIMER = setInterval(async () => {
      try {
        const snap = graphState.serialize();
        const metadata = {
          saved_at: new Date().toISOString(),
          inactivity_threshold_ms: lastInactivityThresholdMs,
          event_history_limit: eventStore.getMaxHistory()
        };
        await writeFile(
          AUTOSAVE_PATH!,
          JSON.stringify({ metadata, snapshot: snap }, null, 2),
          "utf8"
        );
        logger.info("graph_autosave_written", {
          path: AUTOSAVE_PATH,
          node_count: snap.nodes.length,
          edge_count: snap.edges.length
        });
      } catch (error) {
        logger.error("graph_autosave_failed", {
          path: AUTOSAVE_PATH,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }, interval);
    return {
      content: [
        {
          type: "text",
          text: j({
            format: "json",
            ok: true,
            status: "started",
            path: p,
            interval_ms: interval,
            inactivity_threshold_ms: lastInactivityThresholdMs,
            event_history_limit: eventStore.getMaxHistory()
          })
        }
      ]
    };
  }
);

// graph_config_retention
server.registerTool(
  "graph_config_retention",
  { title: "Graph retention", description: "Configure la retention (transcripts, events).", inputSchema: { max_transcript_per_child: z.number().optional(), max_event_nodes: z.number().optional() } },
  async (input: { max_transcript_per_child?: number; max_event_nodes?: number }) => {
    graphState.configureRetention({
      maxTranscriptPerChild: input.max_transcript_per_child,
      maxEventNodes: input.max_event_nodes
    });
    return { content: [{ type: "text", text: j({ format: "json", ok: true }) }] };
  }
);

// graph_prune
server.registerTool(
  "graph_prune",
  { title: "Graph prune", description: "Prune manuellement des transcripts ou evenements.", inputSchema: GraphPruneShape },
  async (input: GraphPruneInput) => {
    if (input.action === "transcript") {
      if (!input.child_id || typeof input.keep_last !== "number") {
        return {
          isError: true,
          content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "child_id et keep_last requis" }) }]
        };
      }
      const keep = Math.max(0, Math.floor(input.keep_last));
      graphState.pruneChildTranscript(input.child_id, keep);
      return { content: [{ type: "text", text: j({ ok: true, action: "transcript", child_id: input.child_id, keep_last: keep }) }] };
    }
    const max = typeof input.max_events === "number" ? Math.max(0, Math.floor(input.max_events)) : 0;
    if (max <= 0) {
      return {
        isError: true,
        content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "max_events > 0 requis" }) }]
      };
    }
    graphState.pruneEvents(max, input.job_id ?? undefined, input.child_id ?? undefined);
    return {
      content: [
        {
          type: "text",
          text: j({ ok: true, action: "events", job_id: input.job_id ?? null, child_id: input.child_id ?? null, max_events: max })
        }
      ]
    };
  }
);

// graph_query
server.registerTool(
  "graph_config_runtime",
  { title: "Graph runtime", description: "Configure le runtime par defaut des enfants planifies.", inputSchema: GraphRuntimeShape },
  async (input: GraphRuntimeInput) => {
    const previous = DEFAULT_CHILD_RUNTIME;
    if (input.reset) {
      setDefaultChildRuntime("codex");
    } else if (typeof input.runtime === 'string' && input.runtime.trim().length) {
      setDefaultChildRuntime(input.runtime);
    }
    return { content: [{ type: "text", text: j({ format: "json", ok: true, runtime: DEFAULT_CHILD_RUNTIME, previous }) }] };
  }
);

server.registerTool(
  "graph_state_stats",
  { title: "Graph stats", description: "Expose des compteurs sur les noeuds/aretes et runtimes.", inputSchema: GraphStatsShape },
  async (_input: GraphStatsInput) => {
    const nodes = graphState.listNodeRecords();
    const edges = graphState.listEdgeRecords();
    const stats: { nodes: number; edges: number; jobs: number; children: number; messages: number; pending: number; events: number; subscriptions: number } = {
      nodes: nodes.length,
      edges: edges.length,
      jobs: 0,
      children: 0,
      messages: 0,
      pending: 0,
      events: 0,
      subscriptions: 0
    };
    const runtimeCounts: Record<string, number> = {};
    const childStateCounts: Record<string, number> = {};
    for (const node of nodes) {
      const attrs = node.attributes ?? {};
      const type = String(attrs.type ?? '');
      switch (type) {
        case 'job':
          stats.jobs += 1;
          break;
        case 'child': {
          stats.children += 1;
          const runtime = String(attrs.runtime ?? DEFAULT_CHILD_RUNTIME);
          runtimeCounts[runtime] = (runtimeCounts[runtime] ?? 0) + 1;
          const state = String(attrs.state ?? '');
          if (state) childStateCounts[state] = (childStateCounts[state] ?? 0) + 1;
          break;
        }
        case 'message':
          stats.messages += 1;
          break;
        case 'pending':
          stats.pending += 1;
          break;
        case 'event':
          stats.events += 1;
          break;
        case 'subscription':
          stats.subscriptions += 1;
          break;
        default:
          break;
      }
    }
    const jobs = graphState.listJobs().map((job) => ({ id: job.id, state: job.state, child_count: job.childIds.length }));
    return {
      content: [
        {
          type: 'text',
          text: j({
            format: 'json',
            stats,
            runtimes: runtimeCounts,
            child_states: childStateCounts,
            jobs,
            default_runtime: DEFAULT_CHILD_RUNTIME
          })
        }
      ]
    };
  }
);

server.registerTool(
  "graph_state_metrics",
  {
    title: "Graph metrics",
    description: "Expose des métriques synthétiques (jobs actifs, événements, heartbeats).",
    inputSchema: GraphStatsShape
  },
  async () => {
    const metrics = graphState.collectMetrics();
    const heartbeatEvents = eventStore.getEventsByKind("HEARTBEAT").sort((a, b) => a.ts - b.ts);
    let averageHeartbeatMs: number | null = null;
    if (heartbeatEvents.length > 1) {
      let total = 0;
      for (let index = 1; index < heartbeatEvents.length; index += 1) {
        total += heartbeatEvents[index].ts - heartbeatEvents[index - 1].ts;
      }
      averageHeartbeatMs = Math.round(total / (heartbeatEvents.length - 1));
    }

    const payload = {
      format: "json" as const,
      jobs: {
        total: metrics.totalJobs,
        active: metrics.activeJobs,
        completed: metrics.completedJobs
      },
      children: {
        total: metrics.totalChildren,
        active: metrics.activeChildren,
        pending: metrics.pendingChildren
      },
      events: {
        total: eventStore.getEventCount(),
        last_seq: eventStore.getLastSequence(),
        history_limit: eventStore.getMaxHistory(),
        average_heartbeat_ms: averageHeartbeatMs
      },
      messages: metrics.totalMessages,
      subscriptions: metrics.subscriptions
    };

    return { content: [{ type: "text", text: j(payload) }] };
  }
);

server.registerTool(
  "graph_state_inactivity",
  {
    title: "Graph inactivity",
    description: "Identifie les enfants inactifs ou avec pending prolongé.",
    inputSchema: GraphInactivityShape
  },
  async (input: GraphInactivityInput) => {
    const inactivitySec = input.inactivity_threshold_sec ?? input.inactivityThresholdSec;
    const inactivityMs = typeof inactivitySec === "number" ? Math.max(0, inactivitySec) * 1000 : undefined;
    const idleThreshold = input.idle_threshold_ms ?? inactivityMs ?? 120_000;
    const pendingThreshold = input.pending_threshold_ms ?? idleThreshold;
    const includeWithoutMessages = input.include_children_without_messages ?? true;
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;
    lastInactivityThresholdMs = idleThreshold;
    const reports = graphState.findInactiveChildren({
      idleThresholdMs: idleThreshold,
      pendingThresholdMs: pendingThreshold,
      includeChildrenWithoutMessages: includeWithoutMessages
    });
    const filtered = reports.filter((report) => {
      if (input.job_id && report.jobId !== input.job_id) return false;
      if (input.runtime && report.runtime !== input.runtime) return false;
      if (input.state && report.state !== input.state) return false;
      return true;
    });
    const ordered = [...filtered].sort((a, b) => {
      const scoreA = Math.max(a.idleMs ?? 0, a.pendingMs ?? 0);
      const scoreB = Math.max(b.idleMs ?? 0, b.pendingMs ?? 0);
      if (scoreA === scoreB) {
        return a.childId.localeCompare(b.childId);
      }
      return scoreB - scoreA;
    });
    const limited = ordered.slice(0, limit);
    const defaultFormat = input.format ?? "json";

    if (defaultFormat === "text") {
      if (!limited.length) {
        const idleSec = Math.round(idleThreshold / 1000);
        const pendingSec = Math.round(pendingThreshold / 1000);
        return {
          content: [
            {
              type: "text",
              text: `Aucune inactivité détectée (idle ≥ ${idleSec}s, pending ≥ ${pendingSec}s).`
            }
          ]
        };
      }
      const lines = limited.map((report) => {
        const idleSec = report.idleMs !== null ? Math.round(report.idleMs / 1000) : null;
        const pendingSec = report.pendingMs !== null ? Math.round(report.pendingMs / 1000) : null;
        const flagSummary = report.flags
          .map((flag) => `${flag.type}:${Math.round(flag.valueMs / 1000)}s≥${Math.round(flag.thresholdMs / 1000)}s`)
          .join(", ");
        const waiting = report.waitingFor ?? "∅";
        const job = report.jobId || "∅";
        return `- ${report.childId} (${report.state}) job=${job} runtime=${report.runtime} idle=${idleSec ?? "∅"}s pending=${
          pendingSec ?? "∅"
        }s waiting=${waiting} flags=[${flagSummary}]`;
      });
      const header = `Enfants inactifs (idle ≥ ${Math.round(idleThreshold / 1000)}s, pending ≥ ${Math.round(
        pendingThreshold / 1000
      )}s) :`;
      return {
        content: [
          {
            type: "text",
            text: [header, ...lines].join("\n")
          }
        ]
      };
    }

    const payload = {
      format: "json" as const,
      idle_threshold_ms: idleThreshold,
      pending_threshold_ms: pendingThreshold,
      inactivity_threshold_sec: inactivityMs !== undefined ? inactivityMs / 1000 : Math.round(idleThreshold / 1000),
      total: filtered.length,
      returned: limited.length,
      items: limited.map((report) => ({
        child_id: report.childId,
        job_id: report.jobId || null,
        name: report.name,
        state: report.state,
        runtime: report.runtime,
        waiting_for: report.waitingFor,
        pending_id: report.pendingId,
        created_at: report.createdAt,
        last_activity_ts: report.lastActivityTs,
        idle_ms: report.idleMs,
        pending_since: report.pendingSince,
        pending_ms: report.pendingMs,
        transcript_size: report.transcriptSize,
        flags: report.flags.map((flag) => ({
          type: flag.type,
          value_ms: flag.valueMs,
          threshold_ms: flag.thresholdMs
        }))
      }))
    };

    return { content: [{ type: "text", text: j(payload) }] };
  }
);

server.registerTool(
  "graph_query",
  { title: "Graph query", description: "Requete simple: neighbors ou filter.", inputSchema: { kind: z.enum(["neighbors", "filter"]), node_id: z.string().optional(), direction: z.enum(["out", "in", "both"]).optional(), edge_type: z.string().optional(), select: z.enum(["nodes", "edges", "both"]).optional(), where: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), limit: z.number().optional() } },
  async (input: { kind: "neighbors" | "filter"; node_id?: string; direction?: "out" | "in" | "both"; edge_type?: string; select?: "nodes" | "edges" | "both"; where?: Record<string, string | number | boolean>; limit?: number }) => {
    if (input.kind === "neighbors") {
      if (!input.node_id) return { isError: true, content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "node_id requis" }) }] };
      const res = graphState.neighbors(input.node_id, input.direction ?? "both", input.edge_type);
      return { content: [{ type: "text", text: j({ format: "json", data: res }) }] };
    }
    // filter
    const select = input.select ?? "nodes";
    const where = input.where ?? {};
    const limit = input.limit && input.limit > 0 ? input.limit : undefined;
    if (select === "nodes") {
      const nodes = graphState.filterNodes(where, limit);
      return { content: [{ type: "text", text: j({ format: "json", nodes }) }] };
    } else if (select === "edges") {
      const edges = graphState.filterEdges(where, limit);
      return { content: [{ type: "text", text: j({ format: "json", edges }) }] };
    } else {
      const nodes = graphState.filterNodes(where, limit);
      const edges = graphState.filterEdges(where, limit);
      return { content: [{ type: "text", text: j({ format: "json", nodes, edges }) }] };
    }
  }
);

// plan_fanout
server.registerTool(

  "plan_fanout",

  { title: "Plan fan-out", description: "Planifie des enfants en parallele, retourne job_id et child_ids.", inputSchema: PlanFanoutShape },

  async (input: PlanFanoutInput) => {

    pruneExpired();

    const { goal, children = [], ttl_s, max_children = 6 } = input;



    let planned: SpawnChildSpec[] = children.map((child) => ({ ...child, runtime: child.runtime ?? "codex" }));

    if (!planned.length && goal) {

      planned = [

        {
          name: "planner",
          system: `Tu es ${DEFAULT_CHILD_RUNTIME} (instance planificatrice). L'orchestrateur agit comme l'utilisateur et attend un plan concis, hierarchise et actionnable.`,
          goals: [goal],
          runtime: DEFAULT_CHILD_RUNTIME
        },

        {
          name: "researcher",
          system: `Tu es ${DEFAULT_CHILD_RUNTIME} (instance analyste). L'orchestrateur est l'utilisateur ; collecte, verifie et synthetise les informations cles sans digresser.`,
          goals: [goal],
          runtime: DEFAULT_CHILD_RUNTIME
        },

        {
          name: "implementer",
          system: `Tu es ${DEFAULT_CHILD_RUNTIME} (instance mise en oeuvre). L'orchestrateur est l'utilisateur ; propose un patch concret, pret a etre applique et teste.`,
          goals: [goal],
          runtime: DEFAULT_CHILD_RUNTIME
        },

      ];

    }



    const slice = planned.slice(0, max_children).map((spec) => ({ ...spec, runtime: spec.runtime ?? DEFAULT_CHILD_RUNTIME }));

    const jobId = createJob(goal ?? undefined);

    const childIds: string[] = [];

    for (const spec of slice) {

      const childId = createChild(jobId, spec, ttl_s);

      childIds.push(childId);

    }



    startHeartbeat();

    const evt = pushEvent({ kind: "PLAN", jobId, payload: { planned: slice.map((s) => ({ name: s.name, runtime: s.runtime ?? "codex" })), childIds } });



    return { content: [{ type: "text", text: j({ job_id: jobId, child_ids: childIds, planned: slice, event_seq: evt.seq }) }] };

  }

);



// start
server.registerTool(

  "start",

  { title: "Start job", description: "Met les enfants d un job en waiting.", inputSchema: StartShape },

  async (input: StartInput) => {

    pruneExpired();



    const { job_id, children } = input;

    const job = graphState.getJob(job_id);

    if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };



    if (children?.length) {

      for (const spec of children) {
        const normalized: SpawnChildSpec = { ...spec, runtime: spec.runtime ?? DEFAULT_CHILD_RUNTIME };
        createChild(job_id, normalized);
      }

    }



    let started = 0;

    for (const child of graphState.listChildren(job_id)) {

      if (child.state === "idle") {

        graphState.patchChild(child.id, { state: "waiting", waitingFor: "reply", pendingId: null });

        started++;

        pushEvent({ kind: "START", jobId: job_id, childId: child.id, payload: { name: child.name } });

      }

    }



    return { content: [{ type: "text", text: j({ started, job_id }) }] };

  }

);



// child_prompt

server.registerTool(

  "child_prompt",

  { title: "Child prompt", description: "Ajoute des messages au sous-chat et retourne un pending_id.", inputSchema: ChildPromptShape },

  async (input: ChildPromptInput) => {

    pruneExpired();



    const { child_id, messages } = input;

    const child = graphState.getChild(child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };

    if (child.state === "killed") return { isError: true, content: [{ type: "text", text: j({ error: "KILLED", message: "Child termine" }) }] };



    for (const message of messages) {

      const entry: MessageRecord = {

        role: message.role,

        content: message.content,

        ts: now(),

        actor: message.role === "user" ? "user" : "orchestrator"

      };

      graphState.appendMessage(child_id, entry);

    }
    graphState.patchChild(child_id, { state: "running", waitingFor: "reply" });

    const pendingId = `pending_${randomUUID()}`;

    graphState.setPending(child_id, pendingId, now());



    const jobId = child.jobId ?? findJobIdByChild(child_id);

    pushEvent({ kind: "PROMPT", jobId, childId: child_id, source: "orchestrator", payload: { appended: messages.length } });

    pushEvent({ kind: "PENDING", jobId, childId: child_id, payload: { pendingId } });



    return { content: [{ type: "text", text: j({ pending_id: pendingId, child_id }) }] };

  }

);



// child_push_partial

server.registerTool(

  "child_push_partial",

  { title: "Child push partial", description: "Pousse un fragment de reponse (stream).", inputSchema: ChildPushPartialShape },

  async (input: ChildPushPartialInput) => {

    pruneExpired();



    const { pending_id, delta, done } = input;

    const pending = graphState.getPending(pending_id);

    if (!pending) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "pending_id inconnu" }) }] };



    const child = graphState.getChild(pending.childId);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child introuvable" }) }] };



    const text = String(delta ?? "").trim();
    if (text.length) {
      graphState.appendMessage(child.id, { role: "assistant", content: text, ts: now(), actor: "child" });
    }

    const jobId = child.jobId ?? findJobIdByChild(child.id);

    pushEvent({ kind: "REPLY_PART", jobId, childId: child.id, source: "child", payload: { len: text.length } });



    if (done) {

      graphState.clearPending(pending_id);

      graphState.patchChild(child.id, { state: "waiting", waitingFor: null, pendingId: null });

      pushEvent({ kind: "REPLY", jobId, childId: child.id, source: "child", payload: { final: true } });

    }

    return { content: [{ type: "text", text: j({ ok: true }) }] };

  }

);



// child_push_reply

server.registerTool(

  "child_push_reply",

  { title: "Child push reply", description: "Finalise la reponse pour un pending_id.", inputSchema: ChildPushReplyShape },

  async (input: ChildPushReplyInput) => {

    pruneExpired();



    const { pending_id, content } = input;

    const pending = graphState.getPending(pending_id);

    if (!pending) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "pending_id inconnu" }) }] };



    const child = graphState.getChild(pending.childId);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child introuvable" }) }] };



    graphState.appendMessage(child.id, { role: "assistant", content, ts: now(), actor: "child" });

    graphState.clearPending(pending_id);

    graphState.patchChild(child.id, { state: "waiting", waitingFor: null, pendingId: null });



    const jobId = child.jobId ?? findJobIdByChild(child.id);

    pushEvent({ kind: "REPLY", jobId, childId: child.id, source: "child", payload: { length: content.length, final: true } });



    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id }) }] };

  }

);



// child_chat

server.registerTool(

  "child_chat",

  { title: "Child chat", description: "Envoie un message orchestrateur->enfant et retourne un pending_id.", inputSchema: ChildChatShape },

  async (input: ChildChatInput) => {

    pruneExpired();



    const { child_id, content, role = "user" } = input;

    const child = graphState.getChild(child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };

    if (child.state === "killed") return { isError: true, content: [{ type: "text", text: j({ error: "KILLED", message: "Child termine" }) }] };



    graphState.appendMessage(child_id, { role, content, ts: now(), actor: role === "user" ? "user" : "orchestrator" });

    graphState.patchChild(child_id, { state: "running", waitingFor: "reply" });



    const pendingId = `pending_${randomUUID()}`;

    graphState.setPending(child_id, pendingId, now());



    const jobId = child.jobId ?? findJobIdByChild(child_id);

    pushEvent({ kind: "PROMPT", jobId, childId: child_id, source: "orchestrator", payload: { oneShot: true } });

    pushEvent({ kind: "PENDING", jobId, childId: child_id, payload: { pendingId } });



    return { content: [{ type: "text", text: j({ pending_id: pendingId, child_id }) }] };

  }

);



// child_info

server.registerTool(

  "child_info",

  { title: "Child info", description: "Retourne l etat et les metadonnees d un enfant.", inputSchema: ChildInfoShape },

  async (input: ChildInfoInput) => {

    const child = graphState.getChild(input.child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };



    const info = {

      id: child.id,

      name: child.name,

      state: child.state,

      runtime: child.runtime,

      waiting_for: child.waitingFor,

      pending_id: child.pendingId,

      system: child.systemMessage,

      ttl_at: child.ttlAt,

      transcript_size: child.transcriptSize,

      last_ts: child.lastTs

    };

    return { content: [{ type: "text", text: j(info) }] };

  }

);



// child_transcript

server.registerTool(

  "child_transcript",

  { title: "Child transcript", description: "Retourne une tranche du transcript d un enfant.", inputSchema: ChildTranscriptShape },

  async (input: ChildTranscriptInput) => {

    const child = graphState.getChild(input.child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };



    const slice = graphState.getTranscript(child.id, {

      sinceIndex: input.since_index,

      sinceTs: input.since_ts,

      limit: input.limit,

      reverse: input.reverse

    });



    return { content: [{ type: "text", text: j({ child_id: child.id, total: slice.total, items: slice.items }) }] };

  }

);



// child_rename

server.registerTool(

  "child_rename",

  { title: "Child rename", description: "Renomme un enfant.", inputSchema: ChildRenameShape },

  async (input: ChildRenameInput) => {

    const child = graphState.getChild(input.child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };

    const oldName = child.name;

    graphState.patchChild(child.id, { name: input.name });

    pushEvent({ kind: "INFO", childId: child.id, jobId: child.jobId ?? findJobIdByChild(child.id), payload: { rename: { from: oldName, to: input.name } } });

    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id, name: input.name }) }] };

  }

);



// child_reset

server.registerTool(

  "child_reset",

  { title: "Child reset", description: "Reinitialise la session d un enfant.", inputSchema: ChildResetShape },

  async (input: ChildResetInput) => {

    const child = graphState.getChild(input.child_id);

    if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };



    graphState.resetChild(child.id, { keepSystem: !!input.keep_system, timestamp: now() });

    pushEvent({ kind: "INFO", childId: child.id, jobId: child.jobId ?? findJobIdByChild(child.id), payload: { reset: { keep_system: !!input.keep_system } } });

    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id }) }] };

  }

);



// status

server.registerTool(

  "status",

  { title: "Status", description: "Snapshot d un job ou liste des jobs.", inputSchema: StatusShape },

  async (input: StatusInput) => {

    pruneExpired();



    const { job_id } = input;

    if (job_id) {

      const job = graphState.getJob(job_id);

      if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };

      const children = graphState.listChildren(job_id).map((child) => ({

        id: child.id,

        name: child.name,

        state: child.state,

        runtime: child.runtime,

        waiting_for: child.waitingFor,

        last_update: child.lastTs ?? child.ttlAt ?? null,

        pending_id: child.pendingId,

        transcript_size: child.transcriptSize

      }));

      const payload = { job_id, state: job.state, children };

      pushEvent({ kind: "STATUS", jobId: job.id, payload });

      return { content: [{ type: "text", text: j(payload) }] };

    }



    const jobs = graphState.listJobs().map((job) => ({ id: job.id, state: job.state, child_count: job.childIds.length }));

    return { content: [{ type: "text", text: j({ jobs }) }] };

  }

);



// graph_forge_analyze
server.registerTool(
  "graph_forge_analyze",
  { title: "Graph Forge analyze", description: "Compile un script Graph Forge et execute les analyses demandees.", inputSchema: GraphForgeShape },
  async (input: GraphForgeInput) => {
    let cfg: GraphForgeInput;
    try {
      cfg = GraphForgeSchema.parse(input);
    } catch (validationError) {
      return {
        isError: true,
        content: [{ type: "text", text: j({ error: "GRAPH_FORGE_INPUT_INVALID", detail: describeError(validationError) }) }]
      };
    }
    try {
      const mod = await loadGraphForge();
      let resolvedPath: string | undefined;
      let source = cfg.source;
      if (!source && cfg.path) {
        resolvedPath = resolvePath(process.cwd(), cfg.path);
        try {
          source = await readFile(resolvedPath, "utf8");
        } catch (fsError) {
          const info = describeError(fsError);
          throw new Error(`Impossible de lire le fichier Graph Forge \`${resolvedPath}\`: ${info.message}`);
        }
      }
      if (!source) {
        throw new Error("No Graph Forge source provided");
      }

      const compiled = mod.compileSource(source, { entryGraph: cfg.entry_graph });
      const graphSummary = {
        name: compiled.graph.name,
        directives: Array.from(compiled.graph.directives.entries()).map(([key, value]) => ({ name: key, value })),
        nodes: compiled.graph.listNodes().map(node => ({ id: node.id, attributes: node.attributes })),
        edges: compiled.graph.listEdges().map(edge => ({ from: edge.from, to: edge.to, attributes: edge.attributes }))
      };

      const analysisDefinitions = compiled.analyses.map(analysis => ({
        name: analysis.name,
        args: analysis.args.map(arg => arg.value),
        location: { line: analysis.tokenLine, column: analysis.tokenColumn }
      }));

      const tasks: GraphForgeTask[] = [];
      if (cfg.use_defined_analyses ?? true) {
        for (const analysis of compiled.analyses) {
          tasks.push({
            name: analysis.name,
            args: analysis.args.map(arg => toStringArg(arg.value)),
            source: "dsl"
          });
        }
      }
      if (cfg.analyses?.length) {
        for (const req of cfg.analyses) {
          tasks.push({
            name: req.name,
            args: req.args ?? [],
            weightKey: req.weight_key ?? undefined,
            source: "request"
          });
        }
      }

      const analysisReports = tasks.map(task => {
        try {
          const result = runGraphForgeAnalysis(mod, compiled, task, cfg.weight_key);
          return { name: task.name, source: task.source, args: task.args, result };
        } catch (err) {
          return { name: task.name, source: task.source, args: task.args, error: describeError(err) };
        }
      });

      const payload = {
        entry_graph: cfg.entry_graph ?? compiled.graph.name,
        source: {
          path: resolvedPath ?? null,
          provided_inline: Boolean(cfg.source),
          length: source.length
        },
        graph: graphSummary,
        analyses_defined: analysisDefinitions,
        analyses_resolved: analysisReports
      };

      return { content: [{ type: "text", text: j(payload) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: j({ error: "GRAPH_FORGE_FAILED", detail: describeError(err) }) }]
      };
    }
  }
);

// aggregate

server.registerTool(

  "aggregate",

  { title: "Aggregate", description: "Agrege les sorties d un job (concat par defaut).", inputSchema: AggregateShape },

  async (input: AggregateInput) => {

    pruneExpired();



    const { job_id } = input;

    const job = graphState.getJob(job_id);

    if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };

    const strategyRaw = typeof input.strategy === "string" ? input.strategy.trim() : undefined;
    const knownStrategies = new Set(["concat", "json_merge", "vote", "markdown_compact", "jsonl"]);
    let strategy: "concat" | "json_merge" | "vote" | "markdown_compact" | "jsonl" | undefined;
    if (strategyRaw && knownStrategies.has(strategyRaw)) {
      strategy = strategyRaw as "concat" | "json_merge" | "vote" | "markdown_compact" | "jsonl";
    } else {
      strategy = undefined;
    }

    const res = aggregate(job_id, strategy, { includeSystem: input.include_system, includeGoals: input.include_goals });

    graphState.patchJob(job_id, { state: "done" });

    pushEvent({ kind: "AGGREGATE", jobId: job.id, payload: { strategy: strategy ?? "concat", requested: strategyRaw ?? null } });



    return { content: [{ type: "text", text: j(res) }] };

  }

);



// kill

server.registerTool(

  "kill",

  { title: "Kill", description: "Termine un child_id ou un job_id.", inputSchema: KillShape },

  async (input: KillInput) => {

    pruneExpired();



    const { child_id, job_id } = input;



    if (child_id) {

      const child = graphState.getChild(child_id);

      if (!child) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };

      graphState.clearPendingForChild(child_id);

      graphState.patchChild(child_id, { state: "killed", waitingFor: null, pendingId: null });

      const jobId = child.jobId ?? findJobIdByChild(child_id);

      pushEvent({ kind: "KILL", jobId, childId: child_id, level: "warn", payload: { scope: "child" } });

      return { content: [{ type: "text", text: j({ ok: true, child_id }) }] };

    }



    if (job_id) {

      const job = graphState.getJob(job_id);

      if (!job) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };

      for (const child of graphState.listChildren(job_id)) {

        graphState.clearPendingForChild(child.id);

        graphState.patchChild(child.id, { state: "killed", waitingFor: null, pendingId: null });

      }

      graphState.patchJob(job_id, { state: "killed" });

      pushEvent({ kind: "KILL", jobId: job_id, level: "warn", payload: { scope: "job" } });

      return { content: [{ type: "text", text: j({ ok: true, job_id }) }] };

    }



    return { isError: true, content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "Fournis child_id ou job_id" }) }] };

  }

);



// events_subscribe
server.registerTool(
  "events_subscribe",
  { title: "Events subscribe", description: "S abonner aux evenements (filtrage job_id/child_id).", inputSchema: SubscribeShape },
  async (input: SubscribeInput) => {
    const sub: Subscription = {
      id: `sub_${randomUUID()}`,
      jobId: input.job_id,
      childId: input.child_id,
      lastSeq: typeof input.last_seq === "number" ? input.last_seq : eventStore.getLastSequence(),
      createdAt: now()
    };
    SUBS.set(sub.id, sub);
    graphState.createSubscription({ id: sub.id, jobId: sub.jobId, childId: sub.childId, lastSeq: sub.lastSeq, createdAt: sub.createdAt });
    pushEvent({ kind: "INFO", payload: { msg: "subscription_opened", subId: sub.id, jobId: sub.jobId, childId: sub.childId } });
    return { content: [{ type: "text", text: j({ subscription_id: sub.id, last_seq: sub.lastSeq }) }] };
  }
);

// events_poll
server.registerTool(
  "events_poll",
  { title: "Events poll", description: "Recupere les evenements depuis la derniere sequence (long-poll via wait_ms).", inputSchema: PollShape },
  async (input: PollInput) => {
    const sub = SUBS.get(input.subscription_id);
    if (!sub) return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "subscription_id inconnu" }) }] };

    const since = typeof input.since_seq === "number" ? input.since_seq : sub.lastSeq;
    const max = input.max_events && input.max_events > 0 ? Math.min(input.max_events, 500) : 100;
    const wait = Math.min(Math.max(input.wait_ms ?? 0, 0), 8000);

    let raw = listEventsSince(since, sub.jobId, sub.childId);
    const deadline = Date.now() + wait;
    while (!raw.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
      raw = listEventsSince(since, sub.jobId, sub.childId);
    }
    const suppressed = new Set(input.suppress ?? []);
    let evts = raw.filter(e => !suppressed.has(e.kind)).slice(0, max);
    if (raw.length) {
      sub.lastSeq = raw[raw.length - 1].seq;
      graphState.updateSubscription(sub.id, { lastSeq: sub.lastSeq });
    }
    return { content: [{ type: "text", text: j({ format: "json", events: evts, last_seq: sub.lastSeq }) }] };
  }
);

// events_unsubscribe
server.registerTool(
  "events_unsubscribe",
  { title: "Events unsubscribe", description: "Ferme un abonnement.", inputSchema: UnsubscribeShape },
  async (input: UnsubscribeInput) => {
    const ok = SUBS.delete(input.subscription_id);
    graphState.deleteSubscription(input.subscription_id);
    if (ok) pushEvent({ kind: "INFO", payload: { msg: "subscription_closed", subId: input.subscription_id } });
    return { content: [{ type: "text", text: j({ ok }) }] };
  }
);

// --- Transports ---
const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  let options;
  try {
    options = parseOrchestratorRuntimeOptions(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("cli_options_invalid", { message });
    process.exit(1);
  }

  if (options.logFile) {
    logger = new StructuredLogger({ logFile: options.logFile });
    eventStore.setLogger(logger);
    logger.info("logger_configured", { log_file: options.logFile });
  }

  eventStore.setMaxHistory(options.maxEventHistory);

  let enableStdio = options.enableStdio;
  const httpEnabled = options.http.enabled;

  if (!enableStdio && !httpEnabled) {
    logger.error("no_transport_enabled", {});
    process.exit(1);
  }

  const cleanup: Array<() => Promise<void>> = [];

  if (httpEnabled) {
    if (enableStdio) {
      logger.warn("stdio_disabled_due_to_http");
      enableStdio = false;
    }

    try {
      const handle = await startHttpServer(server, options.http, logger);
      cleanup.push(handle.close);
    } catch (error) {
      logger.error("http_start_failed", { message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  }

  if (enableStdio) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("stdio_listening");
  }

  logger.info("runtime_started", {
    stdio: enableStdio,
    http: httpEnabled,
    max_event_history: eventStore.getMaxHistory()
  });

  process.on("SIGINT", async () => {
    logger.warn("shutdown_signal", { signal: "SIGINT" });
    for (const closer of cleanup) {
      try {
        await closer();
      } catch (error) {
        logger.error("transport_close_failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }
    process.exit(0);
  });
}

export { server, graphState, DEFAULT_CHILD_RUNTIME, buildLiveEvents, setDefaultChildRuntime };

