/**
 * End-to-end smoke script exercising a representative subset of MCP tools. The
 * harness records deterministic artefacts under `runs/validation_<timestamp>/`
 * so operators can inspect request/response pairs and latencies after the run.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { createRunContext } from "../lib/validation/run-context.mjs";
import { ArtifactRecorder } from "../lib/validation/artifact-recorder.mjs";
import { McpSession, McpToolCallError } from "../lib/validation/mcp-session.mjs";
import { runPreflightStage } from "../lib/validation/stages/preflight.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Feature toggles required for the smoke scenario.  The default runtime keeps
 * most MCP modules disabled, so we explicitly enable the ones exercised by the
 * validation run (introspection, transactions, diff/patch and fine-grained
 * child management).  Additional toggles can be merged in through the optional
 * `featureOverrides` parameter exposed by {@link run}.
 */
const SMOKE_FEATURE_OVERRIDES = Object.freeze({
  enableMcpIntrospection: true,
  enableTx: true,
  enableDiffPatch: true,
  enableChildOpsFine: true,
});

/**
 * Builds a shallow clone of the provided object without undefined values so the
 * script never forwards placeholder optionals to the validation runtime. Using
 * an explicit helper keeps the sanitisation co-located with the CLI entrypoint
 * and documents why we intentionally drop these keys ahead of enabling
 * `exactOptionalPropertyTypes` in the entire workspace.
 *
 * @param {Record<string, unknown>} source raw object coming from user options.
 * @returns {Record<string, unknown>} clone containing only defined values.
 */
function omitUndefinedProperties(source) {
  const clone = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      clone[key] = value;
    }
  }
  return clone;
}

/**
 * Merges the default feature toggles required by the smoke scenario with the
 * caller overrides while filtering out `undefined` hints.  This prevents the
 * harness from serialising `undefined` values in the persisted run context and
 * keeps the artefacts stable once strict optional typing is enforced.
 */
function buildFeatureOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") {
    return { ...SMOKE_FEATURE_OVERRIDES };
  }
  return {
    ...SMOKE_FEATURE_OVERRIDES,
    ...omitUndefinedProperties(overrides),
  };
}

/** Normalises trace identifiers so persisted operations never expose `undefined`. */
function normaliseTraceId(traceId) {
  return typeof traceId === "string" && traceId.trim().length > 0 ? traceId : null;
}

/**
 * Computes a deterministic duration (in milliseconds) even when the caller
 * fails to provide latency metadata.  We fall back to the measured elapsed time
 * derived from a high resolution monotonic clock to avoid returning
 * `undefined`.
 */
function normaliseDuration(startedAt, durationMs) {
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    return durationMs;
  }
  const elapsedNs = process.hrtime.bigint() - startedAt;
  return Number(elapsedNs) / 1_000_000;
}

/**
 * Computes an interpolated percentile for the provided dataset. A `null` value
 * is returned when the input array is empty so the caller can omit the metric.
 */
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

/** Formats the summary table describing each smoke operation. */
function formatSummaryTable(operations) {
  const header = `| Operation | Duration (ms) | Status | Trace ID |\n|---|---:|---|---|`;
  const rows = operations.map((op) => {
    const duration = typeof op.durationMs === "number" ? op.durationMs.toFixed(2) : "-";
    const status = op.status;
    const trace = op.traceId ?? "-";
    return `| ${op.label} | ${duration} | ${status} | ${trace} |`;
  });
  return [header, ...rows].join("\n");
}

/**
 * Executes the smoke validation scenario and writes the resulting artefacts and
 * human-readable summary.
 */
/**
 * Executes the smoke validation workflow and records artefacts.
 *
 * @param {{
 *   runId?: string,
 *   runRoot?: string,
 *   traceSeed?: string,
 *   timestamp?: string | Date,
 *   graphId?: string,
 *   graphIdSuffix?: string,
 *   featureOverrides?: Record<string, unknown>,
 * }} [options] optional configuration overriding identifiers and feature flags.
 */
export async function run(options = {}) {
  const timestampSource = options.timestamp ?? new Date().toISOString();
  const timestampIso = timestampSource instanceof Date ? timestampSource.toISOString() : String(timestampSource);
  const sanitizedTimestamp = timestampIso.replace(/[:.]/g, "-");
  const runId = options.runId ?? `validation_${sanitizedTimestamp}`;
  const runContext = await createRunContext(
    omitUndefinedProperties({
      runId,
      workspaceRoot: ROOT_DIR,
      runRoot: options.runRoot,
      traceSeed: options.traceSeed,
    }),
  );
  const recorder = new ArtifactRecorder(runContext);
  const session = new McpSession({
    context: runContext,
    recorder,
    clientName: "smoke-harness",
    clientVersion: "0.1.0",
    featureOverrides: buildFeatureOverrides(options.featureOverrides),
  });

  const stageResults = [];
  const operations = [];

  /** Helper wrapping an MCP invocation while tracking latency and status. */
  async function executeStep(label, invoke) {
    const startedAt = process.hrtime.bigint();
    try {
      const call = await invoke();
      const durationMs = normaliseDuration(startedAt, call.durationMs);
      operations.push({
        label,
        durationMs,
        status: call.response?.isError ? "error" : "ok",
        traceId: normaliseTraceId(call.traceId),
        details: null,
      });
      return call;
    } catch (error) {
      if (error instanceof McpToolCallError) {
        const durationMs = normaliseDuration(startedAt, error.durationMs);
        const causeMessage =
          error.cause instanceof Error ? error.cause.message : error.cause !== undefined ? String(error.cause) : undefined;
        const details = causeMessage ?? (error.message ?? "");
        operations.push({
          label,
          durationMs,
          status: "error",
          traceId: normaliseTraceId(error.traceId),
          details,
        });
      } else {
        const durationMs = normaliseDuration(startedAt, null);
        operations.push({
          label,
          durationMs,
          status: "error",
          traceId: null,
          details: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /** Records a skipped operation (duration is reported as zero). */
  function recordSkippedStep(label, reason) {
    operations.push({
      label,
      durationMs: 0,
      status: "skipped",
      traceId: null,
      details: String(reason),
    });
  }

  const graphIdSuffix = options.graphIdSuffix ?? sanitizedTimestamp;
  const graphId = options.graphId ?? `smoke-graph-${graphIdSuffix}`;
  const baseGraph = {
    graph_id: graphId,
    graph_version: 1,
    name: "Smoke Baseline",
    nodes: [
      { id: "alpha", label: "Alpha", attributes: {} },
      { id: "beta", label: "Beta", attributes: {} },
    ],
    edges: [
      { from: "alpha", to: "beta", label: "bootstrap", attributes: {} },
    ],
    metadata: { owner: "smoke-run" },
  };

  const originalStateless = process.env.MCP_HTTP_STATELESS;
  // Force the HTTP loopback shim during the smoke run so child operations rely on
  // the in-process descriptor even if previous tests disabled stateless mode.
  process.env.MCP_HTTP_STATELESS = "yes";

  try {
    const preflight = await runPreflightStage({
      context: runContext,
      recorder,
      phaseId: "phase-00-preflight",
    });
    stageResults.push(preflight);

    await session.open();

    try {
      await executeStep("mcp_info", () => session.callTool("mcp_info", {}, { phaseId: "smoke" }));

      await executeStep("tools/list", () => session.listTools({ limit: 200 }, { phaseId: "smoke" }));

      const begin = await executeStep("tx_begin", () =>
        session.callTool("tx_begin", {
          graph_id: graphId,
          owner: "smoke-run",
          note: "bootstrap baseline",
          graph: baseGraph,
        }),
      );
      const beginContent = begin.response?.structuredContent ?? {};
      const txId = typeof beginContent?.tx_id === "string" ? beginContent.tx_id : null;
      if (!txId) {
        throw new Error("tx_begin did not return a tx_id");
      }

      await executeStep("tx_commit", () => session.callTool("tx_commit", { tx_id: txId }));

      await executeStep("graph_patch", () =>
        session.callTool("graph_patch", {
          graph_id: graphId,
          base_version: 1,
          owner: "smoke-run",
          note: "append gamma node",
          patch: [
            {
              op: "add",
              path: "/nodes/-",
              value: { id: "gamma", label: "Gamma", attributes: {} },
            },
            {
              op: "add",
              path: "/edges/-",
              value: { from: "beta", to: "gamma", label: "flow", attributes: {} },
            },
          ],
        }),
      );

      const spawn = await executeStep("child_spawn_codex", () =>
        session.callTool("child_spawn_codex", {
          role: "smoke-tester",
          prompt: {
            system: ["You are a smoke-test child."],
            user: ["Acknowledge receipt of this ping."],
          },
        }),
      );
      const spawnContent = spawn.response?.structuredContent ?? {};
      const childId = typeof spawnContent?.child_id === "string" ? spawnContent.child_id : null;
      if (!childId) {
        throw new Error("child_spawn_codex did not return a child_id");
      }

      const endpointDescriptor = spawnContent && typeof spawnContent === "object" ? spawnContent.endpoint ?? null : null;
      if (endpointDescriptor) {
        recordSkippedStep(
          "child_send (logical child)",
          "child exposed HTTP loopback endpoint; direct send skipped",
        );
      } else {
        await executeStep("child_send", () =>
          session.callTool("child_send", {
            child_id: childId,
            payload: { type: "prompt", content: "Provide a short acknowledgement." },
            expect: "final",
            timeout_ms: 2_000,
          }),
        );
      }

      await executeStep("child_kill", () => session.callTool("child_kill", { child_id: childId }));
    } finally {
      await session.close().catch(() => {});
    }
  } finally {
    if (originalStateless === undefined) {
      delete process.env.MCP_HTTP_STATELESS;
    } else {
      process.env.MCP_HTTP_STATELESS = originalStateless;
    }
  }

  const durations = operations
    .map((op) => op.durationMs)
    .filter((value) => typeof value === "number");
  const p50 = computePercentile(durations, 50);
  const p95 = computePercentile(durations, 95);
  const p99 = computePercentile(durations, 99);

  const consideredOperations = operations.filter((op) => op.status !== "skipped");
  const errorCount = consideredOperations.filter((op) => op.status === "error").length;
  const errorRate = consideredOperations.length
    ? (errorCount / consideredOperations.length) * 100
    : 0;

  const summaryLines = [
    `# Smoke Validation Run — ${runId}`,
    "",
    "## HTTP Preflight",
  ];

  const preflightSummary = stageResults[0]?.summary;
  if (preflightSummary) {
    summaryLines.push(
      `- Base URL: ${preflightSummary.target?.baseUrl ?? "n/a"}`,
      `- /healthz status: ${preflightSummary.checks?.healthz?.status ?? "n/a"}`,
      `- /metrics status: ${preflightSummary.checks?.metrics?.status ?? "n/a"}`,
      `- JSON-RPC authorised status: ${preflightSummary.checks?.authorised?.status ?? "n/a"}`,
      `- JSON-RPC unauthorised status: ${preflightSummary.checks?.unauthorised?.status ?? "n/a"}`,
      "",
    );
  } else {
    summaryLines.push("- Preflight stage did not run", "");
  }

  summaryLines.push(
    "## Latency Summary",
    p50 !== null ? `- p50: ${p50.toFixed(2)} ms` : "- p50: n/a",
    p95 !== null ? `- p95: ${p95.toFixed(2)} ms` : "- p95: n/a",
    p99 !== null ? `- p99: ${p99.toFixed(2)} ms` : "- p99: n/a",
    `- error rate: ${errorRate.toFixed(2)}% (${errorCount}/${consideredOperations.length || 0})`,
    "",
    "## Operations",
    formatSummaryTable(operations),
  );

  const summaryPath = join(runContext.rootDir, "summary.md");
  await writeFile(summaryPath, summaryLines.join("\n"), "utf8");

  return { runId, summaryPath, runRoot: runContext.rootDir, operations, stages: stageResults };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (isMainModule()) {
  run()
    .then((result) => {
      console.log(`Smoke validation completed: ${result.runId}`);
      console.log(`Summary written to ${result.summaryPath}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : error);
      process.exitCode = 1;
    });
}
