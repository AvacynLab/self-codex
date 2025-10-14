import { z } from "zod";

/**
 * Schema validating the optional workspace root parameter accepted by the
 * `project_scaffold_run` façade. The value is trimmed and bounded to avoid
 * storing unreasonably long paths inside the idempotency cache key.
 */
const ProjectScaffoldWorkspaceRootSchema = z.string().trim().min(1).max(400);

/** Regular expression enforcing the `YYYY-MM-DD` date contract. */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Input contract enforced by the façade handler. */
export const ProjectScaffoldRunInputSchema = z
  .object({
    workspace_root: ProjectScaffoldWorkspaceRootSchema.optional(),
    iso_date: z
      .string()
      .trim()
      .min(10)
      .max(10)
      .regex(ISO_DATE_REGEX, "la date doit suivre le format YYYY-MM-DD")
      .optional(),
    create_gitkeep_files: z.boolean().optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional(),
    metadata: z.record(z.string().trim().min(1), z.unknown()).optional(),
  })
  .strict();

/** Shape surfaced to the MCP runtime for JSON-RPC schema registration. */
export const ProjectScaffoldRunInputShape = ProjectScaffoldRunInputSchema.shape;

/** Schema describing the directory layout produced by the façade. */
export const ProjectScaffoldRunDirectoriesSchema = z
  .object({
    inputs: z.string().trim().min(1),
    outputs: z.string().trim().min(1),
    events: z.string().trim().min(1),
    logs: z.string().trim().min(1),
    artifacts: z.string().trim().min(1),
    report: z.string().trim().min(1),
  })
  .strict();

/** Diagnostic surfaced when the budget is exhausted before the scaffold completes. */
export const ProjectScaffoldRunBudgetDiagnosticSchema = z
  .object({
    reason: z.literal("budget_exhausted"),
    dimension: z.string().trim().min(1),
    attempted: z.number().nonnegative(),
    remaining: z.number().nonnegative(),
    limit: z.number().nonnegative(),
  })
  .strict();

/** Diagnostic surfaced when the workspace root or filesystem operation fails. */
export const ProjectScaffoldRunErrorDiagnosticSchema = z
  .object({
    reason: z.enum(["invalid_workspace", "io_error"]),
    message: z.string().trim().min(1),
    hint: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * Structured payload returned by the façade. Optional fields are constrained via
 * the `superRefine` block to guarantee that successful executions expose the
 * expected artefacts while degraded outcomes surface diagnostics.
 */
export const ProjectScaffoldRunOutputDetailsSchema = z
  .object({
    idempotency_key: z.string().trim().min(1),
    run_id: z.string().trim().min(1).optional(),
    workspace_root: z.string().trim().min(1).optional(),
    root_dir: z.string().trim().min(1).optional(),
    directories: ProjectScaffoldRunDirectoriesSchema.optional(),
    idempotent: z.boolean().optional(),
    metadata: z.record(z.string().trim().min(1), z.unknown()).optional(),
    budget: ProjectScaffoldRunBudgetDiagnosticSchema.optional(),
    error: ProjectScaffoldRunErrorDiagnosticSchema.optional(),
  })
  .strict();

/** Complete output envelope validated by the façade. */
const ProjectScaffoldRunOutputBaseSchema = z
  .object({
    ok: z.boolean(),
    summary: z.string().trim().min(1),
    details: ProjectScaffoldRunOutputDetailsSchema,
  })
  .strict();

export const ProjectScaffoldRunOutputSchema = ProjectScaffoldRunOutputBaseSchema.superRefine((payload, ctx) => {
    if (payload.ok) {
      const details = payload.details;
      if (!details.run_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "run_id manquant dans une réponse réussie",
          path: ["details", "run_id"],
        });
      }
      if (!details.root_dir) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "root_dir manquant dans une réponse réussie",
          path: ["details", "root_dir"],
        });
      }
      if (!details.directories) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "directories manquant dans une réponse réussie",
          path: ["details", "directories"],
        });
      }
      if (typeof details.idempotent !== "boolean") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "idempotent doit être défini pour une réponse réussie",
          path: ["details", "idempotent"],
        });
      }
    } else {
      const details = payload.details;
      if (!details.budget && !details.error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "une réponse dégradée doit contenir un diagnostic budget ou erreur",
          path: ["details"],
        });
      }
    }
  });

export const ProjectScaffoldRunOutputShape = ProjectScaffoldRunOutputBaseSchema.shape;

/** TypeScript helper referencing the parsed output shape. */
export type ProjectScaffoldRunOutput = z.infer<typeof ProjectScaffoldRunOutputSchema>;

/** TypeScript helper referencing the parsed input shape. */
export type ProjectScaffoldRunInput = z.infer<typeof ProjectScaffoldRunInputSchema>;
