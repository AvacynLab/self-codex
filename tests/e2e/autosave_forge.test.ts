/**
 * End-to-end regression coverage for the graph autosave facility and the Graph Forge
 * analyser.  The suite exercises the public HTTP JSON-RPC interface to guarantee the
 * workflows operate correctly in a stateless deployment:
 *
 * 1. `graph_state_autosave` must emit deterministic snapshots while the timer is
 *    active and stop mutating the artefact immediately after receiving the `stop`
 *    action.  The test watches the generated file, records the `saved_at` timestamps
 *    and confirms no additional ticks occur once the interval is cleared.
 * 2. `graph_forge_analyze` must accept inline DSL snippets, compile the graph and
 *    return both structural metadata and analysis reports without surfacing errors.
 */
import { after, afterEach, before, describe, it } from "mocha";
import { expect } from "chai";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { startHttpServer, type HttpServerHandle } from "../../src/httpServer.js";
import { StructuredLogger } from "../../src/logger.js";
import { configureRuntimeFeatures, getRuntimeFeatures, server as mcpServer } from "../../src/server.js";
import type { FeatureToggles } from "../../src/serverOptions.js";

/** Canonical JSON-RPC envelope returned by the HTTP fast-path. */
interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id: string | null;
  result?: T;
  error?: { code: number; message: string };
}

/** Response container returned by {@link invokeJsonRpc}. */
interface JsonRpcResponse<T> {
  status: number;
  envelope: JsonRpcEnvelope<T>;
}

/** Minimal projection of the autosave payload serialised by the tool. */
interface AutosavePayload {
  format?: string;
  ok?: boolean;
  status?: string;
  path?: string;
  interval_ms?: number;
  inactivity_threshold_ms?: number;
}

/** Snapshot describing the Graph Forge response payload. */
interface GraphForgePayload {
  entry_graph: string;
  source: { path: string | null; provided_inline: boolean; length: number };
  graph: {
    name: string;
    directives: Array<{ name: string; value: unknown }>;
    nodes: Array<{ id: string; attributes: Record<string, unknown> }>;
    edges: Array<{ from: string; to: string; attributes: Record<string, unknown> }>;
  };
  analyses_defined: Array<{ name: string; args: unknown[] }>;
  analyses_resolved: Array<{ name: string; source: string; args: unknown[]; result?: unknown; error?: unknown }>;
}

/** Describes the parsed autosave artefact stored on disk. */
interface AutosaveSnapshot {
  savedAt: string;
  raw: { metadata?: { saved_at?: string }; snapshot?: unknown };
}

/** Issues a JSON-RPC POST request against the stateless HTTP endpoint. */
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

/**
 * Extracts the JSON payload embedded inside the first textual content entry returned
 * by a tool.  Utilities in this file use the helper to avoid duplicating parsing
 * boilerplate.
 */
function parseStructuredTextPayload(result: unknown): unknown | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const record = result as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(record.content)) {
    return null;
  }
  for (const entry of record.content) {
    if (!entry || entry.type !== "text" || typeof entry.text !== "string") {
      continue;
    }
    const text = entry.text.trim();
    if (!text) {
      continue;
    }
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Reads and parses the autosave artefact written by the server.  The helper guards
 * against transient states (file missing or partially written) by returning `null`
 * instead of throwing so the polling loop can retry safely.
 */
async function readAutosaveSnapshot(path: string): Promise<AutosaveSnapshot | null> {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const rawContent = await readFile(path, "utf8");
    const parsed = JSON.parse(rawContent) as { metadata?: { saved_at?: string }; snapshot?: unknown };
    const savedAt = parsed?.metadata?.saved_at;
    if (typeof savedAt !== "string" || savedAt.length === 0) {
      return null;
    }
    return { savedAt, raw: parsed };
  } catch {
    return null;
  }
}

/**
 * Polls the autosave file until the requested number of distinct ticks have been
 * observed.  The implementation records every unique `saved_at` timestamp so callers
 * can subsequently assert quiescence after issuing the `stop` command.
 */
async function waitForAutosaveTicks(
  path: string,
  requiredTicks: number,
  pollIntervalMs = 25,
  timeoutMs = 5000,
): Promise<{ samples: string[]; lastSnapshot: AutosaveSnapshot }> {
  const seenOrder: string[] = [];
  const seenSet = new Set<string>();
  let lastSnapshot: AutosaveSnapshot | null = null;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await readAutosaveSnapshot(path);
    if (snapshot) {
      lastSnapshot = snapshot;
      if (!seenSet.has(snapshot.savedAt)) {
        seenSet.add(snapshot.savedAt);
        seenOrder.push(snapshot.savedAt);
        if (seenOrder.length >= requiredTicks) {
          return { samples: seenOrder, lastSnapshot: snapshot };
        }
      }
    }
    await delay(pollIntervalMs);
  }

  throw new Error(
    `Autosave artefact ${path} did not record ${requiredTicks} unique ticks within ${timeoutMs}ms`,
  );
}

/**
 * HTTP regression tests covering the autosave timer and Graph Forge analysis.
 * The suite provisions an isolated server instance to keep state between the
 * scenarios fully deterministic.
 */
describe("HTTP autosave and Graph Forge end-to-end coverage", function () {
  this.timeout(20_000);

  const logger = new StructuredLogger();
  let handle: HttpServerHandle | null = null;
  let baseUrl = "";
  let originalFeatures: FeatureToggles;
  let originalToken: string | undefined;
  const autosaveRelativePath = join("tmp", "autosave-forge-tests", "graph-autosave.json");
  const autosaveAbsolutePath = resolvePath(autosaveRelativePath);

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
      enableEventsBus: true,
      enableDiffPatch: true,
      enableIdempotency: true,
      enableLocks: true,
      enableTx: true,
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
    await rm(dirname(autosaveAbsolutePath), { recursive: true, force: true });
  });

  afterEach(async () => {
    if (handle) {
      await invokeJsonRpc(baseUrl, "graph_state_autosave", { action: "stop" });
    }
  });

  it("emits autosave ticks and stops mutating the artefact after quiescence", async () => {
    if (!handle) {
      throw new Error("HTTP server handle not initialised");
    }

    const startResponse = await invokeJsonRpc<{ content?: unknown[] }>(baseUrl, "graph_state_autosave", {
      action: "start",
      path: autosaveRelativePath,
      interval_ms: 75,
    });

    expect(startResponse.status).to.equal(200);
    const autosavePayload = parseStructuredTextPayload(startResponse.envelope.result) as AutosavePayload | null;
    expect(autosavePayload).to.not.equal(null);
    expect(autosavePayload?.status).to.equal("started");
    expect(autosavePayload?.path).to.equal(autosaveAbsolutePath);

    const { samples, lastSnapshot } = await waitForAutosaveTicks(autosaveAbsolutePath, 2, 25, 6000);
    expect(samples).to.have.lengthOf.at.least(2);

    const stopResponse = await invokeJsonRpc<{ content?: unknown[] }>(baseUrl, "graph_state_autosave", {
      action: "stop",
    });
    expect(stopResponse.status).to.equal(200);
    const stopPayload = parseStructuredTextPayload(stopResponse.envelope.result) as AutosavePayload | null;
    expect(stopPayload).to.not.equal(null);
    expect(stopPayload?.status).to.equal("stopped");

    const beforeStat = await stat(autosaveAbsolutePath);
    await delay(250);
    const afterStat = await stat(autosaveAbsolutePath);
    const finalSnapshot = await readAutosaveSnapshot(autosaveAbsolutePath);

    expect(afterStat.mtimeMs).to.equal(beforeStat.mtimeMs);
    expect(finalSnapshot?.savedAt).to.equal(lastSnapshot.savedAt);
  });

  it("compiles inline Graph Forge DSL and returns analysis results", async () => {
    if (!handle) {
      throw new Error("HTTP server handle not initialised");
    }

    const forgeDsl = [
      "graph Pipeline {",
      "  directive format table;",
      "  node Ingest { label: \"Data intake\" }",
      "  node Transform { label: \"Normalize\" }",
      "  edge Ingest -> Transform { weight: 1 }",
      "  @analysis shortestPath Ingest Transform;",
      "}",
    ].join("\n");

    const response = await invokeJsonRpc<{ content?: unknown[] }>(baseUrl, "graph_forge_analyze", {
      source: forgeDsl,
      entry_graph: "Pipeline",
    });

    expect(response.status).to.equal(200);
    const payload = parseStructuredTextPayload(response.envelope.result) as GraphForgePayload | null;
    expect(payload, "expected a Graph Forge payload").to.not.equal(null);
    expect(payload?.entry_graph).to.equal("Pipeline");
    expect(payload?.source.provided_inline).to.equal(true);
    expect(payload?.graph.nodes.map((node) => node.id)).to.include.members(["Ingest", "Transform"]);

    const definedNames = (payload?.analyses_defined ?? []).map((analysis) => analysis.name);
    expect(definedNames).to.include("shortestPath");

    const resolved = payload?.analyses_resolved ?? [];
    const shortestPath = resolved.find((analysis) => analysis.name === "shortestPath");
    expect(shortestPath, "expected shortestPath analysis result").to.not.equal(undefined);
    expect(shortestPath?.error).to.equal(undefined);
    expect(shortestPath?.result).to.be.an("object");
  });
});
