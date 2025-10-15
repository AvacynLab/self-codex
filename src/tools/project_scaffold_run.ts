import { randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import { BudgetExceededError, type BudgetCharge } from "../infra/budget.js";
import { IdempotencyRegistry, buildIdempotencyCacheKey } from "../infra/idempotency.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import { StructuredLogger } from "../logger.js";
import type { ToolImplementation, ToolManifest, ToolManifestDraft, ToolRegistry } from "../mcp/registry.js";
import { resolveWorkspacePath, PathResolutionError } from "../paths.js";
import { initializeValidationRunLayout } from "../validation/runLayout.js";
import {
  ProjectScaffoldRunBudgetDiagnosticSchema,
  ProjectScaffoldRunErrorDiagnosticSchema,
  ProjectScaffoldRunInputSchema,
  ProjectScaffoldRunOutputShape,
  ProjectScaffoldRunOutputSchema,
  type ProjectScaffoldRunInput,
  type ProjectScaffoldRunOutput,
} from "../rpc/schemas.js";

/** Canonical façade identifier exposed through the manifest catalogue. */
export const PROJECT_SCAFFOLD_RUN_TOOL_NAME = "project_scaffold_run" as const;

/**
 * Draft manifest describing the façade during registration. Tags include
 * `facade` so that the tool remains visible in basic exposure mode while the
 * `authoring` pack surfaces it to project bootstrap workflows.
 */
export const ProjectScaffoldRunManifestDraft: ToolManifestDraft = {
  name: PROJECT_SCAFFOLD_RUN_TOOL_NAME,
  title: "Initialiser une exécution de validation",
  description:
    "Prépare la structure de dossiers runs/validation_<DATE> attendue par les scripts de validation et retourne les chemins.",
  kind: "dynamic",
  category: "project",
  tags: ["facade", "authoring", "ops"],
  hidden: false,
  budgets: {
    time_ms: 2_000,
    tool_calls: 1,
    bytes_out: 8_192,
  },
};

/** Context forwarded to the façade handler. */
export interface ProjectScaffoldRunToolContext {
  /** Structured logger complying with the observability guidelines. */
  readonly logger: StructuredLogger;
  /** Default workspace root used when the caller does not override it. */
  readonly workspaceRoot: string;
  /** Optional idempotency registry storing scaffold results. */
  readonly idempotency?: IdempotencyRegistry;
  /** Optional clock override (primarily used in tests). */
  readonly now?: () => Date;
}

type RpcExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Serialises the structured result as a JSON payload for textual channels. */
function asJsonPayload(result: ProjectScaffoldRunOutput): string {
  return JSON.stringify({ tool: PROJECT_SCAFFOLD_RUN_TOOL_NAME, result }, null, 2);
}

/** Defensive clone so metadata provided by the caller cannot mutate handler state. */
function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(metadata));
}

/** Resolves the ISO date used to derive the validation run identifier. */
function resolveIsoDate(input: ProjectScaffoldRunInput["iso_date"], now: () => Date): string {
  if (input) {
    return input.trim();
  }
  return now().toISOString().slice(0, 10);
}

/** Builds the validation run identifier for the provided ISO date. */
function buildRunId(isoDate: string): string {
  return `validation_${isoDate}`;
}

/**
 * Builds the degraded response returned when the workspace root escapes the
 * sandbox or cannot be resolved.
 */
function buildWorkspaceErrorResult(
  idempotencyKey: string,
  runId: string,
  requestedWorkspace: string,
  metadata: Record<string, unknown> | undefined,
  error: PathResolutionError,
): ProjectScaffoldRunOutput {
  const diagnostic = ProjectScaffoldRunErrorDiagnosticSchema.parse({
    reason: "invalid_workspace",
    message: error.message,
    hint: error.hint,
  });
  return ProjectScaffoldRunOutputSchema.parse({
    ok: false,
    summary: "impossible de préparer la structure de validation : workspace invalide",
    details: {
      idempotency_key: idempotencyKey,
      run_id: runId,
      workspace_root: requestedWorkspace,
      metadata,
      error: diagnostic,
    },
  });
}

/** Builds the degraded response returned when filesystem operations fail. */
function buildIoErrorResult(
  idempotencyKey: string,
  runId: string,
  workspaceRoot: string,
  metadata: Record<string, unknown> | undefined,
  error: unknown,
): ProjectScaffoldRunOutput {
  const diagnostic = ProjectScaffoldRunErrorDiagnosticSchema.parse({
    reason: "io_error",
    message: error instanceof Error ? error.message : String(error),
  });
  return ProjectScaffoldRunOutputSchema.parse({
    ok: false,
    summary: "échec de la création de la structure de validation",
    details: {
      idempotency_key: idempotencyKey,
      run_id: runId,
      workspace_root: workspaceRoot,
      metadata,
      error: diagnostic,
    },
  });
}

/** Builds the degraded response returned when the request budget is exhausted. */
function buildBudgetExceededResult(
  idempotencyKey: string,
  runId: string,
  workspaceRoot: string,
  metadata: Record<string, unknown> | undefined,
  error: BudgetExceededError,
): ProjectScaffoldRunOutput {
  const diagnostic = ProjectScaffoldRunBudgetDiagnosticSchema.parse({
    reason: "budget_exhausted",
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  });
  return ProjectScaffoldRunOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant la préparation de la structure de validation",
    details: {
      idempotency_key: idempotencyKey,
      run_id: runId,
      workspace_root: workspaceRoot,
      metadata,
      budget: diagnostic,
    },
  });
}

/** Resolves the workspace root, enforcing sandbox constraints. */
function resolveWorkspaceRoot(base: string, override?: string): string {
  if (!override) {
    return base;
  }
  return resolveWorkspacePath(override, { baseDir: base });
}

/**
 * Creates the façade handler. The implementation validates inputs, enforces
 * budgets, prepares the run structure and emits correlated logs.
 */
export function createProjectScaffoldRunHandler(context: ProjectScaffoldRunToolContext): ToolImplementation {
  return async function handleProjectScaffoldRun(input: unknown, extra: RpcExtra): Promise<CallToolResult> {
    const parsed = ProjectScaffoldRunInputSchema.parse(
      input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
    );

    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();
    const metadata = cloneMetadata(parsed.metadata);

    const clock = context.now ?? (() => new Date());
    const isoDate = resolveIsoDate(parsed.iso_date, clock);
    const runId = buildRunId(isoDate);

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    let workspaceRoot: string;
    try {
      workspaceRoot = resolveWorkspaceRoot(context.workspaceRoot, parsed.workspace_root);
    } catch (error) {
      if (error instanceof PathResolutionError) {
        context.logger.warn("project_scaffold_run_workspace_invalid", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          workspace_root: parsed.workspace_root ?? context.workspaceRoot,
          error: error.message,
        });
        const structured = buildWorkspaceErrorResult(idempotencyKey, runId, parsed.workspace_root ?? context.workspaceRoot, metadata, error);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(structured) }],
          structuredContent: structured,
        };
      }
      throw error;
    }

    let charge: BudgetCharge | null = null;
    try {
      if (rpcContext?.budget) {
        charge = rpcContext.budget.consume(
          { toolCalls: 1 },
          { actor: "facade", operation: PROJECT_SCAFFOLD_RUN_TOOL_NAME, detail: "scaffold_run" },
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        context.logger.warn("project_scaffold_run_budget_exhausted", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          dimension: error.dimension,
          attempted: error.attempted,
          remaining: error.remaining,
          limit: error.limit,
        });
        const structured = buildBudgetExceededResult(idempotencyKey, runId, workspaceRoot, metadata, error);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(structured) }],
          structuredContent: structured,
        };
      }
      throw error;
    }

    const createGitkeep = parsed.create_gitkeep_files ?? false;
    const fingerprint = {
      workspace_root: workspaceRoot,
      iso_date: isoDate,
      create_gitkeep_files: createGitkeep,
      metadata,
    };

    const execute = async () =>
      await initializeValidationRunLayout({
        workspaceRoot,
        isoDate,
        createGitkeepFiles: createGitkeep,
      });

    let idempotent = false;
    let layout: Awaited<ReturnType<typeof initializeValidationRunLayout>>;

    if (context.idempotency) {
      const cacheKey = buildIdempotencyCacheKey(PROJECT_SCAFFOLD_RUN_TOOL_NAME, idempotencyKey, fingerprint);
      try {
        const hit = await context.idempotency.remember(cacheKey, execute);
        layout = hit.value;
        idempotent = hit.idempotent;
      } catch (error) {
        context.logger.error("project_scaffold_run_idempotency_failed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        const structured = buildIoErrorResult(idempotencyKey, runId, workspaceRoot, metadata, error);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(structured) }],
          structuredContent: structured,
        };
      }
    } else {
      try {
        layout = await execute();
      } catch (error) {
        context.logger.error("project_scaffold_run_failed", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        const structured = buildIoErrorResult(idempotencyKey, runId, workspaceRoot, metadata, error);
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(structured) }],
          structuredContent: structured,
        };
      }
    }

    const structured = ProjectScaffoldRunOutputSchema.parse({
      ok: true,
      summary: idempotent
        ? `structure de validation déjà prête pour ${layout.runId}`
        : `structure de validation initialisée pour ${layout.runId}`,
      details: {
        idempotency_key: idempotencyKey,
        run_id: layout.runId,
        workspace_root: workspaceRoot,
        root_dir: layout.rootDir,
        directories: layout.directories,
        idempotent,
        ...(metadata ? { metadata } : {}),
      },
    });

    context.logger.info("project_scaffold_run_completed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      run_id: layout.runId,
      workspace_root: workspaceRoot,
      root_dir: layout.rootDir,
      idempotent,
      created_directories: Object.values(layout.directories).length,
    });

    if (rpcContext?.budget && charge) {
      rpcContext.budget.snapshot();
    }

    return {
      content: [{ type: "text", text: asJsonPayload(structured) }],
      structuredContent: structured,
    };
  };
}

/** Registers the façade with the tool registry. */
export async function registerProjectScaffoldRunTool(
  registry: ToolRegistry,
  context: ProjectScaffoldRunToolContext,
): Promise<ToolManifest> {
  return await registry.register(ProjectScaffoldRunManifestDraft, createProjectScaffoldRunHandler(context), {
    inputSchema: ProjectScaffoldRunInputSchema.shape,
    outputSchema: ProjectScaffoldRunOutputShape,
    annotations: { intent: "project_setup" },
  });
}
