/**
 * Shared helpers and error classes for bulk MCP tools. Keeping the aggregated
 * failure reporting logic centralised ensures every surface emits consistent
 * metadata (codes, hints and entry details) when a batch aborts midway through
 * its processing.
 */
import { ERROR_CODES } from "../types.js";

/**
 * Structured description of a single entry that failed during a bulk
 * invocation. The index matches the position in the original request payload so
 * clients can highlight the offending element precisely.
 */
export interface BulkFailureDetail {
  /** Zero-based index of the entry inside the submitted batch. */
  index: number;
  /** Stable error code surfaced by the failing entry. */
  code: string;
  /** Short, human-readable description of the failure. */
  message: string;
  /** Optional actionable hint (if the underlying error exposes one). */
  hint?: string;
  /**
   * Name of the underlying error class when the failure originated from a
   * domain-specific helper. This is useful for diagnostics without leaking the
   * full stack trace.
   */
  name?: string;
  /** Stage of the bulk pipeline that raised the failure (e.g. "spawn"). */
  stage?: string;
  /** Minimal subset of the entry payload to help callers identify the record. */
  entry: Record<string, unknown> | null;
}

/** Additional context returned alongside {@link BulkFailureDetail} entries. */
export interface BulkErrorDetails {
  /** Individual failures grouped under the aggregated error. */
  failures: BulkFailureDetail[];
  /** Indicates whether the handler rolled back previously applied mutations. */
  rolled_back: boolean;
  /** Optional feature-specific metadata exposed for debugging purposes. */
  metadata?: Record<string, unknown>;
}

/**
 * Error raised when a bulk request aborts before completing all its entries.
 * The class exposes a stable `E-BULK-PARTIAL` code so tool wrappers can
 * serialise the structured payload uniformly.
 */
export class BulkOperationError extends Error {
  /** Stable MCP code declaring the aggregated failure. */
  public readonly code = ERROR_CODES.BULK_PARTIAL;
  /** Hint instructing clients to inspect the attached `failures` array. */
  public readonly hint = "inspect_failures";
  /** Machine readable description of the partial failures. */
  public readonly details: BulkErrorDetails;

  constructor(message: string, details: BulkErrorDetails) {
    super(message);
    this.name = "BulkOperationError";
    this.details = details;
  }
}

/**
 * Builds a {@link BulkFailureDetail} entry from an arbitrary error object. The
 * helper extracts stable metadata (`code`, `hint`, `name`) when available while
 * falling back to sensible defaults so downstream consumers always receive a
 * predictable structure.
 */
export function buildBulkFailureDetail({
  index,
  entry,
  error,
  stage,
}: {
  /** Zero-based index of the failing entry. */
  index: number;
  /** Reduced view of the failing entry payload. */
  entry: Record<string, unknown> | null;
  /** Original error thrown by the helper responsible for the entry. */
  error: unknown;
  /** Optional lifecycle stage to disambiguate multi-phase handlers. */
  stage?: string;
}): BulkFailureDetail {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code: string }).code)
      : ERROR_CODES.BULK_PARTIAL;
  const hint =
    typeof (error as { hint?: unknown }).hint === "string"
      ? ((error as { hint: string }).hint)
      : undefined;
  const name = error instanceof Error && error.name ? error.name : undefined;

  const detail: BulkFailureDetail = {
    index,
    code,
    message,
    entry,
  };

  if (hint) {
    detail.hint = hint;
  }
  if (name) {
    detail.name = name;
  }
  if (stage) {
    detail.stage = stage;
  }

  return detail;
}
