import { parentPort, workerData } from "node:worker_threads";

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

function serialiseError(error: unknown): GraphWorkerErrorMessage["error"] {
  if (error instanceof Error) {
    return {
      name: error.name ?? "Error",
      message: error.message,
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }
  return { name: "Error", message: typeof error === "string" ? error : JSON.stringify(error) };
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
    const message: GraphWorkerMessage = { ok: false, error: serialiseError(error) };
    parentPort.postMessage(message);
  }
}

void main();
