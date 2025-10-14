import { z } from "zod";

import { GraphDiffSummarySchema } from "./graphApplyChangeSetSchemas.js";

/**
 * Enumerates the supported operations for the `graph_snapshot_time_travel`
 * façade. The contract intentionally mirrors the high level actions offered to
 * operators so both the HTTP transport and the CLI layer can forward the intent
 * verbatim without bespoke mapping.
 */
export const GRAPH_SNAPSHOT_TIME_TRAVEL_MODES = [
  "list",
  "preview",
  "restore",
] as const;

/** Literal union describing the accepted façade modes. */
export const GraphSnapshotTimeTravelModeSchema = z.enum(
  GRAPH_SNAPSHOT_TIME_TRAVEL_MODES,
);

/**
 * Canonical descriptor surfaced when enumerating the snapshots associated with
 * a graph. The structure is intentionally narrow so the response stays light
 * even when dozens of historical artefacts exist on disk.
 */
export const GraphSnapshotDescriptorSchema = z
  .object({
    snapshot_id: z.string().min(1),
    created_at: z.string().min(1),
    version: z.number().int().nonnegative().nullable(),
    committed_at: z.number().int().nonnegative().nullable(),
    tx_id: z.string().min(1).nullable(),
    size_bytes: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Diagnostic returned when the caller exhausts one of the enforced budget
 * dimensions (tool calls, bytes, ...). Keeping the structure aligned with the
 * other façades makes telemetry aggregation straightforward.
 */
export const GraphSnapshotBudgetDiagnosticSchema = z
  .object({
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

/**
 * Error descriptor surfaced when the façade cannot serve the requested action.
 * The `reason` acts as a programmatic discriminator while `message` offers a
 * short human hint.
 */
export const GraphSnapshotTimeTravelErrorSchema = z
  .object({
    reason: z.enum([
      "graph_not_found",
      "snapshot_not_found",
      "invalid_snapshot",
      "validation_failed",
    ]),
    message: z.string().min(1),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Shared attributes present in every façade response regardless of the mode.
 * Additional fields extend this base definition for specific scenarios (list
 * versus restore for instance).
 */
export const GraphSnapshotTimeTravelBaseDetailsSchema = z
  .object({
    idempotency_key: z.string().min(1),
    graph_id: z.string().min(1),
    mode: GraphSnapshotTimeTravelModeSchema,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Details returned when listing the available snapshots. */
export const GraphSnapshotTimeTravelListDetailsSchema =
  GraphSnapshotTimeTravelBaseDetailsSchema.extend({
    mode: z.literal("list"),
    snapshots: z.array(GraphSnapshotDescriptorSchema).optional(),
    budget: GraphSnapshotBudgetDiagnosticSchema.optional(),
    error: GraphSnapshotTimeTravelErrorSchema.optional(),
  }).superRefine((details, ctx) => {
    if (!details.error && !details.budget && !details.snapshots) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "snapshots must be provided when no budget/error diagnostic is present",
        path: ["snapshots"],
      });
    }
  });

/** Details returned when the caller previews a historical snapshot. */
export const GraphSnapshotTimeTravelPreviewDetailsSchema =
  GraphSnapshotTimeTravelBaseDetailsSchema.extend({
    mode: z.literal("preview"),
    snapshot_id: z.string().min(1).optional(),
    nodes: z.number().int().nonnegative().optional(),
    edges: z.number().int().nonnegative().optional(),
    version: z.number().int().nonnegative().nullable().optional(),
    committed_at: z.number().int().nonnegative().nullable().optional(),
    tx_id: z.string().min(1).nullable().optional(),
    diff_summary: GraphDiffSummarySchema.optional(),
    graph_hash: z.string().length(64).optional(),
    included_graph: z.boolean().optional(),
    graph: z.unknown().optional(),
    budget: GraphSnapshotBudgetDiagnosticSchema.optional(),
    error: GraphSnapshotTimeTravelErrorSchema.optional(),
  }).superRefine((details, ctx) => {
    if (details.error || details.budget) {
      return;
    }
    const required: Array<[keyof typeof details, unknown]> = [
      ["snapshot_id", details.snapshot_id],
      ["nodes", details.nodes],
      ["edges", details.edges],
      ["graph_hash", details.graph_hash],
      ["included_graph", details.included_graph],
    ];
    for (const [key, value] of required) {
      if (value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${String(key)} must be provided when the preview succeeds`,
          path: [key],
        });
      }
    }
  });

/** Details returned when restoring a graph from a historical snapshot. */
export const GraphSnapshotTimeTravelRestoreDetailsSchema =
  GraphSnapshotTimeTravelBaseDetailsSchema.extend({
    mode: z.literal("restore"),
    snapshot_id: z.string().min(1).optional(),
    base_version: z.number().int().nonnegative().optional(),
    restored_version: z.number().int().positive().nullable().optional(),
    restored_at: z.number().int().nonnegative().nullable().optional(),
    nodes: z.number().int().nonnegative().optional(),
    edges: z.number().int().nonnegative().optional(),
    diff_summary: GraphDiffSummarySchema.optional(),
    idempotent: z.boolean().optional(),
    budget: GraphSnapshotBudgetDiagnosticSchema.optional(),
    error: GraphSnapshotTimeTravelErrorSchema.optional(),
  }).superRefine((details, ctx) => {
    if (details.error || details.budget) {
      return;
    }
    const required: Array<[keyof typeof details, unknown]> = [
      ["snapshot_id", details.snapshot_id],
      ["base_version", details.base_version],
      ["restored_version", details.restored_version],
      ["restored_at", details.restored_at],
      ["nodes", details.nodes],
      ["edges", details.edges],
      ["idempotent", details.idempotent],
    ];
    for (const [key, value] of required) {
      if (value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${String(key)} must be provided when the restore succeeds`,
          path: [key],
        });
      }
    }
  });

/**
 * Union capturing every possible detail payload. Consumers can discriminate on
 * the `mode` field to refine the structure at runtime without additional tags.
 */
export const GraphSnapshotTimeTravelDetailsSchema = z.union([
  GraphSnapshotTimeTravelListDetailsSchema,
  GraphSnapshotTimeTravelPreviewDetailsSchema,
  GraphSnapshotTimeTravelRestoreDetailsSchema,
]);

/** Input payload accepted by the façade. */
export const GraphSnapshotTimeTravelInputSchema = z
  .object({
    graph_id: z.string().trim().min(1).max(200),
    mode: GraphSnapshotTimeTravelModeSchema.optional(),
    snapshot_id: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().positive().max(50).optional(),
    include_graph: z.boolean().optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Output payload returned by the façade. */
export const GraphSnapshotTimeTravelOutputSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string(),
    details: GraphSnapshotTimeTravelDetailsSchema,
  })
  .strict();

export type GraphSnapshotTimeTravelMode = z.infer<
  typeof GraphSnapshotTimeTravelModeSchema
>;
export type GraphSnapshotDescriptor = z.infer<
  typeof GraphSnapshotDescriptorSchema
>;
export type GraphSnapshotTimeTravelInput = z.infer<
  typeof GraphSnapshotTimeTravelInputSchema
>;
export type GraphSnapshotTimeTravelOutput = z.infer<
  typeof GraphSnapshotTimeTravelOutputSchema
>;
