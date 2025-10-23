#!/usr/bin/env node
"use strict";

/**
 * Evaluation harness responsible for stressing the MCP orchestrator with
 * adversarial scenarios. The script issues intentionally malformed JSON-RPC
 * calls, exercises out-of-order tool invocations, verifies large payload
 * handling, and performs metamorphic graph checks. Artefacts are persisted
 * under `runs/validation_<timestamp>/` together with a human readable summary.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { createRunContext } from "../lib/validation/run-context.mjs";
import { ArtifactRecorder } from "../lib/validation/artifact-recorder.mjs";
import { McpSession, McpToolCallError } from "../lib/validation/mcp-session.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_PHASE = "evaluation";

/** Feature toggles required by the evaluation scenarios. */
const EVAL_FEATURE_OVERRIDES = Object.freeze({
  enableMcpIntrospection: true,
  enableTx: true,
  enableDiffPatch: true,
  enableChildOpsFine: true,
  enablePlanner: true,
});

/** Remove volatile fields from graph descriptors to enable deterministic comparisons. */
function normaliseGraphDescriptor(graph) {
  if (!graph || typeof graph !== "object") {
    return graph;
  }
  const clone = JSON.parse(JSON.stringify(graph));
  if (clone && typeof clone === "object" && "graph_version" in clone) {
    delete clone.graph_version;
  }
  return clone;
}

/** Extracts comparable slices (sorted nodes/edges) to check structural equality. */
function simplifyGraphStructure(graph) {
  if (!graph || typeof graph !== "object") {
    return null;
  }
  const normalised = normaliseGraphDescriptor(graph);
  const nodes = Array.isArray(normalised?.nodes) ? [...normalised.nodes] : [];
  const edges = Array.isArray(normalised?.edges) ? [...normalised.edges] : [];
  nodes.sort((a, b) => {
    const left = typeof a?.id === "string" ? a.id : "";
    const right = typeof b?.id === "string" ? b.id : "";
    return left.localeCompare(right);
  });
  edges.sort((a, b) => {
    const left = `${a?.from ?? ""}|${a?.to ?? ""}|${a?.label ?? ""}`;
    const right = `${b?.from ?? ""}|${b?.to ?? ""}|${b?.label ?? ""}`;
    return left.localeCompare(right);
  });
  return { nodes, edges };
}

/** Utility computing an interpolated percentile. */
function computePercentile(samples, percentile) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

/** Formats the evaluation summary table. */
function formatSummaryTable(operations) {
  const header = `| Operation | Expected | Status | Duration (ms) | Trace ID | Details |`;
  const rows = operations.map((op) => {
    const expected = op.expected;
    const duration = typeof op.durationMs === "number" ? op.durationMs.toFixed(2) : "-";
    const details = op.details ? op.details.slice(0, 120) : "-";
    const trace = op.traceId ?? "-";
    return `| ${op.label} | ${expected} | ${op.status} | ${duration} | ${trace} | ${details} |`;
  });
  return [header, ...rows].join("\n");
}

/** Records an assertion step while capturing latency metadata. */
async function recordAssertion(operations, label, assertion) {
  const startedAt = process.hrtime.bigint();
  try {
    await assertion();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    operations.push({ label, expected: "ok", status: "ok", durationMs, traceId: null, details: null });
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const message = error instanceof Error ? error.message : String(error);
    operations.push({ label, expected: "ok", status: "error", durationMs, traceId: null, details: message });
    throw error;
  }
}

/**
 * Executes the evaluation campaign and records artefacts.
 *
 * @param {{
 *   runId?: string,
 *   runRoot?: string,
 *   traceSeed?: string,
 *   timestamp?: string | Date,
 *   graphId?: string,
 *   featureOverrides?: Record<string, unknown>,
 * }} [options]
 */
export async function run(options = {}) {
  const timestampSource = options.timestamp ?? new Date().toISOString();
  const timestampIso = timestampSource instanceof Date ? timestampSource.toISOString() : String(timestampSource);
  const sanitizedTimestamp = timestampIso.replace(/[:.]/g, "-");
  const runId = options.runId ?? `validation_${sanitizedTimestamp}`;
  const runContext = await createRunContext({
    runId,
    workspaceRoot: ROOT_DIR,
    runRoot: options.runRoot,
    traceSeed: options.traceSeed,
  });
  const recorder = new ArtifactRecorder(runContext);
  const session = new McpSession({
    context: runContext,
    recorder,
    clientName: "eval-harness",
    clientVersion: "0.2.0",
    featureOverrides: { ...EVAL_FEATURE_OVERRIDES, ...(options.featureOverrides ?? {}) },
  });

  const operations = [];

  /**
   * Helper executing a single MCP tool call while enforcing expectations and
   * recording latency metadata.
   */
  async function executeTool(label, toolName, payload, { expected = "ok", phaseId = DEFAULT_PHASE } = {}) {
    const startedAt = process.hrtime.bigint();
    try {
      const call = await session.callTool(toolName, payload, { phaseId });
      const durationMs = call.durationMs ?? Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      if (expected === "error") {
        operations.push({
          label,
          expected,
          status: "unexpected_success",
          durationMs,
          traceId: call.traceId ?? null,
          details: "call succeeded but failure was expected",
        });
        throw new Error(`${label} succeeded but failure was expected`);
      }
      operations.push({
        label,
        expected,
        status: "ok",
        durationMs,
        traceId: call.traceId ?? null,
        details: null,
      });
      return call;
    } catch (error) {
      const durationMs = error instanceof McpToolCallError
        ? error.durationMs
        : Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const traceId = error instanceof McpToolCallError ? error.traceId : null;
      const message = error instanceof Error ? error.message : String(error);
      if (expected === "error") {
        operations.push({
          label,
          expected,
          status: "expected_error",
          durationMs,
          traceId,
          details: message,
        });
        return { error, traceId, durationMs };
      }
      operations.push({ label, expected, status: "error", durationMs, traceId, details: message });
      throw error;
    }
  }

  const originalStateless = process.env.MCP_HTTP_STATELESS;
  process.env.MCP_HTTP_STATELESS = "yes";

  let currentVersion = 1;
  let baselineGraphDescriptor = null;

  try {
    await session.open();

    const graphId = options.graphId ?? "eval-graph";
    const baseGraph = {
      graph_id: graphId,
      graph_version: 1,
      name: "Evaluation Baseline",
      nodes: [
        { id: "alpha", label: "Alpha", attributes: {} },
        { id: "beta", label: "Beta", attributes: {} },
      ],
      edges: [
        { from: "alpha", to: "beta", label: "link", attributes: {} },
      ],
      metadata: { owner: "eval" },
    };

    const begin = await executeTool("tx_begin (bootstrap)", "tx_begin", {
      graph_id: graphId,
      owner: "eval", 
      note: "bootstrap evaluation graph",
      graph: baseGraph,
    });
    const beginContent = begin.response?.structuredContent ?? {};
    const txId = typeof beginContent.tx_id === "string" ? beginContent.tx_id : null;
    if (!txId) {
      throw new Error("tx_begin did not return a tx_id");
    }

    const commit = await executeTool("tx_commit (bootstrap)", "tx_commit", { tx_id: txId });
    const commitContent = commit.response?.structuredContent ?? {};
    baselineGraphDescriptor = commitContent.graph ?? beginContent.graph ?? baseGraph;
    baselineGraphDescriptor = baselineGraphDescriptor
      ? JSON.parse(JSON.stringify(baselineGraphDescriptor))
      : null;
    currentVersion = typeof commitContent.version === "number"
      ? commitContent.version
      : (baselineGraphDescriptor?.graph_version ?? 1);

    // --- Scenario 1: JSON-RPC fuzzing (unknown methods) ---
    const fuzzNames = ["__proto__", "nonexistent_tool", "graph_patch!", "child_send?bad", ""];
    for (const name of fuzzNames) {
      const methodName = name.trim().length > 0 ? name : "";
      await executeTool(`fuzz_invalid_method:${methodName || "blank"}`,
        methodName || " ",
        { noise: Math.random(), nested: { value: Math.random().toString(36) } },
        { expected: "error" });
    }

    // --- Scenario 2: Out-of-order operations ---
    await executeTool("child_send before spawn", "child_send", {
      child_id: "missing-child",
      payload: { type: "prompt", content: "ping" },
      expect: "final",
      timeout_ms: 1_000,
    }, { expected: "error" });

    await executeTool("tx_commit without begin", "tx_commit", { tx_id: "00000000-0000-4000-8000-000000000000" }, { expected: "error" });

    // --- Scenario 3: Large payload patch and rollback ---
    const largeValue = "L".repeat(48_000);
    const addLarge = await executeTool("graph_patch large attribute", "graph_patch", {
      graph_id: graphId,
      base_version: currentVersion,
      owner: "eval",
      note: "add-large-attribute",
      patch: [
        { op: "add", path: "/nodes/0/attributes/large_note", value: largeValue },
      ],
    });
    const addLargeContent = addLarge.response?.structuredContent ?? {};
    currentVersion = typeof addLargeContent.committed_version === "number"
      ? addLargeContent.committed_version
      : currentVersion;

    const removeLarge = await executeTool("graph_patch remove large attribute", "graph_patch", {
      graph_id: graphId,
      base_version: currentVersion,
      owner: "eval",
      note: "remove-large-attribute",
      patch: [
        { op: "remove", path: "/nodes/0/attributes/large_note" },
      ],
    });
    const removeLargeContent = removeLarge.response?.structuredContent ?? {};
    currentVersion = typeof removeLargeContent.committed_version === "number"
      ? removeLargeContent.committed_version
      : currentVersion;

    await recordAssertion(operations, "verify large attribute removed", () => {
      const graph = removeLargeContent.graph;
      if (!graph) {
        throw new Error("graph_patch remove response missing graph");
      }
      const hasAttribute = Boolean(graph.nodes?.[0]?.attributes?.large_note);
      if (hasAttribute) {
        throw new Error("large attribute still present after removal");
      }
    });

    // --- Scenario 4: Metamorphic patch add/remove ---
    const addNode = await executeTool("graph_patch metamorphic add", "graph_patch", {
      graph_id: graphId,
      base_version: currentVersion,
      owner: "eval",
      note: "add-delta-node",
      patch: [
        { op: "add", path: "/nodes/-", value: { id: "delta", label: "Delta", attributes: {} } },
        { op: "add", path: "/edges/-", value: { from: "beta", to: "delta", label: "fanout", attributes: {} } },
      ],
    });
    const addNodeContent = addNode.response?.structuredContent ?? {};
    currentVersion = typeof addNodeContent.committed_version === "number"
      ? addNodeContent.committed_version
      : currentVersion;

    const removeNode = await executeTool("graph_patch metamorphic remove", "graph_patch", {
      graph_id: graphId,
      base_version: currentVersion,
      owner: "eval",
      note: "remove-delta-node",
      patch: [
        { op: "remove", path: "/edges/1" },
        { op: "remove", path: "/nodes/2" },
      ],
    });
    const removeNodeContent = removeNode.response?.structuredContent ?? {};
    currentVersion = typeof removeNodeContent.committed_version === "number"
      ? removeNodeContent.committed_version
      : currentVersion;

    await recordAssertion(operations, "metamorphic equality", () => {
      if (!baselineGraphDescriptor) {
        throw new Error("baseline graph descriptor unavailable");
      }
      const revertedGraph = removeNodeContent.graph;
      if (!revertedGraph) {
        throw new Error("graph_patch metamorphic remove response missing graph");
      }
      const baselineJson = JSON.stringify(simplifyGraphStructure(baselineGraphDescriptor));
      const revertedJson = JSON.stringify(simplifyGraphStructure(revertedGraph));
      if (baselineJson !== revertedJson) {
        throw new Error("graph descriptor differs after metamorphic cycle");
      }
    });
  } finally {
    if (originalStateless === undefined) {
      delete process.env.MCP_HTTP_STATELESS;
    } else {
      process.env.MCP_HTTP_STATELESS = originalStateless;
    }
    await session.close().catch(() => {});
  }

  const durations = operations
    .map((op) => op.durationMs)
    .filter((value) => typeof value === "number");
  const p50 = computePercentile(durations, 50);
  const p95 = computePercentile(durations, 95);
  const p99 = computePercentile(durations, 99);

  const consideredOperations = operations.filter((op) => op.status !== "expected_error");
  const errorStatuses = new Set(["error", "unexpected_success"]);
  const errorCount = consideredOperations.filter((op) => errorStatuses.has(op.status)).length;
  const errorRate = consideredOperations.length
    ? (errorCount / consideredOperations.length) * 100
    : 0;

  const statusCounts = operations.reduce((acc, op) => {
    acc[op.status] = (acc[op.status] ?? 0) + 1;
    return acc;
  }, {});

  const summaryLines = [
    `# Evaluation Validation Run — ${runId}`,
    "",
    "## Latency Summary",
    p50 !== null ? `- p50: ${p50.toFixed(2)} ms` : "- p50: n/a",
    p95 !== null ? `- p95: ${p95.toFixed(2)} ms` : "- p95: n/a",
    p99 !== null ? `- p99: ${p99.toFixed(2)} ms` : "- p99: n/a",
    `- error rate: ${errorRate.toFixed(2)}% (${errorCount}/${consideredOperations.length || 0})`,
    "",
    "## Status Counts",
  ];

  for (const [status, count] of Object.entries(statusCounts)) {
    summaryLines.push(`- ${status}: ${count}`);
  }

  summaryLines.push("", "## Operations", formatSummaryTable(operations));

  const summaryPath = join(runContext.rootDir, "summary.md");
  await writeFile(summaryPath, summaryLines.join("\n"), "utf8");

  return { runId, summaryPath, runRoot: runContext.rootDir, operations };
}

/**
 * Lightweight CLI argument parser used when the harness is invoked directly
 * from `node scripts/validation/run-eval.mjs`.  The parser purposely avoids any
 * third-party dependency so the script stays compatible with minimal CI
 * environments that only provide Node.js.
 *
 * Recognised flags:
 *   --run-id <string>
 *   --run-root <path>
 *   --workspace-root <path>
 *   --timestamp <iso8601>
 *   --graph-id <string>
 *   --trace-seed <string>
 *   --feature <key=value>
 *   --help / -h
 *
 * @param {string[]} argv raw CLI arguments (typically `process.argv.slice(2)`).
 * @returns {{ options: { runId?: string, runRoot?: string, workspaceRoot?: string, timestamp?: string, graphId?: string, traceSeed?: string, featureOverrides: Record<string, unknown> }, errors: string[], helpRequested: boolean }}
 */
export function parseCliArgs(argv) {
  const options = {
    featureOverrides: {},
  };
  const errors = [];
  let helpRequested = false;

  /** Coerces CLI values into sensible JavaScript primitives. */
  function coerceValue(raw) {
    if (raw === "true" || raw === "false") {
      return raw === "true";
    }
    if (raw === "null") {
      return null;
    }
    if (raw === "undefined") {
      return undefined;
    }
    const numeric = Number(raw);
    if (!Number.isNaN(numeric) && raw.trim() !== "") {
      return numeric;
    }
    return raw;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      helpRequested = true;
      continue;
    }

    const consumeValue = () => {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        errors.push(`Missing value for ${token}`);
        return undefined;
      }
      return value;
    };

    switch (token) {
      case "--run-id": {
        const value = consumeValue();
        if (value !== undefined) {
          options.runId = value;
        }
        break;
      }
      case "--run-root": {
        const value = consumeValue();
        if (value !== undefined) {
          options.runRoot = resolve(value);
        }
        break;
      }
      case "--workspace-root": {
        const value = consumeValue();
        if (value !== undefined) {
          options.workspaceRoot = resolve(value);
        }
        break;
      }
      case "--timestamp": {
        const value = consumeValue();
        if (value !== undefined) {
          options.timestamp = value;
        }
        break;
      }
      case "--graph-id": {
        const value = consumeValue();
        if (value !== undefined) {
          options.graphId = value;
        }
        break;
      }
      case "--trace-seed": {
        const value = consumeValue();
        if (value !== undefined) {
          options.traceSeed = value;
        }
        break;
      }
      case "--feature": {
        const value = consumeValue();
        if (value !== undefined) {
          const [key, rawValue] = value.split("=", 2);
          if (!key || rawValue === undefined) {
            errors.push(`Invalid feature override "${value}". Expected key=value.`);
          } else {
            options.featureOverrides[key] = coerceValue(rawValue);
          }
        }
        break;
      }
      default: {
        if (token.startsWith("--feature=")) {
          const raw = token.slice("--feature=".length);
          const [key, rawValue] = raw.split("=", 2);
          if (!key || rawValue === undefined) {
            errors.push(`Invalid feature override "${raw}". Expected key=value.`);
          } else {
            options.featureOverrides[key] = coerceValue(rawValue);
          }
          break;
        }

        if (token.startsWith("--")) {
          errors.push(`Unknown option ${token}`);
        } else {
          errors.push(`Unexpected argument ${token}`);
        }
        break;
      }
    }
  }

  return { options, errors, helpRequested };
}

/** Prints the CLI usage banner for the evaluation harness. */
function printHelp() {
  const lines = [
    "Usage: node scripts/validation/run-eval.mjs [options]",
    "",
    "Options:",
    "  --run-id <id>           Override the validation run identifier.",
    "  --run-root <path>       Write artefacts under the provided directory.",
    "  --workspace-root <path> Explicit workspace root (defaults to repo root).",
    "  --timestamp <iso8601>   Timestamp used for artefact naming.",
    "  --graph-id <string>     Graph identifier exercised by the campaign.",
    "  --trace-seed <string>   Deterministic seed for trace identifiers.",
    "  --feature key=value     Override evaluation feature toggles (repeatable).",
    "  -h, --help              Display this help message.",
  ];
  console.log(lines.join("\n"));
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === resolve(entry);
}

/**
 * Builds the sanitized option bag passed to {@link run}.  The helper drops
 * fields that the operator did not explicitly provide so the downstream
 * execution context never receives placeholder `undefined` values.  This keeps
 * the script compatible with `exactOptionalPropertyTypes` while documenting the
 * intent for future maintainers.
 */
export function normaliseRunInvocationOptions(options) {
  const sanitizedFeatureOverrides =
    options.featureOverrides && Object.keys(options.featureOverrides).length > 0
      ? { ...options.featureOverrides }
      : undefined;

  /**
   * Collect the tuple representation first so we can easily filter out entries
   * carrying `undefined`.  This ensures the final object mirrors the explicit
   * CLI input without leaking implicit defaults.
   */
  const pairs = [
    ["runId", options.runId],
    ["runRoot", options.runRoot],
    ["workspaceRoot", options.workspaceRoot],
    ["timestamp", options.timestamp],
    ["graphId", options.graphId],
    ["traceSeed", options.traceSeed],
    ["featureOverrides", sanitizedFeatureOverrides],
  ];

  return Object.fromEntries(pairs.filter(([, value]) => value !== undefined));
}

if (isMainModule()) {
  const { options, errors, helpRequested } = parseCliArgs(process.argv.slice(2));

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    if (!helpRequested) {
      console.error("Use --help to display the list of supported options.");
    }
    process.exitCode = 64; // EX_USAGE from sysexits.h
  } else if (helpRequested) {
    printHelp();
  } else {
    const invocationOptions = normaliseRunInvocationOptions(options);
    run(invocationOptions)
      .then((result) => {
        console.log(`Evaluation validation completed: ${result.runId}`);
        console.log(`Summary written to ${result.summaryPath}`);
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.stack ?? error.message : error);
        process.exitCode = 1;
      });
  }
}
