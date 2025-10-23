#!/usr/bin/env node
/**
 * Validation run orchestrator.
 *
 * The production workflow requires us to regenerate the validation artefacts
 * described in `AGENTS.md` before every release candidate.  This script is
 * responsible for preparing the filesystem layout under `runs/` and,
 * eventually, driving the full MCP validation campaign.
 *
 * The current iteration focuses on providing a safe, testable scaffold:
 *   • deterministic directory preparation with `.gitkeep` sentinels;
 *   • dry-run reporting for CI environments;
 *   • an explicit "prepare-only" mode that primes the workspace without starting
 *     the expensive campaign (useful while the orchestration layer is still under
 *     construction).
 *
 * Future iterations will extend `runValidationCampaign` so it can record tool
 * interactions, collect logs, and populate the validation reports described in
 * the updated checklist.
 */
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { resolve, join, relative } from "node:path";
import { createRunContext } from "./lib/validation/run-context.mjs";
import { ArtifactRecorder } from "./lib/validation/artifact-recorder.mjs";
import { runPreflightStage } from "./lib/validation/stages/preflight.mjs";
import { runIntrospectionStage } from "./lib/validation/stages/introspection.mjs";
import { loadServerModule } from "./lib/validation/server-loader.mjs";
import {
  ensureSourceMapNodeOptions,
  assertNodeVersion,
} from "./lib/env-helpers.mjs";

let resourceRegistryPromise = null;

async function resolveResourceRegistry() {
  if (!resourceRegistryPromise) {
    resourceRegistryPromise = (async () => {
      const module = await loadServerModule();
      if (!module.resources) {
        throw new Error(
          "The server module does not expose the resource registry",
        );
      }
      return module.resources;
    })();
  }
  return resourceRegistryPromise;
}

const DEFAULT_SESSION_PREFIX = "validation_";
const SUBDIRECTORIES = ["inputs", "outputs", "events", "logs", "artifacts", "report"];
const GITKEEP_FILENAME = ".gitkeep";
const SERVER_READINESS_TIMEOUT_MS = 1500;
const TEST_MODE = process.env.CODEX_SCRIPT_TEST === "1";

function toBoolean(value, fallback = false) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalised = value.trim().toLowerCase();
  if (normalised === "1" || normalised === "true" || normalised === "yes") {
    return true;
  }
  if (normalised === "0" || normalised === "false" || normalised === "no") {
    return false;
  }
  return fallback;
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function recordAction(action) {
  if (process.env.CODEX_SCRIPT_TEST !== "1") {
    return;
  }
  const bucket = (globalThis.CODEX_VALIDATE_PLAN ??= []);
  bucket.push(action);
}

/**
 * Records background server orchestration steps in the global plan bucket so
 * the mocha suite can assert which transports were attempted during the run.
 */
function recordServerPlan(action) {
  recordAction({ type: "server-plan", ...action });
}

/**
 * Starts the MCP server using the preferred transport script and streams the
 * stdout/stderr output into a log file stored under the validation session.
 * When `CODEX_SCRIPT_TEST=1` we avoid spawning real processes and simply
 * return a mocked descriptor so tests remain hermetic.
 */
async function spawnServerProcess({ workspaceRoot, transport, context }) {
  const { label, script } = transport;
  const logFilename = `server-${label}.log`;
  const logPath = join(context.directories.logs, logFilename);
  const envWithSourceMaps = ensureSourceMapNodeOptions(process.env);

  recordServerPlan({
    stage: "start",
    transport: label,
    script,
    sessionName: context.runId,
    testMode: TEST_MODE,
    nodeOptions: envWithSourceMaps.NODE_OPTIONS,
  });

  if (TEST_MODE) {
    return {
      ok: true,
      transport: label,
      logPath,
      child: null,
      logStream: null,
      testMode: true,
    };
  }

  const child = spawn("npm", ["run", script], {
    cwd: workspaceRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: envWithSourceMaps,
  });

  const logStream = createWriteStream(logPath, { flags: "a" });

  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      logStream.write(chunk);
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      logStream.write(chunk);
    });
  }

  try {
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolvePromise(null);
      }, SERVER_READINESS_TIMEOUT_MS);

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      });

      child.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        rejectPromise(
          new Error(
            `Server process \"${script}\" exited before readiness (code: ${code ?? "null"}, signal: ${signal ?? "null"})`,
          ),
        );
      });
    });
  } catch (error) {
    child.stdout?.removeAllListeners?.("data");
    child.stderr?.removeAllListeners?.("data");
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
    logStream.end();
    throw error;
  }

  child.once("exit", () => {
    logStream.end();
  });

  return {
    ok: true,
    transport: label,
    script,
    child,
    logStream,
    logPath,
    testMode: false,
  };
}

/**
 * Conditionally starts the MCP server before executing the campaign. The
 * helper follows the checklist ordering (HTTP → STDIO) and records each step in
 * both the run log and the in-memory plan so future stages can reuse the same
 * transport metadata.
 */
async function startBackgroundServerIfRequested({ context, recorder, logger, workspaceRoot }) {
  const shouldStart = toBoolean(process.env.START_MCP_BG, false);
  if (!shouldStart) {
    await recorder.appendLogEntry({
      level: "info",
      message: "background_server_skipped",
      details: { reason: "flag_disabled" },
    });
    return { started: false, transport: null, async stop() {} };
  }

  const httpPreferred = toBoolean(process.env.MCP_HTTP_ENABLE, true);
  const transports = [];
  if (httpPreferred) {
    transports.push({ label: "http", script: "start:http" });
  }
  transports.push({ label: "stdio", script: "start:stdio" });

  await recorder.appendLogEntry({
    level: "info",
    message: "background_server_requested",
    details: {
      run_id: context.runId,
      transports: transports.map((entry) => entry.label).join(" -> "),
    },
  });

  const attempts = [];

  for (const transport of transports) {
    try {
      const result = await spawnServerProcess({ workspaceRoot, transport, context });

      recordServerPlan({
        stage: "started",
        transport: result.transport,
        script: transport.script,
        logPath: result.logPath,
        sessionName: context.runId,
        testMode: TEST_MODE,
      });

      await recorder.appendLogEntry({
        level: "info",
        message: TEST_MODE ? "background_server_mocked" : "background_server_started",
        details: {
          transport: result.transport,
          log_path: result.logPath,
          script: transport.script,
          test_mode: TEST_MODE,
        },
      });

      logger?.info?.(
        `[validation] background server ready via ${result.transport}${TEST_MODE ? " (test-mode)" : ""}`,
      );

      return {
        started: true,
        transport: result.transport,
        async stop() {
          recordServerPlan({
            stage: "stop",
            transport: result.transport,
            sessionName: context.runId,
            testMode: TEST_MODE,
          });

          if (!result.testMode && result.child) {
            try {
              if (result.child.exitCode === null && result.child.signalCode === null) {
                result.child.kill("SIGTERM");
                await once(result.child, "exit");
              }
            } catch {
              /* ignore */
            }
            result.logStream?.end();
          }

          await recorder.appendLogEntry({
            level: "info",
            message: TEST_MODE ? "background_server_mocked_stop" : "background_server_stopped",
            details: {
              transport: result.transport,
              test_mode: TEST_MODE,
            },
          });
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordServerPlan({
        stage: "failed",
        transport: transport.label,
        script: transport.script,
        error: message,
        sessionName: context.runId,
        testMode: TEST_MODE,
      });
      attempts.push({ transport: transport.label, error: message });
      logger?.warn?.(
        `[validation] background server attempt ${transport.label} failed: ${message}`,
      );
      await recorder.appendLogEntry({
        level: "warn",
        message: "background_server_start_failed",
        details: { transport: transport.label, error: message },
      });
    }
  }

  await recorder.appendLogEntry({
    level: "warn",
    message: "background_server_unavailable",
    details: { attempts },
  });

  return { started: false, transport: null, async stop() {} };
}

async function ensureDirectory(targetPath, { dryRun }) {
  recordAction({ type: "ensure-dir", path: targetPath, dryRun });
  if (dryRun) {
    return;
  }
  await mkdir(targetPath, { recursive: true });
}

async function ensureGitkeep(targetPath, { dryRun }) {
  const filePath = join(targetPath, GITKEEP_FILENAME);
  recordAction({ type: "ensure-gitkeep", path: filePath, dryRun });
  if (dryRun) {
    return;
  }
  const exists = await pathExists(filePath);
  if (!exists) {
    await writeFile(filePath, "", "utf8");
  }
}

function resolveRootDir(explicitRoot) {
  if (explicitRoot) {
    return resolve(explicitRoot);
  }
  const envOverride = process.env.VALIDATION_RUNS_ROOT;
  if (envOverride) {
    return resolve(envOverride);
  }
  return resolve("runs");
}

function resolveSessionName(explicitName) {
  if (explicitName && explicitName.length > 0) {
    return explicitName;
  }
  if (process.env.VALIDATION_RUNS_SESSION) {
    return process.env.VALIDATION_RUNS_SESSION;
  }
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  return `${DEFAULT_SESSION_PREFIX}${isoDate}`;
}

function extractFirstText(response) {
  const entries = Array.isArray(response?.content) ? response.content : [];
  const candidate = entries.find((entry) => entry && typeof entry === "object" && typeof entry.text === "string");
  return typeof candidate?.text === "string" ? candidate.text : null;
}

function summariseResponse(response) {
  if (!response || typeof response !== "object") {
    return { isError: true, structured: null, parsedText: null, rawText: null };
  }
  const rawText = extractFirstText(response);
  let parsedText = null;
  if (typeof rawText === "string") {
    try {
      parsedText = JSON.parse(rawText);
    } catch {
      parsedText = rawText;
    }
  }
  return {
    isError: Boolean(response.isError),
    structured: response.structuredContent ?? null,
    parsedText,
    rawText,
  };
}

function computeP95(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)));
  return sorted[rank];
}

function buildToolMetrics(calls) {
  const metrics = new Map();
  for (const call of calls) {
    const bucket = metrics.get(call.toolName) ?? {
      toolName: call.toolName,
      totalCalls: 0,
      errorCount: 0,
      durationsMs: [],
      traces: [],
      lastResponse: call.response,
    };
    bucket.totalCalls += 1;
    if (call.response.isError) {
      bucket.errorCount += 1;
    }
    bucket.durationsMs.push(call.durationMs);
    bucket.traces.push({ traceId: call.traceId, artefacts: call.artefacts });
    bucket.lastResponse = call.response;
    metrics.set(call.toolName, bucket);
  }

  return Array.from(metrics.values()).map((entry) => ({
    toolName: entry.toolName,
    totalCalls: entry.totalCalls,
    errorCount: entry.errorCount,
    successRate: entry.totalCalls === 0 ? 0 : (entry.totalCalls - entry.errorCount) / entry.totalCalls,
    p95DurationMs: computeP95(entry.durationsMs),
    traces: entry.traces,
    lastResponse: entry.lastResponse,
  }));
}

async function writeFindingsReport(sessionDir, runId, calls) {
  const generatedAt = new Date().toISOString();
  const totals = {
    totalCalls: calls.length,
    errorCount: calls.filter((call) => call.response.isError).length,
  };
  const byTool = buildToolMetrics(calls);
  const report = {
    runId,
    generatedAt,
    totals,
    tools: byTool,
  };
  const reportPath = join(sessionDir, "report", "findings.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { reportPath, totals, tools: byTool };
}

async function writeSummaryReport(sessionDir, runId, summary, options = {}) {
  const { stages = [] } = options;
  const lines = [];
  lines.push(`# Validation Summary`);
  lines.push("");
  lines.push(`- Run ID: ${runId}`);
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push(`- Total tool calls: ${summary.totals.totalCalls}`);
  lines.push(`- Error count: ${summary.totals.errorCount}`);
  const successRate = summary.totals.totalCalls === 0
    ? 0
    : ((summary.totals.totalCalls - summary.totals.errorCount) / summary.totals.totalCalls) * 100;
  lines.push(`- Success rate: ${successRate.toFixed(2)}%`);
  lines.push("");
  lines.push(`## Latency (p95, milliseconds)`);
  for (const tool of summary.tools) {
    lines.push(`- ${tool.toolName}: ${tool.p95DurationMs.toFixed(2)} ms`);
  }
  lines.push("");
  if (stages.length > 0) {
    lines.push(`## Stage coverage`);
    for (const stage of stages) {
      const events = stage.summary?.events ?? {};
      const baselineCount = events?.baseline?.count
        ?? (Array.isArray(events?.baseline?.events) ? events.baseline.events.length : 0);
      const followUpCount = events?.followUp?.count
        ?? (Array.isArray(events?.followUp?.events) ? events.followUp.events.length : 0);
      const resourceBuckets = stage.summary?.resourceCatalog?.byPrefix ?? [];
      const toolsSummary = stage.summary?.tools ?? {};
      const toolCount = Array.isArray(toolsSummary.items)
        ? toolsSummary.items.length
        : typeof toolsSummary.total === "number"
          ? toolsSummary.total
          : 0;
      lines.push(
        `- ${stage.phaseId}: ${toolCount} tools enumerated, ${resourceBuckets.length} resource prefixes probed, ` +
          `${baselineCount} baseline events captured, ${followUpCount} follow-up events recorded.`,
      );
    }
    lines.push("");
  }
  lines.push(`## Notes`);
  lines.push(`- The campaign currently covers the introspection phase with resource indexing and event sampling.`);
  lines.push(`- Future iterations will extend coverage to additional checklist phases (children, plans, graph snapshots).`);
  lines.push("");

  const summaryPath = join(sessionDir, "report", "summary.md");
  await writeFile(summaryPath, `${lines.join("\n")}\n`, "utf8");
  return summaryPath;
}

async function writeRecommendationsReport(sessionDir, stages = []) {
  const lines = [];
  lines.push(`# Recommendations`);
  lines.push("");
  lines.push(`## P1 – Extend tool coverage`);
  lines.push(`- Implement the remaining checklist phases (events capture, child orchestration, graph snapshots).`);
  lines.push("");
  lines.push(`## P2 – Automate transport fallbacks`);
  lines.push(`- Teach the campaign to attempt HTTP → STDIO → FS-Bridge so the artefacts reflect production deployments.`);
  lines.push("");
  lines.push(`## P2 – Enrich reporting`);
  const completedStages = stages.map((stage) => stage.phaseId).join(", ") || "introspection";
  lines.push(`- Aggregate per-phase metrics (p50/p99) and correlate findings with the recorded event streams for ${completedStages}.`);
  lines.push("");

  const recommendationsPath = join(sessionDir, "report", "recommendations.md");
  await writeFile(recommendationsPath, `${lines.join("\n")}\n`, "utf8");
  return recommendationsPath;
}

function normaliseRelativePath(basePath, targetPath) {
  const relativePath = relative(basePath, targetPath);
  return relativePath.split("\\").join("/");
}

/**
 * Updates the `runs/README.md` file with the latest campaign
 * metadata so operators can quickly identify the freshest artefacts.
 *
 * The README intentionally keeps the historical reset message at the top while
 * surfacing the campaign timestamp and handy links to the main reports.
 *
 * @param {{
 *   rootDir: string,
 *   sessionName: string,
 *   findings: { reportPath: string, totals: { totalCalls: number, errorCount: number } },
 *   summaryPath: string,
 *   recommendationsPath: string,
 * }} params
 * @returns {Promise<string>} absolute path to the README that has been updated.
 */
async function updateValidationReadme(params) {
  const readmePath = join(params.rootDir, "README.md");
  const timestamp = new Date().toISOString();
  const totalCalls = params.findings.totals.totalCalls ?? 0;
  const errorCount = params.findings.totals.errorCount ?? 0;
  const successRate = totalCalls === 0 ? 0 : ((totalCalls - errorCount) / totalCalls) * 100;

  const summaryRelative = normaliseRelativePath(params.rootDir, params.summaryPath);
  const findingsRelative = normaliseRelativePath(params.rootDir, params.findings.reportPath);
  const recommendationsRelative = normaliseRelativePath(params.rootDir, params.recommendationsPath);

  const lines = [];
  lines.push("# Validation Runs");
  lines.push("");
  lines.push("Cette session est **réinitialisée** – toutes les preuves d’exécution seront régénérées.");
  lines.push("");
  lines.push("## Dernière campagne");
  lines.push(`- Horodatage : ${timestamp}`);
  lines.push(`- Session : ${params.sessionName}`);
  lines.push(`- Succès : ${successRate.toFixed(2)}% (${totalCalls} appels, erreurs : ${errorCount})`);
  lines.push(`- Rapport synthèse : [${summaryRelative}](./${summaryRelative})`);
  lines.push(`- Rapport findings : [${findingsRelative}](./${findingsRelative})`);
  lines.push(`- Recommandations : [${recommendationsRelative}](./${recommendationsRelative})`);
  lines.push("");
  lines.push(`Les artefacts détaillés sont disponibles sous \`./${params.sessionName}/\`.`);
  lines.push("");

  await writeFile(readmePath, `${lines.join("\n")}\n`, "utf8");
  return readmePath;
}

async function defaultExecuteCampaign({ sessionName, sessionDir, rootDir, logger }) {
  const workspaceRoot = resolve(".");
  const context = await createRunContext({
    runId: sessionName,
    workspaceRoot,
    runRoot: sessionDir,
  });
  const resourceRegistry = await resolveResourceRegistry();
  const recorder = new ArtifactRecorder(context, { resourceRegistry, logger });
  const recordedCalls = [];
  const stageSummaries = [];

  await recorder.appendLogEntry({
    level: "info",
    message: "campaign_started",
    details: { run_id: sessionName, session_dir: sessionDir, root: rootDir },
  });

  const preflight = await runPreflightStage({
    context,
    recorder,
    logger,
    phaseId: "phase-00-preflight",
  });
  stageSummaries.push({ phaseId: preflight.phaseId, summary: preflight.summary });
  for (const call of preflight.calls ?? []) {
    recordedCalls.push(call);
  }

  const serverController = await startBackgroundServerIfRequested({
    context,
    recorder,
    logger,
    workspaceRoot,
  });

  try {
    const introspection = await runIntrospectionStage({
      context,
      recorder,
      logger,
      phaseId: "phase-01-introspection",
    });
    stageSummaries.push({ phaseId: introspection.phaseId, summary: introspection.summary });
    for (const call of introspection.calls) {
      recordedCalls.push({
        toolName: call.toolName,
        traceId: call.traceId,
        durationMs: call.durationMs,
        artefacts: call.artefacts,
        response: summariseResponse(call.response),
      });
    }
  } finally {
    await serverController.stop();
  }

  await recorder.appendLogEntry({
    level: "info",
    message: "campaign_completed",
    details: {
      run_id: sessionName,
      total_calls: recordedCalls.length,
      stages: stageSummaries.map((stage) => stage.phaseId),
    },
  });

  const findings = await writeFindingsReport(sessionDir, sessionName, recordedCalls);
  const summaryPath = await writeSummaryReport(sessionDir, sessionName, findings, { stages: stageSummaries });
  const recommendationsPath = await writeRecommendationsReport(sessionDir, stageSummaries);

  logger?.info?.(
    `validation campaign completed – ${recordedCalls.length} tool calls captured (errors: ${findings.totals.errorCount})`,
  );

  return {
    calls: recordedCalls,
    findings,
    stages: stageSummaries,
    summaryPath,
    recommendationsPath,
  };
}

export async function runValidationCampaign(options = {}) {
  const {
    dryRun = toBoolean(process.env.CODEX_VALIDATE_DRY_RUN, false),
    prepareOnly = false,
    sessionName: providedSession,
    rootDir: providedRoot,
    logger = console,
    executeCampaign = defaultExecuteCampaign,
  } = options;

  assertNodeVersion();
  const rootDir = resolveRootDir(providedRoot);
  const sessionName = resolveSessionName(providedSession);
  const sessionDir = resolve(rootDir, sessionName);

  recordAction({ type: "session", rootDir, sessionDir, sessionName, dryRun, prepareOnly });

  await ensureDirectory(rootDir, { dryRun });
  await ensureDirectory(sessionDir, { dryRun });

  for (const subdirectory of SUBDIRECTORIES) {
    const subdirPath = resolve(sessionDir, subdirectory);
    await ensureDirectory(subdirPath, { dryRun });
    await ensureGitkeep(subdirPath, { dryRun });
  }

  if (prepareOnly || dryRun) {
    logger?.info?.(
      `validation session "${sessionName}" prepared${dryRun ? " (dry-run)" : ""}`,
    );
    return {
      rootDir,
      sessionDir,
      sessionName,
      prepared: true,
      executed: false,
      dryRun,
    };
  }

  const outcome = await executeCampaign({ sessionName, sessionDir, rootDir, logger });

  const readmePath = await updateValidationReadme({
    rootDir,
    sessionName,
    findings: outcome.findings,
    summaryPath: outcome.summaryPath,
    recommendationsPath: outcome.recommendationsPath,
  });

  return {
    rootDir,
    sessionDir,
    sessionName,
    prepared: true,
    executed: true,
    dryRun: false,
    calls: outcome.calls,
    findings: outcome.findings,
    stages: outcome.stages ?? [],
    readmePath,
  };
}

/**
 * Parses CLI arguments emitted by `scripts/validate-run.mjs` while omitting
 * placeholder `undefined` values.  Returning a sparse object keeps future
 * `exactOptionalPropertyTypes` runs happy because consumers only observe
 * concrete overrides for the recognised flags.
 */
export function parseValidateRunArguments(argv) {
  const args = argv.slice(2);
  let dryRunFlag = null;
  let prepareOnlyFlag = null;
  let sessionName = null;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRunFlag = true;
      continue;
    }
    if (arg === "--prepare-only") {
      prepareOnlyFlag = true;
      continue;
    }
    if (arg.startsWith("--session=")) {
      sessionName = arg.slice("--session=".length);
      continue;
    }
  }

  return {
    ...(dryRunFlag === true ? { dryRun: true } : {}),
    ...(prepareOnlyFlag === true ? { prepareOnly: true } : {}),
    ...(sessionName !== null ? { sessionName } : {}),
  };
}

async function main() {
  const { dryRun, prepareOnly, sessionName } = parseValidateRunArguments(process.argv);
  try {
    await runValidationCampaign({
      dryRun,
      prepareOnly,
      sessionName,
    });
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Unknown error while executing the validation campaign", error);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1]) {
  const entryUrl = new URL(process.argv[1], "file:").href;
  if (import.meta.url === entryUrl) {
    main();
  }
}
