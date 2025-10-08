import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import { McpSession, McpToolCallError, type ToolCallRecord } from './mcpSession.js';

import type { GraphDescriptorPayload, GraphGenerateResult } from '../../../src/tools/graphTools.js';

/**
 * Summary describing the extracted payloads from an MCP tool response. Storing
 * the structured and textual interpretations keeps the audit artefacts easy to
 * correlate while avoiding repeated JSON parsing when generating the final
 * report.
 */
export interface ToolResponseSummary {
  /** Whether the MCP response flagged the call as an error. */
  readonly isError: boolean;
  /** Structured content decoded from the MCP response when available. */
  readonly structured?: unknown;
  /** JSON payload decoded from the textual content, if valid JSON was found. */
  readonly parsedText?: unknown;
  /** Normalised error code extracted from the textual payload, when present. */
  readonly errorCode?: string | null;
  /** Optional hint exposed by the MCP tool to guide remediation. */
  readonly hint?: string | null;
}

/**
 * Snapshot describing a single MCP tool invocation exercised during the base
 * tools validation stage. The metadata is persisted to disk so the final report
 * can reference trace identifiers, artefact paths and error codes directly.
 */
export interface BaseToolCallSummary {
  /** Name of the MCP tool that was invoked. */
  readonly toolName: string;
  /** Optional semantic scenario identifier (e.g. normal vs. invalid input). */
  readonly scenario?: string;
  /** Trace identifier correlating logs, events and artefacts. */
  readonly traceId: string;
  /** Wall-clock duration (in milliseconds) spent waiting for the response. */
  readonly durationMs: number;
  /** Paths of the captured input/output artefacts. */
  readonly artefacts: ToolCallRecord['artefacts'];
  /**
   * Structured summary of the MCP response, including error codes when
   * available.
   */
  readonly response: ToolResponseSummary;
}

/** Aggregated report written once the stage finishes executing. */
export interface BaseToolsStageReport {
  /** Identifier of the validation run. */
  readonly runId: string;
  /** ISO timestamp marking the completion of the stage. */
  readonly completedAt: string;
  /** List of tool invocations captured during the stage. */
  readonly calls: BaseToolCallSummary[];
  /** High level metrics extracted from the captured calls. */
  readonly metrics: {
    /** Total number of tool calls issued. */
    readonly totalCalls: number;
    /** Number of calls whose response flagged an error. */
    readonly errorCount: number;
  };
  /** Optional identifier of the generated baseline graph reused by later steps. */
  readonly generatedGraphId?: string;
}

/** Options accepted by {@link runBaseToolsStage}. */
export interface BaseToolsStageOptions {
  /** Validation run context shared across stages. */
  readonly context: RunContext;
  /** Recorder used to persist inputs/outputs, events and logs. */
  readonly recorder: ArtifactRecorder;
  /** Optional factory injected during testing to control the MCP session. */
  readonly createSession?: () => McpSession;
}

/** Result returned by {@link runBaseToolsStage}. */
export interface BaseToolsStageResult {
  /** Absolute path of the JSON report generated for this stage. */
  readonly reportPath: string;
  /** Optional absolute path where the generated baseline graph was persisted. */
  readonly generatedGraphPath?: string;
  /** Collected summaries for each tool invocation. */
  readonly calls: BaseToolCallSummary[];
}

/**
 * Extracts the textual payload from an MCP response and attempts to parse it as
 * JSON. The helper gracefully falls back to the raw string when parsing fails
 * so that the audit report can still surface the original message.
 */
function parseTextContent(response: ToolCallRecord['response']): { parsed?: unknown; errorCode?: string | null; hint?: string | null } {
  const contentEntries = Array.isArray(response.content) ? response.content : [];
  const firstText = contentEntries.find(
    (entry): entry is { type?: string; text?: string } => typeof entry?.text === 'string' && (entry.type === undefined || entry.type === 'text'),
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

/** Builds a structured summary of the MCP response for the audit report. */
function summariseResponse(response: ToolCallRecord['response']): ToolResponseSummary {
  const { parsed, errorCode, hint } = parseTextContent(response);
  return {
    isError: response.isError ?? false,
    structured: response.structuredContent ?? undefined,
    parsedText: parsed,
    errorCode: errorCode ?? null,
    hint: hint ?? null,
  };
}

/**
 * Calls an MCP tool while capturing the {@link BaseToolCallSummary}. Transport
 * failures are converted into synthetic summaries so the report still contains
 * the trace identifiers and artefact paths required for debugging.
 */
async function callAndRecord(
  session: McpSession,
  toolName: string,
  payload: unknown,
  options: { scenario?: string },
  sink: BaseToolCallSummary[],
): Promise<ToolCallRecord | null> {
  try {
    const call = await session.callTool(toolName, payload);
    sink.push({
      toolName,
      scenario: options.scenario,
      traceId: call.traceId,
      durationMs: call.durationMs,
      artefacts: call.artefacts,
      response: summariseResponse(call.response),
    });
    return call;
  } catch (error) {
    if (error instanceof McpToolCallError) {
      sink.push({
        toolName,
        scenario: options.scenario,
        traceId: error.traceId,
        durationMs: error.durationMs,
        artefacts: error.artefacts,
        response: {
          isError: true,
          structured: undefined,
          parsedText:
            error.cause instanceof Error
              ? { message: error.cause.message, stack: error.cause.stack }
              : { message: String(error.cause) },
          errorCode: 'transport_failure',
          hint: null,
        },
      });
      return null;
    }
    throw error;
  }
}

/**
 * Executes the second checklist stage dedicated to baseline MCP tool coverage.
 * The harness focuses on deterministic graph tooling that does not require
 * complex orchestration state so that future stages can build upon the captured
 * artefacts.
 */
export async function runBaseToolsStage(options: BaseToolsStageOptions): Promise<BaseToolsStageResult> {
  const session = options.createSession
    ? options.createSession()
    : new McpSession({
        context: options.context,
        recorder: options.recorder,
        clientName: 'validation-base-tools',
        clientVersion: '1.0.0',
      });

  await session.open();

  const calls: BaseToolCallSummary[] = [];
  let generatedGraph: GraphDescriptorPayload | undefined;

  try {
    const generateCall = await callAndRecord(
      session,
      'graph_generate',
      {
        name: 'validation_baseline',
        default_weight: 2,
        tasks: {
          tasks: [
            { id: 'fetch', label: 'Fetch dependencies' },
            { id: 'build', label: 'Build', depends_on: ['fetch'], weight: 3 },
            { id: 'test', label: 'Test', depends_on: ['build'] },
          ],
        },
      },
      { scenario: 'valid' },
      calls,
    );

    if (generateCall?.response.structuredContent) {
      const structured = generateCall.response.structuredContent as GraphGenerateResult;
      generatedGraph = structured.graph;
    } else if (generateCall?.response.content) {
      const parsed = parseTextContent(generateCall.response).parsed as Partial<GraphGenerateResult> | undefined;
      if (parsed && typeof parsed === 'object' && parsed && 'graph' in parsed) {
        generatedGraph = (parsed as { graph?: GraphDescriptorPayload }).graph;
      }
    }

    if (!generatedGraph) {
      throw new Error('graph_generate did not return a graph descriptor');
    }

    await callAndRecord(
      session,
      'graph_validate',
      { graph: generatedGraph, include_invariants: true },
      { scenario: 'valid' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_summarize',
      { graph: generatedGraph, include_centrality: true },
      { scenario: 'valid' },
      calls,
    );

    const firstNode = generatedGraph.nodes[0]?.id ?? 'fetch';
    const lastNode = generatedGraph.nodes[generatedGraph.nodes.length - 1]?.id ?? 'test';

    await callAndRecord(
      session,
      'graph_paths_k_shortest',
      { graph: generatedGraph, from: firstNode, to: lastNode, k: 2 },
      { scenario: 'valid' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_paths_k_shortest',
      { graph: generatedGraph, from: '', to: 'missing', k: 0 },
      { scenario: 'invalid' },
      calls,
    );

    await callAndRecord(
      session,
      'logs_tail',
      {},
      { scenario: 'valid' },
      calls,
    );
  } finally {
    await session.close();
  }

  const report: BaseToolsStageReport = {
    runId: options.context.runId,
    completedAt: new Date().toISOString(),
    calls,
    metrics: {
      totalCalls: calls.length,
      errorCount: calls.filter((entry) => entry.response.isError).length,
    },
    generatedGraphId: generatedGraph?.graph_id,
  };

  const reportPath = path.join(options.context.directories.report, 'step02-base-tools.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  let generatedGraphPath: string | undefined;
  if (generatedGraph) {
    generatedGraphPath = path.join(options.context.directories.resources, 'stage02-base-graph.json');
    await writeFile(generatedGraphPath, `${JSON.stringify(generatedGraph, null, 2)}\n`, 'utf8');
  }

  return { reportPath, generatedGraphPath, calls };
}
