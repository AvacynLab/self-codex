import { mergeProvenance, normaliseProvenanceList, type Provenance } from "../types/provenance.js";

/** Accepted runtime states for a reasoning branch. */
export type ThoughtNodeStatus = "pending" | "running" | "completed" | "errored";

/**
 * Snapshot describing a reasoning branch within the orchestrator. The structure
 * purposefully captures provenance so downstream consensus stages can cite the
 * artefacts supporting a branch.
 */
export interface ThoughtNodeSnapshot {
  /** Stable identifier of the branch. */
  id: string;
  /** Parent branch identifiers providing causal lineage. */
  parents: string[];
  /** Prompt or instruction that spawned the branch. */
  prompt: string;
  /** Optional tool invoked while exploring the branch. */
  tool: string | null;
  /** Optional result summarising the branch outcome. */
  result: string | null;
  /** Optional numeric score assigned by critics. */
  score: number | null;
  /** Structured provenance metadata accumulated while reasoning. */
  provenance: Provenance[];
  /** Current lifecycle status of the branch. */
  status: ThoughtNodeStatus;
  /** Timestamp (ms) when the branch started. */
  startedAt: number;
  /** Timestamp (ms) when the branch completed, if available. */
  completedAt: number | null;
}

/** Input accepted when upserting a node in the thought graph. */
export interface ThoughtNodeInput {
  id: string;
  parents?: string[];
  prompt: string;
  tool?: string | null;
  result?: string | null;
  score?: number | null;
  provenance?: Provenance[];
  status?: ThoughtNodeStatus;
  startedAt: number;
  completedAt?: number | null;
}

/** Configuration options controlling {@link ThoughtGraph} behaviour. */
export interface ThoughtGraphOptions {
  /** Maximum number of nodes retained (older entries pruned first). */
  maxNodes?: number;
}

/**
 * Lightweight graph capturing alternative reasoning branches. The structure is
 * intentionally minimal for now and will be expanded when multi-path planning
 * is introduced. Provenance is always normalised to guarantee deterministic
 * serialisations.
 */
export class ThoughtGraph {
  private readonly nodes = new Map<string, ThoughtNodeSnapshot>();
  private readonly maxNodes: number;

  constructor(options: ThoughtGraphOptions = {}) {
    this.maxNodes = Math.max(1, options.maxNodes ?? 1024);
  }

  /** Inserts or updates a node and returns its snapshot. */
  upsertNode(input: ThoughtNodeInput): ThoughtNodeSnapshot {
    const parents = dedupeParents(input.parents ?? []);
    const existing = this.nodes.get(input.id);
    const provenance = existing
      ? mergeProvenance(existing.provenance, normaliseProvenanceList(input.provenance))
      : normaliseProvenanceList(input.provenance);

    const snapshot: ThoughtNodeSnapshot = {
      id: input.id,
      parents,
      prompt: input.prompt,
      tool: normaliseNullableString(input.tool),
      result: normaliseNullableString(input.result),
      score: normaliseScore(input.score),
      provenance,
      status: input.status ?? existing?.status ?? "pending",
      startedAt: input.startedAt,
      completedAt: input.completedAt ?? existing?.completedAt ?? null,
    };

    this.nodes.set(input.id, snapshot);
    this.enforceRetention();
    return cloneNode(snapshot);
  }

  /** Retrieves a node snapshot or null if the identifier is unknown. */
  getNode(id: string): ThoughtNodeSnapshot | null {
    const snapshot = this.nodes.get(id);
    return snapshot ? cloneNode(snapshot) : null;
  }

  /** Returns every node ordered deterministically by insertion time. */
  exportAll(): ThoughtNodeSnapshot[] {
    return Array.from(this.nodes.values(), cloneNode);
  }

  /** Removes every stored node. */
  clear(): void {
    this.nodes.clear();
  }

  private enforceRetention(): void {
    if (this.nodes.size <= this.maxNodes) {
      return;
    }
    const excess = this.nodes.size - this.maxNodes;
    const keys = Array.from(this.nodes.keys());
    for (let i = 0; i < excess; i += 1) {
      this.nodes.delete(keys[i]);
    }
  }
}

function dedupeParents(parents: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const parent of parents) {
    const trimmed = parent.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normaliseNullableString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normaliseScore(score: number | null | undefined): number | null {
  if (typeof score !== "number" || Number.isNaN(score)) {
    return null;
  }
  const clamped = Math.max(-1, Math.min(1, score));
  return Number.isFinite(clamped) ? clamped : null;
}

function cloneNode(node: ThoughtNodeSnapshot): ThoughtNodeSnapshot {
  return {
    ...node,
    parents: [...node.parents],
    provenance: node.provenance.map((entry) => ({ ...entry })),
  };
}
