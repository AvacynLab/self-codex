import { z } from "zod";

/**
 * Ordered list of sections that the runtime_observe façade can populate. Keeping
 * the literal values centralised guarantees that both the handler and schema
 * remain aligned whenever a new section is introduced.
 */
export const RUNTIME_OBSERVE_SECTIONS = ["snapshot", "metrics"] as const;

/** Literal schema guarding the allowed section identifiers. */
export const RuntimeObserveSectionSchema = z.enum(RUNTIME_OBSERVE_SECTIONS);

/**
 * Schema describing the optional filters accepted by the façade. All knobs are
 * optional so operators can quickly inspect the orchestrator without having to
 * provide additional context. Sections default to both "snapshot" and
 * "metrics" when omitted.
 */
export const RuntimeObserveInputSchema = z
  .object({
    sections: z
      .array(RuntimeObserveSectionSchema)
      .min(1)
      .max(RUNTIME_OBSERVE_SECTIONS.length)
      .optional()
      .refine((value) => {
        if (!value) {
          return true;
        }
        return new Set(value).size === value.length;
      }, "les sections doivent être uniques"),
    methods: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(50)
      .optional(),
    limit: z.number().int().positive().max(50).optional(),
    include_error_codes: z.boolean().optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string().trim().min(1), z.unknown()).optional(),
  })
  .strict();

/** Shape used to register the schema with the MCP transport layer. */
export const RuntimeObserveInputShape = RuntimeObserveInputSchema.shape;

/** Schema validating the public HTTP transport snapshot. */
const RuntimeObserveHttpTransportSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().min(1).nullable(),
    port: z.number().int().nullable(),
    path: z.string().trim().min(1).nullable(),
    enableJson: z.boolean(),
    stateless: z.boolean(),
  })
  .strict();

/** Schema validating the stdio transport snapshot. */
const RuntimeObserveStdioTransportSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

/** Schema describing the runtime snapshot persisted in memory. */
export const RuntimeObserveSnapshotSchema = z
  .object({
    server: z
      .object({
        name: z.string().trim().min(1),
        version: z.string().trim().min(1),
        protocol: z.string().trim().min(1),
      })
      .strict(),
    transports: z
      .object({
        stdio: RuntimeObserveStdioTransportSchema,
        http: RuntimeObserveHttpTransportSchema,
      })
      .strict(),
    features: z.record(z.string().trim().min(1), z.boolean()),
    timings: z
      .object({
        btTickMs: z.number().nonnegative(),
        stigHalfLifeMs: z.number().nonnegative(),
        supervisorStallTicks: z.number().int().nonnegative(),
        defaultTimeoutMs: z.number().nonnegative(),
        autoscaleCooldownMs: z.number().nonnegative(),
        heartbeatIntervalMs: z.number().nonnegative(),
      })
      .strict(),
    safety: z
      .object({
        maxChildren: z.number().int().nonnegative(),
        memoryLimitMb: z.number().int().nonnegative(),
        cpuPercent: z.number().int().nonnegative(),
      })
      .strict(),
    limits: z
      .object({
        maxInputBytes: z.number().int().nonnegative(),
        defaultTimeoutMs: z.number().int().nonnegative(),
        maxEventHistory: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/** Schema describing the per-method latency metrics surfaced by the façade. */
export const RuntimeObserveMethodMetricSchema = z
  .object({
    method: z.string().trim().min(1),
    count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    p50_ms: z.number().nonnegative(),
    p95_ms: z.number().nonnegative(),
    p99_ms: z.number().nonnegative(),
    error_codes: z.record(z.string().trim().min(1), z.number().int().nonnegative()).optional(),
  })
  .strict();

/** Diagnostic object attached when the request exhausts its budget. */
export const RuntimeObserveBudgetDiagnosticSchema = z
  .object({
    reason: z.literal("budget_exhausted"),
    dimension: z.string().trim().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

/** Schema validating the structured result returned by the façade. */
export const RuntimeObserveOutputDetailsSchema = z
  .object({
    idempotency_key: z.string().trim().min(1),
    sections: z.array(RuntimeObserveSectionSchema).min(1),
    snapshot: RuntimeObserveSnapshotSchema.optional(),
    metrics: z
      .object({
        total_methods: z.number().int().nonnegative(),
        returned_methods: z.number().int().nonnegative(),
        methods: z.array(RuntimeObserveMethodMetricSchema),
      })
      .strict()
      .optional(),
    metadata: z.record(z.string().trim().min(1), z.unknown()).optional(),
    budget: RuntimeObserveBudgetDiagnosticSchema.optional(),
  })
  .strict();

/** Complete output schema enforced by the handler. */
export const RuntimeObserveOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string().trim().min(1),
    details: RuntimeObserveOutputDetailsSchema,
  })
  .strict();

export type RuntimeObserveInput = z.infer<typeof RuntimeObserveInputSchema>;
export type RuntimeObserveOutput = z.infer<typeof RuntimeObserveOutputSchema>;
export type RuntimeObserveMethodMetric = z.infer<typeof RuntimeObserveMethodMetricSchema>;
export type RuntimeObserveSnapshot = z.infer<typeof RuntimeObserveSnapshotSchema>;
export type RuntimeObserveBudgetDiagnostic = z.infer<typeof RuntimeObserveBudgetDiagnosticSchema>;
