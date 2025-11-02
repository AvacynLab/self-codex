/**
 * Public entry point for the search subsystem. Centralising exports ensures
 * other modules only rely on stable, well-documented contracts.
 */
export { SearchContentCache } from "./cache/contentCache.js";
export {
  collectSearchRedactionTokens,
  loadSearchConfig,
  parseCsvList,
} from "./config.js";
export type {
  FetchCacheConfig,
  FetchConfig,
  PipelineConfig,
  SearchConfig,
  SearxConfig,
  UnstructuredConfig,
} from "./config.js";
export {
  DownloadBackoffError,
  DownloadError,
  DownloadSizeExceededError,
  DownloadTimeoutError,
  HttpStatusError,
  RobotsNotAllowedError,
  SearchDownloader,
  computeDocId,
} from "./downloader.js";
export {
  KnowledgeGraphIngestor,
  P,
  extractKeyTerms,
  type KnowledgeGraphIngestDependencies,
  type KnowledgeGraphIngestResult,
  type KnowledgeGraphIngestedTriple,
} from "./ingest/toKnowledgeGraph.js";
export {
  VectorStoreIngestor,
  type VectorChunkDescriptor,
  type VectorStoreIngestDependencies,
  type VectorStoreIngestResult,
} from "./ingest/toVectorStore.js";
export {
  SearchMetricsRecorder,
  type LatencyBucketSnapshot,
  type OperationLatencyBucketsSnapshot,
  type OperationMetricSnapshot,
  type SearchMetricContext,
  type SearchMetricDimensions,
  type SearchMetricOperation,
  type SearchMetricOutcome,
  type SearchMetricsOptions,
  type SearchMetricsSnapshot,
} from "./metrics.js";
export { deduplicateSegments, finalizeDocId } from "./normalizer.js";
export {
  SearchPipeline,
  type DirectIngestParameters,
  type DirectIngestResult,
  type DirectIngestSource,
  type SearchJobError,
  type SearchJobParameters,
  type SearchJobResult,
  type SearchJobStats,
} from "./pipeline.js";
export {
  type JobBudget,
  type JobFailure,
  type JobMeta,
  type JobProgress,
  type JobProvenance,
  type JobRecord,
  type JobState,
  type JobStatePatch,
  type JobStatus,
  type JobSummary,
  type ListFilter,
  type SearchJobStore,
  type StoredJobMeta,
  type JsonValue,
} from "./jobStore.js";
export { FileSearchJobStore } from "./jobStoreFile.js";
export { InMemorySearchJobStore } from "./jobStoreMemory.js";
export { SearxClient, SearxClientError } from "./searxClient.js";
export type { SearxQueryOptions, SearxQueryResponse } from "./searxClient.js";
export {
  UnstructuredExtractor,
  UnstructuredExtractorError,
  type ExtractionRequest,
  type SearxProvenanceContext,
} from "./extractor.js";
export { SEGMENT_KINDS } from "./types.js";
export type {
  RawFetched,
  SearxResult,
  SegmentKind,
  StructuredDocument,
  StructuredSegment,
} from "./types.js";
