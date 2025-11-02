/**
 * JSON-compatible value used for structured metadata persisted alongside job
 * records. Defining it locally keeps the module self-contained and avoids
 * leaking `undefined` when the payloads are stringified.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

/**
 * Enumerates the lifecycle states a search job transitions through while the
 * orchestrator processes a request. Terminal states (`completed` and `failed`)
 * are immutable once reached to guarantee reliable replay and observability.
 */
export type JobStatus = "pending" | "running" | "completed" | "failed";

/**
 * Captures the resource ceilings enforced for a job. Explicit `null` values
 * mean "no limit" which avoids leaking `undefined` when serialising to JSON.
 */
export interface JobBudget {
  readonly maxDurationMs: number | null;
  readonly maxToolCalls: number | null;
  readonly maxBytesOut: number | null;
}

/**
 * Structured context describing who initiated the job and how it reached the
 * orchestrator. The payload is intentionally conservative (plain data) so it
 * can be safely persisted in JSONL logs.
 */
export interface JobProvenance {
  /** Human-readable trigger such as `search.run` or `search.index`. */
  readonly trigger: string;
  /** Transport that submitted the request (STDIO, HTTP, scheduler, ...). */
  readonly transport: string;
  /** Correlation identifier when available (request id, span id, ...). */
  readonly requestId: string | null;
  /** Optional caller identifier when authentication is enabled. */
  readonly requester: string | null;
  /** Optional remote endpoint (IP:port) when sourced from HTTP. */
  readonly remoteAddress: string | null;
  /**
   * Additional machine-readable metadata preserved for debugging. The payload
   * must stay JSON serialisable to keep the job journal append-only.
   */
  readonly extra: Readonly<Record<string, JsonValue>>;
}

/**
 * Lightweight progress beacon surfaced while the job is running. Each update
 * overwrites the previous one which keeps the persisted footprint compact.
 */
export interface JobProgress {
  /** High-level pipeline step (searx, download, extract, ingest, ...). */
  readonly step: string;
  /** Optional human friendly description for dashboards. */
  readonly message: string | null;
  /** Ratio between 0 and 1 when the progress can be quantified. */
  readonly ratio: number | null;
  /** Timestamp (ms epoch) at which the progress update was emitted. */
  readonly updatedAt: number;
}

/**
 * Snapshot summarising the outcome of a job once it reaches a terminal state.
 */
export interface JobSummary {
  /** Number of Searx results considered during the run. */
  readonly consideredResults: number;
  /** Number of documents successfully fetched. */
  readonly fetchedDocuments: number;
  /** Number of documents ingested into downstream stores. */
  readonly ingestedDocuments: number;
  /** Number of documents skipped because of idempotence or guards. */
  readonly skippedDocuments: number;
  /** Absolute paths to artefacts emitted under `validation_run/`. */
  readonly artifacts: readonly string[];
  /** Arbitrary numeric metrics (latencies, percentiles, custom counters). */
  readonly metrics: Readonly<Record<string, number>>;
  /** Optional free-form commentary (kept short for dashboards). */
  readonly notes: string | null;
}

/**
 * Structured failure captured when the job enters the `failed` state. The list
 * is preserved even for successful jobs to retain intermediate non-fatal
 * issues (e.g. skipped downloads, extractor hiccups).
 */
export interface JobFailure {
  /** Stable error code to assist with analytics and alerting. */
  readonly code: string;
  /** Human friendly description already redacted. */
  readonly message: string;
  /** Optional pipeline stage where the failure originated. */
  readonly stage: string | null;
  /** Timestamp (ms epoch) when the failure was recorded. */
  readonly occurredAt: number;
  /** Additional safe-to-log metadata for debugging. */
  readonly details: JsonValue | null;
}

/**
 * Runtime state stored for each job. All timestamps are monotonically
 * increasing to make GC and dashboards predictable.
 */
export interface JobState {
  readonly status: JobStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly failedAt: number | null;
  readonly progress: JobProgress | null;
  readonly summary: JobSummary | null;
  readonly errors: readonly JobFailure[];
}

/**
 * Partial update accepted by {@link SearchJobStore.update}. Properties omitted
 * from the patch remain untouched. When a value should be cleared the caller
 * must explicitly provide `null`.
 */
export interface JobStatePatch {
  readonly status?: JobStatus;
  readonly updatedAt?: number;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
  readonly failedAt?: number | null;
  readonly progress?: JobProgress | null;
  readonly summary?: JobSummary | null;
  readonly errors?: readonly JobFailure[];
}

/**
 * Metadata persisted for every job. The structure is intentionally compact and
 * deterministic so it can be hashed to produce the idempotent job id.
 */
export interface JobMeta {
  /** Deterministic identifier derived from the normalised query + options. */
  readonly id: string;
  /** Timestamp (ms epoch) at which the request entered the orchestrator. */
  readonly createdAt: number;
  /** Raw query provided by the user or upstream caller. */
  readonly query: string;
  /** Canonicalised query used for idempotent comparisons. */
  readonly normalizedQuery: string;
  /** Optional logical tags (scenario id, campaign, custom labels). */
  readonly tags: readonly string[];
  /** Identifier of the authenticated caller when known. */
  readonly requester: string | null;
  /** Resource ceilings applied to this job (durations, budgets, ...). */
  readonly budget: JobBudget;
  /** Provenance payload preserved alongside the metadata. */
  readonly provenance: JobProvenance;
}

/** Snapshot of the metadata returned by {@link SearchJobStore.get}. */
export type StoredJobMeta = Omit<JobMeta, "provenance">;

/**
 * Full record returned by the job store. Consumers receive immutable copies to
 * prevent accidental mutation of the authoritative state kept in the store.
 */
export interface JobRecord {
  readonly meta: StoredJobMeta;
  readonly state: JobState;
  readonly provenance: JobProvenance;
}

/**
 * Filter accepted by {@link SearchJobStore.list}. When multiple criteria are
 * provided they are ANDed together.
 */
export interface ListFilter {
  /** Restrict the result set to specific states. */
  readonly status?: JobStatus | readonly JobStatus[];
  /** Keep jobs updated on/after this timestamp (ms epoch). */
  readonly since?: number;
  /** Keep jobs updated on/before this timestamp (ms epoch). */
  readonly until?: number;
  /** Require at least one matching tag. */
  readonly tag?: string;
  /** Require all the provided tags to be present. */
  readonly tags?: readonly string[];
  /** Maximum number of entries to return (most recent first). */
  readonly limit?: number;
}

/** Contract implemented by concrete job store backends. */
export interface SearchJobStore {
  /** Persist a brand new job. Must throw when the id already exists. */
  create(job: JobMeta): Promise<void>;
  /** Patch the runtime state of an existing job. */
  update(jobId: string, patch: JobStatePatch): Promise<void>;
  /** Retrieve a single job record. Returns `null` when unknown. */
  get(jobId: string): Promise<JobRecord | null>;
  /**
   * Enumerate jobs optionally filtered by state, tags or recency. Backends are
   * free to implement additional optimisations (pagination, streaming, ...).
   */
  list(filter?: ListFilter): Promise<JobRecord[]>;
  /**
   * Garbage collect expired entries. Implementations return the number of
   * purged records so callers can expose the information via metrics.
   */
  gc(now: number): Promise<number>;
}
