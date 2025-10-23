import { omitUndefinedEntries } from '../../../src/utils/object.js';
import type { McpToolCallError, ToolCallRecord } from './mcpSession.js';
import type { ToolResponseSummary } from './baseTools.js';

/**
 * Lightweight projection of an MCP tool response content.  The helper captures
 * both the parsed JSON payload (when valid) and the most common error signalling
 * fields so callers can reuse the computation without reparsing the original
 * text entries.
 */
export interface ParsedToolResponseContent {
  /** JSON payload decoded from the textual response when available. */
  readonly parsed?: unknown;
  /** Optional error code emitted by the MCP tool inside the textual payload. */
  readonly errorCode?: string | null;
  /** Optional remediation hint exposed alongside the textual payload. */
  readonly hint?: string | null;
}

/**
 * Extracts the first textual entry from an MCP response and attempts to decode
 * it as JSON.  When parsing fails the raw string is preserved so audit reports
 * can still surface the original diagnostic message.
 */
export function parseToolResponseText(
  response: ToolCallRecord['response'],
): ParsedToolResponseContent {
  const contentEntries = Array.isArray(response.content) ? response.content : [];
  const firstText = contentEntries.find(
    (entry): entry is { type?: string; text?: string } =>
      typeof entry?.text === 'string' && (entry.type === undefined || entry.type === 'text'),
  );
  if (!firstText?.text) {
    return { parsed: undefined, errorCode: null, hint: null };
  }

  try {
    const parsed = JSON.parse(firstText.text);
    const errorCode = typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : null;
    const hint = typeof (parsed as { hint?: unknown }).hint === 'string' ? (parsed as { hint: string }).hint : null;
    return { parsed, errorCode, hint };
  } catch {
    return { parsed: firstText.text, errorCode: null, hint: null };
  }
}

/**
 * Builds a structured {@link ToolResponseSummary} while omitting optional
 * properties when they are absent.  The helper keeps the Stage sample projects
 * aligned with the main sanitisation effort preceding the activation of
 * `exactOptionalPropertyTypes`.
 */
export function summariseToolResponse(
  response: ToolCallRecord['response'],
): ToolResponseSummary {
  const { parsed, errorCode, hint } = parseToolResponseText(response);
  const structured = response.structuredContent;
  return omitUndefinedEntries({
    isError: response.isError ?? false,
    structured,
    parsedText: parsed,
    errorCode: errorCode ?? null,
    hint: hint ?? null,
  }) as ToolResponseSummary;
}

/**
 * Constructs a transport failure summary matching the structure returned by
 * {@link summariseToolResponse} so downstream reports can rely on a uniform
 * shape.  The helper omits the optional `structured` field by design because the
 * error originates from the transport layer rather than the MCP tool itself.
 */
export function buildTransportFailureSummary(error: McpToolCallError): ToolResponseSummary {
  const parsedText =
    error.cause instanceof Error
      ? { message: error.cause.message, stack: error.cause.stack }
      : { message: String(error.cause) };

  return {
    isError: true,
    parsedText,
    errorCode: 'transport_failure',
    hint: null,
  } satisfies ToolResponseSummary;
}

export const __testing = {
  parseToolResponseText,
  summariseToolResponse,
  buildTransportFailureSummary,
};
