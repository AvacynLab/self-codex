import { z } from "zod";

/**
 * Options describing the sandbox environment requested when orchestrating a
 * child runtime. Profiles control network access, environment inheritance and
 * memory ceilings to keep test fixtures aligned with production defaults.
 */
export const ChildOrchestrateSandboxSchema = z
  .object({
    profile: z.enum(["strict", "standard", "permissive"]).optional(),
    allow_env: z
      .array(z.string().min(1, "allow_env entries must be non-empty strings"))
      .max(64, "cannot allow more than 64 environment variables")
      .optional(),
    env: z.record(z.string()).optional(),
    inherit_default_env: z.boolean().optional(),
  })
  .strict();

const ChildOrchestrateLimitsValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const ChildOrchestrateSpawnRetrySchema = z
  .object({
    attempts: z.number().int().min(1).optional(),
    initial_delay_ms: z.number().int().nonnegative().optional(),
    backoff_factor: z.number().positive().optional(),
    max_delay_ms: z.number().int().positive().optional(),
  })
  .strict();

const ChildOrchestrateWaitSchema = z
  .object({
    timeout_ms: z.number().int().positive().optional(),
    stream: z.enum(["stdout", "stderr"]).optional(),
  })
  .strict();

export const ChildOrchestrateCollectSchema = z
  .object({
    include_messages: z.boolean().default(true),
    include_artifacts: z.boolean().default(true),
  })
  .strict();

const ChildOrchestrateShutdownSchema = z
  .object({
    mode: z.enum(["cancel", "kill"]).default("cancel"),
    signal: z.string().trim().min(1).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

/** Input payload accepted by the `child_orchestrate` façade. */
export const ChildOrchestrateInputSchema = z
  .object({
    idempotency_key: z.string().trim().min(1).optional(),
    child_id: z.string().trim().min(1).optional(),
    command: z.string().trim().min(1).optional(),
    args: z.array(z.string()).max(64).optional(),
    env: z.record(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    manifest_extras: z.record(z.unknown()).optional(),
    role: z.string().trim().max(120).optional(),
    tools_allow: z.array(z.string().trim().min(1)).max(32).optional(),
    limits: z
      .record(ChildOrchestrateLimitsValueSchema)
      .optional()
      .refine((value) => value === undefined || Object.keys(value).length > 0, {
        message: "limits must include at least one entry when provided",
      }),
    sandbox: ChildOrchestrateSandboxSchema.optional(),
    wait_for_ready: z.boolean().default(true),
    ready_type: z.string().trim().min(1).default("ready"),
    ready_timeout_ms: z.number().int().positive().optional(),
    spawn_retry: ChildOrchestrateSpawnRetrySchema.optional(),
    initial_payload: z.unknown().optional(),
    followup_payloads: z.array(z.unknown()).default([]),
    wait_for_message: ChildOrchestrateWaitSchema.optional(),
    collect: ChildOrchestrateCollectSchema.optional(),
    shutdown: ChildOrchestrateShutdownSchema.optional(),
  })
  .strict();

/** Alias exposed to the registry for JSON-RPC wiring. */
export const ChildOrchestrateInputShape = ChildOrchestrateInputSchema.shape;

/** Normalised child runtime message structure surfaced to clients. */
export const ChildOrchestrateRuntimeMessageSchema = z
  .object({
    stream: z.enum(["stdout", "stderr"]),
    raw: z.string(),
    parsed: z.unknown().nullable(),
    sequence: z.number().int().nonnegative(),
    received_at: z.number().int().nonnegative(),
  })
  .strict();

const ChildOrchestrateSendResultSchema = z
  .object({
    message_id: z.string().min(1),
    sent_at: z.number().int().nonnegative(),
  })
  .strict();

const ChildOrchestrateArtifactSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    mime_type: z.string().min(1),
    sha256: z.string().length(64),
  })
  .strict();

const ChildOrchestrateCollectedSchema = z
  .object({
    manifest_path: z.string().min(1),
    log_path: z.string().min(1),
    message_count: z.number().int().nonnegative(),
    artifact_count: z.number().int().nonnegative(),
    messages: z.array(ChildOrchestrateRuntimeMessageSchema).optional(),
    artifacts: z.array(ChildOrchestrateArtifactSchema).optional(),
  })
  .strict();

const ChildOrchestrateObservationSchema = z
  .object({
    message: ChildOrchestrateRuntimeMessageSchema.nullable(),
    error: z.string().min(1).optional(),
  })
  .strict();

const ChildOrchestrateShutdownResultSchema = z
  .object({
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    forced: z.boolean(),
    duration_ms: z.number().nonnegative(),
  })
  .strict();

/** Successful response details returned by the façade. */
export const ChildOrchestrateSuccessDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    child_id: z.string().min(1),
    ready_message: ChildOrchestrateRuntimeMessageSchema.nullable(),
    send_results: z.array(ChildOrchestrateSendResultSchema),
    observation: ChildOrchestrateObservationSchema.nullable(),
    collected: ChildOrchestrateCollectedSchema.nullable(),
    shutdown: ChildOrchestrateShutdownResultSchema.nullable(),
    idempotent: z.boolean(),
  })
  .strict();

const ChildOrchestrateBudgetDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

const ChildOrchestrateErrorDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    reason: z.literal("operation_failed"),
    message: z.string().min(1),
  })
  .strict();

/** Output payload surfaced by the façade. */
export const ChildOrchestrateOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string().min(1),
    details: z.union([
      ChildOrchestrateSuccessDetailsSchema,
      ChildOrchestrateBudgetDetailsSchema,
      ChildOrchestrateErrorDetailsSchema,
    ]),
  })
  .strict();

export type ChildOrchestrateInput = z.infer<typeof ChildOrchestrateInputSchema>;
export type ChildOrchestrateSuccessDetails = z.infer<typeof ChildOrchestrateSuccessDetailsSchema>;
export type ChildOrchestrateOutput = z.infer<typeof ChildOrchestrateOutputSchema>;
