/**
 * Core domain types produced by the search pipeline. Keeping them in a
 * dedicated module avoids circular dependencies and ensures the rest of the
 * orchestrator can rely on stable contracts when integrating the search
 * subsystem.
 */
/**
 * Ordered list of supported segment kinds emitted by the extractor. Keeping the
 * list centralised avoids discrepancies across the ingestion modules and makes
 * it trivial for tests to reference the canonical enumeration.
 */
export const SEGMENT_KINDS = [
  "title",
  "paragraph",
  "list",
  "table",
  "figure",
  "caption",
  "code",
  "meta",
] as const;

/** Literal union derived from {@link SEGMENT_KINDS}. */
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export interface SearxResult {
  /** Stable identifier derived from the URL and source metadata. */
  readonly id: string;
  /** Canonical URL returned by SearxNG. */
  readonly url: string;
  /** Title extracted from the search result, when available. */
  readonly title: string | null;
  /** Concise snippet or description summarising the hit. */
  readonly snippet: string | null;
  /** Engines that contributed to the result. */
  readonly engines: readonly string[];
  /** Categories associated with the result. */
  readonly categories: readonly string[];
  /** Zero-based rank for provenance and replay debugging. */
  readonly position: number;
  /** Optional media thumbnail when provided by the engine. */
  readonly thumbnailUrl: string | null;
  /** Content type advertised by Searx for the target resource. */
  readonly mime: string | null;
  /** Publication timestamp in ISO-8601 format when provided by Searx. */
  readonly publishedAt: string | null;
  /** Raw score exposed by Searx. */
  readonly score: number | null;
}

/**
 * Raw payload produced by the HTTP downloader before structured extraction.
 *
 * The structure intentionally mirrors what `fetch` returns while exposing the
 * metadata needed to implement caching, provenance and ingestion policies.
 */
export interface RawFetched {
  /** URL that triggered the download. */
  readonly requestedUrl: string;
  /** Final URL after redirects. */
  readonly finalUrl: string;
  /** HTTP status code received from the remote server. */
  readonly status: number;
  /** Timestamp (ms since epoch) at which the resource was fetched. */
  readonly fetchedAt: number;
  /** Normalised HTTP headers with lower-cased keys. */
  readonly headers: ReadonlyMap<string, string>;
  /** Content-Type header without charset or parameters. */
  readonly contentType: string | null;
  /** Size of the payload in bytes (after clamping). */
  readonly size: number;
  /** SHA-256 checksum of the payload, used for deduplication. */
  readonly checksum: string;
  /** Raw binary payload ready to be handed to `unstructured`. */
  readonly body: Buffer;
}

/** Supported structural segment kinds produced by the extractor. */
/**
 * Canonical representation of a structured segment extracted from a document.
 */
export interface StructuredSegment {
  /** Stable identifier combining the document id and the extractor ordinal. */
  readonly id: string;
  /** Semantic kind emitted by the extractor. */
  readonly kind: SegmentKind;
  /** Clean textual content associated with the segment. */
  readonly text: string;
  /** Page number when available (useful for PDFs). */
  readonly pageNumber?: number;
  /** Bounding box when provided by the extractor (x1,y1,x2,y2). */
  readonly boundingBox?: readonly [number, number, number, number];
  /** Additional metadata preserved for auditing. */
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
  /** Identifier referencing the raw element produced by `unstructured`. */
  readonly sourceId?: string;
}

/**
 * Structured representation of a fetched document, ready to be ingested either
 * into the knowledge graph or the vector store.
 */
export interface StructuredDocument {
  /** Stable identifier derived from the URL and HTTP validators. */
  readonly id: string;
  /** Canonical URL associated with the document. */
  readonly url: string;
  /** Human readable title when deduced from the document. */
  readonly title: string | null;
  /** Language detected on the aggregated segments. */
  readonly language: string | null;
  /** Optional summary or description (may come from Searx snippets). */
  readonly description: string | null;
  /** Hash of the HTTP payload ensuring deduplication across crawls. */
  readonly checksum: string;
  /** MIME type advertised by the HTTP response. */
  readonly mimeType: string | null;
  /** Number of bytes stored in the payload. */
  readonly size: number;
  /** Timestamp (ms since epoch) marking the fetch time. */
  readonly fetchedAt: number;
  /** Ordered list of structured segments extracted from the content. */
  readonly segments: readonly StructuredSegment[];
  /** Provenance metadata preserved for auditing and replay. */
  readonly provenance: {
    /** Raw query used against SearxNG. */
    readonly searxQuery: string;
    /** Engines enabled for the query. */
    readonly engines: readonly string[];
    /** Categories enabled for the query. */
    readonly categories: readonly string[];
    /** Position of the document in the Searx results. */
    readonly position: number | null;
    /** URL originally advertised by Searx (may differ after redirects). */
    readonly sourceUrl: string;
  };
  /** Optional document-level metadata describing extraction side effects. */
  readonly metadata?: {
    /** Indicates that the source document was truncated during extraction. */
    readonly truncated?: boolean;
  };
}
