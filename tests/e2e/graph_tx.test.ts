import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import {
  configureRuntimeFeatures,
  getRuntimeFeatures,
  server as mcpServer,
} from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/**
 * Canonical JSON-RPC envelope returned by the HTTP fast-path. Each call mirrors the
 * layout implemented in {@link handleJsonRpc} where either a `result` or an `error`
 * object is attached to the response.  The tests only interact with the `result`
 * branch because tool failures are surfaced as structured payloads inside the
 * result field.
 */
interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: string | null;
  result?: T;
  error?: { code: number; message: string };
}

/** Descriptor returned by the `tx_begin` tool. */
interface TxBeginResult {
  op_id: string;
  tx_id: string;
  graph_id: string;
  base_version: number;
  graph: {
    graph_id: string;
    graph_version: number;
    nodes: Array<{ id: string }>;
    edges: Array<{ from: string; to: string }>;
  };
}

/** Result returned by the `tx_commit` tool when a transaction succeeds. */
interface TxCommitResult {
  op_id: string;
  tx_id: string;
  graph_id: string;
  version: number;
  graph: {
    graph_id: string;
    graph_version: number;
    nodes: Array<{ id: string }>;
    edges: Array<{ from: string; to: string }>;
  };
}

/** Result returned by `graph_patch` when the patch commits successfully. */
interface GraphPatchResult {
  op_id: string;
  graph_id: string;
  committed_version: number;
  base_version: number;
  operations_applied: number;
  changed: boolean;
  graph: {
    graph_version: number;
    nodes: Array<{ id: string }>;
    edges: Array<{ from: string; to: string }>;
  };
}

/** Snapshot describing the diff emitted by `graph_diff`. */
interface GraphDiffResult {
  op_id: string;
  graph_id: string;
  changed: boolean;
  operations: Array<{ op: string; path: string }>;
}

/** Structured payload serialised by {@link graphToolError}. */
interface ToolErrorPayload {
  ok?: boolean;
  error?: string;
  message?: string;
  hint?: string;
  details?: unknown;
}

/** Shape returned by `tx_rollback`. */
interface TxRollbackResult {
  op_id: string;
  graph_id: string;
  tx_id: string;
  version: number;
}

/**
 * Extracts the structured tool error embedded in the JSON-RPC result payload.  The
 * HTTP transport serialises tool failures as `isError: true` objects whose `content`
 * array contains a JSON document with the error code, message and optional hint.
 */
function extractToolError(result: unknown): ToolErrorPayload | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as { isError?: unknown; ok?: unknown; content?: unknown };
  const flagged = record.isError === true || record.ok === false;
  if (!flagged) {
    return null;
  }

  if (Array.isArray(record.content)) {
    for (const entry of record.content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const text = (entry as { text?: unknown }).text;
      if (typeof text !== "string" || text.trim().length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          const payload = parsed as ToolErrorPayload;
          if (typeof payload.error === "string") {
            return payload;
          }
        }
      } catch {
        // Ignore malformed JSON snippets and continue scanning the content entries.
      }
    }
  }

  return { error: undefined, message: undefined };
}

/**
 * Issues a JSON-RPC POST request against the HTTP fast-path.  The helper preserves
 * deterministic identifiers so each request can be correlated with the assertions
 * performed in the test cases.
 */
async function invokeJsonRpc<T>(
  baseUrl: string,
  method: string,
  params: unknown,
): Promise<{ status: number; envelope: JsonRpcEnvelope<T> }>
/**
 * Overload used for invocations that omit the `params` bag.  TypeScript retains the
 * caller intent so the helper stays ergonomic for the diff/commit calls that do not
 * require additional arguments.
 */
async function invokeJsonRpc<T>(
  baseUrl: string,
  method: string,
): Promise<{ status: number; envelope: JsonRpcEnvelope<T> }>;
async function invokeJsonRpc<T>(
  baseUrl: string,
  method: string,
  params?: unknown,
): Promise<{ status: number; envelope: JsonRpcEnvelope<T> }> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0" as const,
      id: randomUUID(),
      method,
      params,
    }),
  });
  const envelope = (await response.json()) as JsonRpcEnvelope<T>;
  return { status: response.status, envelope };
}

/**
 * Builds a deterministic graph identifier for each scenario.  Using sequential
 * suffixes avoids relying on random sources while preventing state collisions in
 * the shared registries managed by the MCP server.
 */
function buildGraphId(label: string, index: number): string {
  return `graph-e2e-${label}-${index}`;
}

/** Minimal descriptor used to seed the graph state for the transaction flows. */
function makeBaseGraph(graphId: string) {
  return {
    graph_id: graphId,
    graph_version: 1,
    name: "Transaction baseline",
    nodes: [
      { id: "ingest", label: "Ingest" },
      { id: "process", label: "Process" },
    ],
    edges: [{ from: "ingest", to: "process", label: "next" }],
    metadata: { owner: "graph-e2e" },
  } as const;
}

/**
 * Exercises the graph transaction suite exposed by the HTTP server.  The suite
 * covers three distinct flows:
 *
 * 1. Opening a transaction with an inline descriptor, confirming that diffing the
 *    untouched working copy reports no changes, and committing the transaction to
 *    publish the baseline version.
 * 2. Applying a JSON Patch directly to the committed graph, verifying that the
 *    diff between the previous and latest versions captures the node/edge additions,
 *    and observing the conflict raised when an outdated transaction attempts to
 *    commit after the patch.
 * 3. Attempting to apply an invalid patch to ensure the error surface encodes the
 *    stable `E-PATCH-APPLY` code and that the original transaction can be rolled
 *    back cleanly afterwards.
 */
describe("graph transactions over HTTP", function () {
  this.timeout(20_000);

  const logger = new StructuredLogger();
  let handle: HttpServerHandle | null = null;
  let baseUrl = "";
  let featuresSnapshot: FeatureToggles;
  let tokenSnapshot: string | undefined;
  let graphCounter = 0;

  before(async function () {
    const guard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (guard && guard !== "loopback-only") {
      this.skip();
    }

    tokenSnapshot = process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_TOKEN;

    featuresSnapshot = getRuntimeFeatures();
    configureRuntimeFeatures({
      ...featuresSnapshot,
      enableTx: true,
      enableLocks: true,
      enableDiffPatch: true,
      enableResources: true,
    });

    handle = await startHttpServer(
      mcpServer,
      {
        host: "127.0.0.1",
        port: 0,
        path: "/mcp",
        enableJson: true,
        stateless: true,
      },
      logger,
    );
    baseUrl = `http://127.0.0.1:${handle.port}/mcp`;
  });

  after(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    configureRuntimeFeatures(featuresSnapshot);
    if (tokenSnapshot === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = tokenSnapshot;
    }
  });

  afterEach(() => {
    graphCounter += 1;
  });

  it("commits a baseline transaction without mutations", async () => {
    const graphId = buildGraphId("baseline", graphCounter);
    const descriptor = makeBaseGraph(graphId);

    const begin = await invokeJsonRpc<TxBeginResult>(baseUrl, "tx_begin", {
      graph_id: graphId,
      owner: "graph-e2e",
      note: "seed baseline",
      graph: descriptor,
    });

    expect(begin.status).to.equal(200);
    expect(begin.envelope.error).to.equal(undefined);
    const beginResult = begin.envelope.result;
    expect(beginResult).to.not.equal(undefined);
    expect(beginResult?.base_version).to.equal(1);
    expect(beginResult?.graph.graph_id).to.equal(graphId);
    expect(beginResult?.graph.nodes.map((node) => node.id)).to.include.members(["ingest", "process"]);

    const diff = await invokeJsonRpc<GraphDiffResult>(baseUrl, "graph_diff", {
      graph_id: graphId,
      from: { graph: descriptor },
      to: { graph: descriptor },
    });

    expect(diff.status).to.equal(200);
    expect(diff.envelope.error).to.equal(undefined);
    const diffResult = diff.envelope.result;
    expect(diffResult).to.not.equal(undefined);
    expect(diffResult?.changed).to.equal(false);
    expect(diffResult?.operations).to.be.an("array").that.has.length(0);

    const commit = await invokeJsonRpc<TxCommitResult>(baseUrl, "tx_commit", {
      tx_id: beginResult?.tx_id,
    });

    expect(commit.status).to.equal(200);
    expect(commit.envelope.error).to.equal(undefined);
    const commitResult = commit.envelope.result;
    expect(commitResult).to.not.equal(undefined);
    expect(commitResult?.version).to.equal(1);
    expect(commitResult?.graph.graph_version).to.equal(1);
    expect(commitResult?.graph.nodes.map((node) => node.id)).to.include("ingest");
  });

  it("detects concurrent commits after applying a graph patch", async () => {
    const graphId = buildGraphId("patch", graphCounter);
    const descriptor = makeBaseGraph(graphId);

    // Seed the registry with an initial committed version so the diff selector
    // resolving by version can locate `v1` when the patch is applied.
    const seedBegin = await invokeJsonRpc<TxBeginResult>(baseUrl, "tx_begin", {
      graph_id: graphId,
      graph: descriptor,
      owner: "graph-e2e",
      note: "seed committed baseline",
    });
    expect(seedBegin.envelope.result).to.not.equal(undefined);
    await invokeJsonRpc<TxCommitResult>(baseUrl, "tx_commit", { tx_id: seedBegin.envelope.result?.tx_id });

    // Open a new transaction which will later conflict with the patch commit.
    const begin = await invokeJsonRpc<TxBeginResult>(baseUrl, "tx_begin", {
      graph_id: graphId,
      owner: "graph-e2e",
      note: "concurrent transaction",
    });
    const beginResult = begin.envelope.result;
    expect(beginResult).to.not.equal(undefined);

    const patchOps = [
      { op: "add", path: "/nodes/-", value: { id: "alpha", label: "Alpha" } },
      { op: "add", path: "/nodes/-", value: { id: "beta", label: "Beta" } },
      { op: "add", path: "/edges/-", value: { from: "alpha", to: "beta", label: "flow" } },
    ] as const;

    const patch = await invokeJsonRpc<GraphPatchResult>(baseUrl, "graph_patch", {
      graph_id: graphId,
      base_version: beginResult?.base_version,
      owner: "graph-e2e",
      note: "append alpha/beta segment",
      patch: patchOps,
    });

    expect(patch.status).to.equal(200);
    expect(patch.envelope.error).to.equal(undefined);
    const patchResult = patch.envelope.result;
    expect(patchResult).to.not.equal(undefined);
    expect(patchResult?.committed_version).to.equal((beginResult?.base_version ?? 0) + 1);
    expect(patchResult?.operations_applied).to.equal(3);
    const nodeIds = patchResult?.graph.nodes.map((node) => node.id) ?? [];
    expect(nodeIds).to.include.members(["alpha", "beta"]);

    const diff = await invokeJsonRpc<GraphDiffResult>(baseUrl, "graph_diff", {
      graph_id: graphId,
      from: { version: beginResult?.base_version },
      to: { latest: true },
    });

    expect(diff.status).to.equal(200);
    const diffResult = diff.envelope.result;
    expect(diffResult).to.not.equal(undefined);
    expect(diffResult?.changed).to.equal(true);
    const diffPaths = diffResult?.operations.map((entry) => entry.path) ?? [];
    expect(diffPaths.some((path) => path.includes("/nodes"))).to.equal(true);
    expect(diffPaths.some((path) => path.includes("/edges"))).to.equal(true);

    const commit = await invokeJsonRpc<unknown>(baseUrl, "tx_commit", {
      tx_id: beginResult?.tx_id,
    });

    const toolError = extractToolError(commit.envelope.result);
    expect(toolError).to.not.equal(null);
    expect(toolError?.error).to.equal("E-TX-CONFLICT");
    expect(toolError?.hint ?? "").to.satisfy((hint: string) => hint === "reload latest committed graph before retrying" || hint === undefined);
  });

  it("rolls back transactions after an invalid graph patch", async () => {
    const graphId = buildGraphId("invalid-patch", graphCounter);
    const descriptor = makeBaseGraph(graphId);

    const seedBegin = await invokeJsonRpc<TxBeginResult>(baseUrl, "tx_begin", {
      graph_id: graphId,
      graph: descriptor,
      owner: "graph-e2e",
      note: "seed for invalid patch",
    });
    await invokeJsonRpc<TxCommitResult>(baseUrl, "tx_commit", { tx_id: seedBegin.envelope.result?.tx_id });

    const begin = await invokeJsonRpc<TxBeginResult>(baseUrl, "tx_begin", {
      graph_id: graphId,
      owner: "graph-e2e",
      note: "transaction prior to invalid patch",
    });
    const beginResult = begin.envelope.result;
    expect(beginResult).to.not.equal(undefined);

    const invalidPatch = await invokeJsonRpc<unknown>(baseUrl, "graph_patch", {
      graph_id: graphId,
      base_version: beginResult?.base_version,
      owner: "graph-e2e",
      note: "attempt removal of missing node",
      patch: [{ op: "remove", path: "/nodes/99" }],
    });

    const invalidError = extractToolError(invalidPatch.envelope.result);
    expect(invalidError).to.not.equal(null);
    expect(invalidError?.error).to.equal("E-PATCH-APPLY");
    expect(invalidError?.message ?? "").to.include("path '/nodes/99'");

    const rollback = await invokeJsonRpc<TxRollbackResult>(baseUrl, "tx_rollback", {
      tx_id: beginResult?.tx_id,
    });

    expect(rollback.status).to.equal(200);
    expect(rollback.envelope.error).to.equal(undefined);
    const rollbackResult = rollback.envelope.result;
    expect(rollbackResult).to.not.equal(undefined);
    expect(rollbackResult?.graph_id).to.equal(graphId);
    expect(rollbackResult?.version).to.equal(beginResult?.base_version);
  });
});
