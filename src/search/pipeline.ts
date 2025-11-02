import { createHash } from "node:crypto";

import pLimit from "p-limit";

import { StructuredLogger } from "../logger.js";
import { EventStore } from "../eventStore.js";

import type { SearchConfig } from "./config.js";
import type { SearxQueryOptions, SearxQueryResponse } from "./searxClient.js";
import { SearxClient, SearxClientError } from "./searxClient.js";
import {
  SearchDownloader,
  DownloadError,
  DownloadSizeExceededError,
  RobotsNotAllowedError,
} from "./downloader.js";
import { UnstructuredExtractor, UnstructuredExtractorError } from "./extractor.js";
import { KnowledgeGraphIngestor, type KnowledgeGraphIngestResult } from "./ingest/toKnowledgeGraph.js";
import { VectorStoreIngestor, type VectorStoreIngestResult } from "./ingest/toVectorStore.js";
import { deduplicateSegments, finalizeDocId } from "./normalizer.js";
import {
  SearchMetricsRecorder,
  type SearchMetricContext,
  type SearchMetricsSnapshot,
} from "./metrics.js";
import { computeDocId } from "./downloader.js";
import type { SearxResult, StructuredDocument } from "./types.js";
import type {
  JobBudget,
  JobFailure,
  JobMeta,
  JobProgress,
  JobProvenance,
  JobRecord,
  JobStatePatch,
  JobSummary,
  JobStatus,
  SearchJobStore,
  JsonValue,
} from "./jobStore.js";

/** Dependencies required to orchestrate the search pipeline. */
export interface SearchPipelineDependencies {
  readonly config: SearchConfig;
  readonly searxClient: SearxClient;
  readonly downloader: SearchDownloader;
  readonly extractor: UnstructuredExtractor;
  readonly knowledgeIngestor?: KnowledgeGraphIngestor;
  readonly vectorIngestor?: VectorStoreIngestor;
  readonly eventStore?: EventStore;
  readonly logger?: StructuredLogger;
  readonly metrics?: SearchMetricsRecorder;
  readonly jobStore?: SearchJobStore | null;
  readonly clock?: () => number;
}

/** Parameters describing a job executed by the pipeline. */
export interface SearchJobParameters {
  readonly query: string;
  readonly categories?: readonly string[];
  readonly engines?: readonly string[];
  readonly maxResults?: number;
  readonly language?: string;
  readonly safeSearch?: 0 | 1 | 2;
  readonly jobId?: string | null;
  readonly fetchContent?: boolean;
  readonly injectGraph?: boolean;
  readonly injectVector?: boolean;
  /** Optional orchestration metadata persisted in the job store. */
  readonly jobContext?: SearchJobContext;
}

/** Summary statistics returned after a job completes. */
export interface SearchJobStats {
  readonly requestedResults: number;
  readonly receivedResults: number;
  readonly fetchedDocuments: number;
  readonly structuredDocuments: number;
  readonly graphIngested: number;
  readonly vectorIngested: number;
}

/** Machine readable error surfaced during one of the pipeline stages. */
export interface SearchJobError {
  readonly stage: "search" | "fetch" | "extract" | "ingest_graph" | "ingest_vector";
  readonly url: string | null;
  readonly message: string;
  readonly code: string | null;
}

/** Result returned by {@link SearchPipeline.runSearchJob}. */
export interface SearchJobResult {
  readonly jobId: string;
  readonly query: string;
  readonly results: readonly SearxResult[];
  readonly documents: readonly StructuredDocument[];
  readonly errors: readonly SearchJobError[];
  readonly stats: SearchJobStats;
  readonly rawSearxResponse: SearxQueryResponse["raw"] | null;
  readonly metrics: SearchMetricsSnapshot | null;
}

/** Description of a document ingested directly via the indexing façade. */
export interface DirectIngestSource {
  readonly url: string;
  readonly title?: string | null;
  readonly snippet?: string | null;
  readonly engines?: readonly string[];
  readonly categories?: readonly string[];
  readonly position?: number | null;
}

/** Parameters accepted by {@link SearchPipeline.ingestDirect}. */
export interface DirectIngestParameters {
  readonly sources: readonly DirectIngestSource[];
  readonly jobId?: string | null;
  readonly label?: string | null;
  readonly injectGraph?: boolean;
  readonly injectVector?: boolean;
  /** Optional orchestration metadata persisted in the job store. */
  readonly jobContext?: SearchJobContext;
}

/** Result returned after a direct ingestion completes. */
export interface DirectIngestResult {
  readonly jobId: string;
  readonly documents: readonly StructuredDocument[];
  readonly errors: readonly SearchJobError[];
  readonly stats: SearchJobStats;
  readonly metrics: SearchMetricsSnapshot | null;
}

interface ProcessedResultSet {
  readonly documents: StructuredDocument[];
  readonly fetchedDocuments: number;
  readonly structuredDocuments: number;
  readonly graphIngested: number;
  readonly vectorIngested: number;
}

type SuccessfulFetch = {
  readonly result: SearxResult;
  readonly raw: Awaited<ReturnType<SearchDownloader["fetchUrl"]>>;
};

type SuccessfulExtraction = {
  readonly result: SearxResult;
  readonly document: StructuredDocument;
};

type PipelinePhase = "fetch" | "extract" | "ingest";

interface PhaseProgressPayload {
  readonly success: number;
  readonly total: number;
}

interface StageDurations {
  readonly totalMs: number;
  readonly searxMs: number;
  readonly fetchSamples: readonly number[];
  readonly extractSamples: readonly number[];
  readonly graphSamples: readonly number[];
  readonly vectorSamples: readonly number[];
}

interface FinaliseJobInput {
  readonly status: "completed";
  readonly query: string;
  readonly stats: SearchJobStats;
  readonly errors: readonly SearchJobError[];
  readonly errorTimestamps: readonly number[];
  readonly artifacts: ReadonlySet<string>;
  readonly jobContext: SearchJobContext;
  readonly durations: StageDurations;
}

interface FailJobInput {
  readonly errors: readonly SearchJobError[];
  readonly errorTimestamps: readonly number[];
  readonly artifacts: ReadonlySet<string>;
  readonly jobContext: SearchJobContext;
  readonly durations: StageDurations;
}

/**
 * Optional provenance hints describing how the job reached the orchestrator.
 * Callers may omit most fields; sensible defaults keep persistence payloads
 * consistent even when transports do not provide exhaustive metadata.
 */
export interface SearchJobProvenanceInput {
  readonly trigger?: string;
  readonly transport?: string;
  readonly requestId?: string | null;
  readonly requester?: string | null;
  readonly remoteAddress?: string | null;
  readonly extra?: Readonly<Record<string, JsonValue>>;
}

/**
 * Context propagated alongside {@link SearchJobParameters} so the pipeline can
 * persist durable job metadata. Keeping the structure narrow avoids leaking
 * transport-specific objects while giving operators enough information to
 * diagnose and replay runs.
 */
export interface SearchJobContext {
  readonly createdAt?: number;
  readonly tags?: readonly string[];
  readonly requester?: string | null;
  readonly budget?: Partial<JobBudget>;
  readonly provenance?: SearchJobProvenanceInput;
  readonly artifacts?: readonly string[];
  readonly notes?: string | null;
  readonly extra?: Readonly<Record<string, JsonValue>>;
  readonly idempotencyKey?: string | null;
}

/**
 * Orchestrates the end-to-end search flow (Searx query → download → extraction
 * → normalisation → ingestion). Errors are surfaced as structured entries in
 * the result while the job continues processing remaining documents.
 */
/** Convenience alias describing the limiter returned by `p-limit`. */
type Limit = ReturnType<typeof pLimit>;

export class SearchPipeline {
  private readonly config: SearchConfig;
  private readonly searxClient: SearxClient;
  private readonly downloader: SearchDownloader;
  private readonly extractor: UnstructuredExtractor;
  private readonly knowledgeIngestor: KnowledgeGraphIngestor | null;
  private readonly vectorIngestor: VectorStoreIngestor | null;
  private readonly eventStore: EventStore | null;
  private readonly logger: StructuredLogger | null;
  private readonly metrics: SearchMetricsRecorder | null;
  private readonly jobStore: SearchJobStore | null;
  private readonly clock: () => number;
  private readonly fetchLimiter: Limit;
  private readonly extractLimiter: Limit;

  constructor(dependencies: SearchPipelineDependencies) {
    this.config = dependencies.config;
    this.searxClient = dependencies.searxClient;
    this.downloader = dependencies.downloader;
    this.extractor = dependencies.extractor;
    this.knowledgeIngestor = dependencies.knowledgeIngestor ?? null;
    this.vectorIngestor = dependencies.vectorIngestor ?? null;
    this.eventStore = dependencies.eventStore ?? null;
    this.logger = dependencies.logger ?? null;
    this.metrics = dependencies.metrics ?? null;
    this.jobStore = dependencies.jobStore ?? null;
    this.clock = dependencies.clock ?? (() => Date.now());
    this.fetchLimiter = pLimit(Math.max(1, Math.floor(this.config.fetch.parallelism)));
    this.extractLimiter = pLimit(Math.max(1, Math.floor(this.config.pipeline.parallelExtract)));
  }

  /** Returns the monotonic clock used for job timestamps. */
  private now(): number {
    return this.clock();
  }

  /** Executes the full search job and returns structured results. */
  async runSearchJob(parameters: SearchJobParameters): Promise<SearchJobResult> {
    const invocationStartedAt = this.now();
    const query = parameters.query.trim();
    const maxResults = normaliseMaxResults(parameters.maxResults, this.config.pipeline.maxResults);
    const effectiveCategories = normaliseList(parameters.categories, this.config.searx.categories);
    const effectiveEngines = normaliseList(parameters.engines, this.config.searx.engines);
    const fetchContent = parameters.fetchContent ?? true;
    const injectGraph = parameters.injectGraph ?? this.config.pipeline.injectGraph;
    const injectVector = parameters.injectVector ?? this.config.pipeline.injectVector;
    const fingerprint = computeSearchJobFingerprint({
      query,
      categories: effectiveCategories,
      engines: effectiveEngines,
      maxResults,
      fetchContent,
      injectGraph,
      injectVector,
      language: parameters.language ?? null,
      safeSearch: parameters.safeSearch ?? null,
    });
    const jobId = resolveJobId(parameters.jobId, fingerprint);

    const jobContext = parameters.jobContext ?? {};
    const jobMeta = this.buildJobMeta({
      id: jobId,
      query,
      normalizedQuery: normaliseJobQuery(query),
      createdAt: jobContext.createdAt ?? invocationStartedAt,
      tags: jobContext.tags ?? [],
      requester: jobContext.requester ?? null,
      ...(jobContext.budget ? { budget: jobContext.budget } : {}),
      ...(jobContext.provenance ? { provenance: jobContext.provenance } : {}),
      ...(jobContext.extra ? { extra: jobContext.extra } : {}),
      idempotencyKey: jobContext.idempotencyKey ?? null,
      options: {
        categories: effectiveCategories,
        engines: effectiveEngines,
        maxResults,
        fetchContent,
        injectGraph,
        injectVector,
        language: parameters.language ?? null,
        safeSearch: parameters.safeSearch ?? null,
      },
    });

    const registration = await this.registerJob(jobId, jobMeta);
    const storeWritable = registration.canMutate;

    const artifacts = new Set<string>(sanitiseArtifacts(jobContext.artifacts));
    const errors: SearchJobError[] = [];
    const errorTimestamps: number[] = [];
    const recordError = (failure: SearchJobError): void => {
      errors.push(failure);
      errorTimestamps.push(this.now());
    };

    const fetchDurations: number[] = [];
    const extractDurations: number[] = [];
    const graphDurations: number[] = [];
    const vectorDurations: number[] = [];
    let searxDuration = 0;

    if (storeWritable) {
      const progress = this.buildProgress("initialising", "initialising search pipeline", 0);
      await this.safeUpdateJob(
        jobId,
        {
          status: "running",
          startedAt: progress.updatedAt,
          updatedAt: progress.updatedAt,
          progress,
        },
        "initialising",
      );
      this.emitJobProgress(jobId, progress);
    }

    this.emitJobStarted(jobId, {
      query,
      categories: effectiveCategories,
      engines: effectiveEngines,
      maxResults,
      fetchContent,
      injectGraph,
      injectVector,
    });

    const queryOptions: SearxQueryOptions = {
      categories: effectiveCategories,
      engines: effectiveEngines,
      count: maxResults,
      ...(parameters.language ? { language: parameters.language } : {}),
      ...(parameters.safeSearch !== undefined ? { safeSearch: parameters.safeSearch } : {}),
    };

    let uniqueResults: SearxResult[] = [];
    let processingOutcome: ProcessedResultSet = {
      documents: [],
      fetchedDocuments: 0,
      structuredDocuments: 0,
      graphIngested: 0,
      vectorIngested: 0,
    };
    let rawSearxResponse: SearxQueryResponse["raw"] | null = null;

    try {
      const searxStartedAt = this.now();
      const searchResponse = await this.executeWithMetrics(
        "searxQuery",
        () => this.searxClient.search(query, queryOptions),
        (error) => (error instanceof SearxClientError ? error.code : null),
        { domain: deriveDomain(this.config.searx.baseUrl), contentType: "application/json" },
      ).catch((error) => {
        const failure = buildError("search", null, error);
        recordError(failure);
        this.emitError(jobId, failure);
        this.logger?.error("search_query_failed", {
          job_id: jobId,
          message: failure.message,
          code: failure.code,
        });
        return null;
      });
      searxDuration = this.now() - searxStartedAt;

      if (!searchResponse) {
        const stats: SearchJobStats = {
          requestedResults: maxResults,
          receivedResults: 0,
          fetchedDocuments: 0,
          structuredDocuments: 0,
          graphIngested: 0,
          vectorIngested: 0,
        };
        if (storeWritable) {
          await this.finaliseJob(jobId, {
            status: "completed",
            query,
            stats,
            errors,
            errorTimestamps,
            artifacts,
            jobContext,
            durations: this.collectDurations(
              invocationStartedAt,
              searxDuration,
              fetchDurations,
              extractDurations,
              graphDurations,
              vectorDurations,
            ),
          });
        }
        this.emitJobCompleted(jobId, query, stats, errors.length);
        return {
          jobId,
          query,
          results: [],
          documents: [],
          errors,
          stats,
          rawSearxResponse: null,
          metrics: this.metrics ? this.metrics.snapshot() : null,
        };
      }

      rawSearxResponse = searchResponse.raw;
      uniqueResults = deduplicateByUrl(searchResponse.results).slice(0, maxResults);

      if (storeWritable) {
        const progress = this.buildProgress(
          "search",
          uniqueResults.length > 0
            ? `received ${uniqueResults.length} candidates`
            : "no results received",
          uniqueResults.length > 0 ? 0.25 : 0.5,
        );
        await this.safeUpdateJob(jobId, { updatedAt: progress.updatedAt, progress }, "after-search");
        this.emitJobProgress(jobId, progress);
      }

      if (!fetchContent || uniqueResults.length === 0) {
        const stats: SearchJobStats = {
          requestedResults: maxResults,
          receivedResults: uniqueResults.length,
          fetchedDocuments: 0,
          structuredDocuments: 0,
          graphIngested: 0,
          vectorIngested: 0,
        };
        if (storeWritable) {
          await this.finaliseJob(jobId, {
            status: "completed",
            query,
            stats,
            errors,
            errorTimestamps,
            artifacts,
            jobContext,
            durations: this.collectDurations(
              invocationStartedAt,
              searxDuration,
              fetchDurations,
              extractDurations,
              graphDurations,
              vectorDurations,
            ),
          });
        }
        this.emitJobCompleted(jobId, query, stats, errors.length);
        return {
          jobId,
          query,
          results: uniqueResults,
          documents: [],
          errors,
          stats,
          rawSearxResponse,
          metrics: this.metrics ? this.metrics.snapshot() : null,
        };
      }

      processingOutcome = await this.processResultSet(jobId, query, uniqueResults, {
        injectGraph,
        injectVector,
        recordError,
        recordFetchDuration: (duration) => fetchDurations.push(duration),
        recordExtractDuration: (duration) => extractDurations.push(duration),
        recordGraphDuration: (duration) => graphDurations.push(duration),
        recordVectorDuration: (duration) => vectorDurations.push(duration),
        onPhaseCompleted: async (phase, payload) => {
          if (!storeWritable) {
            return;
          }
          const progress = this.progressForPhase(phase, payload);
          if (!progress) {
            return;
          }
          await this.safeUpdateJob(jobId, { updatedAt: progress.updatedAt, progress }, `phase-${phase}`);
          this.emitJobProgress(jobId, progress);
        },
      });

      const stats: SearchJobStats = {
        requestedResults: maxResults,
        receivedResults: uniqueResults.length,
        fetchedDocuments: processingOutcome.fetchedDocuments,
        structuredDocuments: processingOutcome.structuredDocuments,
        graphIngested: processingOutcome.graphIngested,
        vectorIngested: processingOutcome.vectorIngested,
      };

      if (storeWritable) {
        await this.finaliseJob(jobId, {
          status: "completed",
          query,
          stats,
          errors,
          errorTimestamps,
          artifacts,
          jobContext,
          durations: this.collectDurations(
            invocationStartedAt,
            searxDuration,
            fetchDurations,
            extractDurations,
            graphDurations,
            vectorDurations,
          ),
        });
      }

      this.emitJobCompleted(jobId, query, stats, errors.length);

      return {
        jobId,
        query,
        results: uniqueResults,
        documents: processingOutcome.documents,
        errors,
        stats,
        rawSearxResponse,
        metrics: this.metrics ? this.metrics.snapshot() : null,
      };
    } catch (error) {
      if (storeWritable) {
        await this.failJob(jobId, {
          errors,
          errorTimestamps,
          artifacts,
          jobContext,
          durations: this.collectDurations(
            invocationStartedAt,
            searxDuration,
            fetchDurations,
            extractDurations,
            graphDurations,
            vectorDurations,
          ),
        });
      }
      throw error;
    }
  }
  /**
   * Performs a direct ingestion of explicit URLs without relying on SearxNG.
   * The method reuses the same fetching/extraction/ingestion pipeline to
   * guarantee observability and provenance remain consistent with standard
   * search jobs.
   */
  async ingestDirect(parameters: DirectIngestParameters): Promise<DirectIngestResult> {
    const injectGraph = parameters.injectGraph ?? this.config.pipeline.injectGraph;
    const injectVector = parameters.injectVector ?? this.config.pipeline.injectVector;
    const label = normaliseDirectLabel(parameters.label);
    const jobId = resolveJobId(
      parameters.jobId,
      computeDirectIngestFingerprint({
        sources: parameters.sources ?? [],
        label,
        injectGraph,
        injectVector,
      }),
    );

    const errors: SearchJobError[] = [];
    const sources = parameters.sources ?? [];
    const syntheticResults = deduplicateByUrl(
      sources.map((source, index) => buildSyntheticResult(source, index)),
    );

    const aggregatedCategories = collectDistinct(syntheticResults.map((result) => result.categories));
    const aggregatedEngines = collectDistinct(syntheticResults.map((result) => result.engines));

    this.emitJobStarted(jobId, {
      query: label,
      categories: aggregatedCategories,
      engines: aggregatedEngines,
      maxResults: sources.length,
      fetchContent: true,
      injectGraph,
      injectVector,
    });

    let processingOutcome: ProcessedResultSet = {
      documents: [],
      fetchedDocuments: 0,
      structuredDocuments: 0,
      graphIngested: 0,
      vectorIngested: 0,
    };

    if (syntheticResults.length > 0) {
      processingOutcome = await this.processResultSet(jobId, label, syntheticResults, {
        injectGraph,
        injectVector,
        recordError: (failure) => errors.push(failure),
      });
    }

    const stats: SearchJobStats = {
      requestedResults: sources.length,
      receivedResults: syntheticResults.length,
      fetchedDocuments: processingOutcome.fetchedDocuments,
      structuredDocuments: processingOutcome.structuredDocuments,
      graphIngested: processingOutcome.graphIngested,
      vectorIngested: processingOutcome.vectorIngested,
    };

    this.emitJobCompleted(jobId, label, stats, errors.length);

    return {
      jobId,
      documents: processingOutcome.documents,
      errors,
      stats,
      metrics: this.metrics ? this.metrics.snapshot() : null,
    };
  }

  private async processResultSet(
    jobId: string,
    query: string,
    results: readonly SearxResult[],
    options: {
      injectGraph: boolean;
      injectVector: boolean;
      recordError: (failure: SearchJobError) => void;
      recordFetchDuration?: (duration: number) => void;
      recordExtractDuration?: (duration: number) => void;
      recordGraphDuration?: (duration: number) => void;
      recordVectorDuration?: (duration: number) => void;
      onPhaseCompleted?: (phase: PipelinePhase, payload: PhaseProgressPayload) => Promise<void> | void;
    },
  ): Promise<ProcessedResultSet> {
    if (results.length === 0) {
      return { documents: [], fetchedDocuments: 0, structuredDocuments: 0, graphIngested: 0, vectorIngested: 0 };
    }

    let structuredDocuments = 0;
    let graphIngested = 0;
    let vectorIngested = 0;
    const documents: StructuredDocument[] = [];

    const fetchOutcomes: Array<SuccessfulFetch | null> = await Promise.all(
      results.map((result) =>
        this.fetchLimiter(async () => {
          const startedAt = this.now();
          try {
            const raw = await this.executeWithMetrics(
              "fetchUrl",
              () => this.downloader.fetchUrl(result.url),
              (error) => {
                if (error instanceof DownloadError) {
                  return error.name;
                }
                return error instanceof Error ? error.name : null;
              },
              (outcome) => {
                if (outcome.ok) {
                  return {
                    domain: deriveDomain(outcome.value.finalUrl) ?? deriveDomain(result.url),
                    contentType: outcome.value.contentType ?? result.mime,
                  };
                }
                return {
                  domain: deriveDomain(result.url),
                  contentType: result.mime,
                };
              },
            );
            options.recordFetchDuration?.(this.now() - startedAt);
            return { result, raw } as const;
          } catch (error) {
            const failure = buildError("fetch", result.url, error);
            options.recordError(failure);
            options.recordFetchDuration?.(this.now() - startedAt);
            this.emitError(jobId, failure);
            this.logger?.warn("search_fetch_failed", {
              job_id: jobId,
              url: result.url,
              message: failure.message,
              code: failure.code,
            });
            return null;
          }
        }),
      ),
    );

    const successfulFetches = fetchOutcomes.filter((entry): entry is SuccessfulFetch => entry !== null);
    const fetchedDocuments = successfulFetches.length;

    if (options.onPhaseCompleted) {
      await Promise.resolve(options.onPhaseCompleted("fetch", { success: fetchedDocuments, total: results.length }));
    }

    const extractionInputs = successfulFetches.map((entry) => ({
      result: entry.result,
      raw: entry.raw,
      docId: computeDocId(entry.raw.finalUrl, entry.raw.headers, entry.raw.body),
    }));

    const extractionOutcomes: Array<SuccessfulExtraction | null> = await Promise.all(
      extractionInputs.map((input) =>
        this.extractLimiter(async () => {
          const startedAt = this.now();
          try {
            const structured = await this.executeWithMetrics(
              "extractWithUnstructured",
              () =>
                this.extractor.extract({
                  docId: input.docId,
                  raw: input.raw,
                  provenance: {
                    query,
                    engines: input.result.engines,
                    categories: input.result.categories,
                    position: input.result.position,
                    sourceUrl: input.result.url,
                    titleHint: input.result.title,
                    snippetHint: input.result.snippet,
                  },
                }),
              (error) => (error instanceof UnstructuredExtractorError ? error.code : null),
              (outcome) => {
                if (outcome.ok) {
                  return {
                    domain: deriveDomain(outcome.value.url) ?? deriveDomain(input.raw.finalUrl),
                    contentType:
                      outcome.value.mimeType ?? input.raw.contentType ?? input.result.mime ?? null,
                  };
                }
                return {
                  domain: deriveDomain(input.raw.finalUrl),
                  contentType: input.raw.contentType ?? input.result.mime ?? null,
                };
              },
            );
            const deduped = deduplicateSegments(structured);
            const finalDocument = finalizeDocId(deduped, input.docId);
            options.recordExtractDuration?.(this.now() - startedAt);
            return { result: input.result, document: finalDocument } as const;
          } catch (error) {
            const failure = buildError("extract", input.raw.finalUrl, error);
            options.recordError(failure);
            options.recordExtractDuration?.(this.now() - startedAt);
            this.emitError(jobId, failure);
            this.logger?.error("search_extract_failed", {
              job_id: jobId,
              url: input.raw.finalUrl,
              message: failure.message,
              code: failure.code,
            });
            return null;
          }
        }),
      ),
    );

    const successfulExtractions = extractionOutcomes.filter((entry): entry is SuccessfulExtraction => entry !== null);
    structuredDocuments = successfulExtractions.length;

    if (options.onPhaseCompleted) {
      await Promise.resolve(
        options.onPhaseCompleted("extract", {
          success: structuredDocuments,
          total: successfulFetches.length,
        }),
      );
    }

    for (const outcome of successfulExtractions) {
      const { document, result } = outcome;
      const docErrors: SearchJobError[] = [];

      let graphResult: KnowledgeGraphIngestResult | null = null;
      if (options.injectGraph) {
        if (this.knowledgeIngestor) {
          const startedAt = this.now();
          try {
            graphResult = await this.executeWithMetrics(
              "ingestGraph",
              async () => this.knowledgeIngestor!.ingest(document),
              (error) => (error instanceof Error ? error.name : null),
              { domain: deriveDomain(document.url), contentType: document.mimeType },
            );
            graphIngested += 1;
            options.recordGraphDuration?.(this.now() - startedAt);
          } catch (error) {
            const failure = buildError("ingest_graph", document.url, error);
            options.recordError(failure);
            options.recordGraphDuration?.(this.now() - startedAt);
            docErrors.push(failure);
            this.emitError(jobId, failure);
            this.logger?.error("search_graph_ingest_failed", {
              job_id: jobId,
              url: document.url,
              message: failure.message,
              code: failure.code,
            });
          }
        } else {
          this.logger?.warn("search_graph_ingest_skipped", {
            job_id: jobId,
            url: document.url,
            reason: "missing_knowledge_ingestor",
          });
        }
      }

      let vectorResult: VectorStoreIngestResult | null = null;
      if (options.injectVector) {
        if (this.vectorIngestor) {
          const startedAt = this.now();
          try {
            vectorResult = await this.executeWithMetrics(
              "ingestVector",
              () => this.vectorIngestor!.ingest(document),
              (error) => (error instanceof Error ? error.name : null),
              { domain: deriveDomain(document.url), contentType: document.mimeType },
            );
            vectorIngested += 1;
            options.recordVectorDuration?.(this.now() - startedAt);
          } catch (error) {
            const failure = buildError("ingest_vector", document.url, error);
            options.recordError(failure);
            options.recordVectorDuration?.(this.now() - startedAt);
            docErrors.push(failure);
            this.emitError(jobId, failure);
            this.logger?.error("search_vector_ingest_failed", {
              job_id: jobId,
              url: document.url,
              message: failure.message,
              code: failure.code,
            });
          }
        } else {
          this.logger?.warn("search_vector_ingest_skipped", {
            job_id: jobId,
            url: document.url,
            reason: "missing_vector_ingestor",
          });
        }
      }

      documents.push(document);

      this.emitDocumentIngested(jobId, document, {
        graphResult,
        vectorResult,
        errors: docErrors,
        searxResult: result,
      });
    }

    if (options.onPhaseCompleted) {
      await Promise.resolve(
        options.onPhaseCompleted("ingest", {
          success: documents.length,
          total: successfulExtractions.length,
        }),
      );
    }

    return { documents, fetchedDocuments, structuredDocuments, graphIngested, vectorIngested };
  }

  private async executeWithMetrics<T>(
    operation: Parameters<SearchMetricsRecorder["measure"]>[0],
    callback: () => Promise<T>,
    errorCodeResolver?: (error: unknown) => string | null,
    context?: SearchMetricContext<T>,
  ): Promise<T> {
    if (this.metrics) {
      return this.metrics.measure(operation, callback, errorCodeResolver, context);
    }
    return callback();
  }

  private emitJobCreated(jobId: string, meta: JobMeta): void {
    this.eventStore?.emit({
      kind: "search:job_created",
      jobId,
      payload: {
        query: meta.query,
        created_at: meta.createdAt,
        tags: [...meta.tags],
        requester: meta.requester,
      },
    });
    this.logger?.info("search_job_created", {
      job_id: jobId,
      requester: meta.requester,
      tags: meta.tags.length,
    });
  }

  private emitJobProgress(jobId: string, progress: JobProgress): void {
    this.eventStore?.emit({
      kind: "search:job_progress",
      jobId,
      payload: {
        step: progress.step,
        message: progress.message,
        ratio: progress.ratio,
        updated_at: progress.updatedAt,
      },
    });
    this.logger?.info("search_job_progress", {
      job_id: jobId,
      step: progress.step,
      ratio: progress.ratio,
      message: progress.message,
    });
  }

  private emitJobFailed(jobId: string, failureCount: number): void {
    this.eventStore?.emit({
      kind: "search:job_failed",
      jobId,
      payload: {
        failures: failureCount,
      },
    });
    this.logger?.error("search_job_failed", {
      job_id: jobId,
      failures: failureCount,
    });
  }

  private emitJobStarted(
    jobId: string,
    payload: {
      query: string;
      categories: readonly string[];
      engines: readonly string[];
      maxResults: number;
      fetchContent: boolean;
      injectGraph: boolean;
      injectVector: boolean;
    },
  ): void {
    this.eventStore?.emit({
      kind: "search:job_started",
      jobId,
      payload: {
        query: payload.query,
        categories: [...payload.categories],
        engines: [...payload.engines],
        max_results: payload.maxResults,
        fetch_content: payload.fetchContent,
        inject_graph: payload.injectGraph,
        inject_vector: payload.injectVector,
      },
    });
    this.logger?.info("search_job_started", {
      job_id: jobId,
      query: payload.query,
      max_results: payload.maxResults,
    });
  }

  private emitDocumentIngested(
    jobId: string,
    document: StructuredDocument,
    details: {
      graphResult: KnowledgeGraphIngestResult | null;
      vectorResult: VectorStoreIngestResult | null;
      errors: readonly SearchJobError[];
      searxResult: SearxResult;
    },
  ): void {
    // Emit a compact payload to keep the event bus lightweight. Large blobs such as
    // the extracted segments are intentionally omitted so dashboards remain fast.
    this.eventStore?.emit({
      kind: "search:doc_ingested",
      jobId,
      payload: {
        doc_id: document.id,
        url: document.url,
        title: document.title,
        language: document.language,
        checksum: document.checksum,
        size: document.size,
        fetched_at: document.fetchedAt,
        mime_type: document.mimeType,
        searx_position: details.searxResult.position,
        graph_ingested: details.graphResult !== null,
        graph_triples: details.graphResult ? details.graphResult.triples.length : 0,
        vector_ingested: details.vectorResult !== null,
        vector_chunks: details.vectorResult ? details.vectorResult.chunks.length : 0,
        error_count: details.errors.length,
      },
    });
    this.logger?.info("search_doc_ingested", {
      job_id: jobId,
      doc_id: document.id,
      graph_ingested: details.graphResult !== null,
      vector_ingested: details.vectorResult !== null,
      errors: details.errors.length,
    });
  }

  private emitJobCompleted(jobId: string, query: string, stats: SearchJobStats, errorCount: number): void {
    this.eventStore?.emit({
      kind: "search:job_completed",
      jobId,
      payload: {
        query,
        requested_results: stats.requestedResults,
        received_results: stats.receivedResults,
        fetched_documents: stats.fetchedDocuments,
        structured_documents: stats.structuredDocuments,
        graph_ingested: stats.graphIngested,
        vector_ingested: stats.vectorIngested,
        errors: errorCount,
      },
    });
    this.logger?.info("search_job_completed", {
      job_id: jobId,
      query,
      fetched: stats.fetchedDocuments,
      structured: stats.structuredDocuments,
      errors: errorCount,
    });
  }

  private emitError(jobId: string, error: SearchJobError): void {
    this.eventStore?.emit({
      kind: "search:error",
      jobId,
      level: "error",
      payload: {
        stage: error.stage,
        url: error.url,
        message: error.message,
        code: error.code,
      },
    });
  }

  private buildJobMeta(input: {
    readonly id: string;
    readonly query: string;
    readonly normalizedQuery: string;
    readonly createdAt: number;
    readonly tags: readonly string[];
    readonly requester: string | null;
    readonly budget?: Partial<JobBudget> | undefined;
    readonly provenance?: SearchJobProvenanceInput;
    readonly extra?: Readonly<Record<string, JsonValue>>;
    readonly idempotencyKey: string | null;
    readonly options: {
      readonly categories: readonly string[];
      readonly engines: readonly string[];
      readonly maxResults: number;
      readonly fetchContent: boolean;
      readonly injectGraph: boolean;
      readonly injectVector: boolean;
      readonly language: string | null;
      readonly safeSearch: number | null;
    };
  }): JobMeta {
    const tags = normaliseJobTags(input.tags);
    const budget = normaliseJobBudget(input.budget);
    const provenance = this.normaliseJobProvenance(
      input.provenance,
      input.requester,
      input.extra,
      input.idempotencyKey,
      input.options,
    );
    return {
      id: input.id,
      query: input.query,
      normalizedQuery: input.normalizedQuery,
      createdAt: input.createdAt,
      tags,
      requester: input.requester,
      budget,
      provenance,
    };
  }

  private async registerJob(jobId: string, meta: JobMeta): Promise<{ status: "skipped" | "created" | "duplicate"; canMutate: boolean; record: JobRecord | null }> {
    if (!this.jobStore) {
      return { status: "skipped", canMutate: false, record: null };
    }
    try {
      await this.jobStore.create(meta);
      this.emitJobCreated(jobId, meta);
      return { status: "created", canMutate: true, record: null };
    } catch (error) {
      if (isDuplicateJobError(error)) {
        const existing = await this.jobStore.get(jobId);
        if (existing) {
          const mutable = !isTerminalStatus(existing.state.status);
          this.logger?.info("search_job_duplicate", {
            job_id: jobId,
            status: existing.state.status,
            mutable,
          });
          return { status: "duplicate", canMutate: mutable, record: existing };
        }
        this.logger?.warn("search_job_duplicate_missing_record", { job_id: jobId });
        return { status: "duplicate", canMutate: false, record: null };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("search_job_store_create_failed", { job_id: jobId, message });
      return { status: "skipped", canMutate: false, record: null };
    }
  }

  private async safeUpdateJob(jobId: string, patch: JobStatePatch, reason: string): Promise<void> {
    if (!this.jobStore) {
      return;
    }
    try {
      await this.jobStore.update(jobId, patch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("search_job_store_update_failed", { job_id: jobId, reason, message });
    }
  }

  private collectDurations(
    startedAt: number,
    searxDuration: number,
    fetchSamples: readonly number[],
    extractSamples: readonly number[],
    graphSamples: readonly number[],
    vectorSamples: readonly number[],
  ): StageDurations {
    const totalMs = clampDuration(this.now() - startedAt);
    return {
      totalMs,
      searxMs: clampDuration(searxDuration),
      fetchSamples: [...fetchSamples],
      extractSamples: [...extractSamples],
      graphSamples: [...graphSamples],
      vectorSamples: [...vectorSamples],
    };
  }

  private buildSummary(stats: SearchJobStats, artifacts: ReadonlySet<string>, notes: string | null, durations: StageDurations): JobSummary {
    const skippedDocuments = Math.max(0, stats.receivedResults - stats.structuredDocuments);
    const metrics: Record<string, number> = {
      total_duration_ms: durations.totalMs,
      searx_duration_ms: durations.searxMs,
      graph_ingested_documents: stats.graphIngested,
      vector_ingested_documents: stats.vectorIngested,
    };

    appendPercentiles(metrics, "fetch", durations.fetchSamples);
    appendPercentiles(metrics, "extract", durations.extractSamples);
    appendPercentiles(metrics, "ingest_graph", durations.graphSamples);
    appendPercentiles(metrics, "ingest_vector", durations.vectorSamples);

    return {
      consideredResults: stats.receivedResults,
      fetchedDocuments: stats.fetchedDocuments,
      ingestedDocuments: stats.structuredDocuments,
      skippedDocuments,
      artifacts: [...artifacts].sort(),
      metrics,
      notes: normaliseNote(notes),
    };
  }

  private convertErrorsToFailures(errors: readonly SearchJobError[], timestamps: readonly number[]): JobFailure[] {
    const failures: JobFailure[] = [];
    for (let index = 0; index < errors.length; index += 1) {
      const error = errors[index];
      const timestamp = timestamps[index];
      const occurredAt = Number.isFinite(timestamp) ? Math.round(Number(timestamp)) : this.now();
      const details: Record<string, JsonValue> | null = error.url ? { url: error.url } : null;
      failures.push({
        code: error.code ?? "unknown_error",
        message: error.message,
        stage: error.stage,
        occurredAt,
        details,
      });
    }
    return failures;
  }

  private progressForPhase(phase: PipelinePhase, payload: PhaseProgressPayload): JobProgress | null {
    const total = payload.total > 0 ? payload.total : 0;
    const success = Math.max(0, payload.success);
    switch (phase) {
      case "fetch":
        return this.buildProgress(
          phase,
          total > 0 ? `downloaded ${success}/${total} documents` : "download phase completed",
          0.5,
        );
      case "extract":
        return this.buildProgress(
          phase,
          total > 0 ? `extracted ${success}/${total} documents` : "extraction phase completed",
          0.7,
        );
      case "ingest":
        return this.buildProgress(
          phase,
          total > 0 ? `ingested ${success}/${total} documents` : "ingestion phase completed",
          0.9,
        );
      default:
        return null;
    }
  }

  private buildProgress(step: string, message: string | null, ratio: number | null): JobProgress {
    const trimmedMessage = message && message.trim().length > 0 ? message.trim() : null;
    const normalisedRatio = ratio === null || ratio === undefined || !Number.isFinite(ratio)
      ? null
      : Math.min(1, Math.max(0, Number(ratio)));
    return {
      step,
      message: trimmedMessage,
      ratio: normalisedRatio,
      updatedAt: this.now(),
    };
  }

  private async finaliseJob(jobId: string, input: FinaliseJobInput): Promise<void> {
    if (!this.jobStore) {
      return;
    }
    const progress = this.buildProgress("completed", "search job completed", 1);
    const summary = this.buildSummary(input.stats, input.artifacts, input.jobContext.notes ?? null, input.durations);
    const failures = this.convertErrorsToFailures(input.errors, input.errorTimestamps);
    await this.safeUpdateJob(
      jobId,
      {
        status: input.status,
        completedAt: progress.updatedAt,
        updatedAt: progress.updatedAt,
        progress,
        summary,
        errors: failures,
      },
      input.status,
    );
    this.emitJobProgress(jobId, progress);
  }

  private async failJob(jobId: string, input: FailJobInput): Promise<void> {
    if (!this.jobStore) {
      return;
    }
    const progress = this.buildProgress("failed", "search job failed", 1);
    const summary = this.buildSummary(
      {
        requestedResults: 0,
        receivedResults: 0,
        fetchedDocuments: 0,
        structuredDocuments: 0,
        graphIngested: 0,
        vectorIngested: 0,
      },
      input.artifacts,
      input.jobContext.notes ?? null,
      input.durations,
    );
    const failures = this.convertErrorsToFailures(input.errors, input.errorTimestamps);
    await this.safeUpdateJob(
      jobId,
      {
        status: "failed",
        failedAt: progress.updatedAt,
        updatedAt: progress.updatedAt,
        progress,
        summary,
        errors: failures,
      },
      "failed",
    );
    this.emitJobProgress(jobId, progress);
    this.emitJobFailed(jobId, failures.length);
  }

  private normaliseJobProvenance(
    provenance: SearchJobProvenanceInput | undefined,
    fallbackRequester: string | null,
    extra: Readonly<Record<string, JsonValue>> | undefined,
    idempotencyKey: string | null,
    options: {
      readonly categories: readonly string[];
      readonly engines: readonly string[];
      readonly maxResults: number;
      readonly fetchContent: boolean;
      readonly injectGraph: boolean;
      readonly injectVector: boolean;
      readonly language: string | null;
      readonly safeSearch: number | null;
    },
  ): JobProvenance {
    const trigger = provenance?.trigger?.trim() || "search.run";
    const transport = provenance?.transport?.trim() || "unknown";
    const requestId = provenance?.requestId ?? null;
    const requester = provenance?.requester ?? fallbackRequester ?? null;
    const remoteAddress = provenance?.remoteAddress ?? null;
    const extraPayload: Record<string, JsonValue> = {};
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        extraPayload[key] = value;
      }
    }
    extraPayload.job_options = {
      categories: [...options.categories],
      engines: [...options.engines],
      max_results: options.maxResults,
      fetch_content: options.fetchContent,
      inject_graph: options.injectGraph,
      inject_vector: options.injectVector,
      language: options.language,
      safe_search: options.safeSearch,
    };
    if (idempotencyKey) {
      extraPayload.idempotency_key = idempotencyKey;
    }
    return {
      trigger,
      transport,
      requestId,
      requester,
      remoteAddress,
      extra: extraPayload,
    };
  }
}

function normaliseJobBudget(budget: Partial<JobBudget> | undefined): JobBudget {
  return {
    maxDurationMs: budget?.maxDurationMs ?? null,
    maxToolCalls: budget?.maxToolCalls ?? null,
    maxBytesOut: budget?.maxBytesOut ?? null,
  };
}

function normaliseJobTags(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") {
      continue;
    }
    const trimmed = tag.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}

function sanitiseArtifacts(artifacts?: readonly string[] | null): string[] {
  if (!artifacts) {
    return [];
  }
  const set = new Set<string>();
  for (const entry of artifacts) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    set.add(trimmed);
  }
  return [...set];
}

function normaliseJobQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : Math.round(value);
}

function appendPercentiles(target: Record<string, number>, prefix: string, samples: readonly number[]): void {
  if (!samples || samples.length === 0) {
    return;
  }
  const sorted = [...samples].filter((sample) => Number.isFinite(sample) && sample >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return;
  }
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  target[`${prefix}_duration_p50_ms`] = clampDuration(p50);
  target[`${prefix}_duration_p95_ms`] = clampDuration(p95);
  target[`${prefix}_duration_p99_ms`] = clampDuration(p99);
}

function percentile(sortedSamples: readonly number[], fraction: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }
  const index = Math.min(sortedSamples.length - 1, Math.max(0, Math.floor(fraction * (sortedSamples.length - 1))));
  return sortedSamples[index];
}

function normaliseNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") {
    return null;
  }
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isDuplicateJobError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /already exists/i.test(error.message);
}

function isTerminalStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed";
}

function resolveJobId(jobId: string | null | undefined, fingerprint: string): string {
  if (typeof jobId === "string") {
    const trimmed = jobId.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return `search:job:${fingerprint}`;
}

function normaliseMaxResults(maxResults: number | undefined, configuredMax: number): number {
  const upperBound = Math.min(50, Math.max(1, Math.floor(configuredMax)));
  if (typeof maxResults !== "number" || Number.isNaN(maxResults) || maxResults <= 0) {
    return upperBound;
  }
  return Math.min(upperBound, Math.floor(maxResults));
}

function normaliseList(values: readonly string[] | undefined, fallback: readonly string[]): string[] {
  if (values && values.length > 0) {
    return values.map((value) => value.trim()).filter((value) => value.length > 0);
  }
  return [...fallback];
}

function normaliseDirectLabel(label: string | null | undefined): string {
  if (typeof label === "string") {
    const trimmed = label.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "direct:index";
}

function buildSyntheticResult(source: DirectIngestSource, index: number): SearxResult {
  const title = typeof source.title === "string" ? source.title : null;
  const snippet = typeof source.snippet === "string" ? source.snippet : null;
  const engines = collectDistinct([source.engines ?? []]);
  const categories = collectDistinct([source.categories ?? []]);
  const basePosition = source.position;
  const position =
    typeof basePosition === "number" && Number.isFinite(basePosition) && basePosition >= 0
      ? Math.floor(basePosition)
      : index;
  return {
    id: `direct:${index}:${source.url}`,
    url: source.url,
    title,
    snippet,
    engines,
    categories,
    position,
    thumbnailUrl: null,
    mime: null,
    publishedAt: null,
    score: null,
  };
}

function computeSearchJobFingerprint(payload: {
  query: string;
  categories: readonly string[];
  engines: readonly string[];
  maxResults: number;
  fetchContent: boolean;
  injectGraph: boolean;
  injectVector: boolean;
  language: string | null;
  safeSearch: 0 | 1 | 2 | null;
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        query: payload.query,
        categories: [...payload.categories],
        engines: [...payload.engines],
        max_results: payload.maxResults,
        fetch_content: payload.fetchContent,
        inject_graph: payload.injectGraph,
        inject_vector: payload.injectVector,
        language: payload.language,
        safe_search: payload.safeSearch,
      }),
    )
    .digest("hex");
}

function computeDirectIngestFingerprint(payload: {
  sources: readonly DirectIngestSource[];
  label: string;
  injectGraph: boolean;
  injectVector: boolean;
}): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        label: payload.label,
        inject_graph: payload.injectGraph,
        inject_vector: payload.injectVector,
        sources: payload.sources.map((source) => ({
          url: source.url,
          title: source.title ?? null,
          snippet: source.snippet ?? null,
          engines: source.engines ?? null,
          categories: source.categories ?? null,
          position: source.position ?? null,
        })),
      }),
    )
    .digest("hex");
}

function collectDistinct(collections: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const group of collections) {
    for (const value of group) {
      const trimmed = value.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      ordered.push(trimmed);
    }
  }
  return ordered;
}

function deduplicateByUrl(results: readonly SearxResult[]): SearxResult[] {
  const seen = new Set<string>();
  const unique: SearxResult[] = [];
  for (const result of results) {
    const key = result.url.trim();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(result);
  }
  return unique;
}

/** Extracts a lower-cased hostname from a URL or returns null when unavailable. */
function deriveDomain(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const value = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const { hostname } = new URL(value);
    return hostname.toLowerCase();
  } catch {
    const candidate = trimmed.split("/")[0]?.toLowerCase();
    return candidate && candidate.length > 0 ? candidate : null;
  }
}

function buildError(stage: SearchJobError["stage"], url: string | null, cause: unknown): SearchJobError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = classifyError(stage, cause);
  return {
    stage,
    url,
    message,
    code,
  };
}

function classifyError(stage: SearchJobError["stage"], cause: unknown): string | null {
  if (cause instanceof RobotsNotAllowedError) {
    return "robots_denied";
  }
  if (cause instanceof DownloadSizeExceededError) {
    return "max_size_exceeded";
  }
  if (cause instanceof DownloadError) {
    return "network_error";
  }
  if (cause instanceof UnstructuredExtractorError) {
    return "extract_error";
  }
  if (stage === "ingest_graph" || stage === "ingest_vector") {
    return "ingest_error";
  }
  if (cause instanceof SearxClientError) {
    return cause.code ?? "network_error";
  }
  if (cause instanceof Error) {
    return stage === "search" || stage === "fetch" ? "network_error" : "ingest_error";
  }
  return null;
}

