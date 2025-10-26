import { detect } from "tinyld";
import { z } from "zod";

import type { SearchConfig } from "./config.js";
import type { RawFetched, StructuredDocument, StructuredSegment, StructuredSegmentKind } from "./types.js";

/** Error code emitted when the unstructured API responds with an HTTP failure. */
const ERROR_UNSTRUCTURED_HTTP = "E-SEARCH-UNSTRUCTURED-HTTP" as const;
/** Error code emitted when the unstructured API rejects the request. */
const ERROR_UNSTRUCTURED_NETWORK = "E-SEARCH-UNSTRUCTURED-NETWORK" as const;
/** Error code emitted when the unstructured API times out. */
const ERROR_UNSTRUCTURED_TIMEOUT = "E-SEARCH-UNSTRUCTURED-TIMEOUT" as const;
/** Error code emitted when the JSON payload returned by unstructured is invalid. */
const ERROR_UNSTRUCTURED_SCHEMA = "E-SEARCH-UNSTRUCTURED-SCHEMA" as const;

/**
 * Schema describing the element structure returned by `unstructured`.
 * The server emits a heterogeneous list of objects containing a `type`,
 * optional textual `text` content, an identifier and a metadata object.  The
 * metadata is intentionally loose as it varies wildly depending on the input
 * format (HTML, PDF, images...).
 */
const unstructuredElementSchema = z
  .object({
    type: z.string(),
    id: z.string().optional().nullable(),
    text: z.string().optional().nullable(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/** Schema validating the response body emitted by `unstructured`. */
const unstructuredResponseSchema = z.array(unstructuredElementSchema);

/**
 * Payload describing the Searx provenance associated with the document being
 * extracted.  The extractor uses this information to populate the
 * {@link StructuredDocument.provenance} block.
 */
export interface SearxProvenanceContext {
  readonly query: string;
  readonly engines: readonly string[];
  readonly categories: readonly string[];
  readonly position: number | null;
  readonly sourceUrl: string;
  readonly titleHint?: string | null;
  readonly snippetHint?: string | null;
}

/** Options accepted by {@link UnstructuredExtractor}. */
interface ExtractorOptions {
  readonly now?: () => number;
}

/**
 * Error thrown when the extractor cannot obtain a valid response from the
 * `unstructured` API.  The error exposes machine readable codes so the caller
 * can react deterministically (retry, abort the job, surface a rich MCP
 * failure...).
 */
export class UnstructuredExtractorError extends Error {
  public readonly code:
    | typeof ERROR_UNSTRUCTURED_HTTP
    | typeof ERROR_UNSTRUCTURED_NETWORK
    | typeof ERROR_UNSTRUCTURED_TIMEOUT
    | typeof ERROR_UNSTRUCTURED_SCHEMA;
  public readonly status: number | null;

  constructor(
    message: string,
    options: {
      code:
        | typeof ERROR_UNSTRUCTURED_HTTP
        | typeof ERROR_UNSTRUCTURED_NETWORK
        | typeof ERROR_UNSTRUCTURED_TIMEOUT
        | typeof ERROR_UNSTRUCTURED_SCHEMA;
      status?: number | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "UnstructuredExtractorError";
    this.code = options.code;
    this.status = options.status ?? null;
  }
}

/**
 * Input payload accepted by {@link UnstructuredExtractor.extract}.  The
 * extractor requires the raw HTTP payload alongside the deterministic document
 * identifier and provenance hints describing the originating Searx query.
 */
export interface ExtractionRequest {
  readonly docId: string;
  readonly raw: RawFetched;
  readonly provenance: SearxProvenanceContext;
}

/** Mapping between the raw element `type` emitted by unstructured and our internal segment kinds. */
const SEGMENT_KIND_MAP: Readonly<Record<string, StructuredSegmentKind>> = {
  title: "title",
  header: "title",
  heading: "title",
  subtitle: "title",
  narrative_text: "paragraph",
  paragraph: "paragraph",
  text: "paragraph",
  list_item: "list",
  unordered_list: "list",
  ordered_list: "list",
  table: "table",
  table_row: "table",
  figure: "figure",
  image: "figure",
  picture: "figure",
  figure_caption: "caption",
  caption: "caption",
  code: "code",
  metadata: "meta",
};

/** Set of kinds considered textual for deduplication and language detection. */
const TEXTUAL_KINDS: ReadonlySet<StructuredSegmentKind> = new Set([
  "title",
  "paragraph",
  "list",
  "caption",
  "code",
]);

/** Maximum number of characters forwarded to the language detector. */
const LANGUAGE_SAMPLE_LIMIT = 8_000;

/**
 * Extractor responsible for invoking the `unstructured` API and mapping its
 * heterogeneous response into the strongly typed {@link StructuredDocument}
 * representation consumed by the rest of the search pipeline.
 */
export class UnstructuredExtractor {
  private readonly config: SearchConfig["unstructured"];
  private readonly fetchImpl: typeof fetch;

  constructor(config: SearchConfig, fetchImpl: typeof fetch = fetch, _options: ExtractorOptions = {}) {
    this.config = config.unstructured;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Performs a structured extraction of the provided {@link raw} payload.
   * Returns a {@link StructuredDocument} that can later be normalised and
   * ingested into the graph/vector subsystems.
   */
  async extract(request: ExtractionRequest): Promise<StructuredDocument> {
    const response = await this.callUnstructured(request.raw);
    const parsed = this.parseResponse(response);
    const segments = this.materialiseSegments(request.docId, parsed);
    const language = detectLanguage(segments);
    const title = chooseTitle(request.provenance.titleHint, segments);
    const description = chooseDescription(request.provenance.snippetHint, segments);

    return {
      id: request.docId,
      url: request.raw.finalUrl,
      title,
      language,
      description,
      checksum: request.raw.checksum,
      mimeType: request.raw.contentType,
      size: request.raw.size,
      fetchedAt: request.raw.fetchedAt,
      segments,
      provenance: {
        searxQuery: request.provenance.query,
        engines: [...request.provenance.engines],
        categories: [...request.provenance.categories],
        position: request.provenance.position,
        sourceUrl: request.provenance.sourceUrl,
      },
    };
  }

  private async callUnstructured(raw: RawFetched): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const endpoint = new URL("/general/v0/general", this.config.baseUrl);
      const form = new FormData();
      const fileName = deriveFileName(raw.finalUrl);
      const blob = new Blob([raw.body], { type: raw.contentType ?? "application/octet-stream" });
      form.append("files", blob, fileName);
      form.append("strategy", this.config.strategy);

      const headers = new Headers({ Accept: "application/json" });
      if (this.config.apiKey) {
        headers.set("Authorization", `Bearer ${this.config.apiKey}`);
      }

      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        body: form,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new UnstructuredExtractorError(`unstructured responded with HTTP ${response.status}`, {
          code: ERROR_UNSTRUCTURED_HTTP,
          status: response.status,
        });
      }

      return await response.json();
    } catch (error) {
      if (error instanceof UnstructuredExtractorError) {
        throw error;
      }
      const maybeAbort = (error as { name?: string }).name === "AbortError";
      if (maybeAbort) {
        throw new UnstructuredExtractorError("unstructured request timed out", {
          code: ERROR_UNSTRUCTURED_TIMEOUT,
          status: null,
          cause: error,
        });
      }
      throw new UnstructuredExtractorError("Failed to call unstructured", {
        code: ERROR_UNSTRUCTURED_NETWORK,
        status: null,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(payload: unknown): z.infer<typeof unstructuredResponseSchema> {
    try {
      return unstructuredResponseSchema.parse(payload);
    } catch (error) {
      throw new UnstructuredExtractorError("Invalid payload returned by unstructured", {
        code: ERROR_UNSTRUCTURED_SCHEMA,
        status: null,
        cause: error,
      });
    }
  }

  private materialiseSegments(
    docId: string,
    elements: ReadonlyArray<z.infer<typeof unstructuredElementSchema>>,
  ): StructuredSegment[] {
    const segments: StructuredSegment[] = [];
    let ordinal = 0;

    for (const element of elements) {
      const kind = resolveKind(element.type);
      if (!kind) {
        continue;
      }

      const text = normaliseText(element.text ?? "");
      if (TEXTUAL_KINDS.has(kind) && text.length === 0) {
        // Drop empty textual segments to avoid noise downstream.
        continue;
      }

      const metadata = normaliseMetadata(element.metadata ?? {});
      const pageNumber = extractPageNumber(element.metadata);
      const boundingBox = extractBoundingBox(element.metadata);
      const sourceId = typeof element.id === "string" && element.id.trim().length > 0 ? element.id.trim() : null;
      const segment: StructuredSegment = {
        id: `${docId}#raw-${++ordinal}`,
        kind,
        text,
        ...(pageNumber !== null ? { pageNumber } : {}),
        ...(boundingBox ? { boundingBox } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(sourceId ? { sourceId } : {}),
      };

      segments.push(segment);
    }

    return segments;
  }
}

/** Derives a filename from the final URL so unstructured can infer a mimetype. */
function deriveFileName(url: string): string {
  try {
    const parsed = new URL(url);
    const basename = parsed.pathname.split("/").filter(Boolean).pop();
    if (basename && basename.length > 0 && basename.length < 120) {
      return basename;
    }
  } catch {
    // Ignore URL parsing errors and fall back to a deterministic placeholder.
  }
  return `document-${Date.now()}`;
}

/** Maps the unstructured element type to our internal segment kind. */
function resolveKind(rawType: string | undefined): StructuredSegmentKind | null {
  if (typeof rawType !== "string") {
    return null;
  }
  const key = rawType.trim().toLowerCase().replace(/\s+/g, "_");
  return SEGMENT_KIND_MAP[key] ?? (key.startsWith("title") ? "title" : key.startsWith("list") ? "list" : null);
}

/** Collapses whitespace so deduplication and chunking receive clean content. */
function normaliseText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Extracts the page number from the element metadata, if available. */
function extractPageNumber(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const candidates = [record.page_number, record.pageNumber, record.page];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, Math.floor(candidate));
    }
  }
  return null;
}

/** Extracts a bounding box from the element metadata when provided. */
function extractBoundingBox(metadata: unknown): readonly [number, number, number, number] | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const bbox = record.bbox ?? record.bounding_box ?? record.boundingBox;
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((value) => typeof value === "number")) {
    return [bbox[0], bbox[1], bbox[2], bbox[3]];
  }
  const coords = record.coordinates;
  if (coords && typeof coords === "object") {
    const maybeArray = (coords as Record<string, unknown>).bbox;
    if (Array.isArray(maybeArray) && maybeArray.length === 4 && maybeArray.every((value) => typeof value === "number")) {
      return [maybeArray[0], maybeArray[1], maybeArray[2], maybeArray[3]];
    }
  }
  return null;
}

/** Filters metadata keys so the resulting payload stays serialisable and compact. */
function normaliseMetadata(metadata: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null) {
      result[key] = null;
      continue;
    }
    const type = typeof value;
    if (type === "string" || type === "number" || type === "boolean") {
      result[key] = value as string | number | boolean;
    }
  }
  return result;
}

/**
 * Chooses the most appropriate title for the structured document.  We honour
 * the Searx hint when provided, otherwise we fall back to the first `title`
 * segment emitted by the extractor.
 */
function chooseTitle(hint: string | null | undefined, segments: readonly StructuredSegment[]): string | null {
  const cleanedHint = hint?.trim();
  if (cleanedHint) {
    return cleanedHint;
  }
  const titleSegment = segments.find((segment) => segment.kind === "title" && segment.text.length > 0);
  return titleSegment ? titleSegment.text : null;
}

/**
 * Picks a short description for the document.  Prefers the snippet returned by
 * Searx and falls back to the first paragraph-like segment.
 */
function chooseDescription(hint: string | null | undefined, segments: readonly StructuredSegment[]): string | null {
  const cleanedHint = hint?.trim();
  if (cleanedHint) {
    return cleanedHint;
  }
  const candidate = segments.find((segment) =>
    (segment.kind === "paragraph" || segment.kind === "list" || segment.kind === "caption") && segment.text.length > 0,
  );
  return candidate ? candidate.text : null;
}

/**
 * Performs language detection on the textual segments.  When no reliable
 * signal is found, the function returns `null` so downstream modules can fall
 * back to heuristics.
 */
function detectLanguage(segments: readonly StructuredSegment[]): string | null {
  let sample = "";
  for (const segment of segments) {
    if (!TEXTUAL_KINDS.has(segment.kind)) {
      continue;
    }
    if (sample.length >= LANGUAGE_SAMPLE_LIMIT) {
      break;
    }
    const remaining = LANGUAGE_SAMPLE_LIMIT - sample.length;
    sample += (sample ? " " : "") + segment.text.slice(0, remaining);
  }
  if (sample.trim().length === 0) {
    return null;
  }
  try {
    const detected = detect(sample);
    return typeof detected === "string" && detected.trim().length > 0 ? detected : null;
  } catch {
    return null;
  }
}

