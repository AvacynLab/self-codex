import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve as resolvePath, dirname as pathDirname, basename as pathBasename } from "node:path";
import { pathToFileURL } from "url";
import { GraphState } from "./graphState.js";
import { GraphTransactionManager, GraphVersionConflictError } from "./graph/tx.js";
import { StructuredLogger } from "./logger.js";
import { EventStore } from "./eventStore.js";
import { startHttpServer } from "./httpServer.js";
import { startDashboardServer } from "./monitor/dashboard.js";
import { BehaviorTreeStatusRegistry } from "./monitor/btStatusRegistry.js";
import { parseOrchestratorRuntimeOptions, } from "./serverOptions.js";
import { ChildSupervisor } from "./childSupervisor.js";
import { UnknownChildError } from "./state/childrenIndex.js";
import { Autoscaler } from "./agents/autoscaler.js";
import { OrchestratorSupervisor } from "./agents/supervisor.js";
import { MetaCritic } from "./agents/metaCritic.js";
import { reflect } from "./agents/selfReflect.js";
import { scoreCode, scorePlan, scoreText } from "./quality/scoring.js";
import { SharedMemoryStore } from "./memory/store.js";
import { selectMemoryContext } from "./memory/attention.js";
import { LoopDetector } from "./guard/loopDetector.js";
import { BlackboardStore } from "./coord/blackboard.js";
import { ContractNetCoordinator } from "./coord/contractNet.js";
import { StigmergyField } from "./coord/stigmergy.js";
import { KnowledgeGraph } from "./knowledge/knowledgeGraph.js";
import { CausalMemory } from "./knowledge/causalMemory.js";
import { ValueGraph } from "./values/valueGraph.js";
import { ChildCancelInputShape, ChildCancelInputSchema, ChildCollectInputShape, ChildCollectInputSchema, ChildCreateInputShape, ChildCreateInputSchema, ChildGcInputShape, ChildGcInputSchema, ChildKillInputShape, ChildKillInputSchema, ChildSendInputShape, ChildSendInputSchema, ChildStreamInputShape, ChildStreamInputSchema, ChildStatusInputShape, ChildStatusInputSchema, handleChildCancel, handleChildCollect, handleChildCreate, handleChildGc, handleChildKill, handleChildSend, handleChildStream, handleChildStatus, } from "./tools/childTools.js";
import { PlanFanoutInputSchema, PlanFanoutInputShape, PlanJoinInputSchema, PlanJoinInputShape, PlanCompileBTInputSchema, PlanCompileBTInputShape, PlanRunBTInputSchema, PlanRunBTInputShape, PlanRunReactiveInputSchema, PlanRunReactiveInputShape, PlanReduceInputSchema, PlanReduceInputShape, handlePlanFanout, handlePlanJoin, handlePlanCompileBT, handlePlanRunBT, handlePlanRunReactive, handlePlanReduce, ValueGuardRejectionError, } from "./tools/planTools.js";
import { BbGetInputSchema, BbGetInputShape, BbQueryInputSchema, BbQueryInputShape, BbSetInputSchema, BbSetInputShape, BbWatchInputSchema, BbWatchInputShape, CnpAnnounceInputSchema, CnpAnnounceInputShape, handleBbGet, handleBbQuery, handleBbSet, handleBbWatch, StigDecayInputSchema, StigDecayInputShape, StigMarkInputSchema, StigMarkInputShape, StigSnapshotInputSchema, StigSnapshotInputShape, handleStigDecay, handleStigMark, handleStigSnapshot, handleCnpAnnounce, ConsensusVoteInputSchema, ConsensusVoteInputShape, handleConsensusVote, } from "./tools/coordTools.js";
import { AgentAutoscaleSetInputSchema, AgentAutoscaleSetInputShape, handleAgentAutoscaleSet, } from "./tools/agentTools.js";
import { GraphGenerateInputSchema, GraphGenerateInputShape, GraphMutateInputSchema, GraphMutateInputShape, GraphDescriptorSchema, GraphPathsConstrainedInputSchema, GraphPathsConstrainedInputShape, GraphPathsKShortestInputSchema, GraphPathsKShortestInputShape, GraphCentralityBetweennessInputSchema, GraphCentralityBetweennessInputShape, GraphCriticalPathInputSchema, GraphCriticalPathInputShape, GraphOptimizeInputSchema, GraphOptimizeInputShape, GraphOptimizeMooInputSchema, GraphOptimizeMooInputShape, GraphCausalAnalyzeInputSchema, GraphCausalAnalyzeInputShape, GraphRewriteApplyInputSchema, GraphRewriteApplyInputShape, GraphHyperExportInputSchema, GraphHyperExportInputShape, GraphPartitionInputSchema, GraphPartitionInputShape, GraphSummarizeInputSchema, GraphSummarizeInputShape, GraphSimulateInputSchema, GraphSimulateInputShape, GraphValidateInputSchema, GraphValidateInputShape, handleGraphGenerate, handleGraphMutate, handleGraphRewriteApply, handleGraphHyperExport, handleGraphPathsConstrained, handleGraphPathsKShortest, handleGraphCentralityBetweenness, handleGraphCriticalPath, handleGraphOptimize, handleGraphOptimizeMoo, handleGraphCausalAnalyze, handleGraphPartition, handleGraphSummarize, handleGraphSimulate, handleGraphValidate, normaliseGraphPayload, serialiseNormalisedGraph, } from "./tools/graphTools.js";
import { KgExportInputSchema, KgExportInputShape, KgInsertInputSchema, KgInsertInputShape, KgQueryInputSchema, KgQueryInputShape, handleKgExport, handleKgInsert, handleKgQuery, } from "./tools/knowledgeTools.js";
import { CausalExportInputSchema, CausalExportInputShape, CausalExplainInputSchema, CausalExplainInputShape, handleCausalExport, handleCausalExplain, } from "./tools/causalTools.js";
import { ValuesFilterInputSchema, ValuesFilterInputShape, ValuesScoreInputSchema, ValuesScoreInputShape, ValuesSetInputSchema, ValuesSetInputShape, handleValuesFilter, handleValuesScore, handleValuesSet, } from "./tools/valueTools.js";
import { renderMermaidFromGraph } from "./viz/mermaid.js";
import { renderDotFromGraph } from "./viz/dot.js";
import { renderGraphmlFromGraph } from "./viz/graphml.js";
import { snapshotToGraphDescriptor } from "./viz/snapshot.js";
import { SUBGRAPH_REGISTRY_KEY, collectMissingSubgraphDescriptors, collectSubgraphReferences, } from "./graph/subgraphRegistry.js";
import { extractSubgraphToFile } from "./graph/subgraphExtract.js";
// ---------------------------
// Stores en memoire
// ---------------------------
const graphState = new GraphState();
/**
 * Transaction manager guarding graph mutations. Every server-side mutation is
 * funneled through this instance to guarantee optimistic concurrency checks and
 * deterministic version bumps.
 */
const graphTransactions = new GraphTransactionManager();
/** Shared blackboard store powering coordination tools. */
const blackboard = new BlackboardStore();
/** Shared stigmergic field coordinating pheromone-driven prioritisation. */
const stigmergy = new StigmergyField();
/** Shared contract-net coordinator balancing task assignments. */
const contractNet = new ContractNetCoordinator();
/** Shared knowledge graph storing reusable plan patterns. */
const knowledgeGraph = new KnowledgeGraph();
/** Shared causal memory tracking runtime event relationships. */
const causalMemory = new CausalMemory();
/** Shared value graph guarding plan execution against policy violations. */
const valueGraph = new ValueGraph();
/** Registry storing the last guard decision for spawned children. */
const valueGuardRegistry = new Map();
/** Registry exposing live Behaviour Tree node statuses to dashboards. */
const btStatusRegistry = new BehaviorTreeStatusRegistry();
/** Default feature toggles used before CLI/flags are parsed. */
const DEFAULT_FEATURE_TOGGLES = {
    enableBT: false,
    enableReactiveScheduler: false,
    enableBlackboard: false,
    enableStigmergy: false,
    enableCNP: false,
    enableConsensus: false,
    enableAutoscaler: false,
    enableSupervisor: false,
    enableKnowledge: false,
    enableCausalMemory: false,
    enableValueGuard: false,
};
/** Default runtime timings exposed before configuration takes place. */
const DEFAULT_RUNTIME_TIMINGS = {
    btTickMs: 50,
    stigHalfLifeMs: 30_000,
    supervisorStallTicks: 6,
};
const DEFAULT_CHILD_SAFETY_LIMITS = {
    maxChildren: 16,
    memoryLimitMb: 512,
    cpuPercent: 100,
};
let runtimeFeatures = { ...DEFAULT_FEATURE_TOGGLES };
let runtimeTimings = { ...DEFAULT_RUNTIME_TIMINGS };
let runtimeChildSafety = { ...DEFAULT_CHILD_SAFETY_LIMITS };
/** Returns the active feature toggles applied to the orchestrator. */
export function getRuntimeFeatures() {
    return { ...runtimeFeatures };
}
/** Applies a new set of feature toggles at runtime. */
export function configureRuntimeFeatures(next) {
    runtimeFeatures = { ...next };
}
/** Returns the pacing configuration applied to optional modules. */
export function getRuntimeTimings() {
    return { ...runtimeTimings };
}
/** Applies a new pacing configuration for optional modules. */
export function configureRuntimeTimings(next) {
    runtimeTimings = { ...next };
}
/** Returns the safety guardrails applied to child runtimes. */
export function getChildSafetyLimits() {
    return { ...runtimeChildSafety };
}
/** Applies new safety guardrails and updates the child supervisor accordingly. */
export function configureChildSafetyLimits(next) {
    runtimeChildSafety = { ...next };
    childSupervisor.configureSafety({
        maxChildren: runtimeChildSafety.maxChildren,
        memoryLimitMb: runtimeChildSafety.memoryLimitMb,
        cpuPercent: runtimeChildSafety.cpuPercent,
    });
}
function summariseSubgraphUsage(graph) {
    const references = Array.from(collectSubgraphReferences(graph));
    const missing = collectMissingSubgraphDescriptors(graph);
    return { references, missing };
}
function parseSizeEnv(raw) {
    if (!raw) {
        return undefined;
    }
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned.length) {
        return undefined;
    }
    const match = cleaned.match(/^(\d+)([kmg]?b?)?$/);
    if (!match) {
        return undefined;
    }
    const base = Number(match[1]);
    if (!Number.isFinite(base)) {
        return undefined;
    }
    const unit = match[2];
    switch (unit) {
        case "k":
        case "kb":
            return base * 1024;
        case "m":
        case "mb":
            return base * 1024 * 1024;
        case "g":
        case "gb":
            return base * 1024 * 1024 * 1024;
        default:
            return base;
    }
}
function parseCountEnv(raw) {
    if (!raw) {
        return undefined;
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) {
        return undefined;
    }
    return Math.floor(num);
}
function parseRedactEnv(raw) {
    if (!raw) {
        return [];
    }
    return raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
}
function parseBooleanEnv(raw, defaultValue) {
    if (raw === undefined) {
        return defaultValue;
    }
    const normalised = raw.trim().toLowerCase();
    if (!normalised.length) {
        return defaultValue;
    }
    if (["0", "false", "no", "off"].includes(normalised)) {
        return false;
    }
    if (["1", "true", "yes", "on"].includes(normalised)) {
        return true;
    }
    return defaultValue;
}
function parseQualityThresholdEnv(raw, fallback) {
    if (raw === undefined) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(100, Math.max(0, Math.round(parsed)));
}
const baseLoggerOptions = {
    logFile: process.env.MCP_LOG_FILE ?? undefined,
    maxFileSizeBytes: parseSizeEnv(process.env.MCP_LOG_ROTATE_SIZE),
    maxFileCount: parseCountEnv(process.env.MCP_LOG_ROTATE_KEEP),
    redactSecrets: parseRedactEnv(process.env.MCP_LOG_REDACT),
};
let activeLoggerOptions = { ...baseLoggerOptions };
let logger = new StructuredLogger(activeLoggerOptions);
const eventStore = new EventStore({ maxHistory: 5000, logger });
if (activeLoggerOptions.logFile) {
    logger.info("logger_configured", {
        log_file: activeLoggerOptions.logFile,
        max_size_bytes: activeLoggerOptions.maxFileSizeBytes ?? null,
        max_file_count: activeLoggerOptions.maxFileCount ?? null,
        redacted_tokens: activeLoggerOptions.redactSecrets?.length ?? 0,
        source: "env",
    });
}
const memoryStore = new SharedMemoryStore();
const metaCritic = new MetaCritic();
let lastInactivityThresholdMs = 120_000;
const loopDetector = new LoopDetector();
const REFLECTION_PRIORITY_KINDS = new Set(["code", "plan", "text"]);
let reflectionEnabled = parseBooleanEnv(process.env.MCP_ENABLE_REFLECTION, true);
let qualityGateEnabled = parseBooleanEnv(process.env.MCP_QUALITY_GATE, true);
let qualityGateThreshold = parseQualityThresholdEnv(process.env.MCP_QUALITY_THRESHOLD, 70);
let DEFAULT_CHILD_RUNTIME = "codex";
function setDefaultChildRuntime(runtime) {
    DEFAULT_CHILD_RUNTIME = runtime.trim() || "codex";
}
const CHILDREN_ROOT = process.env.MCP_CHILDREN_ROOT
    ? resolvePath(process.cwd(), process.env.MCP_CHILDREN_ROOT)
    : resolvePath(process.cwd(), "children");
function parseDefaultChildArgs(raw) {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.map((value) => String(value));
        }
        logger.warn("child_default_args_invalid", { raw });
    }
    catch (error) {
        logger.warn("child_default_args_parse_error", {
            raw,
            message: error instanceof Error ? error.message : String(error),
        });
    }
    return [];
}
const defaultChildCommand = process.env.MCP_CHILD_COMMAND ?? process.execPath;
const defaultChildArgs = parseDefaultChildArgs(process.env.MCP_CHILD_ARGS);
const childSupervisor = new ChildSupervisor({
    childrenRoot: CHILDREN_ROOT,
    defaultCommand: defaultChildCommand,
    defaultArgs: defaultChildArgs,
    defaultEnv: process.env,
    safety: {
        maxChildren: runtimeChildSafety.maxChildren,
        memoryLimitMb: runtimeChildSafety.memoryLimitMb,
        cpuPercent: runtimeChildSafety.cpuPercent,
    },
});
const autoscaler = new Autoscaler({ supervisor: childSupervisor, logger });
const orchestratorSupervisor = new OrchestratorSupervisor({
    childManager: childSupervisor,
    logger,
    actions: {
        emitAlert: async (incident) => {
            const level = incident.severity === "critical" ? "error" : "warn";
            const eventKind = level === "error" ? "ERROR" : "WARN";
            if (level === "error") {
                logger.error("supervisor_incident", {
                    type: incident.type,
                    reason: incident.reason,
                    context: incident.context,
                });
            }
            else {
                logger.warn("supervisor_incident", {
                    type: incident.type,
                    reason: incident.reason,
                    context: incident.context,
                });
            }
            pushEvent({ kind: eventKind, level, payload: { type: "supervisor_incident", incident } });
        },
        requestRewrite: async (incident) => {
            logger.warn("supervisor_request_rewrite", incident.context);
            pushEvent({ kind: "INFO", level: "warn", payload: { type: "supervisor_request_rewrite", incident } });
        },
        requestRedispatch: async (incident) => {
            logger.warn("supervisor_request_redispatch", incident.context);
            pushEvent({ kind: "INFO", level: "warn", payload: { type: "supervisor_request_redispatch", incident } });
        },
    },
});
function extractMetadataGoals(metadata) {
    if (!metadata) {
        return [];
    }
    const collected = [];
    const candidateKeys = ["goal", "goals", "objective", "objectives", "mission", "target"];
    for (const key of candidateKeys) {
        const value = metadata[key];
        if (typeof value === "string") {
            collected.push(value);
        }
        else if (Array.isArray(value)) {
            for (const entry of value) {
                if (typeof entry === "string") {
                    collected.push(entry);
                }
            }
        }
    }
    return Array.from(new Set(collected
        .map((goal) => goal.toString().trim())
        .filter((goal) => goal.length > 0)));
}
function extractMetadataTags(metadata) {
    if (!metadata) {
        return [];
    }
    const tags = new Set();
    const candidateKeys = ["tags", "labels", "topics", "areas", "keywords"];
    for (const key of candidateKeys) {
        const value = metadata[key];
        if (typeof value === "string") {
            tags.add(value);
        }
        else if (Array.isArray(value)) {
            for (const entry of value) {
                if (typeof entry === "string") {
                    tags.add(entry);
                }
            }
        }
    }
    for (const [key, value] of Object.entries(metadata)) {
        if (typeof value === "string" && /tag|topic|domain|area|category/i.test(key)) {
            tags.add(value);
        }
        else if (Array.isArray(value) && /tag|topic|domain|area|category/i.test(key)) {
            for (const entry of value) {
                if (typeof entry === "string") {
                    tags.add(entry);
                }
            }
        }
    }
    return Array.from(tags)
        .map((tag) => tag.toString().trim().toLowerCase())
        .filter((tag) => tag.length > 0);
}
function renderPromptForMemory(prompt) {
    if (!prompt || typeof prompt !== "object") {
        return "";
    }
    const segments = [];
    const record = prompt;
    for (const key of ["system", "user", "assistant"]) {
        const value = record[key];
        if (typeof value === "string") {
            segments.push(value);
        }
        else if (Array.isArray(value)) {
            for (const entry of value) {
                if (typeof entry === "string") {
                    segments.push(entry);
                }
            }
        }
    }
    return segments.join(" ").slice(0, 512);
}
/**
 * Normalises arbitrary identifiers (job labels, slugs…) into a compact
 * lowercase string compatible with the graph node naming scheme. Non-alphanumeric
 * characters are replaced to avoid creating invalid node IDs.
 */
function sanitiseIdentifier(raw, fallback) {
    if (typeof raw !== "string") {
        return fallback;
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) {
        return fallback;
    }
    const collapsed = trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    if (collapsed.length === 0) {
        return fallback;
    }
    return collapsed.slice(0, 64);
}
/**
 * Looks up the first string value associated with one of the provided metadata
 * keys. The helper keeps the extraction logic readable when multiple aliases
 * may be supplied by callers.
 */
function pickMetadataString(metadata, keys) {
    if (!metadata) {
        return undefined;
    }
    for (const key of keys) {
        const value = metadata[key];
        if (typeof value === "string" && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}
/**
 * Derives a stable job identifier for ad-hoc children spawned outside of plan
 * executions. The identifier is prefixed to avoid clashing with planner
 * generated jobs while still reflecting operator-provided hints when available.
 */
function deriveManualJobId(childId, metadata) {
    const explicit = pickMetadataString(metadata, ["job_id", "jobId", "job", "jobSlug", "jobName"]);
    const base = sanitiseIdentifier(explicit, childId);
    return `manual-${base}`;
}
/**
 * Extracts a human-friendly child name from metadata while falling back to the
 * technical identifier when no label is provided.
 */
function deriveManualChildName(childId, metadata) {
    const candidate = pickMetadataString(metadata, ["name", "label", "title", "alias", "child_name"]);
    if (!candidate) {
        return childId;
    }
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 120) : childId;
}
/**
 * Normalises a prompt segment (string or string array) into a single string.
 * Empty entries are ignored so transcripts remain concise.
 */
function normalisePromptSegment(segment) {
    if (!segment) {
        return undefined;
    }
    if (typeof segment === "string") {
        const trimmed = segment.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    const parts = segment
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0);
    if (parts.length === 0) {
        return undefined;
    }
    return parts.join("\n");
}
/**
 * Extracts the system prompt string, if any, so a synthetic transcript entry
 * can be recorded when we materialise ad-hoc children in the graph.
 */
function deriveSystemPrompt(prompt) {
    if (!prompt) {
        return undefined;
    }
    return normalisePromptSegment(prompt.system);
}
/**
 * Derives a runtime label used by the dashboard. Metadata wins over the
 * underlying executable name which itself falls back to the configured default.
 */
function deriveRuntimeLabel(metadata, runtimeStatus) {
    const metadataRuntime = pickMetadataString(metadata, ["runtime", "model", "engine", "llm"]);
    if (metadataRuntime) {
        return metadataRuntime.trim();
    }
    const command = runtimeStatus.command ?? "";
    const commandBasename = command.length > 0 ? pathBasename(command) : "";
    if (commandBasename.length > 0) {
        return commandBasename;
    }
    return DEFAULT_CHILD_RUNTIME;
}
/**
 * Ensures ad-hoc child creations appear in the graph by synthesising a job and
 * child node when the planner did not pre-register them. This keeps the
 * dashboard consistent regardless of how the runtime was spawned.
 */
function ensureChildVisibleInGraph(options) {
    const { childId, snapshot, metadata, prompt, runtimeStatus, startedAt } = options;
    const existing = graphState.getChild(childId);
    if (existing) {
        graphState.syncChildIndexSnapshot(snapshot);
        return;
    }
    const goals = extractMetadataGoals(metadata);
    const jobId = deriveManualJobId(childId, metadata);
    const createdAtCandidates = [snapshot.startedAt, startedAt, Date.now()].filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
    const createdAt = createdAtCandidates.length > 0 ? createdAtCandidates[0] : Date.now();
    if (!graphState.getJob(jobId)) {
        graphState.createJob(jobId, { createdAt, goal: goals[0], state: "running" });
    }
    else if (goals[0]) {
        graphState.patchJob(jobId, { goal: goals[0] });
    }
    const runtimeLabel = deriveRuntimeLabel(metadata, runtimeStatus);
    const systemPrompt = deriveSystemPrompt(prompt);
    const spec = {
        name: deriveManualChildName(childId, metadata),
        runtime: runtimeLabel,
        goals: goals.length > 0 ? goals.slice(0, 5) : undefined,
        system: systemPrompt,
    };
    graphState.createChild(jobId, childId, spec, { createdAt, ttlAt: null });
    graphState.patchChild(childId, {
        state: snapshot.state,
        runtime: runtimeLabel,
        lastHeartbeatAt: snapshot.lastHeartbeatAt,
        startedAt: snapshot.startedAt,
        waitingFor: null,
        pendingId: null,
    });
    graphState.syncChildIndexSnapshot(snapshot);
}
function summariseChildOutputs(outputs) {
    const parts = [];
    const tags = new Set(["child"]);
    let kind = "text";
    const codeExtensions = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cs", "json", "mjs"]);
    for (const artifact of outputs.artifacts) {
        const ext = artifact.path.split(".").pop()?.toLowerCase();
        if (ext) {
            tags.add(ext);
            if (codeExtensions.has(ext)) {
                kind = "code";
            }
        }
    }
    for (const message of outputs.messages) {
        tags.add(message.stream);
        const parsed = message.parsed;
        if (parsed && typeof parsed === "object") {
            const record = parsed;
            if (typeof record.content === "string") {
                parts.push(record.content);
                continue;
            }
            if (typeof record.text === "string") {
                parts.push(record.text);
                continue;
            }
            parts.push(JSON.stringify(record));
        }
        else if (typeof parsed === "string") {
            parts.push(parsed);
        }
        else if (typeof message.raw === "string") {
            parts.push(message.raw);
        }
    }
    if (kind !== "code") {
        const joined = parts.join(" ").toLowerCase();
        if (/\betape\b|\bétape\b|\bplan\b|\bphase\b/.test(joined)) {
            kind = "plan";
        }
    }
    let text = parts.join("\n").slice(0, 2_000).trim();
    if (!text) {
        text = outputs.artifacts
            .map((artifact) => `${artifact.path} (${artifact.size ?? 0} bytes)`)
            .join("; ");
    }
    if (!text) {
        text = "(aucune sortie)";
    }
    return { text, tags: Array.from(tags), kind };
}
function countMatches(pattern, text) {
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
}
function deriveCodeQualitySignals(summaryText) {
    const tokens = summaryText.split(/\s+/).filter((token) => token.length > 0);
    const testsSignals = countMatches(/\b(test|describe|it|expect)\b/gi, summaryText);
    const lintSignals = countMatches(/\b(?:lint|eslint|tsc|warning|erreur|error|exception)\b/gi, summaryText) +
        countMatches(/\b(fail|échec)\b/gi, summaryText);
    const complexityEstimate = tokens.length === 0 ? 5 : Math.ceil(tokens.length / 40);
    return {
        testsPassed: Math.min(testsSignals, 6),
        lintErrors: Math.min(lintSignals, 10),
        complexity: Math.min(complexityEstimate, 100),
    };
}
function deriveTextQualitySignals(summaryText, reviewScore) {
    const condensed = summaryText.replace(/\s+/g, " ").trim();
    const sentences = condensed.split(/[.!?]+/).map((part) => part.trim()).filter((part) => part.length > 0);
    const words = condensed.length > 0 ? condensed.split(/\s+/) : [];
    const averageSentenceLength = sentences.length > 0 ? words.length / sentences.length : words.length;
    const readability = Math.min(100, Math.max(20, 120 - averageSentenceLength * 3));
    const bulletMatches = countMatches(/\n\s*(?:[-*•]|\d+\.)/g, summaryText);
    const sectionMatches = countMatches(/\n\s*[A-Za-zÀ-ÿ0-9]+\s*:/g, summaryText);
    const structure = Math.min(1, bulletMatches / 5 + sectionMatches / 6 + (sentences.length > 3 ? 0.2 : 0));
    return {
        factsOK: Math.min(1, Math.max(0, reviewScore)),
        readability,
        structure: Math.min(1, Math.max(0, structure)),
    };
}
function derivePlanQualitySignals(summaryText, reviewScore) {
    const lines = summaryText.split(/\n+/).map((line) => line.trim());
    const nonEmpty = lines.filter((line) => line.length > 0);
    const stepLines = nonEmpty.filter((line) => /^(?:\d+\.|[-*•])/.test(line));
    const lower = summaryText.toLowerCase();
    const coherence = Math.min(1, stepLines.length / Math.max(nonEmpty.length, 1));
    const coverage = Math.min(1, stepLines.length / 6 + (summaryText.length > 400 ? 0.25 : 0));
    let risk = reviewScore < 0.5 ? 0.8 : reviewScore < 0.7 ? 0.55 : 0.35;
    if (!/fallback|plan\s*b|mitigation|contingence|secours/.test(lower)) {
        risk += 0.2;
    }
    risk += Math.min(countMatches(/\brisque|bloquant|retard|incident\b/gi, summaryText) * 0.1, 0.3);
    return {
        coherence: Math.min(1, Math.max(0, coherence)),
        coverage: Math.min(1, Math.max(0, coverage)),
        risk: Math.min(1, Math.max(0, risk)),
    };
}
function computeQualityAssessment(kind, summaryText, review) {
    switch (kind) {
        case "code": {
            const signals = deriveCodeQualitySignals(summaryText);
            const result = scoreCode(signals);
            return { score: result.score, rubric: result.rubric, metrics: signals };
        }
        case "text": {
            const signals = deriveTextQualitySignals(summaryText, review.overall);
            const result = scoreText(signals);
            return { score: result.score, rubric: result.rubric, metrics: signals };
        }
        case "plan": {
            const signals = derivePlanQualitySignals(summaryText, review.overall);
            const result = scorePlan(signals);
            return { score: result.score, rubric: result.rubric, metrics: signals };
        }
        default:
            return null;
    }
}
function getChildToolContext() {
    return { supervisor: childSupervisor, logger, loopDetector, contractNet, supervisorAgent: orchestratorSupervisor };
}
function getPlanToolContext() {
    return {
        supervisor: childSupervisor,
        graphState,
        logger,
        childrenRoot: CHILDREN_ROOT,
        defaultChildRuntime: DEFAULT_CHILD_RUNTIME,
        emitEvent: (event) => {
            pushEvent({
                kind: event.kind,
                level: event.level,
                jobId: event.jobId,
                childId: event.childId,
                payload: event.payload,
            });
        },
        stigmergy,
        blackboard: runtimeFeatures.enableBlackboard ? blackboard : undefined,
        supervisorAgent: orchestratorSupervisor,
        causalMemory: runtimeFeatures.enableCausalMemory ? causalMemory : undefined,
        valueGuard: runtimeFeatures.enableValueGuard
            ? { graph: valueGraph, registry: valueGuardRegistry }
            : undefined,
        loopDetector,
        autoscaler: runtimeFeatures.enableAutoscaler ? autoscaler : undefined,
        btStatusRegistry,
    };
}
function getCoordinationToolContext() {
    return { blackboard, stigmergy, contractNet, logger };
}
function getAgentToolContext() {
    return { autoscaler, logger };
}
function getKnowledgeToolContext() {
    return { knowledgeGraph, logger };
}
function getCausalToolContext() {
    return { causalMemory, logger };
}
function getValueToolContext() {
    return { valueGraph, logger };
}
function normaliseToolError(error, defaultCode) {
    const message = error instanceof Error ? error.message : String(error);
    let code = defaultCode;
    let hint;
    let details;
    if (error instanceof z.ZodError) {
        code = defaultCode;
        hint = "invalid_input";
        details = { issues: error.issues };
    }
    else if (typeof error.code === "string") {
        code = error.code;
        if (typeof error.hint === "string") {
            hint = error.hint;
        }
        if (Object.prototype.hasOwnProperty.call(error, "details")) {
            details = error.details;
        }
    }
    else if (Object.prototype.hasOwnProperty.call(error, "details")) {
        details = error.details;
    }
    return { code, message, hint, details };
}
function childToolError(toolName, error, context = {}) {
    const defaultCode = error instanceof UnknownChildError ? "NOT_FOUND" : "CHILD_TOOL_ERROR";
    const normalised = normaliseToolError(error, defaultCode);
    logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
    const payload = {
        error: normalised.code,
        tool: toolName,
        message: normalised.message,
    };
    if (normalised.hint) {
        payload.hint = normalised.hint;
    }
    if (normalised.details !== undefined) {
        payload.details = normalised.details;
    }
    return {
        isError: true,
        content: [{ type: "text", text: j(payload) }],
    };
}
function planToolError(toolName, error, context = {}, defaultCode = "PLAN_TOOL_ERROR") {
    const normalised = normaliseToolError(error, defaultCode);
    logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
    const payload = {
        error: normalised.code,
        tool: toolName,
        message: normalised.message,
    };
    if (normalised.hint) {
        payload.hint = normalised.hint;
    }
    if (normalised.details !== undefined) {
        payload.details = normalised.details;
    }
    return {
        isError: true,
        content: [{ type: "text", text: j(payload) }],
    };
}
function graphToolError(toolName, error, context = {}, defaultCode = "GRAPH_TOOL_ERROR") {
    const normalised = normaliseToolError(error, defaultCode);
    logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
    const payload = {
        error: normalised.code,
        tool: toolName,
        message: normalised.message,
    };
    if (normalised.hint) {
        payload.hint = normalised.hint;
    }
    if (normalised.details !== undefined) {
        payload.details = normalised.details;
    }
    return {
        isError: true,
        content: [{ type: "text", text: j(payload) }],
    };
}
function coordinationToolError(toolName, error, context = {}, defaultCode = "COORD_TOOL_ERROR") {
    const normalised = normaliseToolError(error, defaultCode);
    logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
    const payload = {
        error: normalised.code,
        tool: toolName,
        message: normalised.message,
    };
    if (normalised.hint) {
        payload.hint = normalised.hint;
    }
    if (normalised.details !== undefined) {
        payload.details = normalised.details;
    }
    return {
        isError: true,
        content: [{ type: "text", text: j(payload) }],
    };
}
function knowledgeToolError(toolName, error, context = {}, defaultCode = "KNOWLEDGE_TOOL_ERROR") {
    const normalised = normaliseToolError(error, defaultCode);
    logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
    const payload = {
        error: normalised.code,
        tool: toolName,
        message: normalised.message,
    };
    if (normalised.hint) {
        payload.hint = normalised.hint;
    }
    if (normalised.details !== undefined) {
        payload.details = normalised.details;
    }
    return {
        isError: true,
        content: [{ type: "text", text: j(payload) }],
    };
}
function causalToolError(toolName, error, context = {}, defaultCode = "CAUSAL_TOOL_ERROR") {
    const normalised = normaliseToolError(error, defaultCode);
    logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
    const payload = {
        error: normalised.code,
        tool: toolName,
        message: normalised.message,
    };
    if (normalised.hint) {
        payload.hint = normalised.hint;
    }
    if (normalised.details !== undefined) {
        payload.details = normalised.details;
    }
    return {
        isError: true,
        content: [{ type: "text", text: j(payload) }],
    };
}
function valueToolError(toolName, error, context = {}, defaultCode = "VALUE_TOOL_ERROR") {
    const normalised = normaliseToolError(error, defaultCode);
    logger.error(`${toolName}_failed`, { ...context, message: normalised.message, code: normalised.code, details: normalised.details });
    const payload = {
        error: normalised.code,
        tool: toolName,
        message: normalised.message,
    };
    if (normalised.hint) {
        payload.hint = normalised.hint;
    }
    if (normalised.details !== undefined) {
        payload.details = normalised.details;
    }
    return {
        isError: true,
        content: [{ type: "text", text: j(payload) }],
    };
}
function ensureKnowledgeEnabled(toolName) {
    if (!runtimeFeatures.enableKnowledge) {
        logger.warn(`${toolName}_disabled`, { tool: toolName });
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: j({ error: "KNOWLEDGE_DISABLED", tool: toolName, message: "knowledge module disabled" }),
                },
            ],
        };
    }
    return null;
}
function ensureCausalMemoryEnabled(toolName) {
    if (!runtimeFeatures.enableCausalMemory) {
        logger.warn(`${toolName}_disabled`, { tool: toolName });
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: j({ error: "CAUSAL_MEMORY_DISABLED", tool: toolName, message: "causal memory module disabled" }),
                },
            ],
        };
    }
    return null;
}
function ensureValueGuardEnabled(toolName) {
    if (!runtimeFeatures.enableValueGuard) {
        logger.warn(`${toolName}_disabled`, { tool: toolName });
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: j({ error: "VALUE_GUARD_DISABLED", tool: toolName, message: "value guard disabled" }),
                },
            ],
        };
    }
    return null;
}
const SUBS = new Map();
// ---------------------------
// Utils
// ---------------------------
const now = () => Date.now();
const j = (o) => JSON.stringify(o, null, 2);
/**
 * Input schema guarding the `graph_subgraph_extract` tool. The strict contract
 * rejects stray properties so export destinations remain predictable.
 */
const GraphSubgraphExtractInputSchema = z
    .object({
    graph: GraphDescriptorSchema,
    node_id: z.string().min(1),
    run_id: z.string().min(1),
    directory: z.string().min(1).optional(),
})
    .strict();
const GraphSubgraphExtractInputShape = GraphSubgraphExtractInputSchema.shape;
function pushEvent(event) {
    const emitted = eventStore.emit({
        kind: event.kind,
        level: event.level,
        source: event.source,
        jobId: event.jobId,
        childId: event.childId,
        payload: event.payload
    });
    graphState.recordEvent({
        seq: emitted.seq,
        ts: emitted.ts,
        kind: emitted.kind,
        level: emitted.level,
        jobId: emitted.jobId,
        childId: emitted.childId
    });
    return emitted;
}
function listEventsSince(lastSeq, jobId, childId) {
    return eventStore.list({ minSeq: lastSeq, jobId, childId });
}
function buildLiveEvents(input) {
    const base = eventStore.list({ jobId: input.job_id, childId: input.child_id });
    const filtered = base.filter((evt) => typeof input.min_seq === "number" ? evt.seq >= input.min_seq : true);
    const ordered = [...filtered].sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq));
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 500) : 100;
    return ordered.slice(0, limit).map((evt) => {
        const deepLink = evt.childId ? `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(evt.childId)}` : null;
        const commandUri = evt.childId
            ? `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: evt.childId }))}`
            : null;
        return { ...evt, vscode_deeplink: deepLink, vscode_command: commandUri };
    });
}
// Heartbeat
let HEARTBEAT_TIMER = null;
function startHeartbeat() {
    if (HEARTBEAT_TIMER)
        return;
    HEARTBEAT_TIMER = setInterval(() => {
        for (const job of graphState.listJobsByState("running")) {
            pushEvent({ kind: "HEARTBEAT", jobId: job.id, payload: { msg: "alive" } });
        }
    }, 2000);
}
// ---------------------------
// Orchestrateur (jobs/enfants)
// ---------------------------
function createJob(goal) {
    const jobId = `job_${randomUUID()}`;
    graphState.createJob(jobId, { goal, createdAt: now(), state: "running" });
    return jobId;
}
function createChild(jobId, spec, ttl_s) {
    const childId = `child_${randomUUID()}`;
    const createdAt = now();
    const ttlAt = ttl_s ? createdAt + ttl_s * 1000 : null;
    const normalizedSpec = { ...spec, runtime: spec.runtime ?? DEFAULT_CHILD_RUNTIME };
    graphState.createChild(jobId, childId, normalizedSpec, { createdAt, ttlAt });
    return childId;
}
function findJobIdByChild(childId) {
    return graphState.findJobIdByChild(childId);
}
function pruneExpired() {
    const t = now();
    for (const child of graphState.listChildSnapshots()) {
        if (child.ttlAt && t > child.ttlAt && child.state !== "killed") {
            graphState.clearPendingForChild(child.id);
            graphState.patchChild(child.id, { state: "killed", waitingFor: null, pendingId: null, ttlAt: null });
            const jobId = child.jobId ?? findJobIdByChild(child.id);
            pushEvent({ kind: "KILL", jobId, childId: child.id, level: "warn", payload: { reason: "ttl" } });
        }
    }
    const expiredEntries = blackboard.evictExpired();
    if (expiredEntries.length > 0) {
        const keys = expiredEntries.map((event) => event.key);
        logger.info("bb_expire", {
            count: expiredEntries.length,
            keys: keys.slice(0, 5),
            truncated: keys.length > 5 ? keys.length - 5 : 0,
        });
    }
}
// ---------------------------
// Aggregation
// ---------------------------
function aggregateConcat(jobId, opts) {
    const job = graphState.getJob(jobId);
    if (!job) {
        throw new Error(`Unknown job '${jobId}'`);
    }
    const transcripts = job.childIds.map((cid) => {
        const child = graphState.getChild(cid);
        const slice = graphState.getTranscript(cid, { limit: 1000 });
        const items = slice.items.filter((m) => {
            if (m.role === "system" && opts?.includeSystem === false)
                return false;
            if (m.role === "user" && child?.name && m.content.startsWith("Objectifs:") && opts?.includeGoals === false)
                return false;
            return true;
        });
        return {
            child_id: cid,
            name: child?.name ?? cid,
            transcript: items.map((m) => ({
                idx: m.idx,
                role: m.role,
                content: m.content,
                ts: m.ts,
                actor: m.actor
            }))
        };
    });
    const summary = transcripts
        .map((t) => `# ${t.name}\n` + t.transcript.map((m) => `- [${m.role}] ${m.content}`).join("\n"))
        .join("\n\n");
    return { summary, transcripts, artifacts: [] };
}
function aggregateCompact(jobId, opts) {
    const base = aggregateConcat(jobId, opts);
    const compactLines = [];
    for (const t of base.transcripts) {
        compactLines.push(`# ${t.name}`);
        const merged = [];
        for (const m of t.transcript) {
            if (m.role === "assistant") {
                const prev = merged[merged.length - 1];
                if (prev && prev.role === "assistant") {
                    prev.content = `${prev.content} ${m.content}`.replace(/\s+/g, " ").trim();
                }
                else {
                    merged.push({ role: m.role, content: m.content });
                }
            }
            else {
                merged.push({ role: m.role, content: m.content });
            }
        }
        for (const m of merged)
            compactLines.push(`- [${m.role}] ${m.content}`);
        compactLines.push("");
    }
    const summary = compactLines.join("\n").trim();
    return { summary, transcripts: base.transcripts, artifacts: [] };
}
function aggregateJsonl(jobId) {
    const job = graphState.getJob(jobId);
    if (!job)
        throw new Error(`Unknown job '${jobId}'`);
    const lines = [];
    for (const cid of job.childIds) {
        const child = graphState.getChild(cid);
        const slice = graphState.getTranscript(cid, { limit: 5000 });
        for (const m of slice.items) {
            lines.push(JSON.stringify({ child_id: cid, child_name: child?.name ?? cid, idx: m.idx, role: m.role, content: m.content, ts: m.ts, actor: m.actor ?? null }));
        }
    }
    const summary = `jsonl_count=${lines.length}`;
    return { summary, transcripts: [], artifacts: lines };
}
function aggregate(jobId, strategy, opts) {
    switch (strategy) {
        case "markdown_compact":
            return aggregateCompact(jobId, opts);
        case "jsonl":
            return aggregateJsonl(jobId);
        case "json_merge":
        case "vote":
            return aggregateConcat(jobId, opts);
        case "concat":
        default:
            return aggregateConcat(jobId, opts);
    }
}
// ---------------------------
// Zod shapes et types
// ---------------------------
const ChildSpecShape = {
    name: z.string(),
    system: z.string().optional(),
    goals: z.array(z.string()).optional(),
    runtime: z.string().optional()
};
const StartShape = {
    job_id: z.string(),
    children: z.array(z.object(ChildSpecShape)).optional()
};
const StartSchema = z.object(StartShape);
const ChildPromptShape = {
    child_id: z.string(),
    messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
};
const ChildPromptSchema = z.object(ChildPromptShape);
const ChildPushReplyShape = { pending_id: z.string(), content: z.string() };
const ChildPushReplySchema = z.object(ChildPushReplyShape);
const ChildPushPartialShape = { pending_id: z.string(), delta: z.string(), done: z.boolean().optional() };
const ChildPushPartialSchema = z.object(ChildPushPartialShape);
const StatusShape = { job_id: z.string().optional() };
const StatusSchema = z.object(StatusShape);
const AggregateShape = {
    job_id: z.string(),
    // Accept any string to allow client wrappers with custom strategies; server falls back gracefully.
    strategy: z.string().optional(),
    include_system: z.boolean().optional(),
    include_goals: z.boolean().optional()
};
const AggregateSchema = z.object(AggregateShape);
const KillShape = { child_id: z.string().optional(), job_id: z.string().optional() };
const KillSchema = z.object(KillShape);
const ChildInfoShape = { child_id: z.string() };
const ChildInfoSchema = z.object(ChildInfoShape);
const ChildTranscriptShape = {
    child_id: z.string(),
    since_index: z.number().int().min(0).optional(),
    since_ts: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    reverse: z.boolean().optional()
};
const ChildTranscriptSchema = z.object(ChildTranscriptShape);
const ChildChatShape = {
    child_id: z.string(),
    content: z.string(),
    role: z.enum(["user", "system"]).optional()
};
const ChildChatSchema = z.object(ChildChatShape);
const ChildRenameShape = { child_id: z.string(), name: z.string().min(1) };
const ChildRenameSchema = z.object(ChildRenameShape);
const ChildResetShape = { child_id: z.string(), keep_system: z.boolean().optional() };
const ChildResetSchema = z.object(ChildResetShape);
const GraphForgeAnalysisShape = {
    name: z.string().min(1),
    args: z.array(z.string()).optional(),
    weight_key: z.string().optional()
};
const GraphForgeAnalysisSchema = z.object(GraphForgeAnalysisShape);
const GraphForgeShape = {
    source: z.string().optional(),
    path: z.string().optional(),
    entry_graph: z.string().optional(),
    weight_key: z.string().optional(),
    use_defined_analyses: z.boolean().optional(),
    analyses: z.array(GraphForgeAnalysisSchema).optional()
};
const GraphForgeSchemaBase = z.object(GraphForgeShape);
const GraphForgeSchema = GraphForgeSchemaBase.refine((input) => Boolean(input.source) || Boolean(input.path), { message: "Provide 'source' or 'path'", path: ["source"] });
const SubscribeShape = { job_id: z.string().optional(), child_id: z.string().optional(), last_seq: z.number().optional() };
const SubscribeSchema = z.object(SubscribeShape);
const PollShape = {
    subscription_id: z.string(),
    since_seq: z.number().optional(),
    max_events: z.number().optional(),
    wait_ms: z.number().optional(),
    suppress: z.array(z.enum([
        "PLAN",
        "START",
        "PROMPT",
        "PENDING",
        "REPLY_PART",
        "REPLY",
        "STATUS",
        "AGGREGATE",
        "KILL",
        "HEARTBEAT",
        "INFO",
        "WARN",
        "ERROR"
    ])).optional()
};
const PollSchema = z.object(PollShape);
const UnsubscribeShape = { subscription_id: z.string() };
const UnsubscribeSchema = z.object(UnsubscribeShape);
// Graph export/save/load
const GraphExportShape = {
    format: z.enum(["json", "mermaid", "dot", "graphml"]).default("json"),
    direction: z.enum(["LR", "TB"]).optional(),
    label_attribute: z.string().min(1).optional(),
    weight_attribute: z.string().min(1).optional(),
    max_label_length: z.number().int().min(8).max(160).optional(),
    inline: z.boolean().default(true),
    path: z.string().min(1).optional(),
    pretty: z.boolean().default(true),
    truncate: z.number().int().min(256).max(16384).optional(),
};
const GraphExportSchema = z.object(GraphExportShape).superRefine((input, ctx) => {
    if (!input.inline && !input.path) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "when inline=false a path must be provided",
            path: ["path"],
        });
    }
});
const GraphSaveShape = { path: z.string() };
const GraphSaveSchema = z.object(GraphSaveShape);
const GraphLoadShape = { path: z.string() };
const GraphLoadSchema = z.object(GraphLoadShape);
const GraphRuntimeShape = { runtime: z.string().optional(), reset: z.boolean().optional() };
const GraphRuntimeSchema = z.object(GraphRuntimeShape);
const GraphStatsShape = {};
const GraphStatsSchema = z.object(GraphStatsShape);
const GraphInactivityShape = {
    scope: z.enum(["children"]).optional(),
    idle_threshold_ms: z.number().min(0).optional(),
    pending_threshold_ms: z.number().min(0).optional(),
    inactivity_threshold_sec: z.number().min(0).optional(),
    inactivityThresholdSec: z.number().min(0).optional(),
    job_id: z.string().optional(),
    runtime: z.string().optional(),
    state: z.string().optional(),
    include_children_without_messages: z.boolean().optional(),
    limit: z.number().optional(),
    format: z.enum(["json", "text"]).optional()
};
const GraphInactivitySchema = z.object(GraphInactivityShape);
// job_view
const JobViewShape = { job_id: z.string(), per_child_limit: z.number().optional(), format: z.enum(["json", "text"]).optional(), include_system: z.boolean().optional() };
const JobViewSchema = z.object(JobViewShape);
const EventsViewLiveShape = {
    job_id: z.string().optional(),
    child_id: z.string().optional(),
    limit: z.number().optional(),
    order: z.enum(["asc", "desc"]).optional(),
    min_seq: z.number().optional()
};
const EventsViewLiveSchema = z.object(EventsViewLiveShape);
const GraphPruneShape = {
    action: z.enum(["transcript", "events"]),
    child_id: z.string().optional(),
    keep_last: z.number().optional(),
    job_id: z.string().optional(),
    max_events: z.number().optional()
};
const GraphPruneSchema = z.object(GraphPruneShape);
let graphForgeModulePromise = null;
async function loadGraphForge() {
    if (!graphForgeModulePromise) {
        graphForgeModulePromise = (async () => {
            const distUrl = new URL("../graph-forge/dist/index.js", import.meta.url);
            try {
                return (await import(distUrl.href));
            }
            catch (distError) {
                const srcUrl = new URL("../graph-forge/src/index.ts", import.meta.url);
                try {
                    return (await import(srcUrl.href));
                }
                catch {
                    throw distError;
                }
            }
        })();
    }
    return graphForgeModulePromise;
}
function describeError(err) {
    if (err instanceof Error) {
        return { name: err.name, message: err.message, stack: err.stack };
    }
    return { name: "UnknownError", message: String(err) };
}
function toStringArg(value) {
    if (value === null || value === undefined)
        return "";
    if (typeof value === "object")
        return JSON.stringify(value);
    return String(value);
}
function runGraphForgeAnalysis(mod, compiled, task, defaultWeightKey) {
    const weightAttribute = task.weightKey ?? defaultWeightKey;
    switch (task.name) {
        case "shortestPath": {
            if (task.args.length < 2) {
                throw new Error("shortestPath requires <start> and <goal>");
            }
            const [start, goal] = task.args;
            return mod.shortestPath(compiled.graph, start, goal, { weightAttribute });
        }
        case "criticalPath":
            return mod.criticalPath(compiled.graph, { weightAttribute });
        case "stronglyConnected": {
            if (task.args.length) {
                throw new Error("stronglyConnected does not accept arguments");
            }
            return mod.tarjanScc(compiled.graph);
        }
        default:
            throw new Error(`Unknown analysis '${task.name}'`);
    }
}
const server = new McpServer({ name: "mcp-self-fork-orchestrator", version: "1.3.0" });
// job_view (apercu d'un job avec previsualisation transcript + liens VS Code)
server.registerTool("job_view", { title: "Job view", description: "Vue d'ensemble d'un job avec un extrait par enfant.", inputSchema: JobViewShape }, async (input) => {
    const job = graphState.getJob(input.job_id);
    if (!job)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };
    const perChild = Math.max(1, Math.min(input.per_child_limit ?? 20, 200));
    const includeSystem = input.include_system ?? true;
    const children = graphState.listChildren(job.id).map((child) => {
        const slice = graphState.getTranscript(child.id, { limit: perChild });
        const items = slice.items.filter((m) => (m.role === "system" ? includeSystem : true));
        const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(child.id)}`;
        const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: child.id }))}`;
        return {
            id: child.id,
            name: child.name,
            state: child.state,
            runtime: child.runtime,
            waiting_for: child.waitingFor,
            pending_id: child.pendingId,
            transcript_preview: items,
            vscode_deeplink: deepLink,
            vscode_command: commandUri
        };
    });
    if ((input.format ?? "json") === "text") {
        const lines = [`# Job ${job.id} (${children.length} enfants)`];
        for (const c of children) {
            lines.push(`\n## ${c.name} (${c.id}) [${c.state}] runtime=${c.runtime}`);
            for (const m of c.transcript_preview)
                lines.push(`- [${m.role}] ${m.content}`);
            lines.push(`(open) ${c.vscode_deeplink}`);
        }
        return { content: [{ type: "text", text: j({ format: "text", render: lines.join("\n") }) }] };
    }
    return { content: [{ type: "text", text: j({ format: "json", job: { id: job.id, state: job.state }, children }) }] };
});
// graph_export
server.registerTool("graph_export", { title: "Graph export", description: "Exporte l'etat graphe en JSON.", inputSchema: GraphExportShape }, async (input) => {
    try {
        const parsed = GraphExportSchema.parse(input);
        const snapshot = graphState.serialize();
        const descriptor = snapshotToGraphDescriptor(snapshot, {
            labelAttribute: parsed.label_attribute,
        });
        let payloadString = "";
        let structuredPayload = null;
        switch (parsed.format) {
            case "json": {
                structuredPayload = {
                    snapshot,
                    descriptor,
                };
                payloadString = JSON.stringify(structuredPayload, null, parsed.pretty ? 2 : 0);
                break;
            }
            case "mermaid": {
                payloadString = renderMermaidFromGraph(descriptor, {
                    direction: parsed.direction ?? "LR",
                    labelAttribute: parsed.label_attribute,
                    weightAttribute: parsed.weight_attribute,
                    maxLabelLength: parsed.max_label_length,
                });
                break;
            }
            case "dot": {
                payloadString = renderDotFromGraph(descriptor, {
                    labelAttribute: parsed.label_attribute,
                    weightAttribute: parsed.weight_attribute,
                });
                break;
            }
            case "graphml": {
                payloadString = renderGraphmlFromGraph(descriptor, {
                    labelAttribute: parsed.label_attribute,
                    weightAttribute: parsed.weight_attribute,
                });
                break;
            }
        }
        const bytes = Buffer.byteLength(payloadString, "utf8");
        const maxPreview = parsed.truncate ?? 4096;
        const notes = [];
        let absolutePath = null;
        if (parsed.path) {
            const cwd = process.cwd();
            const absolute = resolvePath(cwd, parsed.path);
            if (!absolute.toLowerCase().startsWith(cwd.toLowerCase())) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text",
                            text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }),
                        },
                    ],
                };
            }
            await mkdir(pathDirname(absolute), { recursive: true });
            await writeFile(absolute, payloadString, "utf8");
            absolutePath = absolute;
        }
        const inline = parsed.inline ?? true;
        let preview = payloadString;
        let truncated = false;
        if (payloadString.length > maxPreview) {
            preview = payloadString.slice(0, maxPreview);
            truncated = true;
            notes.push("content_truncated");
        }
        const result = {
            format: parsed.format,
            bytes,
            inline,
            truncated,
            path: absolutePath,
            notes,
        };
        if (inline) {
            if (parsed.format === "json") {
                result.payload = structuredPayload;
            }
            else {
                result.preview = preview;
            }
        }
        else {
            result.preview = preview;
        }
        return {
            content: [
                {
                    type: "text",
                    text: j({ tool: "graph_export", result }),
                },
            ],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_export", error);
    }
});
// graph_state_save
server.registerTool("graph_state_save", { title: "Graph save", description: "Sauvegarde l'etat graphe dans un fichier JSON.", inputSchema: GraphSaveShape }, async (input) => {
    const cwd = process.cwd();
    const abs = resolvePath(cwd, input.path);
    if (!abs.toLowerCase().startsWith(cwd.toLowerCase())) {
        return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
    }
    const snap = graphState.serialize();
    await writeFile(abs, JSON.stringify(snap, null, 2), "utf8");
    return { content: [{ type: "text", text: j({ format: "json", ok: true, path: abs }) }] };
});
// graph_state_load
server.registerTool("graph_state_load", { title: "Graph load", description: "Recharge l'etat graphe depuis un fichier JSON.", inputSchema: GraphLoadShape }, async (input) => {
    const cwd = process.cwd();
    const abs = resolvePath(cwd, input.path);
    if (!abs.toLowerCase().startsWith(cwd.toLowerCase())) {
        return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
    }
    const data = await readFile(abs, "utf8");
    const snap = JSON.parse(data);
    graphState.resetFromSnapshot(snap);
    return { content: [{ type: "text", text: j({ format: "json", ok: true, path: abs }) }] };
});
// conversation_view (vue conviviale de la discussion orchestrateur<->enfant)
server.registerTool("conversation_view", { title: "Conversation view", description: "Affiche la conversation d'un enfant (texte ou JSON).", inputSchema: { child_id: z.string(), since_index: z.number().optional(), since_ts: z.number().optional(), limit: z.number().optional(), format: z.enum(["text", "json"]).optional(), include_system: z.boolean().optional() } }, async (input) => {
    const child = graphState.getChild(input.child_id);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    const slice = graphState.getTranscript(child.id, { sinceIndex: input.since_index, sinceTs: input.since_ts, limit: input.limit });
    const items = slice.items.filter((m) => (m.role === "system" ? (input.include_system ?? true) : true));
    const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(child.id)}`;
    const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: child.id }))}`;
    if ((input.format ?? "text") === "json") {
        return { content: [{ type: "text", text: j({ format: "json", child: { id: child.id, name: child.name }, total: slice.total, items, vscode_deeplink: deepLink, vscode_command: commandUri }) }] };
    }
    const lines = [
        `# ${child.name} (${child.id})`,
        ...items.map((m) => `- [${m.role}] ${m.content}`)
    ];
    return { content: [{ type: "text", text: j({ format: "text", render: lines.join("\n"), vscode_deeplink: deepLink, vscode_command: commandUri }) }] };
});
// events_view (liste des evenements recents ou pending)
server.registerTool("events_view", { title: "Events view", description: "Affiche les evenements (recent/pending/live)", inputSchema: { mode: z.enum(["recent", "pending", "live"]).optional(), job_id: z.string().optional(), child_id: z.string().optional(), limit: z.number().optional(), order: z.enum(["asc", "desc"]).optional(), min_seq: z.number().optional() } }, async (input) => {
    const mode = input.mode ?? "recent";
    if (mode === "pending") {
        const nodes = graphState.filterNodes({ type: "pending" }, undefined);
        const items = nodes
            .filter((n) => (input.child_id ? String(n.attributes.child_id ?? "") === input.child_id : true))
            .map((n) => {
            const childId = String(n.attributes.child_id ?? "");
            const deepLink = `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(childId)}`;
            const commandUri = `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: childId }))}`;
            return { id: n.id, child_id: childId, created_at: Number(n.attributes.created_at ?? 0), vscode_deeplink: deepLink, vscode_command: commandUri };
        });
        return { content: [{ type: "text", text: j({ format: "json", mode: "pending", pending: items }) }] };
    }
    if (mode === "live") {
        const events = buildLiveEvents({ job_id: input.job_id, child_id: input.child_id, limit: input.limit, order: input.order, min_seq: input.min_seq });
        return { content: [{ type: "text", text: j({ format: "json", mode: "live", events, via: "events_view" }) }] };
    }
    const limit = input.limit && input.limit > 0 ? input.limit : 100;
    const events = graphState
        .filterNodes({ type: "event" }, undefined)
        .filter((n) => (input.job_id ? String(n.attributes.job_id ?? "") === input.job_id : true))
        .filter((n) => (input.child_id ? String(n.attributes.child_id ?? "") === input.child_id : true))
        .map((n) => {
        const childId = String(n.attributes.child_id ?? "");
        const deepLink = childId ? `vscode://local.self-fork-orchestrator-viewer/open?child_id=${encodeURIComponent(childId)}` : null;
        const commandUri = childId ? `command:selfForkViewer.openConversation?${encodeURIComponent(JSON.stringify({ child_id: childId }))}` : null;
        return {
            id: n.id,
            seq: Number(n.attributes.seq ?? 0),
            ts: Number(n.attributes.ts ?? 0),
            kind: String(n.attributes.kind ?? ""),
            level: String(n.attributes.level ?? "info"),
            job_id: String(n.attributes.job_id ?? ""),
            child_id: childId,
            vscode_deeplink: deepLink,
            vscode_command: commandUri
        };
    })
        .sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq))
        .slice(0, limit);
    return { content: [{ type: "text", text: j({ format: "json", mode: "recent", events, live_hint: { tool: "events_view_live", suggested_input: { job_id: input.job_id ?? null, child_id: input.child_id ?? null, limit: input.limit ?? null, order: input.order ?? null, min_seq: input.min_seq ?? null } } }) }] };
});
// events_view_live (liste les evenements du bus live, sans dependre du graphe ni des suppressions cote client)
server.registerTool("events_view_live", { title: "Events view (live)", description: "Affiche les evenements issus du bus live.", inputSchema: EventsViewLiveShape }, async (input) => {
    const events = buildLiveEvents(input);
    return { content: [{ type: "text", text: j({ format: "json", mode: "live", events, via: "events_view_live" }) }] };
});
// Autosave (start/stop)
let AUTOSAVE_TIMER = null;
let AUTOSAVE_PATH = null;
server.registerTool("graph_state_autosave", { title: "Graph autosave", description: "Demarre/arrete la sauvegarde periodique du graphe.", inputSchema: { action: z.enum(["start", "stop"]), path: z.string().optional(), interval_ms: z.number().optional() } }, async (input) => {
    if (input.action === "stop") {
        if (AUTOSAVE_TIMER)
            clearInterval(AUTOSAVE_TIMER);
        AUTOSAVE_TIMER = null;
        AUTOSAVE_PATH = null;
        return { content: [{ type: "text", text: j({ format: "json", ok: true, status: "stopped" }) }] };
    }
    const cwd = process.cwd();
    const p = input.path ? resolvePath(cwd, input.path) : resolvePath(cwd, "graph-autosave.json");
    if (!p.toLowerCase().startsWith(cwd.toLowerCase())) {
        return { isError: true, content: [{ type: "text", text: j({ error: "BAD_PATH", message: "Path must be inside workspace" }) }] };
    }
    const interval = Math.min(Math.max(input.interval_ms ?? 5000, 1000), 600000);
    if (AUTOSAVE_TIMER)
        clearInterval(AUTOSAVE_TIMER);
    AUTOSAVE_PATH = p;
    AUTOSAVE_TIMER = setInterval(async () => {
        try {
            const snap = graphState.serialize();
            const metadata = {
                saved_at: new Date().toISOString(),
                inactivity_threshold_ms: lastInactivityThresholdMs,
                event_history_limit: eventStore.getMaxHistory()
            };
            await writeFile(AUTOSAVE_PATH, JSON.stringify({ metadata, snapshot: snap }, null, 2), "utf8");
            logger.info("graph_autosave_written", {
                path: AUTOSAVE_PATH,
                node_count: snap.nodes.length,
                edge_count: snap.edges.length
            });
        }
        catch (error) {
            logger.error("graph_autosave_failed", {
                path: AUTOSAVE_PATH,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }, interval);
    return {
        content: [
            {
                type: "text",
                text: j({
                    format: "json",
                    ok: true,
                    status: "started",
                    path: p,
                    interval_ms: interval,
                    inactivity_threshold_ms: lastInactivityThresholdMs,
                    event_history_limit: eventStore.getMaxHistory()
                })
            }
        ]
    };
});
// graph_config_retention
server.registerTool("graph_config_retention", { title: "Graph retention", description: "Configure la retention (transcripts, events).", inputSchema: { max_transcript_per_child: z.number().optional(), max_event_nodes: z.number().optional() } }, async (input) => {
    graphState.configureRetention({
        maxTranscriptPerChild: input.max_transcript_per_child,
        maxEventNodes: input.max_event_nodes
    });
    return { content: [{ type: "text", text: j({ format: "json", ok: true }) }] };
});
// graph_prune
server.registerTool("graph_prune", { title: "Graph prune", description: "Prune manuellement des transcripts ou evenements.", inputSchema: GraphPruneShape }, async (input) => {
    if (input.action === "transcript") {
        if (!input.child_id || typeof input.keep_last !== "number") {
            return {
                isError: true,
                content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "child_id et keep_last requis" }) }]
            };
        }
        const keep = Math.max(0, Math.floor(input.keep_last));
        graphState.pruneChildTranscript(input.child_id, keep);
        return { content: [{ type: "text", text: j({ ok: true, action: "transcript", child_id: input.child_id, keep_last: keep }) }] };
    }
    const max = typeof input.max_events === "number" ? Math.max(0, Math.floor(input.max_events)) : 0;
    if (max <= 0) {
        return {
            isError: true,
            content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "max_events > 0 requis" }) }]
        };
    }
    graphState.pruneEvents(max, input.job_id ?? undefined, input.child_id ?? undefined);
    return {
        content: [
            {
                type: "text",
                text: j({ ok: true, action: "events", job_id: input.job_id ?? null, child_id: input.child_id ?? null, max_events: max })
            }
        ]
    };
});
// graph_query
server.registerTool("graph_config_runtime", { title: "Graph runtime", description: "Configure le runtime par defaut des enfants planifies.", inputSchema: GraphRuntimeShape }, async (input) => {
    const previous = DEFAULT_CHILD_RUNTIME;
    if (input.reset) {
        setDefaultChildRuntime("codex");
    }
    else if (typeof input.runtime === 'string' && input.runtime.trim().length) {
        setDefaultChildRuntime(input.runtime);
    }
    return { content: [{ type: "text", text: j({ format: "json", ok: true, runtime: DEFAULT_CHILD_RUNTIME, previous }) }] };
});
server.registerTool("graph_state_stats", { title: "Graph stats", description: "Expose des compteurs sur les noeuds/aretes et runtimes.", inputSchema: GraphStatsShape }, async (_input) => {
    const nodes = graphState.listNodeRecords();
    const edges = graphState.listEdgeRecords();
    const stats = {
        nodes: nodes.length,
        edges: edges.length,
        jobs: 0,
        children: 0,
        messages: 0,
        pending: 0,
        events: 0,
        subscriptions: 0
    };
    const runtimeCounts = {};
    const childStateCounts = {};
    for (const node of nodes) {
        const attrs = node.attributes ?? {};
        const type = String(attrs.type ?? '');
        switch (type) {
            case 'job':
                stats.jobs += 1;
                break;
            case 'child': {
                stats.children += 1;
                const runtime = String(attrs.runtime ?? DEFAULT_CHILD_RUNTIME);
                runtimeCounts[runtime] = (runtimeCounts[runtime] ?? 0) + 1;
                const state = String(attrs.state ?? '');
                if (state)
                    childStateCounts[state] = (childStateCounts[state] ?? 0) + 1;
                break;
            }
            case 'message':
                stats.messages += 1;
                break;
            case 'pending':
                stats.pending += 1;
                break;
            case 'event':
                stats.events += 1;
                break;
            case 'subscription':
                stats.subscriptions += 1;
                break;
            default:
                break;
        }
    }
    const jobs = graphState.listJobs().map((job) => ({ id: job.id, state: job.state, child_count: job.childIds.length }));
    return {
        content: [
            {
                type: 'text',
                text: j({
                    format: 'json',
                    stats,
                    runtimes: runtimeCounts,
                    child_states: childStateCounts,
                    jobs,
                    default_runtime: DEFAULT_CHILD_RUNTIME
                })
            }
        ]
    };
});
server.registerTool("graph_state_metrics", {
    title: "Graph metrics",
    description: "Expose des métriques synthétiques (jobs actifs, événements, heartbeats).",
    inputSchema: GraphStatsShape
}, async () => {
    const metrics = graphState.collectMetrics();
    const heartbeatEvents = eventStore.getEventsByKind("HEARTBEAT").sort((a, b) => a.ts - b.ts);
    let averageHeartbeatMs = null;
    if (heartbeatEvents.length > 1) {
        let total = 0;
        for (let index = 1; index < heartbeatEvents.length; index += 1) {
            total += heartbeatEvents[index].ts - heartbeatEvents[index - 1].ts;
        }
        averageHeartbeatMs = Math.round(total / (heartbeatEvents.length - 1));
    }
    const payload = {
        format: "json",
        jobs: {
            total: metrics.totalJobs,
            active: metrics.activeJobs,
            completed: metrics.completedJobs
        },
        children: {
            total: metrics.totalChildren,
            active: metrics.activeChildren,
            pending: metrics.pendingChildren
        },
        events: {
            total: eventStore.getEventCount(),
            last_seq: eventStore.getLastSequence(),
            history_limit: eventStore.getMaxHistory(),
            average_heartbeat_ms: averageHeartbeatMs
        },
        messages: metrics.totalMessages,
        subscriptions: metrics.subscriptions
    };
    return { content: [{ type: "text", text: j(payload) }] };
});
server.registerTool("graph_state_inactivity", {
    title: "Graph inactivity",
    description: "Identifie les enfants inactifs ou avec pending prolongé.",
    inputSchema: GraphInactivityShape
}, async (input) => {
    const scope = input.scope ?? "children";
    if (scope !== "children") {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: j({ error: "UNSUPPORTED_SCOPE", message: `graph_state_inactivity does not support scope=${scope}` })
                }
            ]
        };
    }
    const inactivitySec = input.inactivity_threshold_sec ?? input.inactivityThresholdSec;
    const inactivityMs = typeof inactivitySec === "number" ? Math.max(0, inactivitySec) * 1000 : undefined;
    const idleThreshold = input.idle_threshold_ms ?? inactivityMs ?? 120_000;
    const pendingThreshold = input.pending_threshold_ms ?? idleThreshold;
    const includeWithoutMessages = input.include_children_without_messages ?? true;
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20;
    lastInactivityThresholdMs = idleThreshold;
    const reports = graphState.findInactiveChildren({
        idleThresholdMs: idleThreshold,
        pendingThresholdMs: pendingThreshold,
        includeChildrenWithoutMessages: includeWithoutMessages
    });
    const filtered = reports.filter((report) => {
        if (input.job_id && report.jobId !== input.job_id)
            return false;
        if (input.runtime && report.runtime !== input.runtime)
            return false;
        if (input.state && report.state !== input.state)
            return false;
        return true;
    });
    const ordered = [...filtered].sort((a, b) => {
        const scoreA = Math.max(a.idleMs ?? 0, a.pendingMs ?? 0);
        const scoreB = Math.max(b.idleMs ?? 0, b.pendingMs ?? 0);
        if (scoreA === scoreB) {
            return a.childId.localeCompare(b.childId);
        }
        return scoreB - scoreA;
    });
    const limited = ordered.slice(0, limit);
    const defaultFormat = input.format ?? "json";
    if (defaultFormat === "text") {
        if (!limited.length) {
            const idleSec = Math.round(idleThreshold / 1000);
            const pendingSec = Math.round(pendingThreshold / 1000);
            return {
                content: [
                    {
                        type: "text",
                        text: `Aucune inactivité détectée (idle ≥ ${idleSec}s, pending ≥ ${pendingSec}s).`
                    }
                ]
            };
        }
        const lines = limited.map((report) => {
            const idleSec = report.idleMs !== null ? Math.round(report.idleMs / 1000) : null;
            const pendingSec = report.pendingMs !== null ? Math.round(report.pendingMs / 1000) : null;
            const flagSummary = report.flags
                .map((flag) => `${flag.type}:${Math.round(flag.valueMs / 1000)}s≥${Math.round(flag.thresholdMs / 1000)}s`)
                .join(", ");
            const waiting = report.waitingFor ?? "∅";
            const job = report.jobId || "∅";
            const actions = report.suggestedActions.length ? report.suggestedActions.join("|") : "∅";
            return `- ${report.childId} (${report.state}) job=${job} runtime=${report.runtime} idle=${idleSec ?? "∅"}s pending=${pendingSec ?? "∅"}s waiting=${waiting} actions=${actions} flags=[${flagSummary}]`;
        });
        const header = `Enfants inactifs (idle ≥ ${Math.round(idleThreshold / 1000)}s, pending ≥ ${Math.round(pendingThreshold / 1000)}s) :`;
        return {
            content: [
                {
                    type: "text",
                    text: [header, ...lines].join("\n")
                }
            ]
        };
    }
    const payload = {
        format: "json",
        idle_threshold_ms: idleThreshold,
        pending_threshold_ms: pendingThreshold,
        inactivity_threshold_sec: inactivityMs !== undefined ? inactivityMs / 1000 : Math.round(idleThreshold / 1000),
        total: filtered.length,
        returned: limited.length,
        items: limited.map((report) => ({
            child_id: report.childId,
            job_id: report.jobId || null,
            name: report.name,
            state: report.state,
            runtime: report.runtime,
            waiting_for: report.waitingFor,
            pending_id: report.pendingId,
            created_at: report.createdAt,
            last_activity_ts: report.lastActivityTs,
            idle_ms: report.idleMs,
            pending_since: report.pendingSince,
            pending_ms: report.pendingMs,
            transcript_size: report.transcriptSize,
            flags: report.flags.map((flag) => ({
                type: flag.type,
                value_ms: flag.valueMs,
                threshold_ms: flag.thresholdMs
            })),
            suggested_actions: report.suggestedActions
        }))
    };
    return { content: [{ type: "text", text: j(payload) }] };
});
server.registerTool("graph_query", { title: "Graph query", description: "Requete simple: neighbors ou filter.", inputSchema: { kind: z.enum(["neighbors", "filter"]), node_id: z.string().optional(), direction: z.enum(["out", "in", "both"]).optional(), edge_type: z.string().optional(), select: z.enum(["nodes", "edges", "both"]).optional(), where: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(), limit: z.number().optional() } }, async (input) => {
    if (input.kind === "neighbors") {
        if (!input.node_id)
            return { isError: true, content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "node_id requis" }) }] };
        const res = graphState.neighbors(input.node_id, input.direction ?? "both", input.edge_type);
        return { content: [{ type: "text", text: j({ format: "json", data: res }) }] };
    }
    // filter
    const select = input.select ?? "nodes";
    const where = input.where ?? {};
    const limit = input.limit && input.limit > 0 ? input.limit : undefined;
    if (select === "nodes") {
        const nodes = graphState.filterNodes(where, limit);
        return { content: [{ type: "text", text: j({ format: "json", nodes }) }] };
    }
    else if (select === "edges") {
        const edges = graphState.filterEdges(where, limit);
        return { content: [{ type: "text", text: j({ format: "json", edges }) }] };
    }
    else {
        const nodes = graphState.filterNodes(where, limit);
        const edges = graphState.filterEdges(where, limit);
        return { content: [{ type: "text", text: j({ format: "json", nodes, edges }) }] };
    }
});
server.registerTool("graph_generate", {
    title: "Graph generate",
    description: "Genere un graphe de dependances a partir de taches (preset, texte ou JSON).",
    inputSchema: GraphGenerateInputShape,
}, async (input) => {
    try {
        const parsed = GraphGenerateInputSchema.parse(input);
        logger.info("graph_generate_requested", {
            preset: parsed.preset ?? null,
            has_tasks: parsed.tasks !== undefined,
        });
        const result = handleGraphGenerate(parsed, {
            knowledgeGraph: runtimeFeatures.enableKnowledge ? knowledgeGraph : undefined,
            knowledgeEnabled: runtimeFeatures.enableKnowledge,
        });
        const summary = summariseSubgraphUsage(result.graph);
        if (summary.references.length > 0) {
            logger.info("graph_generate_subgraphs_detected", {
                references: summary.references.length,
                missing: summary.missing.length,
            });
        }
        let notes = result.notes;
        if (summary.missing.length > 0) {
            const deduped = new Set(result.notes);
            deduped.add("missing_subgraph_descriptors");
            notes = Array.from(deduped);
            logger.warn("graph_generate_missing_subgraphs", {
                missing: summary.missing,
                graph_id: result.graph.graph_id ?? null,
            });
        }
        const enriched = {
            ...result,
            notes,
            subgraph_refs: summary.references,
            ...(summary.missing.length > 0 ? { missing_subgraph_descriptors: summary.missing } : {}),
        };
        logger.info("graph_generate_succeeded", {
            nodes: result.graph.nodes.length,
            edges: result.graph.edges.length,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_generate", result: enriched }) }],
            structuredContent: enriched,
        };
    }
    catch (error) {
        return graphToolError("graph_generate", error);
    }
});
server.registerTool("graph_mutate", {
    title: "Graph mutate",
    description: "Applique des operations idempotentes (add/remove/rename) sur un graphe.",
    inputSchema: GraphMutateInputShape,
}, async (input) => {
    let graphIdForError = null;
    let graphVersionForError = null;
    try {
        const parsed = GraphMutateInputSchema.parse(input);
        graphIdForError = parsed.graph.graph_id ?? null;
        graphVersionForError = parsed.graph.graph_version ?? null;
        logger.info("graph_mutate_requested", {
            operations: parsed.operations.length,
            graph_id: graphIdForError,
            version: graphVersionForError,
        });
        const baseGraph = normaliseGraphPayload(parsed.graph);
        const tx = graphTransactions.begin(baseGraph);
        let committed;
        try {
            const mutateInput = {
                ...parsed,
                graph: serialiseNormalisedGraph(tx.workingCopy),
            };
            const intermediate = handleGraphMutate(mutateInput);
            committed = graphTransactions.commit(tx.txId, normaliseGraphPayload(intermediate.graph));
            const finalGraph = serialiseNormalisedGraph(committed.graph);
            const result = { ...intermediate, graph: finalGraph };
            const summary = summariseSubgraphUsage(result.graph);
            if (summary.references.length > 0) {
                logger.info("graph_mutate_subgraphs_detected", {
                    references: summary.references.length,
                    missing: summary.missing.length,
                    graph_id: committed.graphId,
                });
            }
            if (summary.missing.length > 0) {
                logger.warn("graph_mutate_missing_subgraphs", {
                    missing: summary.missing,
                    graph_id: committed.graphId,
                });
            }
            const enrichedResult = {
                ...result,
                subgraph_refs: summary.references,
                ...(summary.missing.length > 0 ? { missing_subgraph_descriptors: summary.missing } : {}),
            };
            const changed = enrichedResult.applied.filter((entry) => entry.changed).length;
            logger.info("graph_mutate_succeeded", {
                operations: parsed.operations.length,
                changed,
                graph_id: committed.graphId,
                version: committed.version,
                committed_at: committed.committedAt,
            });
            return {
                content: [{ type: "text", text: j({ tool: "graph_mutate", result: enrichedResult }) }],
                structuredContent: enrichedResult,
            };
        }
        catch (error) {
            if (!committed) {
                try {
                    graphTransactions.rollback(tx.txId);
                    logger.warn("graph_mutate_rolled_back", {
                        graph_id: tx.graphId,
                        base_version: tx.baseVersion,
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
                catch (rollbackError) {
                    logger.error("graph_mutate_rollback_failed", {
                        graph_id: tx.graphId,
                        message: rollbackError instanceof Error
                            ? rollbackError.message
                            : String(rollbackError),
                    });
                }
            }
            throw error;
        }
    }
    catch (error) {
        if (error instanceof GraphVersionConflictError) {
            return graphToolError("graph_mutate", error, {
                graph_id: graphIdForError,
                version: graphVersionForError,
            });
        }
        return graphToolError("graph_mutate", error, {
            graph_id: graphIdForError,
            version: graphVersionForError ?? undefined,
        });
    }
});
server.registerTool("graph_subgraph_extract", {
    title: "Graph subgraph extract",
    description: "Exporte le descripteur d'un sous-graphe vers le dossier de run.",
    inputSchema: GraphSubgraphExtractInputShape,
}, async (input) => {
    let parsed;
    try {
        parsed = GraphSubgraphExtractInputSchema.parse(input);
        logger.info("graph_subgraph_extract_requested", {
            node_id: parsed.node_id,
            run_id: parsed.run_id,
        });
        const extraction = await extractSubgraphToFile({
            graph: parsed.graph,
            nodeId: parsed.node_id,
            runId: parsed.run_id,
            childrenRoot: CHILDREN_ROOT,
            directoryName: parsed.directory,
        });
        logger.info("graph_subgraph_extract_succeeded", {
            node_id: parsed.node_id,
            run_id: extraction.runId,
            subgraph_ref: extraction.subgraphRef,
            version: extraction.version,
        });
        const descriptorPayload = {
            run_id: extraction.runId,
            node_id: extraction.nodeId,
            subgraph_ref: extraction.subgraphRef,
            version: extraction.version,
            extracted_at: extraction.extractedAt,
            absolute_path: extraction.absolutePath,
            relative_path: extraction.relativePath,
            graph_id: extraction.graphId,
            graph_version: extraction.graphVersion,
        };
        return {
            content: [
                {
                    type: "text",
                    text: j({ tool: "graph_subgraph_extract", result: descriptorPayload }),
                },
            ],
            structuredContent: {
                ...descriptorPayload,
                descriptor: extraction.descriptor,
                metadata_key: SUBGRAPH_REGISTRY_KEY,
            },
        };
    }
    catch (error) {
        return graphToolError("graph_subgraph_extract", error, {
            node_id: parsed?.node_id,
            run_id: parsed?.run_id,
        });
    }
});
server.registerTool("graph_hyper_export", {
    title: "Graph hyper export",
    description: "Projette un hyper-graphe en graphe orienté avec métadonnées conservées.",
    inputSchema: GraphHyperExportInputShape,
}, async (input) => {
    try {
        const parsed = GraphHyperExportInputSchema.parse(input);
        logger.info("graph_hyper_export_requested", {
            graph_id: parsed.id,
            nodes: parsed.nodes.length,
            hyper_edges: parsed.hyper_edges.length,
        });
        const result = handleGraphHyperExport(parsed);
        logger.info("graph_hyper_export_succeeded", {
            graph_id: result.graph.graph_id,
            nodes: result.stats.nodes,
            edges: result.stats.edges,
            hyper_edges: result.stats.hyper_edges,
        });
        return {
            content: [
                { type: "text", text: j({ tool: "graph_hyper_export", result }) },
            ],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_hyper_export", error);
    }
});
server.registerTool("kg_insert", {
    title: "Knowledge insert",
    description: "Insère ou met à jour des triplets dans le graphe de connaissances.",
    inputSchema: KgInsertInputShape,
}, async (input) => {
    const disabled = ensureKnowledgeEnabled("kg_insert");
    if (disabled) {
        return disabled;
    }
    try {
        const parsed = KgInsertInputSchema.parse(input);
        const result = handleKgInsert(getKnowledgeToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "kg_insert", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return knowledgeToolError("kg_insert", error);
    }
});
server.registerTool("kg_query", {
    title: "Knowledge query",
    description: "Recherche des triplets par motif (joker * supporté).",
    inputSchema: KgQueryInputShape,
}, async (input) => {
    const disabled = ensureKnowledgeEnabled("kg_query");
    if (disabled) {
        return disabled;
    }
    try {
        const parsed = KgQueryInputSchema.parse(input);
        const result = handleKgQuery(getKnowledgeToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "kg_query", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return knowledgeToolError("kg_query", error);
    }
});
server.registerTool("kg_export", {
    title: "Knowledge export",
    description: "Exporte l'intégralité du graphe de connaissances (ordre déterministe).",
    inputSchema: KgExportInputShape,
}, async (input) => {
    const disabled = ensureKnowledgeEnabled("kg_export");
    if (disabled) {
        return disabled;
    }
    try {
        const parsed = KgExportInputSchema.parse(input);
        const result = handleKgExport(getKnowledgeToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "kg_export", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return knowledgeToolError("kg_export", error);
    }
});
server.registerTool("values_set", {
    title: "Values graph set",
    description: "Définit les valeurs, priorités et contraintes du garde-fou.",
    inputSchema: ValuesSetInputShape,
}, async (input) => {
    const disabled = ensureValueGuardEnabled("values_set");
    if (disabled) {
        return disabled;
    }
    try {
        const parsed = ValuesSetInputSchema.parse(input);
        const result = handleValuesSet(getValueToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "values_set", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return valueToolError("values_set", error);
    }
});
server.registerTool("values_score", {
    title: "Values score",
    description: "Évalue un plan par rapport au graphe de valeurs.",
    inputSchema: ValuesScoreInputShape,
}, async (input) => {
    const disabled = ensureValueGuardEnabled("values_score");
    if (disabled) {
        return disabled;
    }
    try {
        const parsed = ValuesScoreInputSchema.parse(input);
        const result = handleValuesScore(getValueToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "values_score", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return valueToolError("values_score", error);
    }
});
server.registerTool("values_filter", {
    title: "Values filter",
    description: "Applique le seuil du garde-fou et retourne la décision détaillée.",
    inputSchema: ValuesFilterInputShape,
}, async (input) => {
    const disabled = ensureValueGuardEnabled("values_filter");
    if (disabled) {
        return disabled;
    }
    try {
        const parsed = ValuesFilterInputSchema.parse(input);
        const result = handleValuesFilter(getValueToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "values_filter", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return valueToolError("values_filter", error);
    }
});
server.registerTool("causal_export", {
    title: "Causal memory export",
    description: "Exporte la mémoire causale pour analyse hors-ligne.",
    inputSchema: CausalExportInputShape,
}, async (input) => {
    const disabled = ensureCausalMemoryEnabled("causal_export");
    if (disabled) {
        return disabled;
    }
    try {
        const parsed = CausalExportInputSchema.parse(input);
        const result = handleCausalExport(getCausalToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "causal_export", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return causalToolError("causal_export", error);
    }
});
server.registerTool("causal_explain", {
    title: "Causal memory explain",
    description: "Reconstruit l'arbre des causes pour un événement donné.",
    inputSchema: CausalExplainInputShape,
}, async (input) => {
    const disabled = ensureCausalMemoryEnabled("causal_explain");
    if (disabled) {
        return disabled;
    }
    let parsed;
    try {
        parsed = CausalExplainInputSchema.parse(input);
        const result = handleCausalExplain(getCausalToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "causal_explain", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return causalToolError("causal_explain", error, parsed ? { outcome_id: parsed.outcome_id } : {});
    }
});
server.registerTool("graph_rewrite_apply", {
    title: "Graph rewrite apply",
    description: "Applique les règles de réécriture (manuelles ou adaptatives) sur un graphe hiérarchique.",
    inputSchema: GraphRewriteApplyInputShape,
}, async (input) => {
    let parsed;
    let graphIdForError = null;
    let graphVersionForError = null;
    try {
        parsed = GraphRewriteApplyInputSchema.parse(input);
        graphIdForError = parsed.graph.graph_id ?? null;
        graphVersionForError = parsed.graph.graph_version ?? null;
        logger.info("graph_rewrite_apply_requested", {
            mode: parsed.mode,
            graph_id: graphIdForError,
            version: graphVersionForError,
        });
        const baseGraph = normaliseGraphPayload(parsed.graph);
        const tx = graphTransactions.begin(baseGraph);
        let committed;
        try {
            const rewriteInput = {
                ...parsed,
                graph: serialiseNormalisedGraph(tx.workingCopy),
            };
            const intermediate = handleGraphRewriteApply(rewriteInput);
            committed = graphTransactions.commit(tx.txId, normaliseGraphPayload(intermediate.graph));
            const finalGraph = serialiseNormalisedGraph(committed.graph);
            const result = { ...intermediate, graph: finalGraph };
            const summary = summariseSubgraphUsage(result.graph);
            if (summary.references.length > 0) {
                logger.info("graph_rewrite_apply_subgraphs_detected", {
                    graph_id: committed.graphId,
                    references: summary.references.length,
                    missing: summary.missing.length,
                });
            }
            if (summary.missing.length > 0) {
                logger.warn("graph_rewrite_apply_missing_subgraphs", {
                    graph_id: committed.graphId,
                    missing: summary.missing,
                });
            }
            const enrichedResult = {
                ...result,
                subgraph_refs: summary.references,
                ...(summary.missing.length > 0
                    ? { missing_subgraph_descriptors: summary.missing }
                    : {}),
            };
            logger.info("graph_rewrite_apply_succeeded", {
                mode: parsed.mode,
                total_applied: enrichedResult.total_applied,
                changed: enrichedResult.changed,
                graph_id: committed.graphId,
                version: committed.version,
                committed_at: committed.committedAt,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: j({ tool: "graph_rewrite_apply", result: enrichedResult }),
                    },
                ],
                structuredContent: enrichedResult,
            };
        }
        catch (error) {
            if (!committed) {
                try {
                    graphTransactions.rollback(tx.txId);
                    logger.warn("graph_rewrite_apply_rolled_back", {
                        graph_id: tx.graphId,
                        base_version: tx.baseVersion,
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
                catch (rollbackError) {
                    logger.error("graph_rewrite_apply_rollback_failed", {
                        graph_id: tx.graphId,
                        message: rollbackError instanceof Error
                            ? rollbackError.message
                            : String(rollbackError),
                    });
                }
            }
            throw error;
        }
    }
    catch (error) {
        if (error instanceof GraphVersionConflictError) {
            return graphToolError("graph_rewrite_apply", error, {
                graph_id: graphIdForError ?? undefined,
                version: graphVersionForError ?? undefined,
                mode: parsed?.mode,
            });
        }
        return graphToolError("graph_rewrite_apply", error, {
            graph_id: graphIdForError ?? undefined,
            version: graphVersionForError ?? undefined,
            mode: parsed?.mode,
        });
    }
});
server.registerTool("graph_validate", {
    title: "Graph validate",
    description: "Analyse un graphe (cycles, noeuds isoles, poids) et retourne erreurs/avertissements.",
    inputSchema: GraphValidateInputShape,
}, async (input) => {
    try {
        const parsed = GraphValidateInputSchema.parse(input);
        logger.info("graph_validate_requested", {
            strict_weights: parsed.strict_weights ?? false,
            cycle_limit: parsed.cycle_limit,
        });
        const result = handleGraphValidate(parsed);
        logger.info("graph_validate_completed", {
            ok: result.ok,
            errors: result.errors.length,
            warnings: result.warnings.length,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_validate", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_validate", error);
    }
});
server.registerTool("graph_summarize", {
    title: "Graph summarize",
    description: "Resume un graphe (layers, metriques, centralites).",
    inputSchema: GraphSummarizeInputShape,
}, async (input) => {
    try {
        const parsed = GraphSummarizeInputSchema.parse(input);
        logger.info("graph_summarize_requested", {
            include_centrality: parsed.include_centrality,
        });
        const result = handleGraphSummarize(parsed);
        logger.info("graph_summarize_succeeded", {
            nodes: result.metrics.node_count,
            edges: result.metrics.edge_count,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_summarize", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_summarize", error);
    }
});
server.registerTool("graph_paths_k_shortest", {
    title: "Graph k-shortest paths",
    description: "Calcule les k plus courts chemins (Yen) entre deux noeuds.",
    inputSchema: GraphPathsKShortestInputShape,
}, async (input) => {
    try {
        const parsed = GraphPathsKShortestInputSchema.parse(input);
        logger.info("graph_paths_k_shortest_requested", {
            from: parsed.from,
            to: parsed.to,
            k: parsed.k,
            weight_attribute: parsed.weight_attribute,
            max_deviation: parsed.max_deviation ?? null,
        });
        const result = handleGraphPathsKShortest(parsed);
        logger.info("graph_paths_k_shortest_succeeded", {
            returned_k: result.returned_k,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_paths_k_shortest", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_paths_k_shortest", error);
    }
});
server.registerTool("graph_paths_constrained", {
    title: "Graph constrained path",
    description: "Recherche un chemin optimal en excluant certains noeuds/arcs.",
    inputSchema: GraphPathsConstrainedInputShape,
}, async (input) => {
    try {
        const parsed = GraphPathsConstrainedInputSchema.parse(input);
        logger.info("graph_paths_constrained_requested", {
            from: parsed.from,
            to: parsed.to,
            avoid_nodes: parsed.avoid_nodes.length,
            avoid_edges: parsed.avoid_edges.length,
            max_cost: parsed.max_cost ?? null,
        });
        const result = handleGraphPathsConstrained(parsed);
        logger.info("graph_paths_constrained_completed", {
            status: result.status,
            reason: result.reason,
            cost: result.cost,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_paths_constrained", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_paths_constrained", error);
    }
});
server.registerTool("graph_centrality_betweenness", {
    title: "Graph betweenness centrality",
    description: "Calcule les scores de centralite de Brandes (pondere ou non).",
    inputSchema: GraphCentralityBetweennessInputShape,
}, async (input) => {
    try {
        const parsed = GraphCentralityBetweennessInputSchema.parse(input);
        logger.info("graph_centrality_betweenness_requested", {
            weighted: parsed.weighted,
            normalise: parsed.normalise,
            top_k: parsed.top_k,
        });
        const result = handleGraphCentralityBetweenness(parsed);
        logger.info("graph_centrality_betweenness_succeeded", {
            top_count: result.top.length,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_centrality_betweenness", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_centrality_betweenness", error);
    }
});
server.registerTool("graph_partition", {
    title: "Graph partition",
    description: "Partitionne le graphe en communautés ou minimise les coupures.",
    inputSchema: GraphPartitionInputShape,
}, async (input) => {
    try {
        const parsed = GraphPartitionInputSchema.parse(input);
        logger.info("graph_partition_requested", {
            k: parsed.k,
            objective: parsed.objective,
            seed: parsed.seed ?? null,
        });
        const result = handleGraphPartition(parsed);
        logger.info("graph_partition_succeeded", {
            partition_count: result.partition_count,
            cut_edges: result.cut_edges,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_partition", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_partition", error);
    }
});
server.registerTool("graph_critical_path", {
    title: "Graph critical path",
    description: "Analyse le chemin critique et expose les marges/slacks.",
    inputSchema: GraphCriticalPathInputShape,
}, async (input) => {
    try {
        const parsed = GraphCriticalPathInputSchema.parse(input);
        logger.info("graph_critical_path_requested", {
            duration_attribute: parsed.duration_attribute,
            fallback_duration_attribute: parsed.fallback_duration_attribute ?? null,
        });
        const result = handleGraphCriticalPath(parsed);
        logger.info("graph_critical_path_succeeded", {
            duration: result.duration,
            path_length: result.critical_path.length,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_critical_path", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_critical_path", error);
    }
});
server.registerTool("graph_simulate", {
    title: "Graph simulate",
    description: "Simule l'execution du graphe et retourne un planning détaillé.",
    inputSchema: GraphSimulateInputShape,
}, async (input) => {
    try {
        const parsed = GraphSimulateInputSchema.parse(input);
        logger.info("graph_simulate_requested", {
            parallelism: parsed.parallelism,
            duration_attribute: parsed.duration_attribute,
        });
        const result = handleGraphSimulate(parsed);
        logger.info("graph_simulate_succeeded", {
            makespan: result.metrics.makespan,
            queue_events: result.metrics.queue_events,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_simulate", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_simulate", error);
    }
});
server.registerTool("graph_optimize", {
    title: "Graph optimize",
    description: "Analyse un graphe planifié et propose des leviers de réduction du makespan.",
    inputSchema: GraphOptimizeInputShape,
}, async (input) => {
    try {
        const parsed = GraphOptimizeInputSchema.parse(input);
        logger.info("graph_optimize_requested", {
            parallelism: parsed.parallelism,
            max_parallelism: parsed.max_parallelism,
            explore_count: parsed.explore_parallelism?.length ?? 0,
        });
        const result = handleGraphOptimize(parsed);
        const bestMakespan = result.projections.reduce((acc, projection) => Math.min(acc, projection.makespan), Number.POSITIVE_INFINITY);
        logger.info("graph_optimize_completed", {
            suggestions: result.suggestions.length,
            best_makespan: Number.isFinite(bestMakespan) ? bestMakespan : null,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_optimize", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_optimize", error);
    }
});
server.registerTool("graph_optimize_moo", {
    title: "Graph optimize multi-objectifs",
    description: "Explore les pareto fronts pour plusieurs objectifs (makespan/coût/risque).",
    inputSchema: GraphOptimizeMooInputShape,
}, async (input) => {
    try {
        const parsed = GraphOptimizeMooInputSchema.parse(input);
        logger.info("graph_optimize_moo_requested", {
            candidates: parsed.parallelism_candidates.length,
            objectives: parsed.objectives.length,
        });
        const result = handleGraphOptimizeMoo(parsed);
        logger.info("graph_optimize_moo_completed", {
            pareto_count: result.pareto_front.length,
            scalarized: result.scalarization ? true : false,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_optimize_moo", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_optimize_moo", error);
    }
});
server.registerTool("graph_causal_analyze", {
    title: "Graph causal analysis",
    description: "Analyse causale: ordre topo, cycles et coupure minimale.",
    inputSchema: GraphCausalAnalyzeInputShape,
}, async (input) => {
    try {
        const parsed = GraphCausalAnalyzeInputSchema.parse(input);
        logger.info("graph_causal_analyze_requested", {
            max_cycles: parsed.max_cycles,
            compute_min_cut: parsed.compute_min_cut,
        });
        const result = handleGraphCausalAnalyze(parsed);
        logger.info("graph_causal_analyze_completed", {
            acyclic: result.acyclic,
            cycles: result.cycles.length,
            min_cut_size: result.min_cut?.size ?? null,
        });
        return {
            content: [{ type: "text", text: j({ tool: "graph_causal_analyze", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return graphToolError("graph_causal_analyze", error);
    }
});
// plan_fanout
server.registerTool("plan_fanout", {
    title: "Plan fan-out",
    description: "Planifie des enfants en parallele, retourne job_id et child_ids.",
    inputSchema: PlanFanoutInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = PlanFanoutInputSchema.parse(input);
        const result = await handlePlanFanout(getPlanToolContext(), parsed);
        startHeartbeat();
        return {
            content: [
                { type: "text", text: j({ tool: "plan_fanout", result }) },
            ],
            structuredContent: result,
        };
    }
    catch (error) {
        if (error instanceof ValueGuardRejectionError) {
            logger.error("plan_fanout_rejected_by_value_guard", {
                rejected: error.rejections.length,
            });
            const rejected = error.rejections.map((entry) => ({
                name: entry.name,
                value_guard: {
                    allowed: entry.decision.allowed,
                    score: entry.decision.score,
                    total: entry.decision.total,
                    threshold: entry.decision.threshold,
                    violations: entry.decision.violations,
                },
            }));
            return {
                isError: true,
                content: [
                    {
                        type: "text",
                        text: j({
                            error: "E-VALUES-VIOLATION",
                            tool: "plan_fanout",
                            message: error.message,
                            rejected,
                        }),
                    },
                ],
            };
        }
        return planToolError("plan_fanout", error);
    }
});
server.registerTool("plan_join", {
    title: "Plan join",
    description: "Attend les reponses des enfants selon une politique de quorum ou de premiere reussite.",
    inputSchema: PlanJoinInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = PlanJoinInputSchema.parse(input);
        const result = await handlePlanJoin(getPlanToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "plan_join", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return planToolError("plan_join", error);
    }
});
server.registerTool("plan_reduce", {
    title: "Plan reduce",
    description: "Combine les sorties des enfants (concat, merge_json, vote, custom).",
    inputSchema: PlanReduceInputShape,
}, async (input) => {
    try {
        const parsed = PlanReduceInputSchema.parse(input);
        const result = await handlePlanReduce(getPlanToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "plan_reduce", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return planToolError("plan_reduce", error);
    }
});
server.registerTool("plan_compile_bt", {
    title: "Plan compile Behaviour Tree",
    description: "Compile un graphe hiérarchique en Behaviour Tree exécutable.",
    inputSchema: PlanCompileBTInputShape,
}, async (input) => {
    try {
        const parsed = PlanCompileBTInputSchema.parse(input);
        const result = handlePlanCompileBT(getPlanToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "plan_compile_bt", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return planToolError("plan_compile_bt", error, {}, "E-BT-INVALID");
    }
});
server.registerTool("plan_run_bt", {
    title: "Plan run Behaviour Tree",
    description: "Exécute un Behaviour Tree et trace chaque invocation de tool.",
    inputSchema: PlanRunBTInputShape,
}, async (input) => {
    try {
        const parsed = PlanRunBTInputSchema.parse(input);
        const result = await handlePlanRunBT(getPlanToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "plan_run_bt", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return planToolError("plan_run_bt", error, {}, "E-BT-INVALID");
    }
});
server.registerTool("plan_run_reactive", {
    title: "Plan run reactive loop",
    description: "Exécute un Behaviour Tree via le scheduler réactif et la boucle de ticks (autoscaler/superviseur).",
    inputSchema: PlanRunReactiveInputShape,
}, async (input) => {
    try {
        const parsed = PlanRunReactiveInputSchema.parse(input);
        const result = await handlePlanRunReactive(getPlanToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "plan_run_reactive", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return planToolError("plan_run_reactive", error, {}, "E-BT-INVALID");
    }
});
server.registerTool("bb_set", {
    title: "Blackboard set",
    description: "Définit ou met à jour une clé sur le tableau noir partagé.",
    inputSchema: BbSetInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = BbSetInputSchema.parse(input);
        const result = handleBbSet(getCoordinationToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "bb_set", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("bb_set", error);
    }
});
server.registerTool("bb_get", {
    title: "Blackboard get",
    description: "Récupère la dernière valeur connue pour une clé.",
    inputSchema: BbGetInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = BbGetInputSchema.parse(input);
        const result = handleBbGet(getCoordinationToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "bb_get", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("bb_get", error);
    }
});
server.registerTool("bb_query", {
    title: "Blackboard query",
    description: "Liste les entrées filtrées par tags et/ou clés.",
    inputSchema: BbQueryInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = BbQueryInputSchema.parse(input);
        const result = handleBbQuery(getCoordinationToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "bb_query", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("bb_query", error);
    }
});
server.registerTool("bb_watch", {
    title: "Blackboard watch",
    description: "Retourne les événements après une version donnée pour suivre les changements.",
    inputSchema: BbWatchInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = BbWatchInputSchema.parse(input);
        const result = handleBbWatch(getCoordinationToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "bb_watch", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("bb_watch", error);
    }
});
server.registerTool("stig_mark", {
    title: "Stigmergie mark",
    description: "Dépose des phéromones sur un nœud pour influencer la planification.",
    inputSchema: StigMarkInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = StigMarkInputSchema.parse(input);
        const result = handleStigMark(getCoordinationToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "stig_mark", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("stig_mark", error);
    }
});
server.registerTool("stig_decay", {
    title: "Stigmergie decay",
    description: "Fait s'évaporer les phéromones selon une demi-vie déterministe.",
    inputSchema: StigDecayInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = StigDecayInputSchema.parse(input);
        const result = handleStigDecay(getCoordinationToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "stig_decay", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("stig_decay", error);
    }
});
server.registerTool("stig_snapshot", {
    title: "Stigmergie snapshot",
    description: "Expose l'intensité des phéromones pour chaque nœud et type.",
    inputSchema: StigSnapshotInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = StigSnapshotInputSchema.parse(input);
        const result = handleStigSnapshot(getCoordinationToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "stig_snapshot", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("stig_snapshot", error);
    }
});
server.registerTool("cnp_announce", {
    title: "Contract-Net announce",
    description: "Annonce une tâche au protocole Contract-Net et retourne l'attribution.",
    inputSchema: CnpAnnounceInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = CnpAnnounceInputSchema.parse(input);
        const result = handleCnpAnnounce(getCoordinationToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "cnp_announce", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("cnp_announce", error);
    }
});
server.registerTool("consensus_vote", {
    title: "Consensus vote",
    description: "Agrège des bulletins pour calculer une décision de consensus auditable.",
    inputSchema: ConsensusVoteInputShape,
}, async (input) => {
    try {
        pruneExpired();
        const parsed = ConsensusVoteInputSchema.parse(input);
        logger.info("consensus_vote_requested", {
            mode: parsed.config?.mode ?? "majority",
            votes: parsed.votes.length,
        });
        const result = handleConsensusVote(getCoordinationToolContext(), parsed);
        logger.info("consensus_vote_succeeded", {
            mode: result.mode,
            outcome: result.outcome,
            satisfied: result.satisfied,
            votes: result.votes,
        });
        return {
            content: [{ type: "text", text: j({ tool: "consensus_vote", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return coordinationToolError("consensus_vote", error);
    }
});
server.registerTool("agent_autoscale_set", {
    title: "Agent autoscale set",
    description: "Configure les bornes de l'autoscaler de runtimes enfants.",
    inputSchema: AgentAutoscaleSetInputShape,
}, async (input) => {
    try {
        const parsed = AgentAutoscaleSetInputSchema.parse(input);
        const result = handleAgentAutoscaleSet(getAgentToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "agent_autoscale_set", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("agent_autoscale_set_failed", { message });
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: j({ error: "AGENT_AUTOSCALE_ERROR", message }),
                },
            ],
        };
    }
});
// start
server.registerTool("start", { title: "Start job", description: "Met les enfants d un job en waiting.", inputSchema: StartShape }, async (input) => {
    pruneExpired();
    const { job_id, children } = input;
    const job = graphState.getJob(job_id);
    if (!job)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };
    if (children?.length) {
        for (const spec of children) {
            const normalized = { ...spec, runtime: spec.runtime ?? DEFAULT_CHILD_RUNTIME };
            createChild(job_id, normalized);
        }
    }
    let started = 0;
    for (const child of graphState.listChildren(job_id)) {
        if (child.state === "idle") {
            graphState.patchChild(child.id, { state: "waiting", waitingFor: "reply", pendingId: null });
            started++;
            pushEvent({ kind: "START", jobId: job_id, childId: child.id, payload: { name: child.name } });
        }
    }
    return { content: [{ type: "text", text: j({ started, job_id }) }] };
});
// child runtime management (process-based)
server.registerTool("child_create", {
    title: "Child create",
    description: "Démarre un runtime enfant sandboxé (Codex) et peut envoyer un payload initial.",
    inputSchema: ChildCreateInputShape,
}, async (input) => {
    try {
        const parsed = ChildCreateInputSchema.parse(input);
        const metadata = parsed.metadata ?? {};
        const goals = extractMetadataGoals(metadata);
        const tags = extractMetadataTags(metadata);
        const contextSelection = selectMemoryContext(memoryStore, {
            tags,
            goals,
            query: renderPromptForMemory(parsed.prompt),
            limit: 4,
        });
        if (goals.length > 0) {
            memoryStore.upsertKeyValue("orchestrator.last_goals", goals, {
                tags: goals,
                importance: 0.6,
                metadata: { source: "child_create" },
            });
        }
        const enrichedInput = { ...parsed };
        if (contextSelection.episodes.length > 0 || contextSelection.keyValues.length > 0) {
            enrichedInput.manifest_extras = {
                ...(parsed.manifest_extras ?? {}),
                memory_context: contextSelection,
            };
        }
        const result = await handleChildCreate(getChildToolContext(), enrichedInput);
        ensureChildVisibleInGraph({
            childId: result.child_id,
            snapshot: result.index_snapshot,
            metadata: result.index_snapshot.metadata,
            prompt: enrichedInput.prompt,
            runtimeStatus: result.runtime_status,
            startedAt: result.started_at,
        });
        const payload = contextSelection.episodes.length > 0 || contextSelection.keyValues.length > 0
            ? { ...result, memory_context: contextSelection }
            : result;
        return {
            content: [{ type: "text", text: j({ tool: "child_create", result: payload }) }],
            structuredContent: payload,
        };
    }
    catch (error) {
        return childToolError("child_create", error, { child_id: input.child_id ?? null });
    }
});
server.registerTool("child_send", {
    title: "Child send",
    description: "Envoie un message JSON arbitraire à un runtime enfant.",
    inputSchema: ChildSendInputShape,
}, async (input) => {
    try {
        const parsed = ChildSendInputSchema.parse(input);
        const result = await handleChildSend(getChildToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "child_send", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return childToolError("child_send", error, { child_id: input.child_id });
    }
});
server.registerTool("child_status", {
    title: "Child status",
    description: "Expose l'état runtime/index d'un enfant (pid, heartbeats, retries…).",
    inputSchema: ChildStatusInputShape,
}, (input) => {
    try {
        const parsed = ChildStatusInputSchema.parse(input);
        const result = handleChildStatus(getChildToolContext(), parsed);
        graphState.syncChildIndexSnapshot(result.index_snapshot);
        return {
            content: [{ type: "text", text: j({ tool: "child_status", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return childToolError("child_status", error, { child_id: input.child_id });
    }
});
server.registerTool("child_collect", {
    title: "Child collect",
    description: "Collecte les messages et artefacts produits par un enfant.",
    inputSchema: ChildCollectInputShape,
}, async (input) => {
    try {
        const parsed = ChildCollectInputSchema.parse(input);
        const result = await handleChildCollect(getChildToolContext(), parsed);
        const summary = summariseChildOutputs(result.outputs);
        const review = metaCritic.review(summary.text, summary.kind, []);
        logger.logCognitive({
            actor: "meta-critic",
            phase: "score",
            childId: parsed.child_id,
            score: review.overall,
            content: review.feedback.join(" | "),
            metadata: {
                verdict: review.verdict,
                suggestions: review.suggestions.slice(0, 3),
            },
        });
        let reflectionSummary = null;
        const shouldReflect = reflectionEnabled || REFLECTION_PRIORITY_KINDS.has(summary.kind);
        if (shouldReflect) {
            try {
                reflectionSummary = await reflect({
                    kind: summary.kind,
                    input: summary.text,
                    output: summary.text,
                    meta: {
                        score: review.overall,
                        artifacts: result.outputs.artifacts.length,
                        messages: result.outputs.messages.length,
                    },
                });
                logger.logCognitive({
                    actor: "self-reflect",
                    phase: "resume",
                    childId: parsed.child_id,
                    content: reflectionSummary.insights.slice(0, 3).join(" | "),
                    metadata: {
                        kind: summary.kind,
                        next_steps: reflectionSummary.nextSteps.slice(0, 2),
                        risks: reflectionSummary.risks.slice(0, 2),
                    },
                });
            }
            catch (error) {
                logger.warn("self_reflection_failed", {
                    child_id: parsed.child_id,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        const qualityComputation = computeQualityAssessment(summary.kind, summary.text, review);
        let qualityAssessment = null;
        if (qualityComputation) {
            const needsRevision = qualityGateEnabled && qualityComputation.score < qualityGateThreshold;
            qualityAssessment = {
                ...qualityComputation,
                kind: summary.kind,
                gate: {
                    enabled: qualityGateEnabled,
                    threshold: qualityGateThreshold,
                    needs_revision: needsRevision,
                },
            };
            logger.logCognitive({
                actor: "quality-scorer",
                phase: "score",
                childId: parsed.child_id,
                score: qualityComputation.score / 100,
                content: `quality-${summary.kind}`,
                metadata: {
                    threshold: qualityGateThreshold,
                    needs_revision: needsRevision,
                    rubric: qualityComputation.rubric,
                },
            });
        }
        const childSnapshot = childSupervisor.childrenIndex.getChild(parsed.child_id);
        const metadataTags = extractMetadataTags(childSnapshot?.metadata);
        const tags = new Set([...summary.tags, ...metadataTags, parsed.child_id]);
        const goals = extractMetadataGoals(childSnapshot?.metadata);
        const episodeMetadata = {
            child_id: parsed.child_id,
            review,
            artifact_count: result.outputs.artifacts.length,
        };
        if (reflectionSummary) {
            episodeMetadata.reflection = reflectionSummary;
        }
        if (qualityAssessment) {
            episodeMetadata.quality = {
                kind: qualityAssessment.kind,
                score: qualityAssessment.score,
                rubric: qualityAssessment.rubric,
                gate: qualityAssessment.gate,
            };
        }
        const episode = memoryStore.recordEpisode({
            goal: goals.length > 0 ? goals.join(" | ") : `Collecte ${parsed.child_id}`,
            decision: "Synthèse des sorties enfant",
            outcome: summary.text.slice(0, 512),
            tags: Array.from(tags),
            importance: review.overall,
            metadata: episodeMetadata,
        });
        const payload = {
            ...result,
            review,
            memory_snapshot: {
                episode_id: episode.id,
                tags: episode.tags,
                stored_at: episode.createdAt,
            },
        };
        if (reflectionSummary) {
            payload.reflection = reflectionSummary;
        }
        if (qualityAssessment) {
            payload.quality_assessment = {
                kind: qualityAssessment.kind,
                score: qualityAssessment.score,
                rubric: qualityAssessment.rubric,
                metrics: qualityAssessment.metrics,
                gate: qualityAssessment.gate,
            };
            payload.needs_revision = qualityAssessment.gate.needs_revision;
        }
        return {
            content: [{ type: "text", text: j({ tool: "child_collect", result: payload }) }],
            structuredContent: payload,
        };
    }
    catch (error) {
        return childToolError("child_collect", error, { child_id: input.child_id });
    }
});
server.registerTool("child_stream", {
    title: "Child stream",
    description: "Pagine les messages stdout/stderr enregistrés pour un enfant.",
    inputSchema: ChildStreamInputShape,
}, (input) => {
    try {
        const parsed = ChildStreamInputSchema.parse(input);
        const result = handleChildStream(getChildToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "child_stream", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return childToolError("child_stream", error, {
            child_id: input.child_id,
            after_sequence: input.after_sequence ?? null,
        });
    }
});
server.registerTool("child_cancel", {
    title: "Child cancel",
    description: "Demande un arrêt gracieux (SIGINT/SIGTERM) avec timeout optionnel.",
    inputSchema: ChildCancelInputShape,
}, async (input) => {
    try {
        const parsed = ChildCancelInputSchema.parse(input);
        const result = await handleChildCancel(getChildToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "child_cancel", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return childToolError("child_cancel", error, { child_id: input.child_id });
    }
});
server.registerTool("child_kill", {
    title: "Child kill",
    description: "Force la terminaison d'un enfant après le délai indiqué.",
    inputSchema: ChildKillInputShape,
}, async (input) => {
    try {
        const parsed = ChildKillInputSchema.parse(input);
        const result = await handleChildKill(getChildToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "child_kill", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return childToolError("child_kill", error, { child_id: input.child_id });
    }
});
server.registerTool("child_gc", {
    title: "Child gc",
    description: "Nettoie les métadonnées d'un enfant terminé.",
    inputSchema: ChildGcInputShape,
}, (input) => {
    try {
        const parsed = ChildGcInputSchema.parse(input);
        const result = handleChildGc(getChildToolContext(), parsed);
        return {
            content: [{ type: "text", text: j({ tool: "child_gc", result }) }],
            structuredContent: result,
        };
    }
    catch (error) {
        return childToolError("child_gc", error, { child_id: input.child_id });
    }
});
// child_prompt
server.registerTool("child_prompt", { title: "Child prompt", description: "Ajoute des messages au sous-chat et retourne un pending_id.", inputSchema: ChildPromptShape }, async (input) => {
    pruneExpired();
    const { child_id, messages } = input;
    const child = graphState.getChild(child_id);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    if (child.state === "killed")
        return { isError: true, content: [{ type: "text", text: j({ error: "KILLED", message: "Child termine" }) }] };
    for (const message of messages) {
        const entry = {
            role: message.role,
            content: message.content,
            ts: now(),
            actor: message.role === "user" ? "user" : "orchestrator"
        };
        graphState.appendMessage(child_id, entry);
    }
    graphState.patchChild(child_id, { state: "running", waitingFor: "reply" });
    const pendingId = `pending_${randomUUID()}`;
    graphState.setPending(child_id, pendingId, now());
    const jobId = child.jobId ?? findJobIdByChild(child_id);
    pushEvent({ kind: "PROMPT", jobId, childId: child_id, source: "orchestrator", payload: { appended: messages.length } });
    pushEvent({ kind: "PENDING", jobId, childId: child_id, payload: { pendingId } });
    return { content: [{ type: "text", text: j({ pending_id: pendingId, child_id }) }] };
});
// child_push_partial
server.registerTool("child_push_partial", { title: "Child push partial", description: "Pousse un fragment de reponse (stream).", inputSchema: ChildPushPartialShape }, async (input) => {
    pruneExpired();
    const { pending_id, delta, done } = input;
    const pending = graphState.getPending(pending_id);
    if (!pending)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "pending_id inconnu" }) }] };
    const child = graphState.getChild(pending.childId);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child introuvable" }) }] };
    const text = String(delta ?? "").trim();
    if (text.length) {
        graphState.appendMessage(child.id, { role: "assistant", content: text, ts: now(), actor: "child" });
    }
    const jobId = child.jobId ?? findJobIdByChild(child.id);
    pushEvent({ kind: "REPLY_PART", jobId, childId: child.id, source: "child", payload: { len: text.length } });
    if (done) {
        graphState.clearPending(pending_id);
        graphState.patchChild(child.id, { state: "waiting", waitingFor: null, pendingId: null });
        pushEvent({ kind: "REPLY", jobId, childId: child.id, source: "child", payload: { final: true } });
    }
    return { content: [{ type: "text", text: j({ ok: true }) }] };
});
// child_push_reply
server.registerTool("child_push_reply", { title: "Child push reply", description: "Finalise la reponse pour un pending_id.", inputSchema: ChildPushReplyShape }, async (input) => {
    pruneExpired();
    const { pending_id, content } = input;
    const pending = graphState.getPending(pending_id);
    if (!pending)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "pending_id inconnu" }) }] };
    const child = graphState.getChild(pending.childId);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child introuvable" }) }] };
    graphState.appendMessage(child.id, { role: "assistant", content, ts: now(), actor: "child" });
    graphState.clearPending(pending_id);
    graphState.patchChild(child.id, { state: "waiting", waitingFor: null, pendingId: null });
    const jobId = child.jobId ?? findJobIdByChild(child.id);
    pushEvent({ kind: "REPLY", jobId, childId: child.id, source: "child", payload: { length: content.length, final: true } });
    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id }) }] };
});
// child_chat
server.registerTool("child_chat", { title: "Child chat", description: "Envoie un message orchestrateur->enfant et retourne un pending_id.", inputSchema: ChildChatShape }, async (input) => {
    pruneExpired();
    const { child_id, content, role = "user" } = input;
    const child = graphState.getChild(child_id);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    if (child.state === "killed")
        return { isError: true, content: [{ type: "text", text: j({ error: "KILLED", message: "Child termine" }) }] };
    graphState.appendMessage(child_id, { role, content, ts: now(), actor: role === "user" ? "user" : "orchestrator" });
    graphState.patchChild(child_id, { state: "running", waitingFor: "reply" });
    const pendingId = `pending_${randomUUID()}`;
    graphState.setPending(child_id, pendingId, now());
    const jobId = child.jobId ?? findJobIdByChild(child_id);
    pushEvent({ kind: "PROMPT", jobId, childId: child_id, source: "orchestrator", payload: { oneShot: true } });
    pushEvent({ kind: "PENDING", jobId, childId: child_id, payload: { pendingId } });
    return { content: [{ type: "text", text: j({ pending_id: pendingId, child_id }) }] };
});
// child_info
server.registerTool("child_info", { title: "Child info", description: "Retourne l etat et les metadonnees d un enfant.", inputSchema: ChildInfoShape }, async (input) => {
    const child = graphState.getChild(input.child_id);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    const info = {
        id: child.id,
        name: child.name,
        state: child.state,
        runtime: child.runtime,
        waiting_for: child.waitingFor,
        pending_id: child.pendingId,
        system: child.systemMessage,
        ttl_at: child.ttlAt,
        transcript_size: child.transcriptSize,
        last_ts: child.lastTs
    };
    return { content: [{ type: "text", text: j(info) }] };
});
// child_transcript
server.registerTool("child_transcript", { title: "Child transcript", description: "Retourne une tranche du transcript d un enfant.", inputSchema: ChildTranscriptShape }, async (input) => {
    const child = graphState.getChild(input.child_id);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    const slice = graphState.getTranscript(child.id, {
        sinceIndex: input.since_index,
        sinceTs: input.since_ts,
        limit: input.limit,
        reverse: input.reverse
    });
    return { content: [{ type: "text", text: j({ child_id: child.id, total: slice.total, items: slice.items }) }] };
});
// child_rename
server.registerTool("child_rename", { title: "Child rename", description: "Renomme un enfant.", inputSchema: ChildRenameShape }, async (input) => {
    const child = graphState.getChild(input.child_id);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    const oldName = child.name;
    graphState.patchChild(child.id, { name: input.name });
    pushEvent({ kind: "INFO", childId: child.id, jobId: child.jobId ?? findJobIdByChild(child.id), payload: { rename: { from: oldName, to: input.name } } });
    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id, name: input.name }) }] };
});
// child_reset
server.registerTool("child_reset", { title: "Child reset", description: "Reinitialise la session d un enfant.", inputSchema: ChildResetShape }, async (input) => {
    const child = graphState.getChild(input.child_id);
    if (!child)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
    graphState.resetChild(child.id, { keepSystem: !!input.keep_system, timestamp: now() });
    pushEvent({ kind: "INFO", childId: child.id, jobId: child.jobId ?? findJobIdByChild(child.id), payload: { reset: { keep_system: !!input.keep_system } } });
    return { content: [{ type: "text", text: j({ ok: true, child_id: child.id }) }] };
});
// status
server.registerTool("status", { title: "Status", description: "Snapshot d un job ou liste des jobs.", inputSchema: StatusShape }, async (input) => {
    pruneExpired();
    const { job_id } = input;
    if (job_id) {
        const job = graphState.getJob(job_id);
        if (!job)
            return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };
        const children = graphState.listChildren(job_id).map((child) => ({
            id: child.id,
            name: child.name,
            state: child.state,
            runtime: child.runtime,
            waiting_for: child.waitingFor,
            last_update: child.lastTs ?? child.ttlAt ?? null,
            pending_id: child.pendingId,
            transcript_size: child.transcriptSize
        }));
        const payload = { job_id, state: job.state, children };
        pushEvent({ kind: "STATUS", jobId: job.id, payload });
        return { content: [{ type: "text", text: j(payload) }] };
    }
    const jobs = graphState.listJobs().map((job) => ({ id: job.id, state: job.state, child_count: job.childIds.length }));
    return { content: [{ type: "text", text: j({ jobs }) }] };
});
// graph_forge_analyze
server.registerTool("graph_forge_analyze", { title: "Graph Forge analyze", description: "Compile un script Graph Forge et execute les analyses demandees.", inputSchema: GraphForgeShape }, async (input) => {
    let cfg;
    try {
        cfg = GraphForgeSchema.parse(input);
    }
    catch (validationError) {
        return {
            isError: true,
            content: [{ type: "text", text: j({ error: "GRAPH_FORGE_INPUT_INVALID", detail: describeError(validationError) }) }]
        };
    }
    try {
        const mod = await loadGraphForge();
        let resolvedPath;
        let source = cfg.source;
        if (!source && cfg.path) {
            resolvedPath = resolvePath(process.cwd(), cfg.path);
            try {
                source = await readFile(resolvedPath, "utf8");
            }
            catch (fsError) {
                const info = describeError(fsError);
                throw new Error(`Impossible de lire le fichier Graph Forge \`${resolvedPath}\`: ${info.message}`);
            }
        }
        if (!source) {
            throw new Error("No Graph Forge source provided");
        }
        const compiled = mod.compileSource(source, { entryGraph: cfg.entry_graph });
        const graphSummary = {
            name: compiled.graph.name,
            directives: Array.from(compiled.graph.directives.entries()).map(([key, value]) => ({ name: key, value })),
            nodes: compiled.graph.listNodes().map(node => ({ id: node.id, attributes: node.attributes })),
            edges: compiled.graph.listEdges().map(edge => ({ from: edge.from, to: edge.to, attributes: edge.attributes }))
        };
        const analysisDefinitions = compiled.analyses.map(analysis => ({
            name: analysis.name,
            args: analysis.args.map(arg => arg.value),
            location: { line: analysis.tokenLine, column: analysis.tokenColumn }
        }));
        const tasks = [];
        if (cfg.use_defined_analyses ?? true) {
            for (const analysis of compiled.analyses) {
                tasks.push({
                    name: analysis.name,
                    args: analysis.args.map(arg => toStringArg(arg.value)),
                    source: "dsl"
                });
            }
        }
        if (cfg.analyses?.length) {
            for (const req of cfg.analyses) {
                tasks.push({
                    name: req.name,
                    args: req.args ?? [],
                    weightKey: req.weight_key ?? undefined,
                    source: "request"
                });
            }
        }
        const analysisReports = tasks.map(task => {
            try {
                const result = runGraphForgeAnalysis(mod, compiled, task, cfg.weight_key);
                return { name: task.name, source: task.source, args: task.args, result };
            }
            catch (err) {
                return { name: task.name, source: task.source, args: task.args, error: describeError(err) };
            }
        });
        const payload = {
            entry_graph: cfg.entry_graph ?? compiled.graph.name,
            source: {
                path: resolvedPath ?? null,
                provided_inline: Boolean(cfg.source),
                length: source.length
            },
            graph: graphSummary,
            analyses_defined: analysisDefinitions,
            analyses_resolved: analysisReports
        };
        return { content: [{ type: "text", text: j(payload) }] };
    }
    catch (err) {
        return {
            isError: true,
            content: [{ type: "text", text: j({ error: "GRAPH_FORGE_FAILED", detail: describeError(err) }) }]
        };
    }
});
// aggregate
server.registerTool("aggregate", { title: "Aggregate", description: "Agrege les sorties d un job (concat par defaut).", inputSchema: AggregateShape }, async (input) => {
    pruneExpired();
    const { job_id } = input;
    const job = graphState.getJob(job_id);
    if (!job)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };
    const strategyRaw = typeof input.strategy === "string" ? input.strategy.trim() : undefined;
    const knownStrategies = new Set(["concat", "json_merge", "vote", "markdown_compact", "jsonl"]);
    let strategy;
    if (strategyRaw && knownStrategies.has(strategyRaw)) {
        strategy = strategyRaw;
    }
    else {
        strategy = undefined;
    }
    const res = aggregate(job_id, strategy, { includeSystem: input.include_system, includeGoals: input.include_goals });
    graphState.patchJob(job_id, { state: "done" });
    pushEvent({ kind: "AGGREGATE", jobId: job.id, payload: { strategy: strategy ?? "concat", requested: strategyRaw ?? null } });
    return { content: [{ type: "text", text: j(res) }] };
});
// kill
server.registerTool("kill", { title: "Kill", description: "Termine un child_id ou un job_id.", inputSchema: KillShape }, async (input) => {
    pruneExpired();
    const { child_id, job_id } = input;
    if (child_id) {
        const child = graphState.getChild(child_id);
        if (!child)
            return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "child_id inconnu" }) }] };
        graphState.clearPendingForChild(child_id);
        graphState.patchChild(child_id, { state: "killed", waitingFor: null, pendingId: null });
        const jobId = child.jobId ?? findJobIdByChild(child_id);
        pushEvent({ kind: "KILL", jobId, childId: child_id, level: "warn", payload: { scope: "child" } });
        return { content: [{ type: "text", text: j({ ok: true, child_id }) }] };
    }
    if (job_id) {
        const job = graphState.getJob(job_id);
        if (!job)
            return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "job_id inconnu" }) }] };
        for (const child of graphState.listChildren(job_id)) {
            graphState.clearPendingForChild(child.id);
            graphState.patchChild(child.id, { state: "killed", waitingFor: null, pendingId: null });
        }
        graphState.patchJob(job_id, { state: "killed" });
        pushEvent({ kind: "KILL", jobId: job_id, level: "warn", payload: { scope: "job" } });
        return { content: [{ type: "text", text: j({ ok: true, job_id }) }] };
    }
    return { isError: true, content: [{ type: "text", text: j({ error: "BAD_REQUEST", message: "Fournis child_id ou job_id" }) }] };
});
// events_subscribe
server.registerTool("events_subscribe", { title: "Events subscribe", description: "S abonner aux evenements (filtrage job_id/child_id).", inputSchema: SubscribeShape }, async (input) => {
    const sub = {
        id: `sub_${randomUUID()}`,
        jobId: input.job_id,
        childId: input.child_id,
        lastSeq: typeof input.last_seq === "number" ? input.last_seq : eventStore.getLastSequence(),
        createdAt: now()
    };
    SUBS.set(sub.id, sub);
    graphState.createSubscription({ id: sub.id, jobId: sub.jobId, childId: sub.childId, lastSeq: sub.lastSeq, createdAt: sub.createdAt });
    pushEvent({ kind: "INFO", payload: { msg: "subscription_opened", subId: sub.id, jobId: sub.jobId, childId: sub.childId } });
    return { content: [{ type: "text", text: j({ subscription_id: sub.id, last_seq: sub.lastSeq }) }] };
});
// events_poll
server.registerTool("events_poll", { title: "Events poll", description: "Recupere les evenements depuis la derniere sequence (long-poll via wait_ms).", inputSchema: PollShape }, async (input) => {
    const sub = SUBS.get(input.subscription_id);
    if (!sub)
        return { isError: true, content: [{ type: "text", text: j({ error: "NOT_FOUND", message: "subscription_id inconnu" }) }] };
    const since = typeof input.since_seq === "number" ? input.since_seq : sub.lastSeq;
    const max = input.max_events && input.max_events > 0 ? Math.min(input.max_events, 500) : 100;
    const wait = Math.min(Math.max(input.wait_ms ?? 0, 0), 8000);
    let raw = listEventsSince(since, sub.jobId, sub.childId);
    const deadline = Date.now() + wait;
    while (!raw.length && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
        raw = listEventsSince(since, sub.jobId, sub.childId);
    }
    const suppressed = new Set(input.suppress ?? []);
    let evts = raw.filter(e => !suppressed.has(e.kind)).slice(0, max);
    if (raw.length) {
        sub.lastSeq = raw[raw.length - 1].seq;
        graphState.updateSubscription(sub.id, { lastSeq: sub.lastSeq });
    }
    return { content: [{ type: "text", text: j({ format: "json", events: evts, last_seq: sub.lastSeq }) }] };
});
// events_unsubscribe
server.registerTool("events_unsubscribe", { title: "Events unsubscribe", description: "Ferme un abonnement.", inputSchema: UnsubscribeShape }, async (input) => {
    const ok = SUBS.delete(input.subscription_id);
    graphState.deleteSubscription(input.subscription_id);
    if (ok)
        pushEvent({ kind: "INFO", payload: { msg: "subscription_closed", subId: input.subscription_id } });
    return { content: [{ type: "text", text: j({ ok }) }] };
});
// --- Transports ---
const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMain) {
    let options;
    try {
        options = parseOrchestratorRuntimeOptions(process.argv.slice(2));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("cli_options_invalid", { message });
        process.exit(1);
    }
    configureRuntimeFeatures(options.features);
    configureRuntimeTimings(options.timings);
    configureChildSafetyLimits(options.safety);
    reflectionEnabled = options.enableReflection;
    qualityGateEnabled = options.enableQualityGate;
    qualityGateThreshold = options.qualityThreshold;
    if (options.logFile) {
        activeLoggerOptions = { ...activeLoggerOptions, logFile: options.logFile };
        logger = new StructuredLogger(activeLoggerOptions);
        eventStore.setLogger(logger);
        logger.info("logger_configured", {
            log_file: options.logFile,
            max_size_bytes: activeLoggerOptions.maxFileSizeBytes ?? null,
            max_file_count: activeLoggerOptions.maxFileCount ?? null,
            redacted_tokens: activeLoggerOptions.redactSecrets?.length ?? 0,
            source: "cli",
        });
    }
    eventStore.setMaxHistory(options.maxEventHistory);
    let enableStdio = options.enableStdio;
    const httpEnabled = options.http.enabled;
    if (!enableStdio && !httpEnabled) {
        logger.error("no_transport_enabled", {});
        process.exit(1);
    }
    const cleanup = [];
    if (httpEnabled) {
        if (enableStdio) {
            logger.warn("stdio_disabled_due_to_http");
            enableStdio = false;
        }
        try {
            const handle = await startHttpServer(server, options.http, logger);
            cleanup.push(handle.close);
        }
        catch (error) {
            logger.error("http_start_failed", { message: error instanceof Error ? error.message : String(error) });
            process.exit(1);
        }
    }
    // Start the monitoring dashboard when operators enabled it via CLI. The
    // server shares the orchestrator in-memory state so the cleanup hook mirrors
    // the HTTP transport lifecycle.
    if (options.dashboard.enabled) {
        try {
            const handle = await startDashboardServer({
                host: options.dashboard.host,
                port: options.dashboard.port,
                streamIntervalMs: options.dashboard.streamIntervalMs,
                graphState,
                supervisor: childSupervisor,
                eventStore,
                stigmergy,
                btStatusRegistry,
                supervisorAgent: orchestratorSupervisor,
                logger,
            });
            cleanup.push(handle.close);
        }
        catch (error) {
            logger.error("dashboard_start_failed", { message: error instanceof Error ? error.message : String(error) });
            process.exit(1);
        }
    }
    if (enableStdio) {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        logger.info("stdio_listening");
    }
    logger.info("runtime_started", {
        stdio: enableStdio,
        http: httpEnabled,
        max_event_history: eventStore.getMaxHistory()
    });
    process.on("SIGINT", async () => {
        logger.warn("shutdown_signal", { signal: "SIGINT" });
        for (const closer of cleanup) {
            try {
                await closer();
            }
            catch (error) {
                logger.error("transport_close_failed", { message: error instanceof Error ? error.message : String(error) });
            }
        }
        process.exit(0);
    });
}
export { server, graphState, DEFAULT_CHILD_RUNTIME, buildLiveEvents, setDefaultChildRuntime, GraphSubgraphExtractInputSchema, GraphSubgraphExtractInputShape, };
