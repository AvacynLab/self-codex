import { randomUUID } from "node:crypto";

import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z, type EnumLike, type ZodDiscriminatedUnionOption, type ZodTypeAny, ZodFirstPartyTypeKind } from "zod";

import { BudgetExceededError, type BudgetCharge } from "../infra/budget.js";
import { getJsonRpcContext } from "../infra/jsonRpcContext.js";
import { getActiveTraceContext } from "../infra/tracing.js";
import { StructuredLogger } from "../logger.js";
import type {
  ToolManifest,
  ToolManifestDraft,
  ToolPack,
  ToolRegistry,
  ToolVisibilityMode,
  ToolImplementation,
} from "../mcp/registry.js";
import {
  resolveToolPackFromEnv,
  resolveToolVisibilityModeFromEnv,
} from "../mcp/registry.js";
import {
  TOOL_HELP_CATEGORIES,
  ToolsHelpBudgetDiagnosticSchema,
  ToolsHelpInputSchema,
  ToolsHelpOutputSchema,
  ToolsHelpPackSchema,
  ToolsHelpVisibilityModeSchema,
  type ToolsHelpInput,
  type ToolsHelpOutput,
  type ToolsHelpToolSummary,
} from "../rpc/schemas.js";

/** Canonical name advertised by the façade manifest. */
export const TOOLS_HELP_TOOL_NAME = "tools_help" as const;

/**
 * Draft manifest supplied to the ToolRegistry. Tags include `facade` so the
 * tool stays visible when the orchestrator runs in basic exposure mode.
 */
export const ToolsHelpManifestDraft: ToolManifestDraft = {
  name: TOOLS_HELP_TOOL_NAME,
  title: "Guide des outils",
  description: "Expose un aperçu filtrable des façades et primitives disponibles.",
  kind: "dynamic",
  category: "admin",
  tags: ["facade", "authoring", "ops"],
  hidden: false,
  budgets: {
    time_ms: 1_000,
    tool_calls: 1,
    bytes_out: 16_384,
  },
};

/**
 * Minimal registry interface consumed by the façade. Tests provide lightweight
 * implementations to assert the behaviour without requiring the full runtime
 * registry machinery.
 */
export interface ToolsHelpRegistryView {
  list(): ToolManifest[];
  listVisible(mode?: ToolVisibilityMode, pack?: ToolPack): ToolManifest[];
  describe(name: string): { manifest: ToolManifest; inputSchema?: ZodTypeAny } | undefined;
}

/** Context forwarded to the façade handler. */
export interface ToolsHelpToolContext {
  readonly registry: ToolsHelpRegistryView;
  readonly logger: StructuredLogger;
}

type ToolsHelpCategory = (typeof TOOL_HELP_CATEGORIES)[number];

/** Structure representing the filters used to build the façade response. */
interface ToolsHelpFilters {
  categories?: ToolsHelpCategory[];
  tags?: string[];
  search?: string;
  limit?: number;
}

/** Builds a serialisable JSON string for the textual channel. */
function asJsonPayload(result: ToolsHelpOutput): string {
  return JSON.stringify({ tool: TOOLS_HELP_TOOL_NAME, result }, null, 2);
}

/**
 * Normalises the optional filter fields provided by the caller into a compact
 * structure surfaced inside the response details and structured logs.
 */
function extractFilters(input: ToolsHelpInput): ToolsHelpFilters {
  const filters: ToolsHelpFilters = {};
  if (input.categories && input.categories.length > 0) {
    filters.categories = [...input.categories];
  }
  if (input.tags && input.tags.length > 0) {
    filters.tags = [...input.tags];
  }
  if (input.search && input.search.trim().length > 0) {
    filters.search = input.search.trim();
  }
  if (typeof input.limit === "number") {
    filters.limit = input.limit;
  }
  return filters;
}

/** Clones metadata records so callers cannot mutate internal references. */
function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(metadata));
}

/** Maximum recursion depth when constructing illustrative payloads. */
const EXAMPLE_MAX_DEPTH = 6;

/** Upper bound applied to the list of generated error diagnostics. */
const COMMON_ERROR_LIMIT = 8;

/**
 * Retrieves the enum backing object attached to a native enum schema while
 * preserving the original key/value pairs. Zod stores the runtime mapping in
 * the definition so we forward it to helper routines without double casting.
 */
function getNativeEnumValues<T extends EnumLike>(schema: z.ZodNativeEnum<T>): T {
  return schema._def.values;
}

/**
 * Returns the first option declared on a discriminated union. The helper keeps
 * the access to the private `_def` structure centralised and documented,
 * making the intent explicit where we only need a representative example.
 */
function getFirstDiscriminatedUnionOption<Discriminator extends string>(
  schema: z.ZodDiscriminatedUnion<Discriminator, readonly ZodDiscriminatedUnionOption<Discriminator>[]>,
): ZodDiscriminatedUnionOption<Discriminator> | undefined {
  const [first] = schema._def.options;
  return first;
}

/**
 * Formats a dot-separated JSON pointer starting from the payload root. The
 * helper keeps generated diagnostics human readable while remaining compact
 * enough for the textual channel.
 */
function formatPath(path: readonly string[]): string {
  if (path.length === 0) {
    return "payload";
  }
  return `payload.${path.join(".")}`;
}

/**
 * Produces a string value that satisfies the constraints attached to the Zod
 * string schema. Whenever a minimum length is specified the helper pads the
 * placeholder so the resulting payload validates without additional tweaks.
 */
function buildStringExample(schema: z.ZodString): string {
  let length = 5;
  for (const check of schema._def.checks ?? []) {
    if (check.kind === "min") {
      length = Math.max(length, Math.ceil(check.value));
    }
    if (check.kind === "max") {
      length = Math.min(length, Math.ceil(check.value));
    }
  }
  const safeLength = Number.isFinite(length) && length > 0 ? length : 5;
  return "x".repeat(Math.max(1, safeLength));
}

/**
 * Produces a number compatible with the provided schema. The helper honours
 * minimum bounds when present and defaults to zero otherwise to remain
 * intuitive for operators exploring the documentation payload.
 */
function buildNumberExample(schema: z.ZodNumber): number {
  let base = 0;
  for (const check of schema._def.checks ?? []) {
    if (check.kind === "min") {
      const candidate = check.inclusive ? check.value : check.value + 1;
      base = Math.max(base, candidate);
    }
    if (check.kind === "max") {
      const limit = check.inclusive ? check.value : check.value - 1;
      base = Math.min(base, limit);
    }
    if (check.kind === "multipleOf" && check.value > 0) {
      const multiplier = Math.ceil(base / check.value) || 1;
      base = check.value * multiplier;
    }
  }
  return base;
}

/** Selects the first serialisable value from a native enum definition. */
function pickNativeEnumValue(values: EnumLike): string | number {
  for (const candidate of Object.values(values)) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  const numeric = Object.values(values).find((value) => typeof value === "number");
  return (numeric as number | undefined) ?? "value";
}

/**
 * Recursively builds a JSON-serialisable payload satisfying the provided Zod
 * schema. Optional fields are intentionally skipped so the example stays
 * concise. Unknown constructs fall back to `null`, signalling that manual input
 * is required for those shapes.
 */
function buildExampleValue(schema: ZodTypeAny, depth = 0): unknown {
  if (depth > EXAMPLE_MAX_DEPTH) {
    return null;
  }

  const typeName = schema._def.typeName as ZodFirstPartyTypeKind;
  switch (typeName) {
    case ZodFirstPartyTypeKind.ZodString:
      return buildStringExample(schema as z.ZodString);
    case ZodFirstPartyTypeKind.ZodNumber:
      return buildNumberExample(schema as z.ZodNumber);
    case ZodFirstPartyTypeKind.ZodBoolean:
      return true;
    case ZodFirstPartyTypeKind.ZodEnum:
      return (schema as z.ZodEnum<[string, ...string[]]>).options[0];
    case ZodFirstPartyTypeKind.ZodNativeEnum:
      return pickNativeEnumValue(getNativeEnumValues(schema as z.ZodNativeEnum<EnumLike>));
    case ZodFirstPartyTypeKind.ZodLiteral:
      return (schema as z.ZodLiteral<unknown>)._def.value;
    case ZodFirstPartyTypeKind.ZodArray: {
      const arrayDef = schema as z.ZodArray<ZodTypeAny, "many">;
      const element = buildExampleValue(arrayDef._def.type, depth + 1);
      if (typeof arrayDef._def.minLength?.value === "number") {
        const count = Math.max(1, arrayDef._def.minLength.value);
        return Array.from({ length: count }, () => element);
      }
      return element === undefined ? [] : [element];
    }
    case ZodFirstPartyTypeKind.ZodSet: {
      const setDef = schema as z.ZodSet<ZodTypeAny>;
      const element = buildExampleValue(setDef._def.valueType, depth + 1);
      return element === undefined ? [] : [element];
    }
    case ZodFirstPartyTypeKind.ZodTuple: {
      const tupleDef = schema as z.ZodTuple<any>;
      return tupleDef._def.items.map((item: ZodTypeAny) => buildExampleValue(item, depth + 1));
    }
    case ZodFirstPartyTypeKind.ZodObject: {
      const objectDef = schema as z.ZodObject<Record<string, ZodTypeAny>>;
      const shape = objectDef.shape;
      const result: Record<string, unknown> = {};
      for (const [key, valueSchema] of Object.entries(shape)) {
        if (valueSchema.isOptional()) {
          continue;
        }
        const example = buildExampleValue(valueSchema, depth + 1);
        if (example !== undefined) {
          result[key] = example;
        }
      }
      return result;
    }
    case ZodFirstPartyTypeKind.ZodUnion: {
      const unionDef = schema as z.ZodUnion<[ZodTypeAny, ...ZodTypeAny[]]>;
      return buildExampleValue(unionDef._def.options[0], depth + 1);
    }
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const first = getFirstDiscriminatedUnionOption(
        schema as z.ZodDiscriminatedUnion<string, readonly ZodDiscriminatedUnionOption<string>[]>,
      );
      return first ? buildExampleValue(first, depth + 1) : null;
    }
    case ZodFirstPartyTypeKind.ZodIntersection: {
      const intersection = schema as z.ZodIntersection<ZodTypeAny, ZodTypeAny>;
      const left = buildExampleValue(intersection._def.left, depth + 1);
      const right = buildExampleValue(intersection._def.right, depth + 1);
      if (typeof left === "object" && left && typeof right === "object" && right) {
        return { ...(left as Record<string, unknown>), ...(right as Record<string, unknown>) };
      }
      return left ?? right ?? null;
    }
    case ZodFirstPartyTypeKind.ZodRecord: {
      const recordDef = schema as z.ZodRecord<ZodTypeAny, ZodTypeAny>;
      const value = buildExampleValue(recordDef._def.valueType, depth + 1);
      return value === undefined ? {} : { exemple_clef: value };
    }
    case ZodFirstPartyTypeKind.ZodEffects:
      return buildExampleValue((schema as z.ZodEffects<ZodTypeAny>)._def.schema, depth + 1);
    case ZodFirstPartyTypeKind.ZodOptional:
    case ZodFirstPartyTypeKind.ZodNullable:
    case ZodFirstPartyTypeKind.ZodReadonly:
      return buildExampleValue((schema as { _def: { innerType: ZodTypeAny } })._def.innerType, depth + 1);
    case ZodFirstPartyTypeKind.ZodDefault:
      return (schema as z.ZodDefault<ZodTypeAny>)._def.defaultValue();
    case ZodFirstPartyTypeKind.ZodBranded:
      return buildExampleValue((schema as z.ZodBranded<ZodTypeAny, string>)._def.type, depth + 1);
    case ZodFirstPartyTypeKind.ZodCatch:
      return buildExampleValue((schema as z.ZodCatch<ZodTypeAny>)._def.innerType, depth + 1);
    case ZodFirstPartyTypeKind.ZodPipeline:
      return buildExampleValue((schema as z.ZodPipeline<ZodTypeAny, ZodTypeAny>)._def.out, depth + 1);
    default:
      return null;
  }
}

/**
 * Generates a defensive deep-cloned example ensuring consumers cannot mutate
 * references used across requests. `undefined` indicates that no suitable
 * payload could be synthesised for the provided schema.
 */
function buildExampleFromSchema(schema: ZodTypeAny | undefined): unknown {
  if (!schema) {
    return undefined;
  }
  const raw = buildExampleValue(schema);
  if (typeof raw === "undefined") {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(raw));
  } catch {
    return raw;
  }
}

/**
 * Walks the schema to infer common validation mistakes so the façade can
 * surface actionable hints. Messages intentionally stay short and focus on
 * mandatory fields or tight constraints.
 */
function collectCommonErrors(schema: ZodTypeAny | undefined): string[] {
  if (!schema) {
    return [];
  }
  const hints = new Set<string>();

  function visit(current: ZodTypeAny, path: string[], depth: number): void {
    if (depth > EXAMPLE_MAX_DEPTH || hints.size >= COMMON_ERROR_LIMIT) {
      return;
    }
    const typeName = current._def.typeName as ZodFirstPartyTypeKind;
    switch (typeName) {
      case ZodFirstPartyTypeKind.ZodOptional:
      case ZodFirstPartyTypeKind.ZodNullable:
      case ZodFirstPartyTypeKind.ZodReadonly:
        visit((current as { _def: { innerType: ZodTypeAny } })._def.innerType, path, depth + 1);
        return;
      case ZodFirstPartyTypeKind.ZodDefault:
        return;
      case ZodFirstPartyTypeKind.ZodEffects:
        visit((current as z.ZodEffects<ZodTypeAny>)._def.schema, path, depth + 1);
        return;
      case ZodFirstPartyTypeKind.ZodBranded:
        visit((current as z.ZodBranded<ZodTypeAny, string>)._def.type, path, depth + 1);
        return;
      case ZodFirstPartyTypeKind.ZodCatch:
        visit((current as z.ZodCatch<ZodTypeAny>)._def.innerType, path, depth + 1);
        return;
      case ZodFirstPartyTypeKind.ZodPipeline:
        visit((current as z.ZodPipeline<ZodTypeAny, ZodTypeAny>)._def.out, path, depth + 1);
        return;
      case ZodFirstPartyTypeKind.ZodObject: {
        const objectDef = current as z.ZodObject<Record<string, ZodTypeAny>>;
        const shape = objectDef.shape;
        for (const [key, valueSchema] of Object.entries(shape)) {
          const nextPath = [...path, key];
          if (!valueSchema.isOptional()) {
            hints.add(`le champ "${formatPath(nextPath)}" est requis`);
            if (hints.size >= COMMON_ERROR_LIMIT) {
              return;
            }
          }
          visit(valueSchema, nextPath, depth + 1);
          if (hints.size >= COMMON_ERROR_LIMIT) {
            return;
          }
        }
        return;
      }
      case ZodFirstPartyTypeKind.ZodString: {
        for (const check of (current as z.ZodString)._def.checks ?? []) {
          if (check.kind === "min" && typeof check.value === "number") {
            hints.add(`${formatPath(path)} doit contenir au moins ${check.value} caractère(s)`);
          }
          if (check.kind === "max" && typeof check.value === "number") {
            hints.add(`${formatPath(path)} doit contenir au plus ${check.value} caractère(s)`);
          }
          if (check.kind === "regex") {
            hints.add(`${formatPath(path)} doit respecter le format attendu`);
          }
        }
        return;
      }
      case ZodFirstPartyTypeKind.ZodNumber: {
        for (const check of (current as z.ZodNumber)._def.checks ?? []) {
          if (check.kind === "min") {
            hints.add(`${formatPath(path)} doit être ≥ ${check.inclusive ? check.value : check.value + 1}`);
          }
          if (check.kind === "max") {
            hints.add(`${formatPath(path)} doit être ≤ ${check.inclusive ? check.value : check.value - 1}`);
          }
        }
        return;
      }
      case ZodFirstPartyTypeKind.ZodEnum: {
        const enumValues = (current as z.ZodEnum<[string, ...string[]]>).options.join(", ");
        hints.add(`${formatPath(path)} doit correspondre à l'une des valeurs : ${enumValues}`);
        return;
      }
      case ZodFirstPartyTypeKind.ZodNativeEnum: {
        const rawValues = Object.values(
          getNativeEnumValues(current as z.ZodNativeEnum<EnumLike>),
        ).filter((value): value is string => typeof value === "string");
        if (rawValues.length > 0) {
          hints.add(`${formatPath(path)} doit correspondre à l'une des valeurs : ${rawValues.join(", ")}`);
        }
        return;
      }
      case ZodFirstPartyTypeKind.ZodLiteral: {
        hints.add(`${formatPath(path)} doit être exactement ${(current as z.ZodLiteral<unknown>)._def.value}`);
        return;
      }
      case ZodFirstPartyTypeKind.ZodArray: {
        const arrayDef = current as z.ZodArray<ZodTypeAny, "many">;
        const min = arrayDef._def.minLength?.value;
        if (typeof min === "number" && min > 0) {
          hints.add(`${formatPath(path)} doit contenir au moins ${min} élément(s)`);
        }
        visit(arrayDef._def.type, [...path, "[*]"], depth + 1);
        return;
      }
      case ZodFirstPartyTypeKind.ZodSet: {
        const setDef = current as z.ZodSet<ZodTypeAny>;
        visit(setDef._def.valueType, [...path, "[*]"], depth + 1);
        return;
      }
      case ZodFirstPartyTypeKind.ZodUnion: {
        const unionDef = current as z.ZodUnion<[ZodTypeAny, ...ZodTypeAny[]]>;
        hints.add(`${formatPath(path)} doit respecter l'une des formes attendues`);
        visit(unionDef._def.options[0], path, depth + 1);
        return;
      }
      case ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
        const discr = current as z.ZodDiscriminatedUnion<
          string,
          readonly ZodDiscriminatedUnionOption<string>[]
        >;
        const discriminator = discr._def.discriminator;
        hints.add(`${formatPath([...path, discriminator])} doit correspondre à une variante supportée`);
        const first = getFirstDiscriminatedUnionOption(discr);
        if (first) {
          visit(first, path, depth + 1);
        }
        return;
      }
      case ZodFirstPartyTypeKind.ZodRecord: {
        const recordDef = current as z.ZodRecord<ZodTypeAny, ZodTypeAny>;
        visit(recordDef._def.valueType, [...path, "clé"], depth + 1);
        return;
      }
      case ZodFirstPartyTypeKind.ZodIntersection: {
        const intersection = current as z.ZodIntersection<ZodTypeAny, ZodTypeAny>;
        visit(intersection._def.left, path, depth + 1);
        visit(intersection._def.right, path, depth + 1);
        return;
      }
      default:
        return;
    }
  }

  visit(schema, [], 0);
  return Array.from(hints).slice(0, COMMON_ERROR_LIMIT);
}

/**
 * Converts a manifest entry into the façade-friendly summary validated by the
 * public schema.
 */
function toToolSummary(manifest: ToolManifest, schema: ZodTypeAny | undefined): ToolsHelpToolSummary {
  const summary: ToolsHelpToolSummary = {
    name: manifest.name,
    title: manifest.title,
    description: manifest.description,
    category: manifest.category,
    hidden: manifest.hidden,
    tags: manifest.tags ? [...manifest.tags] : undefined,
    deprecated: manifest.deprecated
      ? manifest.deprecated.replace_with
        ? { since: manifest.deprecated.since, replace_with: manifest.deprecated.replace_with }
        : { since: manifest.deprecated.since }
      : undefined,
    budgets: manifest.budgets
      ? {
          ...(typeof manifest.budgets.time_ms === "number" ? { time_ms: manifest.budgets.time_ms } : {}),
          ...(typeof manifest.budgets.tool_calls === "number" ? { tool_calls: manifest.budgets.tool_calls } : {}),
          ...(typeof manifest.budgets.bytes_out === "number" ? { bytes_out: manifest.budgets.bytes_out } : {}),
        }
      : undefined,
  };
  const example = buildExampleFromSchema(schema);
  if (typeof example !== "undefined") {
    summary.example = example;
  }
  const errors = collectCommonErrors(schema);
  if (errors.length > 0) {
    summary.common_errors = errors;
  }
  return summary;
}

/**
 * Builds a degraded response when the caller exhausted its budget before the
 * façade could assemble the requested catalogue information.
 */
function buildBudgetExceededResult(
  idempotencyKey: string,
  mode: ToolVisibilityMode,
  pack: ToolPack,
  includeHidden: boolean,
  filters: ToolsHelpFilters,
  metadata: Record<string, unknown> | undefined,
  error: BudgetExceededError,
): ToolsHelpOutput {
  const diagnostic = ToolsHelpBudgetDiagnosticSchema.parse({
    reason: "budget_exhausted",
    dimension: error.dimension,
    attempted: error.attempted,
    remaining: error.remaining,
    limit: error.limit,
  });

  return ToolsHelpOutputSchema.parse({
    ok: false,
    summary: "budget épuisé avant la génération du guide des outils",
    details: {
      idempotency_key: idempotencyKey,
      mode,
      pack,
      include_hidden: includeHidden,
      total: 0,
      returned: 0,
      filters,
      tools: [],
      metadata,
      budget: diagnostic,
    },
  });
}

/**
 * Creates the façade handler. The implementation validates the input payload,
 * consumes the request budget, filters the manifest catalogue, and emits
 * structured diagnostics for observability consumers.
 */
export function createToolsHelpHandler(context: ToolsHelpToolContext): ToolImplementation {
  return async function handleToolsHelp(
    input: unknown,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<CallToolResult> {
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const parsed = ToolsHelpInputSchema.parse(args);

    const rpcContext = getJsonRpcContext();
    const traceContext = getActiveTraceContext();

    const idempotencyKey =
      parsed.idempotency_key?.trim() ||
      (typeof rpcContext?.idempotencyKey === "string" && rpcContext.idempotencyKey.trim().length > 0
        ? rpcContext.idempotencyKey.trim()
        : randomUUID());

    const resolvedMode: ToolVisibilityMode = parsed.mode
      ? ToolsHelpVisibilityModeSchema.parse(parsed.mode)
      : resolveToolVisibilityModeFromEnv();
    const resolvedPack: ToolPack = parsed.pack
      ? ToolsHelpPackSchema.parse(parsed.pack)
      : resolveToolPackFromEnv();
    const includeHidden = parsed.include_hidden === true;
    const filters = extractFilters(parsed);
    const metadata = cloneMetadata(parsed.metadata);

    let charge: BudgetCharge | null = null;
    try {
      if (rpcContext?.budget) {
        charge = rpcContext.budget.consume(
          { toolCalls: 1 },
          { actor: "facade", operation: TOOLS_HELP_TOOL_NAME, detail: "manifest_listing" },
        );
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        context.logger.warn("tools_help_budget_exhausted", {
          request_id: rpcContext?.requestId ?? extra.requestId ?? null,
          trace_id: traceContext?.traceId ?? null,
          dimension: error.dimension,
          remaining: error.remaining,
          attempted: error.attempted,
          limit: error.limit,
        });
        const structured = buildBudgetExceededResult(
          idempotencyKey,
          resolvedMode,
          resolvedPack,
          includeHidden,
          filters,
          metadata,
          error,
        );
        return {
          isError: true,
          content: [{ type: "text", text: asJsonPayload(structured) }],
          structuredContent: structured,
        };
      }
      throw error;
    }

    const manifests = includeHidden
      ? context.registry.list()
      : context.registry.listVisible(resolvedMode, resolvedPack);

    let filtered = manifests;
    if (filters.categories && filters.categories.length > 0) {
      const allowed = new Set(filters.categories);
      filtered = filtered.filter((manifest) => allowed.has(manifest.category));
    }
    if (filters.tags && filters.tags.length > 0) {
      const requiredTags = new Set(filters.tags.map((tag) => tag.toLowerCase()));
      filtered = filtered.filter((manifest) => {
        const tags = manifest.tags ?? [];
        return tags.some((tag) => requiredTags.has(tag.toLowerCase()));
      });
    }
    if (filters.search && filters.search.length > 0) {
      const needle = filters.search.toLowerCase();
      filtered = filtered.filter((manifest) => {
        const fields = [manifest.name, manifest.title, manifest.description ?? ""];
        return fields.some((field) => field.toLowerCase().includes(needle));
      });
    }

    const limited = typeof filters.limit === "number" ? filtered.slice(0, filters.limit) : filtered;
    const summaries = limited.map((manifest) => {
      const descriptor = context.registry.describe(manifest.name);
      return toToolSummary(manifest, descriptor?.inputSchema);
    });

    const structured: ToolsHelpOutput = {
      ok: true,
      summary:
        summaries.length === 0
          ? "aucun outil ne correspond aux filtres fournis"
          : `${summaries.length} outil${summaries.length > 1 ? "s" : ""} correspondant${summaries.length > 1 ? "s" : ""}`,
      details: {
        idempotency_key: idempotencyKey,
        mode: resolvedMode,
        pack: resolvedPack,
        include_hidden: includeHidden,
        total: filtered.length,
        returned: summaries.length,
        filters,
        tools: summaries,
        ...(metadata ? { metadata } : {}),
      },
    };

    const validated = ToolsHelpOutputSchema.parse(structured);

    context.logger.info("tools_help_listed", {
      request_id: rpcContext?.requestId ?? extra.requestId ?? null,
      trace_id: traceContext?.traceId ?? null,
      idempotency_key: idempotencyKey,
      mode: resolvedMode,
      pack: resolvedPack,
      include_hidden: includeHidden,
      total: filtered.length,
      returned: summaries.length,
      filters,
    });

    if (charge && rpcContext?.budget) {
      rpcContext.budget.snapshot();
    }

    return {
      content: [{ type: "text", text: asJsonPayload(validated) }],
      structuredContent: validated,
    };
  };
}

/**
 * Registers the façade with the tool registry.
 */
export async function registerToolsHelpTool(
  registry: ToolRegistry,
  context: Omit<ToolsHelpToolContext, "registry">,
): Promise<ToolManifest> {
  return await registry.register(ToolsHelpManifestDraft, createToolsHelpHandler({ ...context, registry }), {
    inputSchema: ToolsHelpInputSchema.shape,
    outputSchema: ToolsHelpOutputSchema.shape,
    annotations: { intent: "discovery" },
  });
}
