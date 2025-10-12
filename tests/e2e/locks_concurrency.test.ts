/**
 * End-to-end regression tests covering the cooperative graph locking protocol
 * exposed via the HTTP transport. The suite provisions the stateless MCP
 * server, acquires a lock as one holder and verifies that conflicting mutation
 * attempts issued by a different holder surface the canonical `E-LOCK-HELD`
 * error while authorised holders can keep mutating and release the lock
 * cleanly. The coverage complements the unit/integration suites by observing
 * the behaviour through the public JSON-RPC interface.
 */
import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/** Generic JSON-RPC envelope returned by the HTTP transport. */
interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: string | null;
  result?: T;
  error?: { code: number; message: string };
}

/** Shape returned by {@link invokeJsonRpc}. */
interface JsonRpcResponse<T> {
  status: number;
  envelope: JsonRpcEnvelope<T>;
}

/** Structured payload serialised when a tool reports an error. */
interface ToolErrorPayload {
  error?: string;
  hint?: string;
  message?: string;
  details?: unknown;
}

/** Descriptor returned by the `tx_begin` tool when seeding a graph. */
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

/** Result emitted once a transaction commits successfully. */
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

/** Structured response returned by `graph_patch` when it succeeds. */
interface GraphPatchResult {
  op_id: string;
  graph_id: string;
  base_version: number;
  committed_version: number;
  changed: boolean;
  operations_applied: number;
  graph: {
    graph_version: number;
    nodes: Array<{ id: string }>;
    edges: Array<{ from: string; to: string }>;
  };
}

/** Descriptor describing an acquired graph lock. */
interface GraphLockResult {
  op_id: string;
  lock_id: string;
  graph_id: string;
  holder: string;
  acquired_at: number;
  refreshed_at: number;
  expires_at: number | null;
}

/** Payload returned when a lock is released. */
interface GraphUnlockResult {
  op_id: string;
  lock_id: string;
  graph_id: string;
  holder: string;
  released_at: number;
  expired: boolean;
  expires_at: number | null;
}

/** Issues a JSON-RPC request against the provided endpoint. */
async function invokeJsonRpc<T>(baseUrl: string, method: string, params: unknown): Promise<JsonRpcResponse<T>> {
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

/** Extracts the structured tool error embedded in a JSON-RPC result payload. */
function extractToolError(result: unknown): ToolErrorPayload | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as { isError?: unknown; ok?: unknown; content?: unknown };
  const flagged = record.isError === true || record.ok === false;
  if (!flagged) {
    return null;
  }
  const content = record.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
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
          return parsed as ToolErrorPayload;
        }
      } catch {
        // Ignore malformed fragments and continue scanning the content array.
      }
    }
  }
  return null;
}

/**
 * Builds a deterministic graph identifier for each scenario. Sequential suffixes
 * keep the registry free from collisions without relying on random sources.
 */
function buildGraphId(label: string, index: number): string {
  return `graph-locks-${label}-${index}`;
}

/** Minimal graph descriptor used to seed the registry before acquiring locks. */
function makeBaseGraph(graphId: string) {
  return {
    graph_id: graphId,
    graph_version: 1,
    name: "Graph lock baseline",
    nodes: [
      { id: "ingest", label: "Ingest" },
      { id: "process", label: "Process" },
    ],
    edges: [{ from: "ingest", to: "process", label: "next" }],
    metadata: { owner: "graph-locks" },
  } as const;
}

/**
 * HTTP regression coverage validating that cooperative graph locks prevent
 * conflicting mutations and report actionable diagnostics.
 */
describe("graph lock concurrency over HTTP", function () {
  this.timeout(20_000);

  const logger = new StructuredLogger();
  let originalFeatures: FeatureToggles;
  let originalToken: string | undefined;
  let handle: HttpServerHandle | null = null;
  let baseUrl = "";
  let scenarioCounter = 0;

  before(async function () {
    const guard = (globalThis as { __OFFLINE_TEST_GUARD__?: string }).__OFFLINE_TEST_GUARD__;
    if (guard && guard !== "loopback-only") {
      this.skip();
    }

    originalToken = process.env.MCP_HTTP_TOKEN;
    delete process.env.MCP_HTTP_TOKEN;

    originalFeatures = getRuntimeFeatures();
    configureRuntimeFeatures({
      ...originalFeatures,
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
    configureRuntimeFeatures(originalFeatures);
    if (originalToken === undefined) {
      delete process.env.MCP_HTTP_TOKEN;
    } else {
      process.env.MCP_HTTP_TOKEN = originalToken;
    }
  });

  afterEach(() => {
    scenarioCounter += 1;
  });

  it("blocks conflicting graph_patch calls while allowing the lock holder", async () => {
    const graphId = buildGraphId("concurrent", scenarioCounter);
    const descriptor = makeBaseGraph(graphId);

    const seedBegin = await invokeJsonRpc<TxBeginResult>(baseUrl, "tx_begin", {
      graph_id: graphId,
      graph: descriptor,
      owner: "locks-e2e",
      note: "seed initial version",
    });
    expect(seedBegin.status).to.equal(200);
    const seedBeginResult = seedBegin.envelope.result;
    expect(seedBeginResult).to.not.equal(undefined);
    if (!seedBeginResult) {
      throw new Error("tx_begin did not return a payload");
    }

    const seedCommit = await invokeJsonRpc<TxCommitResult>(baseUrl, "tx_commit", { tx_id: seedBeginResult.tx_id });
    expect(seedCommit.status).to.equal(200);
    const seedCommitResult = seedCommit.envelope.result;
    expect(seedCommitResult).to.not.equal(undefined);
    if (!seedCommitResult) {
      throw new Error("tx_commit did not return a payload");
    }
    const baseVersion = seedCommitResult.version;

    const lockResponse = await invokeJsonRpc<GraphLockResult>(baseUrl, "graph_lock", {
      graph_id: graphId,
      holder: "owner_a",
      ttl_ms: 15_000,
    });
    expect(lockResponse.status).to.equal(200);
    const lockResult = lockResponse.envelope.result;
    expect(lockResult).to.not.equal(undefined);
    if (!lockResult) {
      throw new Error("graph_lock did not return a payload");
    }

    let lockId: string | null = lockResult.lock_id;
    try {
      const patchOperations = [
        { op: "add", path: "/nodes/-", value: { id: "qa", label: "QA" } },
      ] as const;

      const conflictingPatch = await invokeJsonRpc<unknown>(baseUrl, "graph_patch", {
        graph_id: graphId,
        base_version: baseVersion,
        owner: "owner_b",
        note: "attempt conflicting mutation",
        patch: patchOperations,
      });
      expect(conflictingPatch.status).to.equal(200);
      const conflictError = extractToolError(conflictingPatch.envelope.result);
      expect(conflictError).to.not.equal(null);
      expect(conflictError?.error).to.equal("E-LOCK-HELD");
      const conflictDetails = conflictError?.details as { holder?: string; graphId?: string } | undefined;
      expect(conflictDetails?.holder).to.equal("owner_a");
      expect(conflictDetails?.graphId).to.equal(graphId);

      const authorisedPatch = await invokeJsonRpc<GraphPatchResult>(baseUrl, "graph_patch", {
        graph_id: graphId,
        base_version: baseVersion,
        owner: "owner_a",
        note: "authorised mutation under lock",
        patch: patchOperations,
      });
      expect(authorisedPatch.status).to.equal(200);
      expect(authorisedPatch.envelope.error).to.equal(undefined);
      const authorisedResult = authorisedPatch.envelope.result;
      expect(authorisedResult).to.not.equal(undefined);
      if (!authorisedResult) {
        throw new Error("graph_patch with owner_a failed unexpectedly");
      }
      expect(authorisedResult.committed_version).to.equal(baseVersion + 1);
      const nodeIds = authorisedResult.graph.nodes.map((node) => node.id);
      expect(nodeIds).to.include("qa");

      const unlockResponse = await invokeJsonRpc<GraphUnlockResult>(baseUrl, "graph_unlock", {
        lock_id: lockId,
      });
      expect(unlockResponse.status).to.equal(200);
      expect(unlockResponse.envelope.error).to.equal(undefined);
      const unlockResult = unlockResponse.envelope.result;
      expect(unlockResult).to.not.equal(undefined);
      if (!unlockResult) {
        throw new Error("graph_unlock did not return a payload");
      }
      expect(unlockResult.expired).to.equal(false);
      expect(unlockResult.holder).to.equal("owner_a");
      lockId = null;
    } finally {
      if (lockId) {
        await invokeJsonRpc<GraphUnlockResult>(baseUrl, "graph_unlock", { lock_id: lockId }).catch(() => undefined);
      }
    }
  });
});
