/**
 * Prompt templating helpers allow the planner to derive per-child messages from
 * a shared blueprint. Variables enclosed in `{{ }}` are replaced by the values
 * supplied at render time. Missing variables produce a descriptive error to
 * avoid dispatching incomplete prompts to a child agent.
 */
export class PromptTemplatingError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PromptTemplatingError';
    }
}
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
function normaliseSegment(segment) {
    if (!segment) {
        return [];
    }
    if (Array.isArray(segment)) {
        return segment;
    }
    return [segment];
}
function renderTemplateSegment(template, variables) {
    return template.replace(PLACEHOLDER_PATTERN, (_, key) => {
        if (!(key in variables)) {
            throw new PromptTemplatingError(`Missing prompt variable "${key}" while rendering template.`);
        }
        const value = variables[key];
        if (value === undefined || value === null) {
            throw new PromptTemplatingError(`Variable "${key}" must not be null or undefined.`);
        }
        return String(value);
    });
}
/**
 * Returns the list of unique placeholder names referenced in a template.
 */
export function extractTemplateVariables(template) {
    const seen = new Set();
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
export function renderPromptTemplate(template, options) {
    const segments = [
        { role: 'system', content: template.system },
        { role: 'user', content: template.user },
        { role: 'assistant', content: template.assistant },
    ];
    const messages = [];
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
