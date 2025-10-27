# Search Module Runbook

## Overview
The search module adds a self-hosted, privacy-preserving web research pipeline
that leverages a local [SearxNG](https://docs.searxng.org/) metasearch node,
the [unstructured.io](https://github.com/Unstructured-IO/unstructured) API for
multimodal parsing, and the existing knowledge graph / vector memory services.
It mirrors the `graph/` subsystem by exposing a dedicated `src/search` package
and a trio of MCP façades (`search.run`, `search.index`, `search.status`).

High-level responsibilities:

- Accept operator or agent initiated search jobs with strict budgets and
  idempotency keys.
- Query SearxNG, download remote artefacts (HTML, PDF, images), and normalise
  metadata while respecting robots.txt when enabled.
- Forward binary payloads to the unstructured API, translate the structured
  response into typed segments, deduplicate content, and derive language
  metadata via `tinyld` heuristics.
- Ingest the resulting documents into the knowledge graph (triples with
  provenance) and vector store (chunking + embeddings) when the pipeline
  configuration enables those sinks.
- Emit structured telemetry through the event store and tracing backends so the
  dashboard can surface queue depth, domain distribution, and latency percentiles.

## Architecture
The following flow summarises the orchestration that starts in
`SearchPipeline.runSearchJob`:

1. **Searx query** – `searxClient.searxQuery` builds an authenticated request,
   applies retry/timeout guards, and validates the JSON schema via Zod.
2. **Fetch stage** – `downloader.fetchUrl` enforces content-length limits,
   handles redirects, and attaches deterministic document identifiers.
3. **Extraction stage** – `extractor.extractWithUnstructured` posts the raw
   buffer to the unstructured server, mapping each element into a
   `StructuredSegment` and annotating languages.
4. **Normalisation** – `normalizer.finalizeDocId` fixes document identifiers and
   `normalizer.deduplicateSegments` collapses repeated content.
5. **Ingestion** –
   - `ingest/toKnowledgeGraph.ingestStructuredDocument` writes triples and
     provenance records via `knowledgeGraph.upsertTriple`.
   - `ingest/toVectorStore.ingestStructuredDocument` chunks textual segments and
     invokes `memory/vector.embedText` for embeddings.
6. **Telemetry** – `metrics.SearchMetricsRecorder` captures p50/p95/p99
   histograms for Searx queries, fetches, extraction calls, and ingestion spans.
   `pipeline.runSearchJob` publishes `search:job_*` events enriched with
   MIME-type details for dashboard consumers.

Both the `search.run` and `search.index` façades share the same pipeline
building blocks. `search.index` skips the Searx phase and feeds explicit URLs
through the fetch/extract/ingest stages. `search.status` currently exposes a
stateless acknowledgement for observability pipelines.

## Local development & containers
A dedicated Compose file (`docker/docker-compose.search.yml`) launches the
self-hosted SearxNG instance, the unstructured API, and the MCP server. During
local development run:

```bash
docker compose -f docker/docker-compose.search.yml up -d
```

The stack exposes SearxNG on `127.0.0.1:8080` and the unstructured API on
`127.0.0.1:8000`. The MCP server binds to its usual port after the two
dependencies report healthy status checks.

## Configuration reference
The table below documents the environment variables consumed by
`src/search/config.ts`. Defaults match the development Compose stack.

| Variable | Default | Description |
| --- | --- | --- |
| `SEARCH_SEARX_BASE_URL` | `http://searxng:8080` | Base URL for the internal SearxNG instance. |
| `SEARCH_SEARX_API_PATH` | `/search` | Path appended to the Searx base URL for JSON queries. |
| `SEARCH_SEARX_TIMEOUT_MS` | `15000` | Request timeout (ms) for Searx queries. |
| `SEARCH_SEARX_ENGINES` | `bing,ddg,wikipedia,arxiv,github` | Comma separated engine allow-list; duplicates are removed. |
| `SEARCH_SEARX_CATEGORIES` | `general,news,images,files` | Comma separated Searx categories. |
| `SEARCH_SEARX_AUTH_TOKEN` | _unset_ | Optional bearer token when SearxNG enforces authentication. |
| `SEARCH_SEARX_MAX_RETRIES` | `2` | Number of retry attempts performed after the initial query. |
| `UNSTRUCTURED_BASE_URL` | `http://unstructured:8000` | Base URL for the unstructured extraction API. |
| `UNSTRUCTURED_TIMEOUT_MS` | `30000` | Request timeout (ms) when calling unstructured. |
| `UNSTRUCTURED_STRATEGY` | `hi_res` | Extraction strategy passed to unstructured. |
| `UNSTRUCTURED_API_KEY` | _unset_ | Optional API key forwarded in the `Authorization` header. |
| `SEARCH_FETCH_TIMEOUT_MS` | `20000` | Download timeout (ms) when fetching remote artefacts. |
| `SEARCH_FETCH_MAX_BYTES` | `15000000` | Maximum payload size (bytes) accepted before aborting the fetch. |
| `SEARCH_FETCH_UA` | `CodexSearchBot/1.0` | User-Agent header attached to crawl requests. |
| `SEARCH_FETCH_RESPECT_ROBOTS` | `false` | Enable robots.txt enforcement when set to `true`. |
| `SEARCH_FETCH_PARALLEL` | `4` | Maximum concurrent fetches per job. |
| `SEARCH_FETCH_DOMAIN_DELAY_MS` | `0` | Minimum delay (ms) enforced between requests to the same domain. |
| `SEARCH_FETCH_CACHE_ENABLED` | `false` | Enables the per-domain raw content cache when set to `true`. |
| `SEARCH_FETCH_CACHE_TTL_MS` | `600000` | Default TTL (ms) applied to cached documents. |
| `SEARCH_FETCH_CACHE_MAX_ENTRIES` | `16` | Maximum cached documents per domain. |
| `SEARCH_FETCH_CACHE_CLIENT_ERROR_MS` | `300000` | Backoff duration (ms) after repeated 4xx responses. |
| `SEARCH_FETCH_CACHE_SERVER_ERROR_MS` | `60000` | Backoff duration (ms) after repeated 5xx responses. |
| `SEARCH_FETCH_CACHE_DOMAIN_TTLS` | _empty_ | Optional CSV of `domain=ttl` overrides for specific origins. |
| `SEARCH_INJECT_GRAPH` | `true` | Toggle knowledge graph ingestion. |
| `SEARCH_INJECT_VECTOR` | `true` | Toggle vector-store ingestion. |
| `SEARCH_EXTRACT_PARALLEL` | `2` | Maximum concurrent extraction requests per job. |

All configuration keys are tracked in `config/env/expected-keys.json` to keep CI
validation in sync.

## Example MCP tool invocations
### `search.run`
```json
{
  "query": "benchmarks LLM multimodal 2025 filetype:pdf",
  "categories": ["files", "general", "images"],
  "maxResults": 6,
  "fetchContent": true,
  "injectGraph": true,
  "injectVector": true
}
```
- Runs a full search job, downloads content, ingests the results into both
  sinks, and returns a structured summary.
- Idempotency is enforced via the optional `idempotency_key` property or the
  transport-level key provided by the MCP runtime.

### `search.index`
```json
{
  "urls": [
    "https://arxiv.org/pdf/2401.12345.pdf",
    "https://example.com/blog/agentic-search"
  ],
  "injectGraph": false,
  "injectVector": true
}
```
- Skips the Searx phase and forces ingestion for explicit URLs.
- Ideal when operators already know the canonical source and want the artefact
  indexed for downstream RAG queries.

### `search.status`
```json
{
  "job_id": "123e4567-e89b-12d3-a456-426614174000"
}
```
- Returns a deterministic acknowledgement. Persistence is intentionally scoped
  for future iterations; callers should rely on the event stream for progress
  updates until job storage lands.

## Security & request controls
- Both `search.run` and `search.index` derive deterministic idempotency keys
  from the query, category, engine, and flag combinations when callers omit the
  optional `idempotency_key`. This keeps HTTP retries safe without leaking
  transport-specific headers.
- The HTTP transport exposes `MCP_HTTP_SEARCH_RATE_LIMIT_DISABLE`,
  `MCP_HTTP_SEARCH_RATE_LIMIT_RPS`, and `MCP_HTTP_SEARCH_RATE_LIMIT_BURST` to
  throttle `search.*` façade invocations independently from the global
  rate-limiter.

## Re-crawl strategy
The downloader computes deterministic document identifiers based on the URL and
cache-related headers (`ETag`, `Last-Modified`). Operators should:

1. Schedule periodic `search.run` jobs with targeted queries or
   `search.index` calls for canonical feeds.
2. Honour domain-specific TTLs by wrapping the pipeline in the optional content
   cache (`src/search/cache/contentCache.ts`) once enabled.
3. Use the knowledge graph provenance (source URL + `fetchedAt`) to detect stale
   documents and trigger fresh ingestion runs when the upstream signals a new
   revision.

## Known limitations
- OCR-heavy PDFs or scanned documents may produce sparse text output because the
  hi-res strategy delegates to the upstream OCR models bundled with
  unstructured.
- Image extraction retains bounding boxes and captions but skips embedding until
  a multimodal embedding backend is configured.
- Rate limiting still focuses on coarse-grained buckets (HTTP + per-domain
  downloader throttles); persistent job storage and adaptive pacing remain on
  the follow-up roadmap.

## Incident response playbook
| Scenario | Detection | Mitigation |
| --- | --- | --- |
| **Unstructured outage** | Spike in `search:error` events with `stage="extract"` and HTTP 5xx traces. | Restart the container, verify health on `/general/v0/general`, and temporarily disable `SEARCH_INJECT_VECTOR` to keep graph ingestion alive. |
| **SearxNG rate limiting** | Elevated `search:error` entries with `code="searx_http_error"` and 429 status codes; dashboard queue depth increasing. | Reduce concurrent jobs, adjust `SEARCH_SEARX_ENGINES` to a less throttled set, or configure API keys when available. |
| **Large payload rejection** | `search:error` events with `code="fetch_max_bytes_exceeded"`. | Increase `SEARCH_FETCH_MAX_BYTES` cautiously or add domain-specific exceptions via future content-cache hooks. |
| **Robots.txt denial** | Fetch stage errors containing `code="robots_disallowed"`. | Disable `SEARCH_FETCH_RESPECT_ROBOTS` locally (if policy allows) or request manual approval to crawl the domain. |
| **Vector store saturation** | Embedding ingestion errors indicating capacity limits. | Run the vector-store compaction routine, raise storage quotas, or temporarily set `SEARCH_INJECT_VECTOR=false` until capacity is restored. |

## Validation checklist
- `npm run typecheck`
- `TSX_EXTENSIONS=ts node --import tsx ./node_modules/mocha/bin/mocha.js --reporter tap --file tests/setup.ts tests/unit/search/pipeline.test.ts`
- `docker compose -f docker/docker-compose.search.yml up -d`
- `npm run test:e2e:search` *(automatically sets `SEARCH_E2E_ALLOW_RUN=1`; skips when Docker/unstructured are unavailable)*
- `npm run smoke:search` *(brings up the stack, runs a real `search.run` job, and tears everything down with a summary report)*

Keep the validation list updated as new automation arrives.

### Continuous integration guardrails
- The GitHub Actions job **“Search stack end-to-end”** provisions the compose
  stack, runs `npm run test:e2e:search`, and follows up with `npm run
  smoke:search` to ensure the dockerised flow stays healthy on every push.
