import { isMainThread, parentPort, workerData } from "node:worker_threads";

import type { JsonPatchOperation } from "../graph/diff.js";
import type { NormalisedGraph } from "../graph/types.js";
import { computeGraphChangeSet, type GraphChangeSetComputation } from "./graphChangeSet.js";

interface GraphWorkerPayload {
  readonly baseGraph: NormalisedGraph;
  readonly operations: JsonPatchOperation[];
}

interface GraphWorkerSuccessMessage {
  readonly ok: true;
  readonly result: GraphChangeSetComputation;
}

interface GraphWorkerErrorMessage {
  readonly ok: false;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
}

type GraphWorkerMessage = GraphWorkerSuccessMessage | GraphWorkerErrorMessage;

/**
 * Serialise arbitrary errors emitted by the worker into a JSON-friendly shape.
 *
 * The helper trims empty identifiers and omits optional properties entirely
 * instead of materialising them with `undefined`. Doing so keeps the worker
 * compatible with `exactOptionalPropertyTypes` while ensuring downstream
 * consumers never observe placeholder values in structured telemetry.
 */
export function serialiseGraphWorkerError(error: unknown): GraphWorkerErrorMessage["error"] {
  if (error instanceof Error) {
    const name = typeof error.name === "string" && error.name.trim().length > 0 ? error.name : "Error";
      const stack = typeof error.stack === "string" && error.stack.trim().length > 0 ? error.stack : undefined;
      // Construct the payload in a single expression so readonly properties stay
      // untouched once emitted. Mutating the object would violate the
      // `GraphWorkerErrorMessage` contract which marks every field as read-only
      // to mirror the shape exchanged with the parent thread.
      return {
        name,
        message: error.message,
        ...(stack ? { stack } : {}),
      } satisfies GraphWorkerErrorMessage["error"];
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : JSON.stringify(error),
  };
}

function assertParentPort(port: typeof parentPort): asserts port {
  if (!port) {
    throw new Error("graph worker initialisation failed: parentPort missing");
  }
}

async function main(): Promise<void> {
  assertParentPort(parentPort);
  const payload = workerData as GraphWorkerPayload;

  try {
    const result = computeGraphChangeSet(payload.baseGraph, payload.operations);
    const message: GraphWorkerMessage = { ok: true, result };
    parentPort.postMessage(message);
  } catch (error) {
    const message: GraphWorkerMessage = { ok: false, error: serialiseGraphWorkerError(error) };
    parentPort.postMessage(message);
  }
}

if (!isMainThread) {
  void main();
}
