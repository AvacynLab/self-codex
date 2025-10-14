import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { McpServer, type RegisteredTool, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { StructuredLogger } from "../logger.js";
import { ensureParentDirectory, sanitizeFilename } from "../paths.js";
import {
  evaluateToolDeprecation,
  getRegisteredToolDeprecation,
  logToolDeprecation,
  type ToolDeprecationMetadata,
} from "./deprecations.js";

/**
 * Union describing the high-level family a tool belongs to. The categories are
 * intentionally coarse so the exposure logic can reason about the catalogue
 * without inspecting individual manifests.
 */
export type ToolManifestCategory =
  | "project"
  | "artifact"
  | "graph"
  | "plan"
  | "child"
  | "runtime"
  | "memory"
  | "admin";

/** String union controlling whether hidden tools should be visible. */
export type ToolVisibilityMode = "basic" | "pro";

/**
 * Named packs determine which subset of the catalogue is exposed to callers.
 * Packs are evaluated after the visibility mode filter.
 */
export type ToolPack = "basic" | "authoring" | "ops" | "all";

/** Declarative budgets attached to a tool manifest. */
export interface ToolBudgets {
  readonly time_ms?: number;
  readonly tool_calls?: number;
  readonly bytes_out?: number;
}

/** Logical classification applied to registered tools. */
export type ToolKind = "dynamic" | "composite";

/**
 * Definition describing an individual step inside a composite tool pipeline.
 * Steps are executed sequentially and may forward their structured result to
 * the following stage.
 */
export interface CompositeToolStep {
  /** Stable identifier used to reference the step in overrides or logs. */
  readonly id: string;
  /** Fully qualified tool name invoked during the step. */
  readonly tool: string;
  /** Optional static arguments forwarded to the tool. */
  readonly arguments?: Record<string, unknown>;
  /** Whether the step output should be surfaced in the aggregated summary. */
  readonly capture?: boolean;
}

/**
 * High level manifest surfaced by the registry when callers list tools. Only
 * JSON serialisable data is stored so the structure can be persisted and served
 * through HTTP transports without additional transformation.
 */
export interface ToolManifest {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: ToolKind;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly category: ToolManifestCategory;
  readonly tags?: string[];
  readonly hidden?: boolean;
  readonly deprecated?: ToolDeprecationMetadata;
  readonly budgets?: ToolBudgets;
  readonly steps?: CompositeToolStep[];
  readonly inputs?: string[];
  readonly source?: "runtime" | "persisted";
}

/** Draft metadata accepted by {@link ToolRegistry.register}. */
export interface ToolManifestDraft {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly kind: ToolKind;
  readonly category?: ToolManifestCategory;
  readonly tags?: string[];
  readonly hidden?: boolean;
  readonly deprecated?: ToolDeprecationMetadata;
  readonly budgets?: ToolBudgets;
  readonly steps?: CompositeToolStep[];
  readonly inputs?: string[];
  readonly version?: number;
  readonly source?: "runtime" | "persisted";
}

/**
 * Composite registration request accepted by {@link ToolRegistry.registerComposite}.
 * The structure mirrors the JSON-RPC payload parsed by the transport layer and
 * therefore remains intentionally permissive.
 */
export interface CompositeRegistrationRequest {
  readonly name: string;
  readonly title: string;
  readonly description?: string;
  readonly tags?: string[];
  readonly steps: CompositeToolStep[];
}

/** Error thrown when attempting to register a duplicate tool. */
export class ToolRegistrationError extends Error {
  public readonly code = "E_TOOL_REGISTRATION";

  constructor(message: string) {
    super(message);
    this.name = "ToolRegistrationError";
  }
}

/**
 * Error thrown when attempting to call or compose an unknown tool. The error
 * mirrors the runtime JSON-RPC diagnostics so transports can translate it into
 * a consistent response body.
 */
export class ToolNotFoundError extends Error {
  public readonly code = "E_TOOL_NOT_FOUND";

  constructor(name: string) {
    super(`tool \"${name}\" is not registered`);
    this.name = "ToolNotFoundError";
  }
}

/** Invocation context forwarded to underlying tools during composite execution. */
export type ToolInvocationExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Implementation signature accepted by {@link ToolRegistry.register}. */
export type ToolImplementation = (
  input: unknown,
  extra: ToolInvocationExtra,
) => CallToolResult | Promise<CallToolResult>;

/** Options tweaking the registration behaviour for a tool. */
export interface ToolRegistrationOptions {
  readonly inputSchema?: z.ZodRawShape;
  readonly outputSchema?: z.ZodRawShape;
  readonly annotations?: ToolAnnotations;
  readonly meta?: Record<string, unknown>;
  readonly persistManifest?: boolean;
  readonly manifestPath?: string;
  readonly overrideManifest?: Partial<ToolManifest>;
}

/** Options accepted when creating a {@link ToolRegistry} instance. */
export interface ToolRegistryOptions {
  readonly server: McpServer;
  readonly logger: StructuredLogger;
  readonly runsRoot?: string;
  readonly clock?: () => Date;
  readonly invokeTool: (
    tool: string,
    args: unknown,
    extra: ToolInvocationExtra,
  ) => Promise<CallToolResult>;
}

interface ToolRegistrationRecord {
  readonly manifest: ToolManifest;
  readonly handler: ToolImplementation;
  readonly registeredTool: RegisteredTool;
  readonly inputSchema?: z.ZodObject<z.ZodRawShape>;
  readonly manifestPath?: string;
}

const CompositeManifestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    version: z.number().int().positive().default(1),
    kind: z.literal("composite"),
    created_at: z.string().trim().min(1),
    updated_at: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1).max(50)).max(16).optional(),
    steps: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            tool: z.string().trim().min(1).max(200),
            arguments: z.record(z.unknown()).optional(),
            capture: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

interface PersistedCompositeManifest
  extends z.infer<typeof CompositeManifestSchema> {}

/** Helper producing deep JSON copies to avoid leaking internal references. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Normalises an optional tag array by trimming entries, removing duplicates and
 * returning a stable copy that callers can safely mutate.
 */
function sanitiseTags(tags?: readonly string[] | null): string[] {
  if (!tags || tags.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * Lookup table associating well-known tool name prefixes with their default
 * {@link ToolManifestCategory}. The values intentionally mirror the taxonomy
 * described in the engineering brief so legacy primitives can be grouped
 * without having to touch every individual registration call.
 */
const CATEGORY_LOOKUP: Record<string, ToolManifestCategory> = {
  artifact: "artifact",
  artifacts: "artifact",
  project: "project",
  graph: "graph",
  plan: "plan",
  child: "child",
  runtime: "runtime",
  memory: "memory",
  admin: "admin",
  mcp: "admin",
  tools: "admin",
  tool: "admin",
  health: "admin",
  resources: "artifact",
  events: "runtime",
  logs: "runtime",
  job: "plan",
  conversation: "memory",
  kg: "memory",
  values: "memory",
  causal: "graph",
  tx: "graph",
  bb: "memory",
  stig: "memory",
  cnp: "child",
  consensus: "plan",
  agent: "child",
  start: "runtime",
  status: "runtime",
  kill: "runtime",
  aggregate: "runtime",
  op: "plan",
};

/**
 * Derives a reasonable default category for an existing primitive tool based on
 * its name. The heuristic inspects the fully qualified name as well as the
 * prefix before the first underscore, falling back to "runtime" when the tool
 * cannot be categorised more precisely. This keeps the migration manageable
 * while dedicated façades are introduced progressively.
 */
function inferCategoryFromToolName(name: string): ToolManifestCategory {
  const normalised = name.trim().toLowerCase();
  if (!normalised) {
    return "runtime";
  }
  const segments = normalised.split("_");
  const directMatch = CATEGORY_LOOKUP[normalised];
  if (directMatch) {
    return directMatch;
  }
  const prefix = segments[0] ?? normalised;
  return CATEGORY_LOOKUP[prefix] ?? "runtime";
}

/** Returns a shallow clone of the provided budget configuration. */
function cloneBudgets(budgets?: ToolBudgets): ToolBudgets | undefined {
  if (!budgets) {
    return undefined;
  }
  const cloned: ToolBudgets = {
    ...(typeof budgets.time_ms === "number" ? { time_ms: budgets.time_ms } : {}),
    ...(typeof budgets.tool_calls === "number" ? { tool_calls: budgets.tool_calls } : {}),
    ...(typeof budgets.bytes_out === "number" ? { bytes_out: budgets.bytes_out } : {}),
  };
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

/** Dimensions supported when overriding tool budgets via environment variables. */
const BUDGET_OVERRIDE_DIMENSIONS: Array<{ key: keyof ToolBudgets; envKey: string }> = [
  { key: "time_ms", envKey: "TIME_MS" },
  { key: "tool_calls", envKey: "TOOL_CALLS" },
  { key: "bytes_out", envKey: "BYTES_OUT" },
];

interface BudgetOverrideSnapshot {
  dimension: keyof ToolBudgets;
  value: number;
  previous?: number;
}

/** Normalises a tool identifier into the suffix used for budget override variables. */
function normaliseBudgetOverrideIdentifier(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Parses a numeric budget override value, rejecting invalid or negative inputs. */
function parseBudgetOverrideValue(raw: string | undefined): number | null {
  if (typeof raw !== "string" || raw.trim() === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.trunc(value);
}

/**
 * Applies the `MCP_TOOLS_BUDGET_*` overrides to the provided budget settings.
 * The helper returns both the adjusted budgets and a snapshot describing the
 * dimensions that were effectively changed so callers can emit structured
 * logs when overrides are detected.
 */
function applyBudgetOverrides(
  toolName: string,
  input: ToolBudgets | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { budgets: ToolBudgets | undefined; applied: BudgetOverrideSnapshot[] } {
  const identifier = normaliseBudgetOverrideIdentifier(toolName);
  const base = cloneBudgets(input);
  let working = base ? { ...base } : undefined;
  const applied: BudgetOverrideSnapshot[] = [];

  for (const dimension of BUDGET_OVERRIDE_DIMENSIONS) {
    const envKey = `MCP_TOOLS_BUDGET_${identifier}_${dimension.envKey}`;
    const override = parseBudgetOverrideValue(env[envKey]);
    if (override === null) {
      continue;
    }

    if (!working) {
      working = {};
    }

    const current = working[dimension.key];
    const next = typeof current === "number" ? Math.max(current, override) : override;
    if (current !== next) {
      working[dimension.key] = next;
      applied.push({ dimension: dimension.key, value: next, previous: current });
    }
  }

  const budgets = cloneBudgets(working);
  return { budgets, applied };
}

/** Creates a defensive copy of the deprecation metadata. */
function cloneDeprecation(meta?: ToolDeprecationMetadata): ToolDeprecationMetadata | undefined {
  if (!meta) {
    return undefined;
  }
  return meta.replace_with ? { since: meta.since, replace_with: meta.replace_with } : { since: meta.since };
}

/** Normalises a raw environment value into a {@link ToolVisibilityMode}. */
function parseVisibilityMode(value: string | undefined): ToolVisibilityMode {
  if (!value) {
    return "pro";
  }
  const normalised = value.trim().toLowerCase();
  return normalised === "basic" ? "basic" : "pro";
}

/** Normalises a raw environment value into a {@link ToolPack}. */
function parseToolPack(value: string | undefined): ToolPack {
  if (!value) {
    return "all";
  }
  const normalised = value.trim().toLowerCase();
  if (normalised === "basic" || normalised === "authoring" || normalised === "ops" || normalised === "all") {
    return normalised as ToolPack;
  }
  return "all";
}

/**
 * Filters the provided manifests according to the selected mode and pack. The
 * implementation mirrors the snippet included in the engineering brief.
 */
export function listVisible(
  all: ToolManifest[],
  mode: ToolVisibilityMode,
  pack: ToolPack,
): ToolManifest[] {
  let visible = all;
  if (mode === "basic") {
    visible = visible.filter((tool) => tool.hidden !== true || (tool.tags ?? []).includes("facade"));
  }
  if (pack === "basic") {
    visible = visible.filter((tool) => (tool.tags ?? []).includes("facade"));
  } else if (pack === "authoring") {
    visible = visible.filter((tool) => (tool.tags ?? []).some((tag) => tag === "facade" || tag === "authoring"));
  } else if (pack === "ops") {
    visible = visible.filter((tool) => (tool.tags ?? []).some((tag) => tag === "facade" || tag === "ops"));
  }
  visible = visible.filter((tool) => !(tool.hidden === true && tool.deprecated));
  return visible;
}

/** Resolves the visibility mode from the environment, defaulting to "pro". */
export function resolveToolVisibilityModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ToolVisibilityMode {
  return parseVisibilityMode(env.MCP_TOOLS_MODE);
}

/** Resolves the active tool pack from the environment, defaulting to "all". */
export function resolveToolPackFromEnv(env: NodeJS.ProcessEnv = process.env): ToolPack {
  return parseToolPack(env.MCP_TOOL_PACK);
}

/** Helper returning the manifests visible for the current environment flags. */
export function listVisibleFromEnv(all: ToolManifest[], env: NodeJS.ProcessEnv = process.env): ToolManifest[] {
  const mode = resolveToolVisibilityModeFromEnv(env);
  const pack = resolveToolPackFromEnv(env);
  return listVisible(all, mode, pack);
}

function resolveRunsRoot(override?: string): string {
  const base = typeof override === "string" && override.length > 0 ? override : process.env.MCP_RUNS_ROOT ?? "runs";
  return path.resolve(process.cwd(), base);
}

/**
 * Dynamic tool registry backing the Tool-OS feature set. The registry keeps the
 * SDK aware of dynamically registered tools, persists composite manifests for
 * replay/debug and exposes helper methods for transports and tests.
 */
export class ToolRegistry {
  private readonly server: McpServer;
  private readonly logger: StructuredLogger;
  private readonly clock: () => Date;
  private readonly invokeTool: ToolRegistryOptions["invokeTool"];
  private readonly runsRoot: string;
  private readonly manifestsDir: string;
  private readonly entries = new Map<string, ToolRegistrationRecord>();
  private readonly sighupHandler: (() => void) | null;

  private constructor(options: ToolRegistryOptions) {
    this.server = options.server;
    this.logger = options.logger;
    this.clock = options.clock ?? (() => new Date());
    this.invokeTool = options.invokeTool;
    this.runsRoot = resolveRunsRoot(options.runsRoot);
    this.manifestsDir = path.join(this.runsRoot, "tools", "manifests");
    this.sighupHandler = () => {
      void this.reloadFromDisk().catch((error) => {
        this.logger.error("tool_registry_reload_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    process.on("SIGHUP", this.sighupHandler);
  }

  /**
   * Factory creating a registry instance and replaying any persisted composite
   * manifests found on disk.
   */
  public static async create(options: ToolRegistryOptions): Promise<ToolRegistry> {
    const registry = new ToolRegistry(options);
    await registry.reloadFromDisk();
    return registry;
  }

  /** Detaches signal listeners and clears internal state. Primarily used in tests. */
  public close(): void {
    if (this.sighupHandler) {
      process.off("SIGHUP", this.sighupHandler);
    }
  }

  /** Lists the registered tool manifests in lexical order. */
  public list(): ToolManifest[] {
    const manifests = Array.from(this.entries.values()).map((entry) => this.applyDeprecationPolicy(entry));
    return manifests.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Returns the manifests exposed for the current mode/pack combination. */
  public listVisible(mode?: ToolVisibilityMode, pack?: ToolPack): ToolManifest[] {
    const manifests = this.list();
    const resolvedMode = mode ?? resolveToolVisibilityModeFromEnv();
    const resolvedPack = pack ?? resolveToolPackFromEnv();
    return listVisible(manifests, resolvedMode, resolvedPack);
  }

  /** Retrieves a defensive copy of the manifest registered for the given tool. */
  public get(name: string): ToolManifest | undefined {
    const record = this.entries.get(name);
    if (!record) {
      return undefined;
    }
    return cloneJson(record.manifest);
  }

  /**
   * Registers a generic tool implementation with the underlying MCP server and
   * updates the runtime manifest catalogue.
   */
  public async register(
    draft: ToolManifestDraft,
    implementation: ToolImplementation,
    options: ToolRegistrationOptions = {},
  ): Promise<ToolManifest> {
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      throw new ToolRegistrationError("tool name must be a non-empty string");
    }

    if (this.entries.has(trimmedName)) {
      throw new ToolRegistrationError(`tool \"${trimmedName}\" is already registered in the Tool-OS registry`);
    }

    const serverRegistry = (this.server as unknown as {
      _registeredTools?: Record<string, RegisteredTool>;
    })._registeredTools;
    if (serverRegistry && serverRegistry[trimmedName]) {
      throw new ToolRegistrationError(`tool \"${trimmedName}\" is already registered on the MCP server`);
    }

    await mkdir(this.manifestsDir, { recursive: true });

    const nowIso = this.clock().toISOString();
    const resolvedCategory =
      options.overrideManifest?.category ?? draft.category ?? inferCategoryFromToolName(draft.name);
    const tags = sanitiseTags(options.overrideManifest?.tags ?? draft.tags);
    const hasFacadeTag = tags.includes("facade");
    const inferredDeprecation =
      options.overrideManifest?.deprecated ?? draft.deprecated ?? getRegisteredToolDeprecation(trimmedName);
    const deprecated = cloneDeprecation(inferredDeprecation);
    const hiddenBase = options.overrideManifest?.hidden ?? draft.hidden ?? !hasFacadeTag;
    const deprecationState = evaluateToolDeprecation(trimmedName, deprecated, this.clock());
    const hidden = hiddenBase || deprecationState.forceHidden;
    const { budgets, applied: appliedBudgetOverrides } = applyBudgetOverrides(
      trimmedName,
      options.overrideManifest?.budgets ?? draft.budgets,
    );
    if (appliedBudgetOverrides.length > 0) {
      this.logger.info("tool_budget_override_applied", {
        name: trimmedName,
        overrides: appliedBudgetOverrides.map((entry) => ({
          dimension: entry.dimension,
          value: entry.value,
          previous: entry.previous ?? null,
        })),
      });
    }
    const manifest: ToolManifest = {
      name: trimmedName,
      title: draft.title.trim(),
      description: draft.description?.trim() || undefined,
      kind: draft.kind,
      version: draft.version ?? 1,
      createdAt: options.overrideManifest?.createdAt ?? nowIso,
      updatedAt: options.overrideManifest?.updatedAt ?? nowIso,
      category: resolvedCategory,
      tags,
      hidden,
      deprecated: deprecationState.metadata ?? undefined,
      budgets,
      steps: draft.steps ? cloneJson(draft.steps) : undefined,
      inputs: draft.inputs ? [...draft.inputs] : undefined,
      source: options.overrideManifest?.source ?? draft.source ?? "runtime",
    };

    const manifestPath = options.persistManifest
      ? options.manifestPath ?? path.join(this.manifestsDir, `${sanitizeFilename(trimmedName)}.json`)
      : options.manifestPath;

    let handler: ToolCallback<z.ZodRawShape | undefined>;
    if (options.inputSchema) {
      handler = (async (
        args: Record<string, unknown>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ): Promise<CallToolResult> => implementation(args, extra)) as unknown as ToolCallback<
        z.ZodRawShape | undefined
      >;
    } else {
      handler = (async (
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ): Promise<CallToolResult> => implementation(undefined, extra)) as unknown as ToolCallback<
        z.ZodRawShape | undefined
      >;
    }

    const registeredTool = this.server.registerTool(
      trimmedName,
      {
        title: manifest.title,
        description: manifest.description,
        inputSchema: options.inputSchema,
        outputSchema: options.outputSchema,
        annotations: options.annotations,
        _meta: { ...options.meta, tool_kind: manifest.kind },
      },
      handler as unknown as (
        args: Record<string, unknown>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ) => Promise<CallToolResult>,
    );

    const storedSchema = options.inputSchema ? z.object(options.inputSchema).strict() : undefined;
    const record: ToolRegistrationRecord = {
      manifest: cloneJson(manifest),
      handler: implementation,
      registeredTool,
      inputSchema: storedSchema,
      manifestPath,
    };
    this.entries.set(trimmedName, record);

    if (manifestPath) {
      const payload: PersistedCompositeManifest = {
        name: manifest.name,
        title: manifest.title,
        description: manifest.description,
        version: manifest.version,
        kind: "composite",
        created_at: manifest.createdAt,
        updated_at: manifest.updatedAt,
        tags: manifest.tags,
        steps: record.manifest.steps ?? [],
      };
      await ensureParentDirectory(manifestPath);
      await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    }

    return cloneJson(manifest);
  }

  /**
   * Registers a composite pipeline, validating step identifiers and ensuring
   * referenced tools exist before persisting the manifest.
   */
  public async registerComposite(request: CompositeRegistrationRequest): Promise<ToolManifest> {
    const steps = request.steps ?? [];
    if (steps.length === 0) {
      throw new ToolRegistrationError("composite tools must define at least one step");
    }

    const seenIds = new Set<string>();
    for (const step of steps) {
      const trimmedId = step.id.trim();
      if (!trimmedId) {
        throw new ToolRegistrationError("composite step identifiers must be non-empty strings");
      }
      if (seenIds.has(trimmedId)) {
        throw new ToolRegistrationError(`duplicate composite step identifier: ${trimmedId}`);
      }
      seenIds.add(trimmedId);

      if (step.tool.trim() === request.name.trim()) {
        throw new ToolRegistrationError("composite tools cannot invoke themselves recursively");
      }

      const registry = (this.server as unknown as { _registeredTools?: Record<string, RegisteredTool> })._registeredTools;
      if (!registry || !registry[step.tool]) {
        throw new ToolRegistrationError(`referenced tool \"${step.tool}\" is not registered`);
      }
    }

    const inputs = steps.flatMap((step) => Object.keys(step.arguments ?? {}));
    const draft: ToolManifestDraft = {
      name: request.name,
      title: request.title,
      description: request.description,
      kind: "composite",
      tags: request.tags,
      steps,
      inputs,
      version: 1,
      source: "runtime",
    };

    const implementation = this.createCompositeImplementation(request.name, steps);

    return await this.register(draft, implementation, {
      persistManifest: true,
    });
  }

  /**
   * Executes a registered tool directly via the registry. The helper mirrors the
   * behaviour of the MCP transport and therefore validates input payloads before
   * forwarding them to the stored implementation.
   */
  public async call(
    name: string,
    input: unknown,
    extra: ToolInvocationExtra,
  ): Promise<CallToolResult> {
    const record = this.entries.get(name);
    if (!record) {
      throw new ToolNotFoundError(name);
    }

    const evaluation = evaluateToolDeprecation(name, record.manifest.deprecated, this.clock());
    if (evaluation.metadata) {
      const logPayload = { name, metadata: evaluation.metadata, ageDays: evaluation.ageDays };
      if (evaluation.forceRemoval) {
        logToolDeprecation(this.logger, "warn", "tool_deprecated_blocked", logPayload);
        throw new ToolDeprecatedError(name, evaluation.metadata);
      }
      logToolDeprecation(this.logger, "warn", "tool_deprecated_invoked", logPayload);
    }

    const payload = record.inputSchema ? await record.inputSchema.parseAsync(input ?? {}) : undefined;
    return await record.handler(payload, extra);
  }

  /**
   * Reloads persisted composite manifests from disk, replacing the in-memory
   * registrations with their refreshed counterparts. Dynamic (non-persisted)
   * tools remain untouched.
   */
  public async reloadFromDisk(): Promise<void> {
    await mkdir(this.manifestsDir, { recursive: true });
    const entries = await readdir(this.manifestsDir, { withFileTypes: true });

    const persisted = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.manifestsDir, entry.name));

    const manifests: PersistedCompositeManifest[] = [];
    for (const filePath of persisted) {
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = CompositeManifestSchema.parse(JSON.parse(raw));
        manifests.push(parsed);
      } catch (error) {
        this.logger.warn("tool_registry_manifest_parse_failed", {
          file: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const [name, record] of [...this.entries.entries()]) {
      if (record.manifest.kind === "composite" && record.manifestPath) {
        record.registeredTool.remove();
        this.entries.delete(name);
      }
    }

    for (const manifest of manifests) {
      const draft: ToolManifestDraft = {
        name: manifest.name,
        title: manifest.title,
        description: manifest.description,
        kind: "composite",
        tags: manifest.tags,
        steps: manifest.steps,
        version: manifest.version,
        source: "persisted",
      };

      const implementation = this.createCompositeImplementation(manifest.name, manifest.steps);

      await this.register(draft, implementation, {
        manifestPath: path.join(this.manifestsDir, `${sanitizeFilename(manifest.name)}.json`),
        overrideManifest: {
          createdAt: manifest.created_at,
          updatedAt: manifest.updated_at,
          source: "persisted",
          version: manifest.version,
        },
      });
    }
  }

  private createCompositeImplementation(name: string, steps: CompositeToolStep[]): ToolImplementation {
    const OverridesSchema = z
      .record(
        z
          .object({
            arguments: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .optional();
    const ExecutionInputSchema = z
      .object({
        initial: z.record(z.unknown()).optional(),
        overrides: OverridesSchema,
      })
      .strict();

    return async (input, extra) => {
      const parsed = input ? ExecutionInputSchema.parse(input) : { initial: undefined, overrides: undefined };

      const stepSummaries: Array<{
        id: string;
        tool: string;
        is_error: boolean;
        structured?: unknown;
        content?: CallToolResult["content"];
      }> = [];
      let previous: unknown = parsed.initial ?? null;

      for (const step of steps) {
        const baseArgs = step.arguments ? cloneJson(step.arguments) : {};
        const override = parsed.overrides?.[step.id];
        const mergedArgs = { ...baseArgs } as Record<string, unknown>;
        if (override?.arguments) {
          Object.assign(mergedArgs, override.arguments);
        }
        if (previous !== null && previous !== undefined) {
          mergedArgs.previous = previous;
        }

        const result = await this.invokeTool(step.tool, mergedArgs, extra);
        const structured = result.structuredContent ?? null;
        if (step.capture !== false) {
          stepSummaries.push({
            id: step.id,
            tool: step.tool,
            is_error: result.isError === true,
            structured: structured ?? undefined,
            content: result.content,
          });
        }
        previous = structured;
        if (result.isError) {
          break;
        }
      }

      const payload = {
        tool: name,
        executed_at: this.clock().toISOString(),
        steps: stepSummaries,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
        isError: stepSummaries.some((summary) => summary.is_error),
      };
    };
  }

  private applyDeprecationPolicy(record: ToolRegistrationRecord): ToolManifest {
    const base = cloneJson(record.manifest);
    const evaluation = evaluateToolDeprecation(base.name, base.deprecated, this.clock());
    return {
      ...base,
      hidden: base.hidden || evaluation.forceHidden,
      deprecated: evaluation.metadata ?? base.deprecated,
    };
  }
}

/** Error thrown when invoking a tool that has reached the removal deadline. */
export class ToolDeprecatedError extends Error {
  public readonly code = "E_TOOL_DEPRECATED";
  public readonly metadata: ToolDeprecationMetadata;

  constructor(name: string, metadata: ToolDeprecationMetadata) {
    super(`tool "${name}" has been retired`);
    this.name = "ToolDeprecatedError";
    this.metadata = metadata;
  }
}

