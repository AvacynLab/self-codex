import { z } from "zod";

/**
 * Prompt templating helpers allow the planner to derive per-child messages from
 * a shared blueprint. Variables enclosed in `{{ }}` are replaced by the values
 * supplied at render time. Missing variables produce a descriptive error to
 * avoid dispatching incomplete prompts to a child agent.
 */

export type PromptRole = "system" | "user" | "assistant";

export interface PromptMessage {
  /** Role associated with a prompt message following the MCP convention. */
  role: PromptRole;
  /** Fully rendered textual content for the message. */
  content: string;
}

/**
 * Schema describing a prompt segment. Each segment can be a single string or a
 * list of strings rendered sequentially. We export it so other modules
 * (child/create, plan tools) can validate inputs consistently.
 */
export const PromptTemplateSegmentSchema = z.union([
  z.string(),
  z.array(z.string()),
]);

/** Blueprint describing the supported prompt sections. */
export const PromptTemplateSchema = z
  .object({
    system: PromptTemplateSegmentSchema.optional(),
    user: PromptTemplateSegmentSchema.optional(),
    assistant: PromptTemplateSegmentSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.system && !value.user && !value.assistant) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prompt template must define at least one segment",
      });
    }
  });

/**
 * Schema validating the variables that can be injected into a template.
 * Values are limited to primitives so the rendered messages remain serialisable.
 */
export const PromptVariablesSchema = z.record(
  z.union([z.string(), z.number(), z.boolean()]),
);

/** Schema applied to the `renderPromptTemplate` options. */
export const RenderPromptOptionsSchema = z.object({
  variables: PromptVariablesSchema,
});

/** Type alias used throughout the server after validation. */
export type PromptTemplate = z.output<typeof PromptTemplateSchema>;
/** Accepted input type before validation. */
export type PromptTemplateInput = z.input<typeof PromptTemplateSchema>;

/** Normalised representation of the variables injected into a prompt. */
export type PromptVariables = z.output<typeof PromptVariablesSchema>;
/** Input accepted before validation for prompt variables. */
export type PromptVariablesInput = z.input<typeof PromptVariablesSchema>;

/** Final structure accepted by {@link renderPromptTemplate} options. */
export type RenderPromptOptions = z.output<typeof RenderPromptOptionsSchema>;
/** Raw options accepted prior to validation. */
export type RenderPromptOptionsInput = z.input<typeof RenderPromptOptionsSchema>;

/** Custom error surfaced when templating validation fails. */
export class PromptTemplatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptTemplatingError";
  }
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/**
 * Formats the issues reported by Zod into a compact message suitable for
 * operators. Keeping the path and message makes troubleshooting clear while
 * avoiding verbose stack traces in logs.
 */
function formatValidationIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join(".");
      const prefix = path.length > 0 ? `${path}: ` : "";
      return `${prefix}${issue.message}`;
    })
    .join("; ");
}

/**
 * Validates and normalises a prompt template. Throws a
 * {@link PromptTemplatingError} if the input cannot be parsed.
 */
export function parsePromptTemplate(
  template: PromptTemplateInput,
): PromptTemplate {
  const result = PromptTemplateSchema.safeParse(template);
  if (!result.success) {
    throw new PromptTemplatingError(
      `Invalid prompt template: ${formatValidationIssues(result.error.issues)}`,
    );
  }

  return result.data;
}

/**
 * Validates the render options before injecting variables into the template.
 */
export function parseRenderPromptOptions(
  options: RenderPromptOptionsInput,
): RenderPromptOptions {
  const result = RenderPromptOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new PromptTemplatingError(
      `Invalid prompt variables: ${formatValidationIssues(result.error.issues)}`,
    );
  }

  return result.data;
}

type PromptSegment = z.infer<typeof PromptTemplateSegmentSchema>;

function normaliseSegment(segment: PromptSegment | undefined): string[] {
  if (!segment) {
    return [];
  }

  if (Array.isArray(segment)) {
    return segment;
  }

  return [segment];
}

function renderTemplateSegment(
  template: string,
  variables: PromptVariables,
): string {
  return template.replace(PLACEHOLDER_PATTERN, (_, key: string) => {
    if (!(key in variables)) {
      throw new PromptTemplatingError(
        `Missing prompt variable "${key}" while rendering template.`,
      );
    }

    const value = variables[key];
    if (value === undefined || value === null) {
      throw new PromptTemplatingError(
        `Variable "${key}" must not be null or undefined.`,
      );
    }

    return String(value);
  });
}

/**
 * Returns the list of unique placeholder names referenced in a template.
 */
export function extractTemplateVariables(
  template: PromptTemplateInput,
): string[] {
  const parsed = parsePromptTemplate(template);
  const seen = new Set<string>();
  const segments = [parsed.system, parsed.user, parsed.assistant].flatMap(
    normaliseSegment,
  );

  for (const segment of segments) {
    for (const match of segment.matchAll(PLACEHOLDER_PATTERN)) {
      seen.add(match[1]);
    }
  }

  return Array.from(seen.values()).sort();
}

/**
 * Renders the provided prompt template using the supplied variables.
 *
 * @param template - Blueprint describing system/user/assistant messages.
 * @param options - Values injected into the template placeholders.
 * @returns Array of messages in MCP compatible order.
 */
export function renderPromptTemplate(
  template: PromptTemplateInput,
  options: RenderPromptOptionsInput,
): PromptMessage[] {
  const parsedTemplate = parsePromptTemplate(template);
  const parsedOptions = parseRenderPromptOptions(options);

  const segments = [
    { role: "system" as const, content: parsedTemplate.system },
    { role: "user" as const, content: parsedTemplate.user },
    { role: "assistant" as const, content: parsedTemplate.assistant },
  ];

  const messages: PromptMessage[] = [];

  for (const segment of segments) {
    const parts = normaliseSegment(segment.content);
    for (const part of parts) {
      messages.push({
        role: segment.role,
        content: renderTemplateSegment(part, parsedOptions.variables),
      });
    }
  }

  return messages;
}
