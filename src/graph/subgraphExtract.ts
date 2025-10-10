import { promises as fs } from "fs";
import type { ErrnoException } from "../nodePrimitives.js";
import path from "path";

import { ensureDirectory, resolveWithin } from "../paths.js";
import type { GraphDescriptorPayload } from "../tools/graphTools.js";
import {
  SUBGRAPH_REGISTRY_KEY,
  collectMissingSubgraphDescriptors,
  resolveSubgraphDescriptor,
} from "./subgraphRegistry.js";

/** Options accepted when persisting a sub-graph descriptor to disk. */
export interface SubgraphExtractionOptions {
  /** Graph descriptor containing the registry of hierarchical plans. */
  graph: GraphDescriptorPayload;
  /** Identifier of the node flagged as a sub-graph. */
  nodeId: string;
  /** Run directory used to version the exported descriptor. */
  runId: string;
  /** Root directory hosting every child workspace. */
  childrenRoot: string;
  /** Optional directory name inside the run folder (defaults to `subgraphs`). */
  directoryName?: string;
  /** Optional clock override used by tests for deterministic timestamps. */
  now?: () => number;
}

/** Result returned after exporting a sub-graph descriptor. */
export interface SubgraphExtractionResult {
  runId: string;
  nodeId: string;
  subgraphRef: string;
  version: number;
  extractedAt: number;
  absolutePath: string;
  relativePath: string;
  descriptor: unknown;
  graphId: string | null;
  graphVersion: number | null;
}

/**
 * Normalise an identifier so it can safely be used within a file name. The
 * helper replaces characters outside `[a-z0-9_-]` with `-` while collapsing
 * consecutive separators.
 */
function sanitiseForFileName(identifier: string): string {
  const replaced = identifier.replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-");
  const trimmed = replaced.replace(/^[-_]+|[-_]+$/g, "");
  return trimmed.length > 0 ? trimmed.toLowerCase() : "subgraph";
}

/**
 * Persist the descriptor referenced by a sub-graph node inside the run
 * directory. Each export is versioned to keep an audit trail of the modelling
 * steps performed by the orchestrator.
 */
export async function extractSubgraphToFile(
  options: SubgraphExtractionOptions,
): Promise<SubgraphExtractionResult> {
  if (!options.nodeId.trim()) {
    throw new Error("subgraph node id must be provided");
  }
  if (!options.runId.trim()) {
    throw new Error("run identifier must be provided");
  }

  const node = options.graph.nodes.find((candidate) => candidate.id === options.nodeId);
  if (!node) {
    throw new Error(`node '${options.nodeId}' does not exist in the provided graph`);
  }
  const kind = node.attributes?.kind;
  if (kind !== "subgraph") {
    throw new Error(`node '${options.nodeId}' is not flagged as a subgraph node`);
  }
  const ref =
    typeof node.attributes?.ref === "string"
      ? node.attributes.ref
      : typeof node.attributes?.subgraph_ref === "string"
        ? node.attributes.subgraph_ref
        : null;
  if (!ref) {
    throw new Error(`node '${options.nodeId}' does not declare a subgraph reference`);
  }

  const missing = collectMissingSubgraphDescriptors(options.graph);
  if (missing.length > 0) {
    throw new Error(
      `subgraph descriptors missing for: ${missing.join(", ")}`,
    );
  }
  const descriptor = resolveSubgraphDescriptor(options.graph, ref);
  if (!descriptor) {
    throw new Error(`subgraph descriptor '${ref}' is not registered in metadata`);
  }

  const runDirectory = await ensureDirectory(options.childrenRoot, options.runId);
  const subdir = options.directoryName ?? "subgraphs";
  const targetDirectory = await ensureDirectory(options.childrenRoot, options.runId, subdir);

  const safeRef = sanitiseForFileName(ref);
  const entries = await fs.readdir(targetDirectory).catch((error: ErrnoException) => {
    if (error.code === "ENOENT") {
      return [] as string[];
    }
    throw error;
  });
  const pattern = new RegExp(`^${safeRef}\\.v(\\d+)\\.json$`);
  let maxVersion = 0;
  for (const entry of entries) {
    const match = entry.match(pattern);
    if (!match) {
      continue;
    }
    const candidate = Number.parseInt(match[1], 10);
    if (Number.isFinite(candidate) && candidate > maxVersion) {
      maxVersion = candidate;
    }
  }
  const nextVersion = maxVersion + 1;
  const fileName = `${safeRef}.v${String(nextVersion).padStart(3, "0")}.json`;
  const absolutePath = resolveWithin(targetDirectory, fileName);

  const extractedAt = options.now ? options.now() : Date.now();
  const payload = {
    run_id: options.runId,
    node_id: options.nodeId,
    subgraph_ref: ref,
    version: nextVersion,
    extracted_at: extractedAt,
    graph_id: options.graph.graph_id ?? null,
    graph_version: options.graph.graph_version ?? null,
    descriptor: structuredClone(descriptor),
    metadata_key: SUBGRAPH_REGISTRY_KEY,
  };

  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    runId: options.runId,
    nodeId: options.nodeId,
    subgraphRef: ref,
    version: nextVersion,
    extractedAt,
    absolutePath,
    relativePath: path.relative(runDirectory, absolutePath),
    descriptor: payload.descriptor,
    graphId: options.graph.graph_id ?? null,
    graphVersion: options.graph.graph_version ?? null,
  };
}
