import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  executeTransactionsCli,
  parseTransactionsCliOptions,
} from "../../src/validation/transactionsCli.js";
import { TRANSACTIONS_JSONL_FILES } from "../../src/validation/transactions.js";

function buildDefaultResponses() {
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
  };

  const patchOperations = [
    { op: "add", path: "/nodes/-", value: { id: "deliver", label: "Deliver", attributes: { lane: "customer" } } },
    { op: "add", path: "/edges/-", value: { from: "ship", to: "deliver", label: "handoff", attributes: { channel: "secondary" } } },
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
  };

  const cycleOperations = [
    { op: "add", path: "/edges/-", value: { from: "deliver", to: "ingest", label: "cycle", attributes: { channel: "loop" } } },
  ];

  const concurrencyOperations = [
    { op: "add", path: "/nodes/-", value: { id: "qa", label: "Quality", attributes: { lane: "quality" } } },
    { op: "add", path: "/edges/-", value: { from: "analyse", to: "qa", label: "handoff", attributes: { channel: "quality" } } },
  ];

  return [
    { jsonrpc: "2.0", result: { tx_id: "tx-1", graph_id: baseGraph.graph_id, graph: baseGraph, base_version: 1 } },
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
    { jsonrpc: "2.0", result: { committed_version: 3, graph: patchedGraph } },
    { jsonrpc: "2.0", result: { changed: true, operations: cycleOperations } },
    { jsonrpc: "2.0", error: { code: 123, message: "cycle detected", data: { error: "E-PATCH-CYCLE" } } },
    { jsonrpc: "2.0", result: { changed: true, operations: concurrencyOperations } },
    { jsonrpc: "2.0", error: { code: 409, message: "graph locked", data: { error: "E-LOCK-HELD" } } },
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
    {
      jsonrpc: "2.0",
      result: {
        events: [{ id: "evt-1", type: "transaction", label: "commit", data: {}, tags: [], causes: [], effects: [], created_at: 0, ordinal: 1 }],
        total: 1,
      },
    },
  ];
}

describe("transactions CLI", () => {
  let workingDir: string;
  let env: NodeJS.ProcessEnv;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-transactions-cli-"));
    env = {
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_HTTP_PORT: "9999",
      MCP_HTTP_PATH: "/mcp",
      MCP_HTTP_TOKEN: "transactions-cli-secret",
    } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const defaults = parseTransactionsCliOptions([]);
    expect(defaults).to.deep.equal({ baseDir: "runs" });

    const options = parseTransactionsCliOptions([
      "--run-id",
      "custom-run",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "/tmp/manual-run",
      "--unknown",
      "value",
    ]);
    expect(options).to.deep.equal({ runId: "custom-run", baseDir: "custom-runs", runRoot: "/tmp/manual-run" });
  });

  it("executes the default workflow and reports artefact locations", async () => {
    const responses = buildDefaultResponses();
    const capturedLogs: string[] = [];
    const logger = { log: (...args: unknown[]) => capturedLogs.push(args.join(" ")) };

    globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", error: { code: -1, message: "exhausted" } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await executeTransactionsCli({ baseDir: workingDir, runId: "validation_cli" }, env, logger);

    const expectedRoot = join(workingDir, "validation_cli");
    expect(result.runRoot).to.equal(expectedRoot);
    expect(result.outcomes).to.have.lengthOf(13);

    const inputsContent = await readFile(join(expectedRoot, TRANSACTIONS_JSONL_FILES.inputs), "utf8");
    const outputsContent = await readFile(join(expectedRoot, TRANSACTIONS_JSONL_FILES.outputs), "utf8");

    expect(inputsContent.trim().split("\n")).to.have.lengthOf(13);
    expect(outputsContent.trim().split("\n")).to.have.lengthOf(13);

    const causalArtefact = await readFile(join(expectedRoot, "artifacts/graphs/causal_export.json"), "utf8");
    expect(JSON.parse(causalArtefact).total).to.equal(1);

    expect(capturedLogs.some((line) => line.includes(TRANSACTIONS_JSONL_FILES.inputs))).to.equal(true);
    expect(capturedLogs.some((line) => line.includes(TRANSACTIONS_JSONL_FILES.log))).to.equal(true);
  });
});
