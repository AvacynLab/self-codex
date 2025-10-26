/**
 * Public entry point for the search subsystem. Centralising exports ensures
 * other modules only rely on stable, well-documented contracts.
 */
export { collectSearchRedactionTokens, loadSearchConfig, parseCsvList } from "./config.js";
export type {
  FetchCacheConfig,
  FetchConfig,
  PipelineConfig,
  SearchConfig,
  SearxConfig,
  UnstructuredConfig,
} from "./config.js";
export { SearxClient, SearxClientError } from "./searxClient.js";
export type { SearxQueryOptions, SearxQueryResponse } from "./searxClient.js";
export {
  SearchDownloader,
  DownloadError,
  DownloadBackoffError,
  DownloadSizeExceededError,
  DownloadTimeoutError,
  HttpStatusError,
  RobotsNotAllowedError,
  computeDocId,
} from "./downloader.js";
export { SearchContentCache } from "./cache/contentCache.js";
export {
  UnstructuredExtractor,
  UnstructuredExtractorError,
  type ExtractionRequest,
  type SearxProvenanceContext,
} from "./extractor.js";
export { deduplicateSegments, finalizeDocId } from "./normalizer.js";
export {
  KnowledgeGraphIngestor,
  extractKeyTerms,
  type KnowledgeGraphIngestDependencies,
  type KnowledgeGraphIngestResult,
  type KnowledgeGraphIngestedTriple,
} from "./ingest/toKnowledgeGraph.js";
export {
  VectorStoreIngestor,
  type VectorStoreIngestDependencies,
  type VectorStoreIngestResult,
  type VectorChunkDescriptor,
} from "./ingest/toVectorStore.js";
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
  SearchMetricsRecorder,
  type OperationMetricSnapshot,
  type SearchMetricOperation,
  type SearchMetricsOptions,
  type SearchMetricsSnapshot,
} from "./metrics.js";
export type {
  RawFetched,
  SearxResult,
  StructuredDocument,
  StructuredSegment,
  StructuredSegmentKind,
} from "./types.js";
