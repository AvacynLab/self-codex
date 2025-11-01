import { createHash } from "node:crypto";

import pLimit, { type Limit } from "p-limit";

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

/**
 * Orchestrates the end-to-end search flow (Searx query → download → extraction
 * → normalisation → ingestion). Errors are surfaced as structured entries in
 * the result while the job continues processing remaining documents.
 */
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
    this.fetchLimiter = pLimit(Math.max(1, Math.floor(this.config.fetch.parallelism)));
    this.extractLimiter = pLimit(Math.max(1, Math.floor(this.config.pipeline.parallelExtract)));
  }

  /** Executes the full search job and returns structured results. */
  async runSearchJob(parameters: SearchJobParameters): Promise<SearchJobResult> {
    const query = parameters.query.trim();
    const maxResults = normaliseMaxResults(parameters.maxResults, this.config.pipeline.maxResults);
    const effectiveCategories = normaliseList(parameters.categories, this.config.searx.categories);
    const effectiveEngines = normaliseList(parameters.engines, this.config.searx.engines);
    const fetchContent = parameters.fetchContent ?? true;
    const injectGraph = parameters.injectGraph ?? this.config.pipeline.injectGraph;
    const injectVector = parameters.injectVector ?? this.config.pipeline.injectVector;
    const jobId = resolveJobId(
      parameters.jobId,
      computeSearchJobFingerprint({
        query,
        categories: effectiveCategories,
        engines: effectiveEngines,
        maxResults,
        fetchContent,
        injectGraph,
        injectVector,
        language: parameters.language ?? null,
        safeSearch: parameters.safeSearch ?? null,
      }),
    );

    const errors: SearchJobError[] = [];

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

    const searchResponse = await this.executeWithMetrics(
      "searxQuery",
      () => this.searxClient.search(query, queryOptions),
      (error) => (error instanceof SearxClientError ? error.code : null),
      { domain: deriveDomain(this.config.searx.baseUrl), contentType: "application/json" },
    ).catch((error) => {
      const failure = buildError("search", null, error);
      errors.push(failure);
      this.emitError(jobId, failure);
      this.logger?.error("search_query_failed", {
        job_id: jobId,
        message: failure.message,
        code: failure.code,
      });
      return null;
    });

    if (!searchResponse) {
      const stats: SearchJobStats = {
        requestedResults: maxResults,
        receivedResults: 0,
        fetchedDocuments: 0,
        structuredDocuments: 0,
        graphIngested: 0,
        vectorIngested: 0,
      };
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

    const uniqueResults = deduplicateByUrl(searchResponse.results).slice(0, maxResults);

    if (!fetchContent || uniqueResults.length === 0) {
      const stats: SearchJobStats = {
        requestedResults: maxResults,
        receivedResults: uniqueResults.length,
        fetchedDocuments: 0,
        structuredDocuments: 0,
        graphIngested: 0,
        vectorIngested: 0,
      };
      this.emitJobCompleted(jobId, query, stats, errors.length);
      return {
        jobId,
        query,
        results: uniqueResults,
        documents: [],
        errors,
        stats,
        rawSearxResponse: searchResponse.raw,
        metrics: this.metrics ? this.metrics.snapshot() : null,
      };
    }

    const processingOutcome = await this.processResultSet(jobId, query, uniqueResults, {
      injectGraph,
      injectVector,
      errors,
    });

    const stats: SearchJobStats = {
      requestedResults: maxResults,
      receivedResults: uniqueResults.length,
      fetchedDocuments: processingOutcome.fetchedDocuments,
      structuredDocuments: processingOutcome.structuredDocuments,
      graphIngested: processingOutcome.graphIngested,
      vectorIngested: processingOutcome.vectorIngested,
    };

    this.emitJobCompleted(jobId, query, stats, errors.length);

    return {
      jobId,
      query,
      results: uniqueResults,
      documents: processingOutcome.documents,
      errors,
      stats,
      rawSearxResponse: searchResponse.raw,
      metrics: this.metrics ? this.metrics.snapshot() : null,
    };
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
        errors,
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
      errors: SearchJobError[];
    },
  ): Promise<ProcessedResultSet> {
    if (results.length === 0) {
      return { documents: [], fetchedDocuments: 0, structuredDocuments: 0, graphIngested: 0, vectorIngested: 0 };
    }

    let structuredDocuments = 0;
    let graphIngested = 0;
    let vectorIngested = 0;
    const documents: StructuredDocument[] = [];

    const fetchOutcomes = await Promise.all(
      results.map((result) =>
        this.fetchLimiter(async () => {
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
            return { result, raw } as const;
          } catch (error) {
            const failure = buildError("fetch", result.url, error);
            options.errors.push(failure);
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

    const extractionInputs = successfulFetches.map((entry) => ({
      result: entry.result,
      raw: entry.raw,
      docId: computeDocId(entry.raw.finalUrl, entry.raw.headers, entry.raw.body),
    }));

    const extractionOutcomes = await Promise.all(
      extractionInputs.map((input) =>
        this.extractLimiter(async () => {
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
            return { result: input.result, document: finalDocument } as const;
          } catch (error) {
            const failure = buildError("extract", input.raw.finalUrl, error);
            options.errors.push(failure);
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

    for (const outcome of successfulExtractions) {
      const { document, result } = outcome;
      const docErrors: SearchJobError[] = [];

      let graphResult: KnowledgeGraphIngestResult | null = null;
      if (options.injectGraph) {
        if (this.knowledgeIngestor) {
          try {
            graphResult = await this.executeWithMetrics(
              "ingestGraph",
              async () => this.knowledgeIngestor!.ingest(document),
              (error) => (error instanceof Error ? error.name : null),
              { domain: deriveDomain(document.url), contentType: document.mimeType },
            );
            graphIngested += 1;
          } catch (error) {
            const failure = buildError("ingest_graph", document.url, error);
            options.errors.push(failure);
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
          try {
            vectorResult = await this.executeWithMetrics(
              "ingestVector",
              () => this.vectorIngestor!.ingest(document),
              (error) => (error instanceof Error ? error.name : null),
              { domain: deriveDomain(document.url), contentType: document.mimeType },
            );
            vectorIngested += 1;
          } catch (error) {
            const failure = buildError("ingest_vector", document.url, error);
            options.errors.push(failure);
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

