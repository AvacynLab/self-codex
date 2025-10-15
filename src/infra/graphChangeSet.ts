import type { JsonPatchOperation, GraphDiffResult } from "../graph/diff.js";
import { diffGraphs } from "../graph/diff.js";
import { applyGraphPatch } from "../graph/patch.js";
import type { NormalisedGraph } from "../graph/types.js";
import { validateGraph, type GraphValidationResult } from "../graph/validate.js";

/**
 * Structured result returned after applying a change-set to a graph.
 *
 * The data mirrors what the `graph_apply_change_set` façade expects so both the
 * worker-thread implementation and the in-process execution share the same
 * serialization format. Keeping the contract centralised avoids subtle drifts
 * when new fields are added to the validation or diff payloads.
 */
export interface GraphChangeSetComputation {
  /** Graph produced after the patch operations have been applied. */
  readonly patchedGraph: NormalisedGraph;
  /** Validation outcome including invariants and violations when relevant. */
  readonly validation: GraphValidationResult;
  /** Diff between the base graph and the patched result. */
  readonly diff: GraphDiffResult;
}

/**
 * Apply a RFC 6902 change-set to a graph and compute the associated validation
 * and diff artefacts. The helper is intentionally side-effect free so the
 * result can be cached or passed across worker boundaries safely.
 */
export function computeGraphChangeSet(
  baseGraph: NormalisedGraph,
  operations: readonly JsonPatchOperation[],
): GraphChangeSetComputation {
  const patchedGraph = applyGraphPatch(baseGraph, operations as JsonPatchOperation[]);
  const validation = validateGraph(patchedGraph);
  const diff = diffGraphs(baseGraph, patchedGraph);

  return {
    patchedGraph,
    validation,
    diff,
  } satisfies GraphChangeSetComputation;
}
