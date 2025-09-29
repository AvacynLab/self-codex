/**
 * Prompt templating helpers allow the planner to derive per-child messages from
 * a shared blueprint. Variables enclosed in `{{ }}` are replaced by the values
 * supplied at render time. Missing variables produce a descriptive error to
 * avoid dispatching incomplete prompts to a child agent.
 */

export type PromptRole = 'system' | 'user' | 'assistant';

export interface PromptMessage {
  role: PromptRole;
  content: string;
}

export type PromptSegment = string | string[];

export interface PromptTemplate {
  /** Optional system message shown at the beginning of the conversation. */
  system?: PromptSegment;
  /** One or many user messages describing the task. */
  user?: PromptSegment;
  /** Optional assistant priming messages. */
  assistant?: PromptSegment;
}

export interface RenderPromptOptions {
  /** Values injected into the template placeholders. */
  variables: Record<string, string | number | boolean>;
}

export class PromptTemplatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptTemplatingError';
  }
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

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
  variables: RenderPromptOptions['variables'],
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
export function extractTemplateVariables(template: PromptTemplate): string[] {
  const seen = new Set<string>();
  const segments = [template.system, template.user, template.assistant]
    .flatMap(normaliseSegment);

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
  template: PromptTemplate,
  options: RenderPromptOptions,
): PromptMessage[] {
  const segments = [
    { role: 'system' as const, content: template.system },
    { role: 'user' as const, content: template.user },
    { role: 'assistant' as const, content: template.assistant },
  ];

  const messages: PromptMessage[] = [];

  for (const segment of segments) {
    const parts = normaliseSegment(segment.content);
    for (const part of parts) {
      messages.push({
        role: segment.role,
        content: renderTemplateSegment(part, options.variables),
      });
    }
  }

  return messages;
}
