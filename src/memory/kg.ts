import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import { KnowledgeGraph, type KnowledgeInsertResult, type KnowledgeQueryOptions, type KnowledgeQueryPattern, type KnowledgeTripleSnapshot } from "../knowledge/knowledgeGraph.js";
import type { Provenance } from "../types/provenance.js";
import { safePath } from "../gateways/fsArtifacts.js";

/** Options accepted by {@link PersistentKnowledgeGraph.create}. */
export interface PersistentKnowledgeGraphOptions {
  /** Directory storing the JSON snapshot of the knowledge graph. */
  directory: string;
  /** Optional file name override (defaults to `graph.json`). */
  fileName?: string;
  /** Optional clock injected into the underlying {@link KnowledgeGraph}. */
  now?: () => number;
}

/**
 * Wrapper around {@link KnowledgeGraph} that automatically persists the
 * orchestrator knowledge layer to disk. The helper mirrors the in-memory API so
 * existing tool handlers can continue to rely on the graph directly while the
 * persistence layer remains transparent.
 */
export class PersistentKnowledgeGraph {
  /** Underlying in-memory graph exposed to callers. */
  public readonly graph: KnowledgeGraph;
  private readonly filePath: string;

  private constructor(options: PersistentKnowledgeGraphOptions) {
    // Propagate the optional clock only when provided so the constructor stays
    // compatible with `exactOptionalPropertyTypes`.
    const graphOptions = options.now ? { now: options.now } : {};
    this.graph = new KnowledgeGraph(graphOptions);
    // Persist snapshots inside the caller-provided directory while disallowing
    // traversal via the optional `fileName` override. `safePath` mirrors the
    // child workspace guarantees so knowledge artefacts cannot be written
    // outside of their sandbox (e.g. when a misconfigured env passes "../").
    this.filePath = safePath(options.directory, options.fileName ?? "graph.json");
  }

  /**
   * Factory loading an existing snapshot if present. Callers typically store the
   * returned instance and access the in-memory graph via {@link graph}.
   */
  static async create(options: PersistentKnowledgeGraphOptions): Promise<PersistentKnowledgeGraph> {
    await mkdir(options.directory, { recursive: true });
    const persistence = new PersistentKnowledgeGraph(options);
    await persistence.load();
    return persistence;
  }

  /** Synchronous factory mirroring {@link create} for bootstrap code paths. */
  static createSync(options: PersistentKnowledgeGraphOptions): PersistentKnowledgeGraph {
    mkdirSync(options.directory, { recursive: true });
    const persistence = new PersistentKnowledgeGraph(options);
    persistence.loadSync();
    return persistence;
  }

  /** Persists the current knowledge graph snapshot to disk. */
  async persist(): Promise<void> {
    const snapshots = this.graph.exportAll();
    // Use a unique temporary file per persist call so concurrent upserts cannot
    // delete another writer's staging file before it is renamed into place.
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(snapshots, null, 2), "utf8");
    await rename(tmpPath, this.filePath);
  }

  /** Inserts or updates a triple and persists the result. */
  async upsert(triple: {
    subject: string;
    predicate: string;
    object: string;
    source?: string;
    confidence?: number;
    provenance?: Provenance[];
  }): Promise<KnowledgeInsertResult> {
    const result = this.graph.insert(triple);
    await this.persist();
    return result;
  }

  /** Proxies {@link KnowledgeGraph.query} for convenience. */
  query(pattern: KnowledgeQueryPattern, options?: KnowledgeQueryOptions) {
    return this.graph.query(pattern, options);
  }

  /** Proxies {@link KnowledgeGraph.exportAll}. */
  exportAll(): KnowledgeTripleSnapshot[] {
    return this.graph.exportAll();
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const payload = JSON.parse(raw) as KnowledgeTripleSnapshot[];
      this.graph.restore(payload);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private loadSync(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    const raw = readFileSync(this.filePath, "utf8");
    const payload = JSON.parse(raw) as KnowledgeTripleSnapshot[];
    this.graph.restore(payload);
  }
}
