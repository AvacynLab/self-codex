import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { StructuredLogger } from "../logger.js";
import { EventStore, type OrchestratorEvent } from "../eventStore.js";
import {
  KnowledgeGraph,
  type KnowledgeTripleSnapshot,
} from "../knowledge/knowledgeGraph.js";
import { assistKnowledgeQuery, type KnowledgeAssistResult } from "../knowledge/assist.js";
import { LocalVectorMemory } from "../memory/vectorMemory.js";
import type { EmbedTextOptions, EmbedTextResult } from "../memory/vector.js";
import { HybridRetriever } from "../memory/retriever.js";
import { mergeProvenance, type Provenance } from "../types/provenance.js";
import {
  SearchPipeline,
  type DirectIngestParameters,
  type DirectIngestResult,
  type SearchJobError,
  type SearchJobParameters,
  type SearchJobResult,
} from "../search/pipeline.js";
import { SearxClient } from "../search/searxClient.js";
import { SearchDownloader } from "../search/downloader.js";
import { UnstructuredExtractor } from "../search/extractor.js";
import { SearchMetricsRecorder } from "../search/metrics.js";
import { loadSearchConfig, type SearchConfig } from "../search/config.js";
import {
  KnowledgeGraphIngestor,
  type KnowledgeGraphIngestDependencies,
  type KnowledgeGraphIngestResult,
} from "../search/ingest/toKnowledgeGraph.js";
import {
  VectorStoreIngestor,
  type VectorStoreIngestDependencies,
  type VectorStoreIngestResult,
} from "../search/ingest/toVectorStore.js";
import { computeScenarioTimingReportFromEvents } from "./metrics.js";
import {
  recordScenarioRun,
  type ScenarioArtefactPayload,
  type ScenarioErrorEntry,
  type ScenarioTimingReport,
} from "./artefacts.js";
import {
  ensureValidationRunLayout,
  type ValidationRunLayout,
} from "./layout.js";
import {
  initialiseScenarioRun,
  formatScenarioSlug,
  resolveScenarioById,
  VALIDATION_SCENARIOS,
  type ScenarioRunPaths,
  type ValidationScenarioDefinition,
} from "./scenario.js";
import { extractServerLogExcerpt } from "./logs.js";

/**
 * Allows callers to inject bespoke dependencies when executing validation
 * scenarios. Tests rely on the hook to provide deterministic stubs while real
 * runs default to the production-ready search stack.
 */
export interface SearchScenarioDependencyOverrides {
  /** Custom logger used by the search pipeline. */
  readonly logger?: StructuredLogger;
  /** Optional preconfigured event store (defaults to a fresh instance). */
  readonly eventStore?: EventStore;
  /** Allows tests to reuse a prepared knowledge graph. */
  readonly knowledgeGraph?: KnowledgeGraph;
  /** Allows tests to reuse a prepared vector memory. */
  readonly vectorMemory?: LocalVectorMemory;
  /** Optional Searx client override to avoid network calls. */
  readonly searxClient?: SearxClient;
  /** Optional downloader override returning deterministic payloads. */
  readonly downloader?: SearchDownloader;
  /** Optional extractor override bypassing the unstructured API. */
  readonly extractor?: UnstructuredExtractor;
  /** Optional metrics recorder override. */
  readonly metrics?: SearchMetricsRecorder;
  /** Custom embedder injected into the vector ingestor. */
  readonly vectorEmbed?: (options: EmbedTextOptions) => EmbedTextResult;
  /**
   * Overrides the chunk token budget used by the vector ingestor. Useful for
   * tests keeping fixtures concise.
   */
  readonly vectorMaxTokensPerChunk?: number;
  /** Upper bound applied to the in-memory event history. */
  readonly eventHistoryLimit?: number;
  /** Optional search configuration precomputed by tests. */
  readonly config?: SearchConfig;
}

/**
 * Options accepted when executing a validation search scenario.
 */
export interface ExecuteSearchScenarioOptions {
  /** Identifier of the scenario (1..10). */
  readonly scenarioId: number;
  /** Optional custom job id injected into the search pipeline. */
  readonly jobId?: string;
  /** Optional root forwarded to {@link ensureValidationRunLayout}. */
  readonly baseRoot?: string;
  /** Optional precomputed layout. */
  readonly layout?: ValidationRunLayout;
  /** Dependency overrides mainly used by the unit suite. */
  readonly overrides?: SearchScenarioDependencyOverrides;
  /** When false, skips writing dumps under `validation_run/artifacts/`. */
  readonly persistArtifacts?: boolean;
}

/** Summary of the documents processed during the scenario execution. */
export interface DocumentSummary {
  readonly id: string;
  readonly url: string;
  readonly title: string | null;
  readonly language: string | null;
  readonly description: string | null;
  readonly mimeType: string | null;
  readonly checksum: string;
  readonly size: number;
  readonly fetchedAt: number;
  readonly segmentCount: number;
  readonly provenance: ReadonlyArray<Record<string, unknown>>;
}

/** Summary of the triples inserted or updated for a document. */
export interface KnowledgeGraphDocumentSummary {
  readonly subject: string;
  readonly tripleCount: number;
  readonly created: number;
  readonly updated: number;
  readonly mentions: readonly string[];
}

/** Summary of an individual vector chunk stored during the scenario. */
export interface VectorChunkSummary {
  readonly chunkId: string;
  readonly tokenCount: number;
  readonly segmentIds: readonly string[];
  readonly metadata: Record<string, unknown>;
  readonly tags: readonly string[];
  readonly provenance: ReadonlyArray<Record<string, unknown>>;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly textLength: number;
}

/**
 * Result returned once a validation search scenario has been executed and its
 * artefacts persisted.
 */
export interface ExecuteSearchScenarioResult {
  /** Scenario definition resolved from {@link VALIDATION_SCENARIOS}. */
  readonly scenario: ValidationScenarioDefinition;
  /** Job identifier used while running the pipeline. */
  readonly jobId: string;
  /** Chronological list of events persisted to `events.ndjson`. */
  readonly events: readonly Record<string, unknown>[];
  /** Timing report written to `timings.json` when available. */
  readonly timings?: ScenarioTimingReport;
  /** Diagnostic notes emitted while computing timings. */
  readonly timingNotes: readonly string[];
  /** Structured response persisted to `response.json`. */
  readonly response: Record<string, unknown>;
  /** Metadata describing the documents processed during the scenario. */
  readonly documents: readonly DocumentSummary[];
  /** Aggregated knowledge graph summary per document. */
  readonly knowledgeSummaries: readonly KnowledgeGraphDocumentSummary[];
  /** Metadata describing the stored vector chunks. */
  readonly vectorSummaries: readonly VectorChunkSummary[];
  /** Paths to the persisted artefacts. */
  readonly runPaths: ScenarioRunPaths;
  /** Layout used while writing artefacts. */
  readonly layout: ValidationRunLayout;
  /** Directory containing auxiliary dumps under `validation_run/artifacts/`. */
  readonly artifactDir: string;
}

/** Internal state returned by {@link createSearchScenarioRuntime}. */
interface SearchScenarioRuntime {
  readonly layout: ValidationRunLayout;
  readonly pipeline: SearchPipeline;
  readonly eventStore: EventStore;
  readonly logger: StructuredLogger;
  readonly knowledgeGraph: KnowledgeGraph;
  readonly vectorMemory: LocalVectorMemory;
  readonly metrics: SearchMetricsRecorder;
  readonly knowledgeCaptures: KnowledgeGraphIngestResult[];
  readonly vectorCaptures: VectorStoreIngestResult[];
  readonly artifactDir: string;
}

/** Default ceiling applied to the local event history while running scenarios. */
const DEFAULT_EVENT_HISTORY = 4_096;

/**
 * Executes one of the search-driven validation scenarios (S01–S09) by running
 * the web search pipeline end-to-end. The helper captures the resulting
 * artefacts (events, KG/vector updates, structured response) and persists them
 * to the canonical layout under `validation_run/`.
 */
export async function executeSearchScenario(
  options: ExecuteSearchScenarioOptions,
): Promise<ExecuteSearchScenarioResult> {
  const scenario = resolveScenarioById(options.scenarioId);
  if (scenario.id === 10) {
    return executeRagQualityScenario({
      scenario,
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.layout ? { layout: options.layout } : {}),
      ...(options.baseRoot !== undefined ? { baseRoot: options.baseRoot } : {}),
      persistArtifacts: options.persistArtifacts ?? true,
    });
  }

  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const runPaths = await initialiseScenarioRun(scenario, { layout });
  const slug = formatScenarioSlug(scenario);
  const runtime = await createSearchScenarioRuntime({
    scenario,
    layout,
    runPaths,
    ...(options.overrides ? { overrides: options.overrides } : {}),
  });

  const jobId = normaliseJobId(options.jobId, scenario);
  const isDirect = isDirectIngestInput(scenario.input);

  const execution = await runScenarioPipeline({
    runtime,
    scenario,
    jobId,
    input: scenario.input,
    direct: isDirect,
  });

  const events = execution.events;
  const { report: timings, notes: timingNotes } = computeScenarioTimingReportFromEvents(events);
  const errors = convertErrors(execution.errors);
  const knowledgeSummaries = summariseKnowledgeCaptures(runtime.knowledgeCaptures);
  const vectorSummaries = summariseVectorCaptures(runtime.vectorCaptures);
  const kgChanges = flattenKnowledgeCaptures(runtime.knowledgeCaptures);
  const vectorUpserts = flattenVectorCaptures(runtime.vectorCaptures);

  const response = buildResponseSummary({
    scenario,
    jobId,
    direct: isDirect,
    result: execution.result,
    documents: execution.documents,
    knowledgeSummaries,
    vectorSummaries,
    timingNotes,
  });

  const logExcerpt = await extractServerLogExcerpt({
    jobId,
    scenarioSlug: slug,
    layout,
  });

  const artefacts: ScenarioArtefactPayload = {
    input: scenario.input,
    response,
    events,
    timings,
    errors,
    kgChanges,
    vectorUpserts,
    ...(logExcerpt ? { serverLog: logExcerpt.lines } : {}),
  };

  await recordScenarioRun(scenario.id, artefacts, { layout });

  if (options.persistArtifacts ?? true) {
    await persistScenarioArtifacts(runtime.artifactDir, {
      knowledgeGraph: runtime.knowledgeGraph.exportAll(),
      documents: execution.documents,
      knowledgeSummaries,
      vectorSummaries,
      response,
      timingNotes,
    });
  }

  return {
    scenario,
    jobId,
    events,
    timings,
    timingNotes,
    response,
    documents: execution.documents,
    knowledgeSummaries,
    vectorSummaries,
    runPaths,
    layout,
    artifactDir: runtime.artifactDir,
  };
}

/**
 * Runs the search pipeline according to the scenario type (Searx-backed search
 * versus direct ingestion) and returns the structured outcome.
 */
async function runScenarioPipeline(args: {
  readonly runtime: SearchScenarioRuntime;
  readonly scenario: ValidationScenarioDefinition;
  readonly jobId: string;
  readonly input: unknown;
  readonly direct: boolean;
}): Promise<{
  readonly result: SearchJobResult | DirectIngestResult;
  readonly events: Record<string, unknown>[];
  readonly errors: readonly SearchJobError[];
  readonly documents: readonly DocumentSummary[];
}> {
  const { runtime, jobId, input, direct } = args;

  let executionResult: SearchJobResult | DirectIngestResult;
  if (direct) {
    const parameters = buildDirectParameters(jobId, input);
    executionResult = await runtime.pipeline.ingestDirect(parameters);
  } else {
    const parameters = buildSearchParameters(jobId, input);
    executionResult = await runtime.pipeline.runSearchJob(parameters);
  }

  const documents = summariseDocuments(executionResult.documents);
  const rawEvents = runtime.eventStore.listForJob(jobId);
  const events = rawEvents.map(serialiseEvent);

  return {
    result: executionResult,
    events,
    errors: executionResult.errors,
    documents,
  };
}

/** Builds the payload required for {@link SearchPipeline.runSearchJob}. */
function buildSearchParameters(jobId: string, input: unknown): SearchJobParameters {
  if (!input || typeof input !== "object") {
    throw new Error("Scenario input must be an object when running search jobs.");
  }

  const candidate = input as Record<string, unknown>;
  if (typeof candidate.query !== "string" || candidate.query.trim().length === 0) {
    throw new Error("Scenario input must expose a non-empty query.");
  }

  const categories = Array.isArray(candidate.categories)
    ? (candidate.categories.filter((value): value is string => typeof value === "string") as ReadonlyArray<string>)
    : undefined;
  const engines = Array.isArray(candidate.engines)
    ? (candidate.engines.filter((value): value is string => typeof value === "string") as ReadonlyArray<string>)
    : undefined;
  const maxResults =
    typeof candidate.maxResults === "number" && Number.isFinite(candidate.maxResults)
      ? candidate.maxResults
      : undefined;
  const language = typeof candidate.language === "string" ? candidate.language : undefined;
  const safeSearch =
    candidate.safeSearch === 0 || candidate.safeSearch === 1 || candidate.safeSearch === 2
      ? candidate.safeSearch
      : undefined;
  const fetchContent = typeof candidate.fetchContent === "boolean" ? candidate.fetchContent : undefined;
  const injectGraph = typeof candidate.injectGraph === "boolean" ? candidate.injectGraph : undefined;
  const injectVector = typeof candidate.injectVector === "boolean" ? candidate.injectVector : undefined;

  return {
    query: candidate.query.trim(),
    jobId,
    ...(categories !== undefined ? { categories } : {}),
    ...(engines !== undefined ? { engines } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(safeSearch !== undefined ? { safeSearch } : {}),
    ...(fetchContent !== undefined ? { fetchContent } : {}),
    ...(injectGraph !== undefined ? { injectGraph } : {}),
    ...(injectVector !== undefined ? { injectVector } : {}),
  };
}

/** Builds the payload required for {@link SearchPipeline.ingestDirect}. */
function buildDirectParameters(jobId: string, input: unknown): DirectIngestParameters {
  if (!input || typeof input !== "object") {
    throw new Error("Scenario input must be an object when running direct ingestion.");
  }

  const candidate = input as Record<string, unknown>;
  const urls = Array.isArray(candidate.url) ? candidate.url : [];
  if (urls.length === 0) {
    throw new Error("Direct ingestion scenarios must provide a non-empty `url` array.");
  }

  const sources = urls.map((value, index) => ({
    url: String(value),
    position: index,
  }));

  return {
    sources,
    jobId,
    label: typeof candidate.label === "string" ? candidate.label : null,
    injectGraph: normaliseBoolean(candidate.injectGraph, true),
    injectVector: normaliseBoolean(candidate.injectVector, true),
  };
}

/** Determines whether a scenario input describes a direct ingestion. */
function isDirectIngestInput(input: unknown): boolean {
  if (!input || typeof input !== "object") {
    return false;
  }
  return Array.isArray((input as Record<string, unknown>).url);
}

/** Normalises optional boolean flags. */
function normaliseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

/** Converts structured documents into the lightweight summaries stored on disk. */
function summariseDocuments(documents: SearchJobResult["documents"]): DocumentSummary[] {
  return documents.map((document) => ({
    id: document.id,
    url: document.url,
    title: document.title,
    language: document.language,
    description: document.description,
    mimeType: document.mimeType,
    checksum: document.checksum,
    size: document.size,
    fetchedAt: document.fetchedAt,
    segmentCount: document.segments.length,
    provenance: [
      {
        searxQuery: document.provenance.searxQuery,
        engines: [...document.provenance.engines],
        categories: [...document.provenance.categories],
        position: document.provenance.position,
        sourceUrl: document.provenance.sourceUrl,
      } satisfies Record<string, unknown>,
    ],
  }));
}

/** Converts pipeline errors into the structured entries stored in `errors.json`. */
function convertErrors(errors: readonly SearchJobError[]): ScenarioErrorEntry[] {
  return errors.map((error) => ({
    category: error.stage,
    message: error.message,
    ...(error.url ? { url: error.url } : {}),
    ...(error.code ? { metadata: { code: error.code } } : {}),
  }));
}

/** Lightweight serialisation helper producing JSON friendly event payloads. */
function serialiseEvent(event: OrchestratorEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
}

/** Aggregates knowledge graph ingestion outcomes per document. */
function summariseKnowledgeCaptures(
  captures: readonly KnowledgeGraphIngestResult[],
): KnowledgeGraphDocumentSummary[] {
  return captures.map((capture) => ({
    subject: capture.subject,
    tripleCount: capture.triples.length,
    created: capture.triples.filter((entry) => entry.result.created).length,
    updated: capture.triples.filter((entry) => entry.result.updated).length,
    mentions: [...capture.mentions],
  }));
}

/** Converts knowledge graph captures into NDJSON entries. */
function flattenKnowledgeCaptures(
  captures: readonly KnowledgeGraphIngestResult[],
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const capture of captures) {
    for (const triple of capture.triples) {
      entries.push({
        subject: capture.subject,
        predicate: triple.predicate,
        object: triple.object,
        tripleId: triple.result.snapshot.id,
        created: triple.result.created,
        updated: triple.result.updated,
        revision: triple.result.snapshot.revision,
        insertedAt: triple.result.snapshot.insertedAt,
        updatedAt: triple.result.snapshot.updatedAt,
        provenance: triple.result.snapshot.provenance.map((entry) => ({ ...entry })),
        mentions: [...capture.mentions],
      });
    }
  }
  return entries;
}

/** Aggregates vector ingestion outcomes per chunk. */
function summariseVectorCaptures(
  captures: readonly VectorStoreIngestResult[],
): VectorChunkSummary[] {
  const summaries: VectorChunkSummary[] = [];
  for (const capture of captures) {
    const descriptors = capture.descriptors;
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index];
      const chunk = capture.chunks[index];
      summaries.push({
        chunkId: descriptor.chunkId,
        tokenCount: descriptor.tokenCount,
        segmentIds: [...descriptor.segmentIds],
        metadata: { ...descriptor.metadata },
        tags: chunk ? [...chunk.tags] : [],
        provenance: chunk ? chunk.provenance.map((entry) => ({ ...entry })) : [],
        createdAt: chunk?.createdAt ?? null,
        updatedAt: chunk?.updatedAt ?? null,
        textLength: chunk ? chunk.text.length : 0,
      });
    }
  }
  return summaries;
}

/** Converts vector captures into the JSON payload stored in `vector_upserts.json`. */
function flattenVectorCaptures(
  captures: readonly VectorStoreIngestResult[],
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const capture of captures) {
    const descriptors = capture.descriptors;
    for (let index = 0; index < descriptors.length; index += 1) {
      const descriptor = descriptors[index];
      const chunk = capture.chunks[index];
      entries.push({
        chunkId: descriptor.chunkId,
        tokenCount: descriptor.tokenCount,
        segmentIds: [...descriptor.segmentIds],
        metadata: { ...descriptor.metadata },
        tags: chunk ? [...chunk.tags] : [],
        provenance: chunk ? chunk.provenance.map((entry) => ({ ...entry })) : [],
        createdAt: chunk?.createdAt ?? null,
        updatedAt: chunk?.updatedAt ?? null,
        textLength: chunk ? chunk.text.length : 0,
      });
    }
  }
  return entries;
}

/** Builds the structured response persisted to `response.json`. */
function buildResponseSummary(args: {
  readonly scenario: ValidationScenarioDefinition;
  readonly jobId: string;
  readonly direct: boolean;
  readonly result: SearchJobResult | DirectIngestResult;
  readonly documents: readonly DocumentSummary[];
  readonly knowledgeSummaries: readonly KnowledgeGraphDocumentSummary[];
  readonly vectorSummaries: readonly VectorChunkSummary[];
  readonly timingNotes: readonly string[];
}): Record<string, unknown> {
  const { scenario, jobId, direct, result, documents, knowledgeSummaries, vectorSummaries, timingNotes } = args;
  const base = {
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    jobId,
    mode: direct ? "direct" : "search",
    stats: result.stats,
    errorCount: result.errors.length,
    documents,
    knowledgeSummaries,
    vectorSummaries,
    timingNotes,
    metrics: result.metrics,
  } as Record<string, unknown>;

  if (!direct) {
    const searchResult = result as SearchJobResult;
    base.query = searchResult.query;
    base.results = searchResult.results.map((entry) => ({
      url: entry.url,
      title: entry.title,
      snippet: entry.snippet,
      engines: [...entry.engines],
      categories: [...entry.categories],
      position: entry.position,
    }));
  }

  return base;
}

/** Persists auxiliary dumps under `validation_run/artifacts/<scenario>/`. */
async function persistScenarioArtifacts(
  artifactDir: string,
  artefacts: {
    readonly knowledgeGraph: readonly KnowledgeTripleSnapshot[];
    readonly documents: readonly DocumentSummary[];
    readonly knowledgeSummaries: readonly KnowledgeGraphDocumentSummary[];
    readonly vectorSummaries: readonly VectorChunkSummary[];
    readonly response: Record<string, unknown>;
    readonly timingNotes: readonly string[];
  },
): Promise<void> {
  await ensureDirectory(artifactDir);
  await writeJsonFile(path.join(artifactDir, "knowledge_graph.json"), artefacts.knowledgeGraph);
  await writeJsonFile(path.join(artifactDir, "documents_summary.json"), artefacts.documents);
  await writeJsonFile(path.join(artifactDir, "knowledge_summary.json"), artefacts.knowledgeSummaries);
  await writeJsonFile(path.join(artifactDir, "vector_chunks.json"), artefacts.vectorSummaries);
  await writeJsonFile(path.join(artifactDir, "response_summary.json"), artefacts.response);
  if (artefacts.timingNotes.length > 0) {
    await writeJsonFile(path.join(artifactDir, "timing_notes.json"), artefacts.timingNotes);
  }
}

/** Ensures the provided directory exists. */
async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

/** Writes a prettified JSON file with a trailing newline. */
async function writeJsonFile(target: string, payload: unknown): Promise<void> {
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** Result of aggregating knowledge/vector artefacts ahead of the RAG scenario. */
interface RagAggregationResult {
  readonly knowledgeGraph: KnowledgeGraph;
  readonly knowledgeSummaries: readonly KnowledgeGraphDocumentSummary[];
  readonly vectorSummaries: readonly VectorChunkSummary[];
  readonly vectorIndexRecords: readonly AggregatedVectorRecord[];
  readonly aggregatedScenarios: readonly string[];
  readonly missingScenarios: readonly string[];
  readonly notes: readonly string[];
  readonly knowledgeSubjects: number;
}

/** Internal representation of aggregated vector documents persisted to disk. */
interface AggregatedVectorRecord {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly metadata: Record<string, unknown>;
  readonly provenance: readonly Provenance[];
  readonly created_at: number;
  readonly updated_at: number;
  readonly embedding: Record<string, number>;
  readonly norm: number;
  readonly token_count: number;
}

/** Executes scenario S10 by querying the aggregated knowledge graph and RAG index. */
async function executeRagQualityScenario(args: {
  readonly scenario: ValidationScenarioDefinition;
  readonly jobId?: string;
  readonly layout?: ValidationRunLayout;
  readonly baseRoot?: string;
  readonly persistArtifacts: boolean;
}): Promise<ExecuteSearchScenarioResult> {
  const { scenario } = args;
  const layout = args.layout ?? (await ensureValidationRunLayout(args.baseRoot));
  const runPaths = await initialiseScenarioRun(scenario, { layout });
  const slug = formatScenarioSlug(scenario);
  const jobId = normaliseJobId(args.jobId, scenario);
  const artifactDir = path.join(layout.artifactsDir, path.basename(runPaths.root));
  await ensureDirectory(artifactDir);

  const aggregation = await aggregateKnowledgeAndVectors({ layout });

  // Persist the aggregated index before instantiating the retriever so the
  // `LocalVectorMemory` factory can load the combined documents from disk.
  const vectorIndexDir = path.join(artifactDir, "vector_index");
  await ensureDirectory(vectorIndexDir);
  await writeJsonFile(path.join(vectorIndexDir, "index.json"), aggregation.vectorIndexRecords);

  const knowledgeGraph = aggregation.knowledgeGraph;
  const vectorMemory = await LocalVectorMemory.create({ directory: vectorIndexDir });
  const logger = new StructuredLogger();
  const retriever = new HybridRetriever(vectorMemory, logger);

  const { query, limit, domainTags, context } = normaliseRagScenarioInput(scenario.input);
  const startedAt = Date.now();
  const assist = await assistKnowledgeQuery(knowledgeGraph, {
    query,
    limit,
    ...(context ? { context } : {}),
    ragRetriever: retriever,
    ragLimit: Math.max(limit, 6),
    ragMinScore: 0.15,
    domainTags: [...domainTags],
  });
  const tookMs = Date.now() - startedAt;

  const response = buildRagScenarioResponse({
    scenario,
    jobId,
    assist,
    aggregation,
    tookMs,
    query,
    domainTags,
  });

  const events: Record<string, unknown>[] = [
    {
      type: "rag_scenario_prepared",
      timestamp: startedAt,
      jobId,
      scenarios: aggregation.aggregatedScenarios,
      missing: aggregation.missingScenarios,
      knowledgeSubjects: aggregation.knowledgeSubjects,
      knowledgeTriples: knowledgeGraph.exportAll().length,
      vectorDocuments: aggregation.vectorIndexRecords.length,
      notes: aggregation.notes,
    },
    {
      type: "rag_scenario_completed",
      timestamp: startedAt + tookMs,
      jobId,
      knowledgeHits: assist.coverage.knowledge_hits,
      ragHits: assist.coverage.rag_hits,
      citations: assist.citations.length,
      tookMs,
    },
  ];

  const ragLogExcerpt = await extractServerLogExcerpt({
    jobId,
    scenarioSlug: slug,
    layout,
  });

  const artefacts: ScenarioArtefactPayload = {
    input: scenario.input,
    response,
    events,
    errors: buildRagScenarioErrors(aggregation, assist),
    ...(ragLogExcerpt ? { serverLog: ragLogExcerpt.lines } : {}),
  };
  await recordScenarioRun(scenario.id, artefacts, { layout });

  if (args.persistArtifacts) {
    await persistScenarioArtifacts(artifactDir, {
      knowledgeGraph: knowledgeGraph.exportAll(),
      documents: [],
      knowledgeSummaries: aggregation.knowledgeSummaries,
      vectorSummaries: aggregation.vectorSummaries,
      response,
      timingNotes: aggregation.notes,
    });
  }

  return {
    scenario,
    jobId,
    events,
    timingNotes: aggregation.notes,
    response,
    documents: [],
    knowledgeSummaries: aggregation.knowledgeSummaries,
    vectorSummaries: aggregation.vectorSummaries,
    runPaths,
    layout,
    artifactDir,
  };
}

/**
 * Aggregates the knowledge graph snapshots and vector indexes produced by the
 * search scenarios (S01 → S09). Missing artefacts are reported via notes so the
 * final report can highlight potential coverage gaps when reviewing S10.
 */
async function aggregateKnowledgeAndVectors(args: {
  readonly layout: ValidationRunLayout;
}): Promise<RagAggregationResult> {
  const knowledgeGraph = new KnowledgeGraph();
  const tripleMap = new Map<string, { snapshot: KnowledgeTripleSnapshot; scenarios: Set<string> }>();
  const knowledgeSummaries = new Map<
    string,
    {
      tripleCount: number;
      scenarios: Set<string>;
    }
  >();

  const vectorIndexRecords: AggregatedVectorRecord[] = [];
  const vectorSummaries: VectorChunkSummary[] = [];
  const vectorIdMap = new Map<string, string>();

  const aggregatedScenarios: string[] = [];
  const missingScenarios: string[] = [];
  const notes: string[] = [];

  for (const scenario of VALIDATION_SCENARIOS) {
    if (scenario.id >= 10) {
      continue;
    }

    const slug = formatScenarioSlug(scenario);
    const artifactDir = path.join(args.layout.artifactsDir, slug);

    const knowledgePath = path.join(artifactDir, "knowledge_graph.json");
    const knowledgeRaw = await readJsonFileSafe(knowledgePath);

    const vectorIndexPath = path.join(artifactDir, "vector_index", "index.json");
    const vectorRaw = await readJsonFileSafe(vectorIndexPath);

    const vectorChunksPath = path.join(artifactDir, "vector_chunks.json");
    const vectorChunksRaw = await readJsonFileSafe(vectorChunksPath);

    const hasKnowledge = Array.isArray(knowledgeRaw) && knowledgeRaw.length > 0;
    const hasVectors = Array.isArray(vectorRaw) && vectorRaw.length > 0;

    if (!hasKnowledge && !hasVectors) {
      missingScenarios.push(slug);
      notes.push(`Aucun artefact agrégable trouvé pour ${slug}.`);
      continue;
    }

    aggregatedScenarios.push(slug);

    if (!hasKnowledge) {
      notes.push(`knowledge_graph.json manquant pour ${slug}.`);
    } else {
      for (const entry of knowledgeRaw as ReadonlyArray<Record<string, unknown>>) {
        const snapshot = normaliseKnowledgeSnapshot(entry, slug);
        if (!snapshot) {
          notes.push(`Triple invalide ignoré dans ${slug}.`);
          continue;
        }
        const key = `${snapshot.subject}||${snapshot.predicate}||${snapshot.object}`;
        const existing = tripleMap.get(key);
        if (existing) {
          existing.scenarios.add(slug);
          existing.snapshot.confidence = Math.max(existing.snapshot.confidence, snapshot.confidence);
          existing.snapshot.updatedAt = Math.max(existing.snapshot.updatedAt, snapshot.updatedAt);
          existing.snapshot.revision = Math.max(existing.snapshot.revision, snapshot.revision);
          existing.snapshot.provenance = mergeProvenance(existing.snapshot.provenance, snapshot.provenance);
        } else {
          tripleMap.set(key, { snapshot, scenarios: new Set([slug]) });
        }

        const summary = knowledgeSummaries.get(snapshot.subject);
        if (summary) {
          summary.tripleCount += 1;
          summary.scenarios.add(slug);
        } else {
          knowledgeSummaries.set(snapshot.subject, { tripleCount: 1, scenarios: new Set([slug]) });
        }
      }
    }

    if (!hasVectors) {
      notes.push(`vector_index/index.json manquant pour ${slug}.`);
    } else {
      for (const entry of vectorRaw as ReadonlyArray<Record<string, unknown>>) {
        const record = normaliseVectorRecord(entry, slug);
        if (!record) {
          notes.push(`Entrée de vecteur invalide ignorée dans ${slug}.`);
          continue;
        }
        vectorIndexRecords.push(record);
        vectorIdMap.set(entry.id as string, record.id);
      }
    }

    if (Array.isArray(vectorChunksRaw)) {
      for (const chunk of vectorChunksRaw as ReadonlyArray<Record<string, unknown>>) {
        const summary = normaliseVectorSummary(chunk, slug, vectorIdMap);
        if (!summary) {
          notes.push(`vector_chunks.json contient une entrée invalide pour ${slug}.`);
          continue;
        }
        vectorSummaries.push(summary);
      }
    } else if (hasVectors) {
      notes.push(`vector_chunks.json manquant ou vide pour ${slug}.`);
    }
  }

  const orderedTriples: KnowledgeTripleSnapshot[] = [];
  let ordinal = 0;
  for (const entry of tripleMap.values()) {
    ordinal += 1;
    const snapshot = {
      ...entry.snapshot,
      ordinal,
    } satisfies KnowledgeTripleSnapshot;
    orderedTriples.push(snapshot);
  }
  knowledgeGraph.restore(orderedTriples);

  const aggregatedKnowledgeSummaries: KnowledgeGraphDocumentSummary[] = [];
  for (const [subject, summary] of knowledgeSummaries) {
    aggregatedKnowledgeSummaries.push({
      subject,
      tripleCount: summary.tripleCount,
      created: summary.tripleCount,
      updated: 0,
      mentions: Array.from(summary.scenarios).sort(),
    });
  }

  return {
    knowledgeGraph,
    knowledgeSummaries: aggregatedKnowledgeSummaries.sort((a, b) => a.subject.localeCompare(b.subject)),
    vectorSummaries,
    vectorIndexRecords,
    aggregatedScenarios,
    missingScenarios,
    notes,
    knowledgeSubjects: aggregatedKnowledgeSummaries.length,
  };
}

/** Builds the structured response stored in `response.json` for scenario S10. */
function buildRagScenarioResponse(args: {
  readonly scenario: ValidationScenarioDefinition;
  readonly jobId: string;
  readonly assist: KnowledgeAssistResult;
  readonly aggregation: RagAggregationResult;
  readonly tookMs: number;
  readonly query: string;
  readonly domainTags: readonly string[];
}): Record<string, unknown> {
  const { scenario, jobId, assist, aggregation, tookMs, query, domainTags } = args;
  return {
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    jobId,
    mode: "rag_quality",
    query,
    domainTags,
    answer: assist.answer,
    citations: assist.citations,
    rationale: assist.rationale,
    coverage: assist.coverage,
    knowledgeEvidence: assist.knowledge_evidence,
    ragEvidence: assist.rag_evidence,
    stats: {
      aggregatedScenarios: aggregation.aggregatedScenarios,
      missingScenarios: aggregation.missingScenarios,
      knowledgeSubjects: aggregation.knowledgeSubjects,
      knowledgeTriples: aggregation.knowledgeGraph.exportAll().length,
      vectorDocuments: aggregation.vectorIndexRecords.length,
      tookMs,
      knowledgeHits: assist.coverage.knowledge_hits,
      ragHits: assist.coverage.rag_hits,
    },
    notes: aggregation.notes,
  };
}

/** Converts aggregation diagnostics into structured error entries. */
function buildRagScenarioErrors(
  aggregation: RagAggregationResult,
  assist: KnowledgeAssistResult,
): ScenarioErrorEntry[] {
  const errors: ScenarioErrorEntry[] = [];
  for (const scenario of aggregation.missingScenarios) {
    errors.push({
      category: "missing_artifact",
      message: `Aucun artefact agrégé pour ${scenario}.`,
    });
  }
  if (assist.citations.length === 0) {
    errors.push({
      category: "missing_citations",
      message: "La réponse générée n'inclut aucune citation.",
    });
  }
  return errors;
}

/** Extracts the RAG scenario parameters from the canonical input payload. */
function normaliseRagScenarioInput(raw: unknown): {
  readonly query: string;
  readonly limit: number;
  readonly domainTags: readonly string[];
  readonly context?: string;
} {
  if (!isPlainObject(raw)) {
    return { query: "Synthétise les points clés du dernier rapport RAG ingéré", limit: 4, domainTags: [] };
  }
  const query = typeof raw.query === "string" && raw.query.trim().length > 0
    ? raw.query.trim()
    : "Synthétise les points clés du dernier rapport RAG ingéré";
  const limit = Number.isFinite(raw.limit) && Number(raw.limit) > 0 ? Math.min(6, Math.floor(Number(raw.limit))) : 4;
  const domainTags = Array.isArray(raw.categories)
    ? raw.categories
        .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
        .filter((item) => item.length > 0)
    : [];
  const context = typeof raw.context === "string" && raw.context.trim().length > 0 ? raw.context.trim() : undefined;
  return context ? { query, limit, domainTags, context } : { query, limit, domainTags };
}

/** Reads and parses a JSON file, returning `undefined` when missing. */
async function readJsonFileSafe(targetPath: string): Promise<unknown | undefined> {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Validates a knowledge graph snapshot loaded from disk. */
function normaliseKnowledgeSnapshot(
  entry: Record<string, unknown>,
  slug: string,
): KnowledgeTripleSnapshot | null {
  const subject = typeof entry.subject === "string" ? entry.subject.trim() : "";
  const predicate = typeof entry.predicate === "string" ? entry.predicate.trim() : "";
  const object = typeof entry.object === "string" ? entry.object.trim() : "";
  if (!subject || !predicate || !object) {
    return null;
  }

  const id = typeof entry.id === "string" && entry.id.trim().length > 0 ? `${slug}:${entry.id}` : `${slug}:${randomBytes(4).toString("hex")}`;
  const confidence = Number.isFinite(entry.confidence) ? Math.max(0, Math.min(1, Number(entry.confidence))) : 0;
  const insertedAt = Number.isFinite(entry.insertedAt) ? Number(entry.insertedAt) : Date.now();
  const updatedAt = Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : insertedAt;
  const revision = Number.isFinite(entry.revision) ? Math.max(0, Math.floor(Number(entry.revision))) : 0;
  const scenarioProvenance: Provenance = { sourceId: `validation:${slug}`, type: "kg" };
  const provenance = mergeProvenance(
    Array.isArray(entry.provenance) ? (entry.provenance as Provenance[]) : [],
    [scenarioProvenance],
  );

  return {
    id,
    subject,
    predicate,
    object,
    source: typeof entry.source === "string" ? entry.source : null,
    confidence,
    provenance,
    insertedAt,
    updatedAt,
    revision,
    ordinal: 0,
  };
}

/** Validates and normalises a vector index entry. */
function normaliseVectorRecord(entry: Record<string, unknown>, slug: string): AggregatedVectorRecord | null {
  const id = typeof entry.id === "string" && entry.id.trim().length > 0 ? `${slug}:${entry.id}` : null;
  const text = typeof entry.text === "string" ? entry.text : null;
  if (!id || !text) {
    return null;
  }
  const tags = Array.isArray(entry.tags)
    ? normaliseStringArray(entry.tags, slug)
    : [`scenario:${slug}`];
  const metadata = isPlainObject(entry.metadata)
    ? { ...(entry.metadata as Record<string, unknown>), validationScenario: slug }
    : { validationScenario: slug };
  const scenarioProvenance: Provenance = { sourceId: `validation:${slug}`, type: "kg" };
  const provenance = Array.isArray(entry.provenance)
    ? mergeProvenance(entry.provenance as Provenance[], [scenarioProvenance])
    : [scenarioProvenance];
  const createdAt = Number.isFinite(entry.created_at) ? Number(entry.created_at) : Date.now();
  const updatedAt = Number.isFinite(entry.updated_at) ? Number(entry.updated_at) : createdAt;
  const embedding = isPlainObject(entry.embedding) ? (entry.embedding as Record<string, number>) : {};
  const norm = Number.isFinite(entry.norm) ? Number(entry.norm) : 0;
  const tokenCount = Number.isFinite(entry.token_count) ? Number(entry.token_count) : Math.max(1, text.split(/\s+/).length);

  return {
    id,
    text,
    tags,
    metadata,
    provenance,
    created_at: createdAt,
    updated_at: updatedAt,
    embedding,
    norm,
    token_count: tokenCount,
  };
}

/** Builds a vector summary entry aligned with {@link VectorChunkSummary}. */
function normaliseVectorSummary(
  entry: Record<string, unknown>,
  slug: string,
  idMap: Map<string, string>,
): VectorChunkSummary | null {
  const chunkIdRaw = typeof entry.chunkId === "string" ? entry.chunkId : null;
  if (!chunkIdRaw) {
    return null;
  }
  const aggregatedId = idMap.get(chunkIdRaw) ?? `${slug}:${chunkIdRaw}`;
  const tokenCount = Number.isFinite(entry.tokenCount) ? Number(entry.tokenCount) : 0;
  const segmentIds = Array.isArray(entry.segmentIds)
    ? entry.segmentIds.map((segment) => String(segment))
    : [];
  const metadata = isPlainObject(entry.metadata)
    ? { ...(entry.metadata as Record<string, unknown>), validationScenario: slug }
    : { validationScenario: slug };
  const tags = Array.isArray(entry.tags)
    ? normaliseStringArray(entry.tags, slug)
    : [`scenario:${slug}`];
  const provenance = Array.isArray(entry.provenance)
    ? (entry.provenance as Provenance[])
    : [];
  const createdAt = Number.isFinite(entry.createdAt) ? Number(entry.createdAt) : null;
  const updatedAt = Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : null;
  const textLength = Number.isFinite(entry.textLength) ? Number(entry.textLength) : 0;

  return {
    chunkId: aggregatedId,
    tokenCount,
    segmentIds,
    metadata,
    tags,
    provenance,
    createdAt,
    updatedAt,
    textLength,
  };
}

/** Simple type guard used while parsing JSON artefacts. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalises a list of tags while injecting the scenario marker. */
function normaliseStringArray(raw: ReadonlyArray<unknown>, slug: string): string[] {
  const tags = new Set<string>([`scenario:${slug}`]);
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim().toLowerCase();
    if (trimmed) {
      tags.add(trimmed);
    }
  }
  return Array.from(tags);
}

/**
 * Creates the runtime wiring required to execute a search scenario: logger,
 * event store, knowledge/vector stores and the search pipeline.
 */
async function createSearchScenarioRuntime(args: {
  readonly scenario: ValidationScenarioDefinition;
  readonly layout: ValidationRunLayout;
  readonly runPaths: ScenarioRunPaths;
  readonly overrides?: SearchScenarioDependencyOverrides;
}): Promise<SearchScenarioRuntime> {
  const { layout, runPaths, overrides } = args;
  const logger = overrides?.logger ?? new StructuredLogger();
  const eventStore = overrides?.eventStore ?? new EventStore({
    maxHistory: overrides?.eventHistoryLimit ?? DEFAULT_EVENT_HISTORY,
    logger,
  });

  const knowledgeGraph = overrides?.knowledgeGraph ?? new KnowledgeGraph();
  const artifactDir = path.join(layout.artifactsDir, path.basename(runPaths.root));
  await ensureDirectory(artifactDir);

  const vectorMemory = overrides?.vectorMemory ?? (await LocalVectorMemory.create({
    directory: path.join(artifactDir, "vector_index"),
  }));

  const metrics = overrides?.metrics ?? new SearchMetricsRecorder();
  const config = overrides?.config ?? loadSearchConfig();
  const searxClient = overrides?.searxClient ?? new SearxClient(config);
  const downloader = overrides?.downloader ?? new SearchDownloader(config.fetch);
  const extractor = overrides?.extractor ?? new UnstructuredExtractor(config);

  const knowledgeIngestor = new CapturingKnowledgeGraphIngestor({ graph: knowledgeGraph });
  const vectorIngestor = new CapturingVectorStoreIngestor({
    memory: vectorMemory,
    ...(overrides?.vectorEmbed ? { embed: overrides.vectorEmbed } : {}),
    ...(overrides?.vectorMaxTokensPerChunk
      ? { maxTokensPerChunk: overrides.vectorMaxTokensPerChunk }
      : {}),
  });

  const pipeline = new SearchPipeline({
    config,
    searxClient,
    downloader,
    extractor,
    knowledgeIngestor,
    vectorIngestor,
    eventStore,
    logger,
    metrics,
  });

  return {
    layout,
    pipeline,
    eventStore,
    logger,
    knowledgeGraph,
    vectorMemory,
    metrics,
    knowledgeCaptures: knowledgeIngestor.captures,
    vectorCaptures: vectorIngestor.captures,
    artifactDir,
  };
}

/** Generates a deterministic job identifier when callers do not provide one. */
function normaliseJobId(value: string | undefined, scenario: ValidationScenarioDefinition): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed.replace(/[^a-zA-Z0-9:_-]+/g, "_");
    }
  }
  const slug = formatScenarioSlug(scenario);
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const suffix = randomBytes(4).toString("hex");
  return `${slug}_${timestamp}_${suffix}`;
}

/** Capturing wrapper recording knowledge graph ingestions. */
class CapturingKnowledgeGraphIngestor extends KnowledgeGraphIngestor {
  public readonly captures: KnowledgeGraphIngestResult[] = [];

  constructor(dependencies: KnowledgeGraphIngestDependencies) {
    super(dependencies);
  }

  override ingest(document: Parameters<KnowledgeGraphIngestor["ingest"]>[0]): KnowledgeGraphIngestResult {
    const result = super.ingest(document);
    this.captures.push(cloneKnowledgeGraphResult(result));
    return result;
  }
}

/** Capturing wrapper recording vector ingestions. */
class CapturingVectorStoreIngestor extends VectorStoreIngestor {
  public readonly captures: VectorStoreIngestResult[] = [];

  constructor(dependencies: VectorStoreIngestDependencies) {
    super(dependencies);
  }

  override async ingest(
    document: Parameters<VectorStoreIngestor["ingest"]>[0],
  ): Promise<VectorStoreIngestResult> {
    const result = await super.ingest(document);
    this.captures.push(cloneVectorResult(result));
    return result;
  }
}

/** Deep clones the knowledge graph ingestion result to keep artefacts immutable. */
function cloneKnowledgeGraphResult(result: KnowledgeGraphIngestResult): KnowledgeGraphIngestResult {
  return {
    subject: result.subject,
    mentions: [...result.mentions],
    triples: result.triples.map((triple) => ({
      predicate: triple.predicate,
      object: triple.object,
      result: {
        created: triple.result.created,
        updated: triple.result.updated,
        snapshot: {
          ...triple.result.snapshot,
          provenance: triple.result.snapshot.provenance.map((entry) => ({ ...entry })),
        },
      },
    })),
  };
}

/** Deep clones the vector ingestion result to keep artefacts immutable. */
function cloneVectorResult(result: VectorStoreIngestResult): VectorStoreIngestResult {
  return {
    chunks: result.chunks.map((chunk) => ({
      ...chunk,
      tags: [...chunk.tags],
      metadata: { ...chunk.metadata },
      provenance: chunk.provenance.map((entry) => ({ ...entry })),
    })),
    descriptors: result.descriptors.map((descriptor) => ({
      chunkId: descriptor.chunkId,
      tokenCount: descriptor.tokenCount,
      segmentIds: [...descriptor.segmentIds],
      metadata: { ...descriptor.metadata },
    })),
  };
}
