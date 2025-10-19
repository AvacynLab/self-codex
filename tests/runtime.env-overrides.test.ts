/**
 * Focused tests covering the orchestrator runtime environment overrides. The
 * suite exercises the helper functions to ensure the centralised env parsing
 * keeps honouring the legacy defaults while tolerating invalid inputs.
 */
import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";

import { __envRuntimeInternals } from "../src/orchestrator/runtime.js";

const watchedEnvKeys = [
  "IDEMPOTENCY_TTL_MS",
  "MCP_MEMORY_VECTOR_MAX_DOCS",
  "RETRIEVER_K",
  "HYBRID_BM25",
  "THOUGHTGRAPH_MAX_BRANCHES",
  "THOUGHTGRAPH_MAX_DEPTH",
  "MCP_GRAPH_WORKERS",
  "MCP_GRAPH_POOL_THRESHOLD",
  "MCP_GRAPH_WORKER_TIMEOUT_MS",
] as const;

type WatchedKey = (typeof watchedEnvKeys)[number];

const originalValues: Partial<Record<WatchedKey, string | undefined>> = {};

function restoreEnv(): void {
  for (const key of watchedEnvKeys) {
    const original = originalValues[key];
    if (typeof original === "string") {
      process.env[key] = original;
    } else if (original === undefined) {
      delete process.env[key];
    }
  }
}

describe("orchestrator runtime env overrides", () => {
  beforeEach(() => {
    for (const key of watchedEnvKeys) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv();
  });

  it("honours the optional idempotency TTL override", () => {
    const { resolveIdempotencyTtlFromEnv } = __envRuntimeInternals;

    expect(resolveIdempotencyTtlFromEnv(), "default TTL").to.equal(undefined);

    process.env.IDEMPOTENCY_TTL_MS = "5000";
    expect(resolveIdempotencyTtlFromEnv(), "valid TTL").to.equal(5000);

    process.env.IDEMPOTENCY_TTL_MS = "-10";
    expect(resolveIdempotencyTtlFromEnv(), "negative values").to.equal(undefined);

    process.env.IDEMPOTENCY_TTL_MS = "abc";
    expect(resolveIdempotencyTtlFromEnv(), "non numeric").to.equal(undefined);
  });

  it("clamps the vector index capacity to positive integers", () => {
    const { resolveVectorIndexCapacity } = __envRuntimeInternals;

    expect(resolveVectorIndexCapacity(), "default capacity").to.equal(1024);

    process.env.MCP_MEMORY_VECTOR_MAX_DOCS = "2048";
    expect(resolveVectorIndexCapacity(), "explicit override").to.equal(2048);

    process.env.MCP_MEMORY_VECTOR_MAX_DOCS = "0";
    expect(resolveVectorIndexCapacity(), "zero fallback").to.equal(1024);
  });

  it("derives hybrid retriever options from the environment", () => {
    const { resolveHybridRetrieverOptions } = __envRuntimeInternals;

    const defaults = resolveHybridRetrieverOptions();
    expect(defaults.defaultLimit, "default limit").to.equal(6);
    expect(defaults.lexicalWeight, "default lexical weight").to.equal(0.25);
    expect(defaults.vectorWeight, "default vector weight").to.equal(0.75);

    process.env.RETRIEVER_K = "25";
    process.env.HYBRID_BM25 = "yes";
    const tuned = resolveHybridRetrieverOptions();
    expect(tuned.defaultLimit, "limit capped to 10").to.equal(10);
    expect(tuned.lexicalWeight, "bm25 lexical weight").to.equal(0.4);
    expect(tuned.vectorWeight, "bm25 vector weight").to.equal(0.6);
  });

  it("applies the thought-graph bounds while tolerating invalid input", () => {
    const { resolveThoughtGraphOptions } = __envRuntimeInternals;

    const defaults = resolveThoughtGraphOptions();
    expect(defaults.maxBranches, "default branches").to.equal(6);
    expect(defaults.maxDepth, "default depth").to.equal(4);

    process.env.THOUGHTGRAPH_MAX_BRANCHES = "18";
    process.env.THOUGHTGRAPH_MAX_DEPTH = "12";
    const tuned = resolveThoughtGraphOptions();
    expect(tuned.maxBranches, "custom branches").to.equal(18);
    expect(tuned.maxDepth, "depth capped to 10").to.equal(10);

    process.env.THOUGHTGRAPH_MAX_BRANCHES = "-5";
    const fallback = resolveThoughtGraphOptions();
    expect(fallback.maxBranches, "invalid branches fallback").to.equal(6);
  });

  it("configures the graph worker pool from env overrides", () => {
    const { resolveGraphWorkerPoolOptions } = __envRuntimeInternals;

    const defaults = resolveGraphWorkerPoolOptions();
    expect(defaults.maxWorkers, "default worker count").to.equal(0);
    expect(defaults.changeSetSizeThreshold, "default threshold").to.equal(6);
    expect(defaults.workerTimeoutMs, "no timeout").to.equal(undefined);

    process.env.MCP_GRAPH_WORKERS = "4";
    process.env.MCP_GRAPH_POOL_THRESHOLD = "0";
    process.env.MCP_GRAPH_WORKER_TIMEOUT_MS = "15000";
    const tuned = resolveGraphWorkerPoolOptions();
    expect(tuned.maxWorkers, "overridden worker count").to.equal(4);
    expect(tuned.changeSetSizeThreshold, "zero threshold allowed").to.equal(0);
    expect(tuned.workerTimeoutMs, "timeout applied").to.equal(15000);

    process.env.MCP_GRAPH_POOL_THRESHOLD = "-2";
    const fallback = resolveGraphWorkerPoolOptions();
    expect(fallback.changeSetSizeThreshold, "negative threshold fallback").to.equal(6);
  });
});
