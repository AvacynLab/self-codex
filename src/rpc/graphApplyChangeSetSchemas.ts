import { z } from "zod";

/** Allowed primitive values stored in graph metadata or attributes. */
const GraphAttributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** JSON pointer segment represented as a plain string. */
const GraphChangePathSegmentSchema = z.string().min(1, "path segments must not be empty");

/**
 * Declarative change applied to the committed graph. The façade converts the
 * path segments into RFC 6901 pointers before executing the underlying patch
 * operations.
 */
export const GraphChangeOperationSchema = z
  .object({
    op: z.enum(["add", "update", "remove"]),
    path: z.array(GraphChangePathSegmentSchema).min(1, "a path must be provided"),
    value: z.unknown().optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.op === "remove" && operation.value !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remove operations must not declare a value",
        path: ["value"],
      });
    }
    if (operation.op !== "remove" && operation.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "add/update operations must provide a value",
        path: ["value"],
      });
    }
  });

/** Record describing graph-level metadata. */
const GraphAttributeRecordSchema = z.record(GraphAttributeValueSchema);

/** Descriptor for a single graph node. */
const GraphNodeSchema = z
  .object({
    id: z.string().min(1, "node id must not be empty"),
    label: z.string().optional(),
    attributes: GraphAttributeRecordSchema.optional(),
  })
  .strict();

/** Descriptor for a single directed edge. */
const GraphEdgeSchema = z
  .object({
    from: z.string().min(1, "edge source must not be empty"),
    to: z.string().min(1, "edge target must not be empty"),
    label: z.string().optional(),
    weight: z.number().finite().optional(),
    attributes: GraphAttributeRecordSchema.optional(),
  })
  .strict();

/** Serialised representation of a graph returned to façade callers. */
export const GraphDescriptorSchema = z
  .object({
    name: z.string().min(1),
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
    metadata: GraphAttributeRecordSchema.optional(),
    graph_id: z.string().min(1),
    graph_version: z.number().int().nonnegative(),
  })
  .strict();

/** RFC 6902 operation surfaced in the diff summary. */
export const GraphPatchOperationSchema = z
  .object({
    op: z.enum(["add", "remove", "replace"]),
    path: z.string().min(1),
    value: z.unknown().optional(),
  })
  .strict();

/** High level summary of the diff between the committed and mutated graphs. */
export const GraphDiffSummarySchema = z
  .object({
    name_changed: z.boolean(),
    metadata_changed: z.boolean(),
    nodes_changed: z.boolean(),
    edges_changed: z.boolean(),
  })
  .strict();

/** Individual validation issue surfaced when a graph violates invariants. */
export const GraphValidationIssueSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().min(1),
    hint: z.string().min(1).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Structural validation outcome echoed in the façade response. */
export const GraphApplyChangeSetValidationSchema = z
  .object({
    ok: z.boolean(),
    violations: z.array(GraphValidationIssueSchema).optional(),
  })
  .strict()
  .superRefine((validation, ctx) => {
    if (!validation.ok && (!validation.violations || validation.violations.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "violations must be provided when validation fails",
        path: ["violations"],
      });
    }
  });

/** Report describing invariant evaluation outcomes. */
export const GraphInvariantReportSchema = z.union([
  z
    .object({
      ok: z.literal(true),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      violations: z.array(GraphValidationIssueSchema).min(1),
    })
    .strict(),
]);

/** Successful response payload returned by the façade. */
export const GraphApplyChangeSetSuccessDetailsSchema = z
  .object({
    op_id: z.string().min(1),
    idempotency_key: z.string().min(1),
    graph_id: z.string().min(1),
    base_version: z.number().int().nonnegative(),
    committed_version: z.number().int().nonnegative().nullable(),
    committed_at: z.number().int().nonnegative().nullable(),
    dry_run: z.boolean(),
    changed: z.boolean(),
    operations_requested: z.number().int().nonnegative(),
    operations_applied: z.number().int().nonnegative(),
    diff: z
      .object({
        operations: z.array(GraphPatchOperationSchema),
        summary: GraphDiffSummarySchema,
      })
      .strict(),
    graph: GraphDescriptorSchema,
    validation: GraphApplyChangeSetValidationSchema,
    invariants: GraphInvariantReportSchema.nullable(),
    rationale: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    idempotent: z.boolean(),
  })
  .strict();

/** Diagnostic returned when the request exceeds its allocated budget. */
export const GraphApplyChangeSetBudgetDetailsSchema = z
  .object({
    reason: z.literal("budget_exhausted"),
    dimension: z.string().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
    op_id: z.string().min(1),
    idempotency_key: z.string().min(1),
    graph_id: z.string().min(1),
  })
  .strict();

/** Diagnostic returned when validation fails before committing the change-set. */
export const GraphApplyChangeSetValidationFailureDetailsSchema = z
  .object({
    reason: z.literal("validation_failed"),
    op_id: z.string().min(1),
    idempotency_key: z.string().min(1),
    graph_id: z.string().min(1),
    base_version: z.number().int().nonnegative(),
    violations: z.array(GraphValidationIssueSchema).min(1),
  })
  .strict();

/** Input payload accepted by the `graph_apply_change_set` façade. */
export const GraphApplyChangeSetInputSchema = z
  .object({
    graph_id: z.string().trim().min(1).max(200),
    changes: z.array(GraphChangeOperationSchema).min(1).max(200),
    expected_version: z.number().int().nonnegative().optional(),
    rationale: z.string().trim().min(1).max(500).optional(),
    owner: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().min(1).max(240).optional(),
    dry_run: z.boolean().optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
    op_id: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Output payload returned by the `graph_apply_change_set` façade. */
export const GraphApplyChangeSetOutputSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      summary: z.string(),
      details: GraphApplyChangeSetSuccessDetailsSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      summary: z.string(),
      details: GraphApplyChangeSetBudgetDetailsSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      summary: z.string(),
      details: GraphApplyChangeSetValidationFailureDetailsSchema,
    })
    .strict(),
]);

export type GraphApplyChangeSetInput = z.infer<typeof GraphApplyChangeSetInputSchema>;
export type GraphApplyChangeSetOutput = z.infer<typeof GraphApplyChangeSetOutputSchema>;
export type GraphApplyChangeSetSuccessDetails = z.infer<typeof GraphApplyChangeSetSuccessDetailsSchema>;
export type GraphApplyChangeSetValidation = z.infer<typeof GraphApplyChangeSetValidationSchema>;
export type GraphChangeOperation = z.infer<typeof GraphChangeOperationSchema>;
