import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import YAML from "yaml";
import { z } from "zod";

import { omitUndefinedEntries } from "../utils/object.js";

/**
 * Definition describing the execution constraints enforced for a scenario. The
 * budget covers wall-clock latency, token usage, and number of tool calls to
 * keep the campaign reproducible across environments.
 */
export interface ScenarioConstraints {
  /** Maximum cumulative duration (milliseconds) allowed for the scenario run. */
  readonly maxDurationMs?: number;
  /** Maximum number of tool invocations permitted for the scenario. */
  readonly maxToolCalls?: number;
  /** Upper bound for the total token cost observed during the run. */
  readonly maxTokens?: number;
  /**
   * Subset of tools that MUST be exercised at least once. This ensures critical
   * capabilities keep receiving coverage when scenarios are filtered by tags.
   */
  readonly requiredTools?: readonly string[];
}

/**
 * Expected outcome declared for a given step. Steps default to asserting that
 * the MCP call succeeds; additional predicates such as regex checks or minimum
 * list lengths can be layered on top through this structure.
 */
export interface ScenarioStepExpectation {
  /** Whether the tool call should succeed (default: `true`). */
  readonly success?: boolean;
  /**
   * Regular expression constraint applied to the human-readable text emitted by
   * the tool. When present, the pattern must match at least once.
   */
  readonly match?: { readonly pattern: string; readonly flags?: string } | string;
  /**
   * Optional negative regex that must not match the textual output. This is
   * commonly used to detect redacted secrets or explicit error markers.
   */
  readonly notMatch?: { readonly pattern: string; readonly flags?: string } | string;
  /** Minimum length expected when the tool returns an `items` collection. */
  readonly minItems?: number;
  /** Maximum length accepted for the returned `items` collection. */
  readonly maxItems?: number;
}

/**
 * Definition of a single scenario step. Each entry translates to one MCP tool
 * invocation, including optional metadata and expectations.
 */
export interface ScenarioStep {
  /** Stable identifier used for reporting and debugging. */
  readonly id: string;
  /** Human readable description displayed in the summary report. */
  readonly description?: string;
  /** Tool name resolved by the MCP router. */
  readonly tool: string;
  /** Arbitrary JSON payload forwarded to the tool. */
  readonly arguments?: Record<string, unknown>;
  /** Expectations enforced after the tool invocation completes. */
  readonly expect?: ScenarioStepExpectation;
}

/**
 * Declarative oracle verifying that a scenario produced the expected outcome.
 * Oracles complement step-level checks by analysing the combined transcript or
 * executing a custom validation script.
 */
export type ScenarioOracle =
  | {
      readonly type: "regex";
      /** Pattern applied to the aggregated textual transcript. */
      readonly pattern: string;
      /** Optional regular-expression flags (e.g. `i` for case-insensitive). */
      readonly flags?: string;
      /** Optional friendly label rendered in the evaluation report. */
      readonly description?: string;
    }
  | {
      readonly type: "script";
      /** Module resolved relative to the repository root implementing `validate`. */
      readonly module: string;
      /** Named export executed from the module (defaults to `validate`). */
      readonly exportName?: string;
      /** Optional note rendered in the report. */
      readonly description?: string;
    };

/**
 * Fully parsed scenario definition. The parser performs schema validation and
 * injects sensible defaults so downstream consumers can rely on a consistent
 * shape.
 */
export interface EvaluationScenario {
  /** Unique identifier used for reporting and CLI filtering. */
  readonly id: string;
  /** Concise sentence describing the goal of the scenario. */
  readonly objective: string;
  /** Tags used to group scenarios (e.g. `smoke`, `critical`, `latency`). */
  readonly tags: readonly string[];
  /** Optional runtime feature overrides applied before executing the steps. */
  readonly featureOverrides?: Record<string, unknown>;
  /** Budget enforced after the run to catch regressions. */
  readonly constraints: ScenarioConstraints;
  /** Ordered list of tool invocations forming the scenario. */
  readonly steps: readonly ScenarioStep[];
  /** Collection of declarative oracles executed after the steps. */
  readonly oracles: readonly ScenarioOracle[];
}

const regexExpectationSchema = z.union([
  z.string(),
  z.object({
    pattern: z.string(),
    flags: z.string().optional(),
  }),
]);

const expectationSchema = z
  .object({
    success: z.boolean().optional(),
    match: regexExpectationSchema.optional(),
    notMatch: regexExpectationSchema.optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
  })
  .refine((value) => {
    if (value.minItems !== undefined && value.maxItems !== undefined) {
      return value.minItems <= value.maxItems;
    }
    return true;
  }, "minItems cannot exceed maxItems");

const stepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
  expect: expectationSchema.default({ success: true }),
});

const oracleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("regex"),
    pattern: z.string().min(1),
    flags: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal("script"),
    module: z.string().min(1),
    exportName: z.string().min(1).optional(),
    description: z.string().optional(),
  }),
]);

const constraintsSchema = z.object({
  maxDurationMs: z.number().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxTokens: z.number().int().nonnegative().optional(),
  requiredTools: z.array(z.string().min(1)).optional(),
});

const scenarioSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  featureOverrides: z.record(z.unknown()).optional(),
  constraints: constraintsSchema.default({}),
  steps: z.array(stepSchema).min(1),
  oracles: z.array(oracleSchema).min(1),
});

type ParsedScenario = z.infer<typeof scenarioSchema>;

function normaliseRegexExpectation(
  value: { pattern: string; flags?: string } | string | undefined,
): ScenarioStepExpectation["match"] {
  if (value === undefined || typeof value === "string") {
    return value;
  }
  return {
    pattern: value.pattern,
    ...(value.flags ? { flags: value.flags } : {}),
  } satisfies Exclude<ScenarioStepExpectation["match"], string | undefined>;
}

function sanitiseScenario(parsed: ParsedScenario): EvaluationScenario {
  const featureOverrides =
    parsed.featureOverrides && Object.keys(parsed.featureOverrides).length > 0
      ? parsed.featureOverrides
      : undefined;

  const constraints = omitUndefinedEntries(parsed.constraints);

  const steps: ScenarioStep[] = parsed.steps.map((step) => {
    const normalisedExpect = omitUndefinedEntries({
      ...step.expect,
      match: normaliseRegexExpectation(step.expect.match),
      notMatch: normaliseRegexExpectation(step.expect.notMatch),
    });
    const entries: ScenarioStep = {
      id: step.id,
      tool: step.tool,
      ...(step.description ? { description: step.description } : {}),
      ...(Object.keys(step.arguments).length > 0 ? { arguments: step.arguments } : {}),
      ...(Object.keys(normalisedExpect).length > 0 ? { expect: normalisedExpect } : {}),
    };
    return entries;
  });

  const oracles: ScenarioOracle[] = parsed.oracles.map((oracle) => {
    if (oracle.type === "regex") {
      return {
        type: "regex",
        pattern: oracle.pattern,
        ...(oracle.flags ? { flags: oracle.flags } : {}),
        ...(oracle.description ? { description: oracle.description } : {}),
      } satisfies ScenarioOracle;
    }
    return {
      type: "script",
      module: oracle.module,
      ...(oracle.exportName ? { exportName: oracle.exportName } : {}),
      ...(oracle.description ? { description: oracle.description } : {}),
    } satisfies ScenarioOracle;
  });

  return {
    id: parsed.id,
    objective: parsed.objective,
    tags: parsed.tags,
    ...(featureOverrides ? { featureOverrides } : {}),
    constraints,
    steps,
    oracles,
  } satisfies EvaluationScenario;
}

/**
 * Parses raw JSON/YAML data into a validated {@link EvaluationScenario}. The
 * helper attaches default values so runtime code can avoid repetitive null
 * checks.
 */
export function parseScenario(data: unknown, source = "<inline>"): EvaluationScenario {
  const parsed = scenarioSchema.safeParse(data);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    throw new Error(`Failed to parse scenario from ${source}: ${message}`);
  }
  return sanitiseScenario(parsed.data);
}

/**
 * Reads and parses a scenario definition from disk. JSON and YAML extensions
 * are supported transparently.
 */
export async function loadScenarioFromFile(filePath: string): Promise<EvaluationScenario> {
  const contents = await readFile(filePath, "utf8");
  const extension = extname(filePath).toLowerCase();
  let raw: unknown;
  if (extension === ".json") {
    raw = JSON.parse(contents);
  } else if (extension === ".yaml" || extension === ".yml" || extension === "") {
    raw = YAML.parse(contents);
  } else {
    throw new Error(`Unsupported scenario extension for ${basename(filePath)}`);
  }
  return parseScenario(raw, filePath);
}

/**
 * Loads every scenario definition under the provided directory. Files ending in
 * `.yaml`, `.yml`, or `.json` are considered part of the campaign. Optional tag
 * filters allow CLI consumers to only execute targeted subsets.
 */
export async function loadScenariosFromDirectory(
  directory: string,
  options: { tags?: readonly string[] } = {},
): Promise<readonly EvaluationScenario[]> {
  const entries = await readFileDirectory(directory);
  const scenarios: EvaluationScenario[] = [];
  for (const entry of entries) {
    const extension = extname(entry).toLowerCase();
    if (!extension || extension === ".yaml" || extension === ".yml" || extension === ".json") {
      const scenario = await loadScenarioFromFile(join(directory, entry));
      if (options.tags && options.tags.length > 0) {
        const hasTag = options.tags.every((tag) => scenario.tags.includes(tag));
        if (!hasTag) {
          continue;
        }
      }
      scenarios.push(scenario);
    }
  }
  scenarios.sort((a, b) => a.id.localeCompare(b.id));
  return scenarios;
}

/**
 * Enumerates directory entries while ignoring hidden/system files. Extracted to
 * a helper for ease of testing.
 */
async function readFileDirectory(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => entry.name);
}

