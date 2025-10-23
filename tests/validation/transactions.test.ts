import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  collectHttpEnvironment,
  ensureRunStructure,
  type HttpEnvironmentSummary,
} from "../../src/validation/runSetup.js";
import {
  TRANSACTIONS_JSONL_FILES,
  buildDefaultTransactionCalls,
  runTransactionsPhase,
  type TransactionCallSpec,
} from "../../src/validation/transactions.js";

/** Extracts the authorisation header from the captured request. */
function resolveAuthorization(headers: HeadersInit | undefined): string | null {
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get("authorization");
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === "authorization") {
        return value;
      }
    }
    return null;
  }
  const record = headers as Record<string, string>;
  return record.authorization ?? record.Authorization ?? null;
}

/** Parses a request body captured during the fake fetch interactions. */
function parseRequestBody(init: RequestInit | undefined): unknown {
  if (!init || !init.body) {
    return null;
  }
  if (typeof init.body === "string") {
    return JSON.parse(init.body);
  }
  if (init.body instanceof URLSearchParams) {
    return Object.fromEntries(init.body.entries());
  }
  return null;
}

describe("transactions phase runner", () => {
  let workingDir: string;
  let runRoot: string;
  let environment: HttpEnvironmentSummary;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-transactions-"));
    runRoot = await ensureRunStructure(workingDir, "validation_test");
    environment = collectHttpEnvironment({
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "9999",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "transactions-secret",
    } as NodeJS.ProcessEnv);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("executes provided calls, resolves dynamic params, and persists artefacts", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { tx_id: "abc-123", events: [{ seq: 1, type: "started" }] } },
      { jsonrpc: "2.0", result: { ok: true } },
    ];

    const capturedRequests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({ url, init });
      const payload = responses.shift() ?? { jsonrpc: "2.0", error: { code: -1, message: "exhausted" } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const calls: TransactionCallSpec[] = [
      {
        scenario: "nominal",
        name: "tx_begin_probe",
        method: "tx_begin",
        params: { graph_id: "G_TEST", owner: "tester" },
      },
      {
        scenario: "nominal",
        name: "tx_commit_probe",
        method: "tx_commit",
        params: ({ previousCalls }) => {
          const beginOutcome = previousCalls.find((entry) => entry.call.name === "tx_begin_probe");
          const body = beginOutcome?.check.response.body as { result?: { tx_id?: string } } | undefined;
          return { tx_id: body?.result?.tx_id ?? "missing" };
        },
      },
    ];

    const outcomes = await runTransactionsPhase(runRoot, environment, calls);

    expect(outcomes).to.have.lengthOf(2);
    expect(capturedRequests).to.have.lengthOf(2);

    expect(Object.prototype.hasOwnProperty.call(outcomes[0]?.call ?? {}, "headers")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(outcomes[0]?.call ?? {}, "captureEvents")).to.equal(false);
    expect(Object.prototype.hasOwnProperty.call(outcomes[0]?.call ?? {}, "params")).to.equal(true);
    expect(Object.prototype.hasOwnProperty.call(outcomes[1]?.call ?? {}, "idempotencyKey")).to.equal(false);

    const authorisation = resolveAuthorization(capturedRequests[0]?.init?.headers);
    expect(authorisation).to.equal("Bearer transactions-secret");

    const secondBody = parseRequestBody(capturedRequests[1]?.init) as { params?: { tx_id?: string } };
    expect(secondBody?.params?.tx_id).to.equal("abc-123");

    const inputsContent = await readFile(join(runRoot, TRANSACTIONS_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(runRoot, TRANSACTIONS_JSONL_FILES.outputs), "utf8");
    const eventsContent = await readFile(join(runRoot, TRANSACTIONS_JSONL_FILES.events), "utf8");
    const logContent = await readFile(join(runRoot, TRANSACTIONS_JSONL_FILES.log), "utf8");

    const inputLines = inputsContent.trim().split("\n");
    const outputLines = outputsContent.trim().split("\n");
    const eventLines = eventsContent.trim().split("\n").filter(Boolean);

    expect(inputLines).to.have.lengthOf(2);
    expect(outputLines).to.have.lengthOf(2);
    expect(eventLines).to.have.lengthOf(1);

    const recordedEvent = JSON.parse(eventLines[0]);
    expect(recordedEvent.scenario).to.equal("nominal");
    expect(recordedEvent.source).to.equal("tx_begin_probe");

    expect(logContent).to.contain("tx_begin_probe");
    expect(logContent).to.contain("tx_commit_probe");
  });

  it("omits undefined events from the persisted artefacts", async () => {
    const responses = [
      {
        jsonrpc: "2.0",
        result: {
          tx_id: "abc-123",
          events: [undefined, { seq: 1, type: "defined", detail: "kept" }],
        },
      },
      { jsonrpc: "2.0", result: { ok: true } },
    ];

    const capturedRequests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({ url, init });
      const payload = responses.shift() ?? { jsonrpc: "2.0", error: { code: -1, message: "exhausted" } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const calls: TransactionCallSpec[] = [
      {
        scenario: "nominal",
        name: "tx_begin_probe",
        method: "tx_begin",
        params: { graph_id: "G_TEST", owner: "tester" },
      },
      {
        scenario: "nominal",
        name: "tx_commit_probe",
        method: "tx_commit",
        params: ({ previousCalls }) => {
          const beginOutcome = previousCalls.find((entry) => entry.call.name === "tx_begin_probe");
          const body = beginOutcome?.check.response.body as { result?: { tx_id?: string } } | undefined;
          return { tx_id: body?.result?.tx_id ?? "missing" };
        },
      },
    ];

    const outcomes = await runTransactionsPhase(runRoot, environment, calls);

    expect(outcomes).to.have.lengthOf(2);
    expect(capturedRequests).to.have.lengthOf(2);

    const eventsContent = await readFile(join(runRoot, TRANSACTIONS_JSONL_FILES.events), "utf8");
    const eventLines = eventsContent
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: unknown });

    expect(eventLines).to.have.lengthOf(1);
    expect(eventLines[0]?.event).to.deep.equal({ seq: 1, type: "defined", detail: "kept" });

    expect(outcomes[0]?.events).to.deep.equal([{ seq: 1, type: "defined", detail: "kept" }]);
  });

  it("supports the default call plan and records failure responses", async () => {
    const baseGraph = {
      name: "Validation baseline workflow",
      graph_id: "G_VALIDATION_SAMPLE",
      graph_version: 1,
      metadata: { stage: "transactions", variant: "baseline" },
      nodes: [
        { id: "ingest", label: "Ingest", attributes: { lane: "ingestion" } },
        { id: "analyse", label: "Analyse", attributes: { lane: "analysis" } },
      ],
      edges: [{ from: "ingest", to: "analyse", label: "flow", attributes: { channel: "primary" } }],
    };

    const committedGraph = {
      ...baseGraph,
      graph_version: 2,
      nodes: [
        ...baseGraph.nodes,
        { id: "ship", label: "Ship", attributes: { lane: "delivery" } },
      ],
      edges: [
        ...baseGraph.edges,
        { from: "analyse", to: "ship", label: "handoff", attributes: { channel: "secondary" } },
      ],
      metadata: { ...baseGraph.metadata, status: "committed" },
    };

    const patchOperations = [
      { op: "add", path: "/nodes/-", value: { id: "deliver", label: "Deliver", attributes: { lane: "customer" } } },
      { op: "add", path: "/edges/-", value: { from: "ship", to: "deliver", label: "handoff", attributes: { channel: "secondary" } } },
      { op: "replace", path: "/metadata/release_channel", value: "beta" },
      { op: "add", path: "/metadata/release_candidate", value: true },
    ];

    const patchedGraph = {
      ...committedGraph,
      graph_version: 3,
      nodes: [
        ...committedGraph.nodes,
        { id: "deliver", label: "Deliver", attributes: { lane: "customer" } },
      ],
      edges: [
        ...committedGraph.edges,
        { from: "ship", to: "deliver", label: "handoff", attributes: { channel: "secondary" } },
      ],
      metadata: { ...committedGraph.metadata, release_channel: "beta", release_candidate: true },
    };

    const cycleOperations = [
      { op: "add", path: "/edges/-", value: { from: "deliver", to: "ingest", label: "cycle", attributes: { channel: "loop" } } },
    ];

    const concurrencyOperations = [
      { op: "add", path: "/nodes/-", value: { id: "qa", label: "Quality", attributes: { lane: "quality" } } },
      { op: "add", path: "/edges/-", value: { from: "analyse", to: "qa", label: "handoff", attributes: { channel: "quality" } } },
    ];

    const responses = [
      { jsonrpc: "2.0", result: { tx_id: "tx-1", graph_id: baseGraph.graph_id, graph: baseGraph, base_version: 1 } },
      { jsonrpc: "2.0", result: { changed: false, operations: [] } },
      { jsonrpc: "2.0", result: { tx_id: "tx-1", graph: committedGraph } },
      { jsonrpc: "2.0", result: { tx_id: "tx-1", version: 2, graph: committedGraph } },
      { jsonrpc: "2.0", result: { changed: true, operations: [{ op: "test", path: "/metadata/status", value: "committed" }] } },
      { jsonrpc: "2.0", result: { changed: true, operations: patchOperations } },
      {
        jsonrpc: "2.0",
        result: {
          op_id: "graph_lock_op",
          lock_id: "lock-1",
          graph_id: baseGraph.graph_id,
          holder: "validation-harness",
          acquired_at: 1,
          refreshed_at: 1,
          expires_at: null,
        },
      },
      { jsonrpc: "2.0", result: { committed_version: 3, graph: patchedGraph, events: [{ seq: 5, type: "patched" }] } },
      { jsonrpc: "2.0", result: { changed: true, operations: cycleOperations } },
      { jsonrpc: "2.0", result: { tx_id: "tx-2", graph_id: baseGraph.graph_id, graph: patchedGraph, base_version: 3 } },
      {
        jsonrpc: "2.0",
        error: {
          code: 422,
          message: "cycle detected in transaction",
          data: { error: "E-TX-CYCLE", operation: 0 },
        },
      },
      { jsonrpc: "2.0", result: { tx_id: "tx-2", rolled_back: true, reason: "abort invalid patch replay" } },
      {
        jsonrpc: "2.0",
        error: { code: 123, message: "cycle detected", data: { error: "E-PATCH-CYCLE" } },
      },
      { jsonrpc: "2.0", result: { changed: true, operations: concurrencyOperations } },
      {
        jsonrpc: "2.0",
        error: {
          code: 409,
          message: "graph locked",
          data: { error: "E-LOCK-HELD", holder: "validation-harness" },
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          op_id: "graph_unlock_op",
          lock_id: "lock-1",
          graph_id: baseGraph.graph_id,
          holder: "validation-harness",
          released_at: 2,
          expired: false,
          expires_at: null,
        },
      },
      { jsonrpc: "2.0", result: { total: 1, values: [{ id: "v-1", type: "control" }] } },
      {
        jsonrpc: "2.0",
        result: {
          events: [{ id: "evt-1", type: "transaction", label: "commit", data: {}, tags: [], causes: [], effects: [], created_at: 0, ordinal: 1 }],
          total: 1,
        },
      },
    ];

    const capturedRequests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];

    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({ url, init });
      const payload = responses.shift() ?? { jsonrpc: "2.0", error: { code: -1, message: "exhausted" } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const outcomes = await runTransactionsPhase(runRoot, environment, buildDefaultTransactionCalls());

    expect(outcomes).to.have.lengthOf(18);
    expect(capturedRequests).to.have.lengthOf(18);

    const baselineDiff = parseRequestBody(capturedRequests[1]?.init) as { params?: { from?: unknown; to?: unknown } };
    expect(baselineDiff?.params?.from).to.deep.equal({ graph: baseGraph });
    expect(baselineDiff?.params?.to).to.deep.equal({ graph: baseGraph });

    const patchRequest = parseRequestBody(capturedRequests[7]?.init) as { params?: { patch?: unknown } };
    expect(patchRequest?.params?.patch).to.deep.equal(patchOperations);

    const invalidPatchRequest = parseRequestBody(capturedRequests[12]?.init) as { params?: { patch?: unknown } };
    expect(invalidPatchRequest?.params?.patch).to.deep.equal(cycleOperations);

    const transactionalApply = parseRequestBody(capturedRequests[10]?.init) as { params?: { tx_id?: string; operations?: unknown } };
    expect(transactionalApply?.params?.tx_id).to.equal("tx-2");
    expect(transactionalApply?.params?.operations).to.deep.equal(cycleOperations);

    const rollbackRequest = parseRequestBody(capturedRequests[11]?.init) as { params?: { tx_id?: string; reason?: string } };
    expect(rollbackRequest?.params?.tx_id).to.equal("tx-2");
    expect(rollbackRequest?.params?.reason).to.equal("abort invalid patch replay");

    const conflictingPatchRequest = parseRequestBody(capturedRequests[14]?.init) as { params?: { owner?: string } };
    expect(conflictingPatchRequest?.params?.owner).to.equal("validation-harness-b");

    const unlockRequest = parseRequestBody(capturedRequests[15]?.init) as { params?: { lock_id?: string } };
    expect(unlockRequest?.params?.lock_id).to.equal("lock-1");

    const eventsContent = await readFile(join(runRoot, TRANSACTIONS_JSONL_FILES.events), "utf8");
    const eventLines = eventsContent.trim().split("\n").filter(Boolean);
    const patchEvents = eventLines.filter((line) => line.includes("graph_patch_success"));
    expect(patchEvents).to.have.lengthOf(1);

    const outputsContent = await readFile(join(runRoot, TRANSACTIONS_JSONL_FILES.outputs), "utf8");
    const outputLines = outputsContent.trim().split("\n");
    expect(outputLines).to.have.lengthOf(18);

    const parsedOutputs = outputLines.map((line) => JSON.parse(line)) as Array<{ name: string; response: { body?: unknown } }>;
    const invariantOutput = parsedOutputs.find((entry) => entry.name === "graph_patch_invariant_violation");
    expect(invariantOutput?.response.body?.error?.data?.error).to.equal("E-PATCH-CYCLE");

    const transactionalError = parsedOutputs.find((entry) => entry.name === "tx_apply_invalid_patch");
    expect(transactionalError?.response.body?.error?.data?.error).to.equal("E-TX-CYCLE");

    const baselineOutput = parsedOutputs.find((entry) => entry.name === "graph_diff_baseline");
    expect(baselineOutput?.response.body?.result?.changed).to.equal(false);

    const conflictOutput = parsedOutputs.find((entry) => entry.name === "graph_patch_conflicting_holder");
    expect(conflictOutput?.response.body?.error?.data?.error).to.equal("E-LOCK-HELD");

    const causalArtefact = await readFile(join(runRoot, "artifacts/graphs/causal_export.json"), "utf8");
    const causalPayload = JSON.parse(causalArtefact);
    expect(causalPayload.total).to.equal(1);

    const valuesArtefact = await readFile(join(runRoot, "artifacts/graphs/values_graph_export.json"), "utf8");
    const valuesPayload = JSON.parse(valuesArtefact);
    expect(valuesPayload.total).to.equal(1);
  });
});
