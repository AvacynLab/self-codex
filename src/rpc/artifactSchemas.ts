import { z } from "zod";

/**
 * Enumerates the Node.js buffer encodings accepted by the artifact façades when
 * callers provide textual payloads. The union mirrors the native
 * {@link BufferEncoding} string literals while omitting rarely used legacy
 * encodings (e.g. `utf16le` already covers `ucs2`).
 */
export const ARTIFACT_BUFFER_ENCODINGS = [
  "ascii",
  "utf8",
  "utf-8",
  "utf16le",
  "ucs2",
  "ucs-2",
  "base64",
  "base64url",
  "latin1",
  "binary",
  "hex",
] as const;

/** Schema validating accepted buffer encodings. */
export const ArtifactEncodingSchema = z.enum(ARTIFACT_BUFFER_ENCODINGS);

/** Shared shape echoed in every façade response so logs stay consistent. */
export const ArtifactOperationContextSchema = z
  .object({
    idempotency_key: z.string().min(1),
    child_id: z.string().min(1),
    path: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Diagnostic surfaced when the request exhausted its resource budget. */
export const ArtifactBudgetDiagnosticSchema = z
  .object({
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

/** Error payload surfaced when the façade could not perform the requested IO. */
export const ArtifactOperationErrorSchema = z
  .object({
    reason: z.enum(["artifact_not_found", "io_error"]),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
  })
  .strict();

/** Input payload accepted by the `artifact_write` façade. */
export const ArtifactWriteInputSchema = z
  .object({
    child_id: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(4096),
    content: z.string(),
    encoding: ArtifactEncodingSchema.optional(),
    mime_type: z.string().trim().min(1).max(200),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Successful response details produced by the `artifact_write` façade. */
export const ArtifactWriteSuccessDetailsSchema = ArtifactOperationContextSchema.extend({
  bytes_written: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  mime_type: z.string().min(1),
  sha256: z.string().length(64),
  idempotent: z.boolean(),
});

/** Union describing the possible diagnostic payloads for `artifact_write`. */
export const ArtifactWriteDetailsSchema = ArtifactOperationContextSchema.extend({
  bytes_written: z.number().int().nonnegative().optional(),
  size: z.number().int().nonnegative().optional(),
  mime_type: z.string().min(1).optional(),
  sha256: z.string().length(64).optional(),
  idempotent: z.boolean().optional(),
  budget: ArtifactBudgetDiagnosticSchema.optional(),
  error: ArtifactOperationErrorSchema.optional(),
});

/** Output payload returned by the `artifact_write` façade. */
export const ArtifactWriteOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string(),
    details: ArtifactWriteDetailsSchema,
  })
  .strict();

/** Input payload accepted by the `artifact_read` façade. */
export const ArtifactReadInputSchema = z
  .object({
    child_id: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1).max(4096),
    format: z.enum(["text", "base64"]).optional(),
    encoding: ArtifactEncodingSchema.optional(),
    max_bytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Details surfaced when `artifact_read` succeeds. */
export const ArtifactReadSuccessDetailsSchema = ArtifactOperationContextSchema.extend({
  format: z.enum(["text", "base64"]),
  bytes_returned: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  truncated: z.boolean().optional(),
  content: z.string().optional(),
});

/** Structured payload returned by the `artifact_read` façade. */
export const ArtifactReadDetailsSchema = ArtifactOperationContextSchema.extend({
  format: z.enum(["text", "base64"]).optional(),
  bytes_returned: z.number().int().nonnegative().optional(),
  size: z.number().int().nonnegative().optional(),
  sha256: z.string().length(64).optional(),
  truncated: z.boolean().optional(),
  content: z.string().optional(),
  budget: ArtifactBudgetDiagnosticSchema.optional(),
  error: ArtifactOperationErrorSchema.optional(),
});

/** Output payload returned by the `artifact_read` façade. */
export const ArtifactReadOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string(),
    details: ArtifactReadDetailsSchema,
  })
  .strict();

/** Input payload accepted by the `artifact_search` façade. */
export const ArtifactSearchInputSchema = z
  .object({
    child_id: z.string().trim().min(1).max(200),
    query: z.string().trim().min(1).max(200).optional(),
    mime_types: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    limit: z.number().int().positive().max(500).optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Individual artifact entry returned by `artifact_search`. */
export const ArtifactSearchResultEntrySchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    mime_type: z.string().min(1),
    sha256: z.string().length(64),
  })
  .strict();

/** Structured payload returned by the `artifact_search` façade. */
export const ArtifactSearchDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    child_id: z.string().min(1),
    total: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    filters: z
      .object({
        query: z.string().min(1).optional(),
        mime_types: z.array(z.string().min(1)).optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict(),
    artifacts: z.array(ArtifactSearchResultEntrySchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
    budget: ArtifactBudgetDiagnosticSchema.optional(),
  })
  .strict();

/** Output payload returned by the `artifact_search` façade. */
export const ArtifactSearchOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string(),
    details: ArtifactSearchDetailsSchema,
  })
  .strict();

export type ArtifactWriteInput = z.infer<typeof ArtifactWriteInputSchema>;
export type ArtifactWriteOutput = z.infer<typeof ArtifactWriteOutputSchema>;
export type ArtifactReadInput = z.infer<typeof ArtifactReadInputSchema>;
export type ArtifactReadOutput = z.infer<typeof ArtifactReadOutputSchema>;
export type ArtifactSearchInput = z.infer<typeof ArtifactSearchInputSchema>;
export type ArtifactSearchOutput = z.infer<typeof ArtifactSearchOutputSchema>;
