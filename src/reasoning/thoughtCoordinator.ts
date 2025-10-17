import { StructuredLogger } from "../logger.js";
import type { GraphState } from "../graphState.js";
import { MetaCritic } from "../agents/metaCritic.js";
import type { ValueGraph } from "../values/valueGraph.js";
import {
  ThoughtGraph,
  type ThoughtNodeSnapshot,
  type ThoughtNodeStatus,
} from "./thoughtGraph.js";
import type { Provenance } from "../types/provenance.js";

/**
 * Normalised descriptor provided when registering a branch in the thought graph.
 * The scheduler keeps only the minimal prompt information required to inspect
 * reasoning diversity without exposing entire prompt payloads.
 */
export interface ThoughtBranchInput {
  /** Identifier of the spawned child runtime backing the branch. */
  childId: string;
  /** Human readable name advertised by the planner for the branch. */
  name: string;
  /** Prompt summary injected into the child (system+user distilled). */
  prompt: string;
  /** Runtime advertised when spawning the child (kept for diagnostics). */
  runtime: string;
  /** Optional provenance accumulated while building the prompt. */
  provenance?: Provenance[];
}

/** Options accepted when recording a fan-out in the scheduler. */
export interface ThoughtFanoutRecord {
  jobId: string;
  runId: string;
  goal: string | null;
  parentChildId: string | null;
  plannerNodeId: string | null;
  branches: ThoughtBranchInput[];
  startedAt: number;
}

/** Observation captured once a branch reaches a terminal response. */
export interface ThoughtJoinObservation {
  childId: string;
  status: "success" | "error" | "timeout";
  summary: string | null;
  /** Optional value guard verdict attached to the branch, when available. */
  valueGuard?: ThoughtBranchGuardSnapshot | null;
}

/** Outcome metadata propagated when a join completes. */
export interface ThoughtJoinRecord {
  jobId: string | null;
  runId: string;
  policy: "all" | "first_success" | "quorum";
  satisfied: boolean;
  candidateWinner: string | null;
  observations: ThoughtJoinObservation[];
}

/** Result returned after the scheduler reconciles a join event. */
export interface ThoughtJoinOutcome {
  /** Winning branch recommended by the scheduler once scores are applied. */
  winner: string | null;
  /** Branch identifiers ordered by descending score and recency. */
  ranking: string[];
  /** Branch identifiers flagged as pruned to respect retention limits. */
  pruned: string[];
}

/**
 * Compact snapshot of the value guard decision associated with a branch.
 * Detailed breakdowns stay in plan tooling while the coordinator only tracks
 * the verdict and margin to influence scheduling analytics.
 */
export interface ThoughtBranchGuardSnapshot {
  allowed: boolean;
  score: number;
  total: number;
  threshold: number;
  violationCount: number;
}

interface BranchMetadata {
  runId: string;
  depth: number;
  startedAt: number;
  parent: string | null;
}

interface ThoughtGraphCacheEntry {
  graph: ThoughtGraph;
  metadata: Map<string, BranchMetadata>;
}

interface ThoughtGraphCoordinatorOptions {
  graphState: GraphState;
  logger?: StructuredLogger;
  metaCritic?: MetaCritic;
  valueGraph?: ValueGraph;
  maxBranches?: number;
  maxDepth?: number;
  now?: () => number;
}

/**
 * Coordinates multi-branch reasoning by projecting plan fan-out and join
 * activity into a {@link ThoughtGraph}. The coordinator serialises compact
 * snapshots into {@link GraphState} so dashboards can render causal timelines
 * without reconstructing state from raw events.
 */
export class ThoughtGraphCoordinator {
  private readonly graphState: GraphState;
  private readonly logger?: StructuredLogger;
  private readonly metaCritic?: MetaCritic;
  private readonly valueGraph?: ValueGraph;
  private readonly maxBranches: number;
  private readonly maxDepth: number;
  private readonly now: () => number;
  private readonly graphs = new Map<string, ThoughtGraphCacheEntry>();

  constructor(options: ThoughtGraphCoordinatorOptions) {
    this.graphState = options.graphState;
    this.logger = options.logger;
    this.metaCritic = options.metaCritic;
    this.valueGraph = options.valueGraph;
    this.maxBranches = Math.max(1, options.maxBranches ?? 6);
    this.maxDepth = Math.max(1, options.maxDepth ?? 3);
    this.now = options.now ?? Date.now;
  }

  /** Records a plan fan-out by registering the newly spawned branches. */
  recordFanout(record: ThoughtFanoutRecord): void {
    const cache = this.ensureJobGraph(record.jobId);
    const rootId = this.ensureRunRoot(cache, record);

    for (const branch of record.branches) {
      const parents = new Set<string>([rootId]);
      if (record.parentChildId) {
        parents.add(record.parentChildId);
      }
      const existing = cache.graph.getNode(branch.childId);
      const startedAt = existing?.startedAt ?? record.startedAt;
      const provenance = branch.provenance ?? existing?.provenance ?? [];

      cache.graph.upsertNode({
        id: branch.childId,
        parents: Array.from(parents),
        prompt: branch.prompt,
        tool: "plan_fanout",
        result: existing?.result ?? null,
        score: existing?.score ?? null,
        provenance,
        status: existing?.status ?? "pending",
        startedAt,
        completedAt: existing?.completedAt ?? null,
      });

      const depth = this.computeBranchDepth(cache, Array.from(parents));
      cache.metadata.set(branch.childId, {
        runId: record.runId,
        depth,
        startedAt,
        parent: record.parentChildId,
      });

      if (depth > this.maxDepth) {
        cache.graph.upsertNode({
          id: branch.childId,
          parents: Array.from(parents),
          prompt: branch.prompt,
          tool: "plan_fanout",
          result: `pruned_depth>${this.maxDepth}`,
          score: -1,
          provenance,
          status: "pruned",
          startedAt,
          completedAt: this.now(),
        });
      }
    }

    this.persistJobThoughtGraph(record.jobId, cache);
    const pruned = this.enforceBranchLimit(record.jobId, record.runId, cache);
    if (pruned.length > 0) {
      this.logger?.warn("thought_graph_pruned_after_fanout", {
        job_id: record.jobId,
        run_id: record.runId,
        pruned,
      });
    }
  }

  /**
   * Records the outcome of a join and returns the recommended winner alongside
   * the pruned branches, if any. The ranking is derived from MetaCritic
   * assessments whenever summaries are available, falling back to heuristic
   * scores based on status and latency.
   */
  recordJoin(record: ThoughtJoinRecord): ThoughtJoinOutcome {
    if (!record.jobId) {
      return { winner: record.candidateWinner ?? null, ranking: [], pruned: [] };
    }
    const cache = this.ensureJobGraph(record.jobId);
    const rootId = this.ensureRunRoot(cache, {
      jobId: record.jobId,
      runId: record.runId,
      goal: null,
      parentChildId: null,
      plannerNodeId: null,
      branches: [],
      startedAt: this.now(),
    });

    const now = this.now();
    const scored: Array<{ childId: string; score: number | null; snapshot: ThoughtNodeSnapshot }>
      = [];

    for (const observation of record.observations) {
      const snapshot = cache.graph.getNode(observation.childId);
      if (!snapshot) {
        continue;
      }
      const score = this.computeBranchScore(observation);
      const status: ThoughtNodeStatus = observation.status === "success"
        ? "completed"
        : observation.status === "timeout"
          ? "errored"
          : "errored";

      cache.graph.upsertNode({
        id: observation.childId,
        parents: snapshot.parents,
        prompt: snapshot.prompt,
        tool: snapshot.tool,
        result: observation.summary,
        score,
        provenance: snapshot.provenance,
        status,
        startedAt: snapshot.startedAt,
        completedAt: now,
      });

      scored.push({ childId: observation.childId, score, snapshot });
    }

    const rootSnapshot = cache.graph.getNode(rootId);
    if (rootSnapshot) {
      const resultSummary = record.satisfied
        ? `winner=${record.candidateWinner ?? "none"}`
        : `unsatisfied policy=${record.policy}`;
      cache.graph.upsertNode({
        id: rootId,
        parents: rootSnapshot.parents,
        prompt: rootSnapshot.prompt,
        tool: "plan_join",
        result: resultSummary,
        score: null,
        provenance: rootSnapshot.provenance,
        status: record.satisfied ? "completed" : rootSnapshot.status,
        startedAt: rootSnapshot.startedAt,
        completedAt: record.satisfied ? now : rootSnapshot.completedAt,
      });
    }

    scored.sort((a, b) => compareBranches(a, b));
    const ranking = scored.map((entry) => entry.childId);
    const winner = selectWinner(ranking, record.candidateWinner);

    this.persistJobThoughtGraph(record.jobId, cache);
    const pruned = this.enforceBranchLimit(record.jobId, record.runId, cache);

    if (pruned.length > 0) {
      this.logger?.warn("thought_graph_pruned_after_join", {
        job_id: record.jobId,
        run_id: record.runId,
        pruned,
      });
    }

    return { winner, ranking, pruned };
  }

  private ensureJobGraph(jobId: string): ThoughtGraphCacheEntry {
    const existing = this.graphs.get(jobId);
    if (existing) {
      return existing;
    }
    const entry: ThoughtGraphCacheEntry = {
      graph: new ThoughtGraph({ maxNodes: 2048 }),
      metadata: new Map(),
    };
    this.graphs.set(jobId, entry);
    return entry;
  }

  private ensureRunRoot(cache: ThoughtGraphCacheEntry, record: ThoughtFanoutRecord): string {
    const rootId = `run:${record.runId}`;
    const existing = cache.graph.getNode(rootId);
    if (existing) {
      return rootId;
    }
    const prompt = record.goal ? `objectif: ${record.goal}` : `run ${record.runId}`;
    const parents = record.parentChildId ? [record.parentChildId] : [];

    cache.graph.upsertNode({
      id: rootId,
      parents,
      prompt,
      tool: "plan_run",
      result: null,
      score: null,
      provenance: [],
      status: "running",
      startedAt: record.startedAt,
      completedAt: null,
    });

    cache.metadata.set(rootId, {
      runId: record.runId,
      depth: 0,
      startedAt: record.startedAt,
      parent: record.parentChildId,
    });

    return rootId;
  }

  private computeBranchDepth(cache: ThoughtGraphCacheEntry, parents: string[]): number {
    let depth = 1;
    for (const parent of parents) {
      const parentMeta = cache.metadata.get(parent);
      if (parentMeta) {
        depth = Math.max(depth, parentMeta.depth + 1);
      }
    }
    return depth;
  }

  private computeBranchScore(observation: ThoughtJoinObservation): number {
    const guard = observation.valueGuard ?? null;
    if (guard && guard.allowed === false) {
      // Unsafe branches are demoted below timeout/error so dashboards surface
      // violations prominently even when the child produced a nominal answer.
      return -0.95;
    }
    if (observation.status === "timeout") {
      return -0.9;
    }
    if (observation.status === "error") {
      return -0.6;
    }

    let baseScore = 0.2;
    if (this.metaCritic && observation.summary) {
      try {
        const review = this.metaCritic.review(observation.summary, "plan", []);
        const scaled = review.overall * 2 - 1;
        baseScore = Number.isFinite(scaled) ? scaled : 0.3;
      } catch {
        baseScore = 0.3;
      }
    }

    if (guard && guard.allowed) {
      baseScore += this.computeValueGuardModifier(guard);
    }

    return clamp(baseScore, -1, 1);
  }

  /**
   * Converts the value guard margin into a bounded score adjustment. Strong
   * passes receive a boost while borderline approvals only nudge the branch.
   * Any lingering violations apply a soft penalty so cautious options stay
   * ahead of risky ones.
   */
  private computeValueGuardModifier(guard: ThoughtBranchGuardSnapshot): number {
    if (!guard.allowed) {
      return -0.95;
    }

    const defaultThreshold = this.valueGraph?.getDefaultThreshold() ?? guard.threshold;
    const margin = guard.score - guard.threshold;
    const slack = Math.max(0.05, 1 - defaultThreshold);
    const marginRatio = clamp(margin / slack, -1, 1);
    const violationPenalty = guard.violationCount > 0
      ? Math.min(0.4, guard.violationCount * 0.15)
      : 0;

    return clamp(marginRatio * 0.6 - violationPenalty, -0.6, 0.6);
  }

  private persistJobThoughtGraph(jobId: string, cache: ThoughtGraphCacheEntry): void {
    const snapshots = cache.graph.exportAll();
    const nodes = snapshots.map((snapshot) => {
      const meta = cache.metadata.get(snapshot.id);
      return {
        snapshot,
        runId: meta?.runId ?? null,
        depth: meta?.depth ?? 0,
      };
    });

    this.graphState.setThoughtGraph(jobId, {
      updatedAt: this.now(),
      nodes: nodes.map((entry) => ({
        id: entry.snapshot.id,
        parents: [...entry.snapshot.parents],
        prompt: entry.snapshot.prompt,
        tool: entry.snapshot.tool,
        result: entry.snapshot.result,
        score: entry.snapshot.score,
        status: entry.snapshot.status,
        startedAt: entry.snapshot.startedAt,
        completedAt: entry.snapshot.completedAt,
        provenance: entry.snapshot.provenance,
        depth: entry.depth,
        runId: entry.runId,
      })),
    });
  }

  private enforceBranchLimit(
    jobId: string,
    runId: string,
    cache: ThoughtGraphCacheEntry,
  ): string[] {
    const runNodeId = `run:${runId}`;
    const nodes = cache.graph.exportAll();
    const tracked = nodes.filter((node) =>
      node.id !== runNodeId &&
      node.status !== "pruned" &&
      node.parents.includes(runNodeId),
    );

    if (tracked.length <= this.maxBranches) {
      return [];
    }

    const ordered = tracked
      .map((node) => ({ node, score: node.score ?? -1 }))
      .sort((a, b) => compareSnapshots(a.node, b.node, a.score, b.score));

    const pruned = ordered.slice(this.maxBranches);
    const prunedIds: string[] = [];
    for (const { node } of pruned) {
      cache.graph.upsertNode({
        id: node.id,
        parents: node.parents,
        prompt: node.prompt,
        tool: node.tool,
        result: node.result ?? "pruned_by_scheduler",
        score: node.score,
        provenance: node.provenance,
        status: "pruned",
        startedAt: node.startedAt,
        completedAt: this.now(),
      });
      prunedIds.push(node.id);
    }

    if (prunedIds.length > 0) {
      this.persistJobThoughtGraph(jobId, cache);
    }

    return prunedIds;
  }
}

function compareBranches(
  a: { childId: string; score: number | null; snapshot: ThoughtNodeSnapshot },
  b: { childId: string; score: number | null; snapshot: ThoughtNodeSnapshot },
): number {
  const scoreA = a.score ?? -1;
  const scoreB = b.score ?? -1;
  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }
  const completedA = a.snapshot.completedAt ?? Number.POSITIVE_INFINITY;
  const completedB = b.snapshot.completedAt ?? Number.POSITIVE_INFINITY;
  if (completedA !== completedB) {
    return completedA - completedB;
  }
  if (a.snapshot.startedAt !== b.snapshot.startedAt) {
    return a.snapshot.startedAt - b.snapshot.startedAt;
  }
  return a.childId.localeCompare(b.childId);
}

/**
 * Prefers the highest ranked branch while still honouring the planner hint
 * when it already tops the scoring. This avoids promoting unsafe candidates
 * above safer alternatives once ValueGraph penalties are applied.
 */
function selectWinner(ranking: string[], candidate: string | null): string | null {
  if (ranking.length === 0) {
    return candidate;
  }
  if (candidate && ranking[0] === candidate) {
    return candidate;
  }
  return ranking[0];
}

function compareSnapshots(
  a: ThoughtNodeSnapshot,
  b: ThoughtNodeSnapshot,
  scoreA: number,
  scoreB: number,
): number {
  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }
  if ((a.completedAt ?? Infinity) !== (b.completedAt ?? Infinity)) {
    return (a.completedAt ?? Infinity) - (b.completedAt ?? Infinity);
  }
  if (a.startedAt !== b.startedAt) {
    return a.startedAt - b.startedAt;
  }
  return a.id.localeCompare(b.id);
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
