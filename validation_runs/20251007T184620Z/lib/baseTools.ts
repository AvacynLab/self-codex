import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import { McpSession, McpToolCallError, type ToolCallRecord } from './mcpSession.js';
import {
  buildTransportFailureSummary,
  parseToolResponseText,
  summariseToolResponse,
} from './responseSummary.js';

import type { GraphDescriptorPayload, GraphGenerateResult } from '../../../src/tools/graphTools.js';
import { SUBGRAPH_REGISTRY_KEY } from '../../../src/graph/subgraphRegistry.js';
import { omitUndefinedEntries } from '../../../src/utils/object.js';

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
      ...(options.scenario ? { scenario: options.scenario } : {}),
      traceId: call.traceId,
      durationMs: call.durationMs,
      artefacts: call.artefacts,
      response: summariseToolResponse(call.response),
    });
    return call;
  } catch (error) {
    if (error instanceof McpToolCallError) {
      sink.push({
        toolName,
        ...(options.scenario ? { scenario: options.scenario } : {}),
        traceId: error.traceId,
        durationMs: error.durationMs,
        artefacts: error.artefacts,
        response: buildTransportFailureSummary(error),
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
        featureOverrides: {
          enableMcpIntrospection: true,
          enableResources: true,
          enableEventsBus: true,
          enableAutoscaler: true,
          enableBlackboard: true,
          enableBulk: true,
        },
      });

  await session.open();

  const calls: BaseToolCallSummary[] = [];
  let generatedGraph: GraphDescriptorPayload | undefined;
  const workspaceRoot = process.cwd();
  const runWorkspaceDir = path.join('runs', options.context.runId);
  const graphSnapshotRelativePath = path.join(runWorkspaceDir, 'stage02-graph-snapshot.json');
  const graphSnapshotAbsolutePath = path.join(workspaceRoot, graphSnapshotRelativePath);
  const graphAutosaveRelativePath = path.join(runWorkspaceDir, 'stage02-graph-autosave.json');
  const graphAutosaveAbsolutePath = path.join(workspaceRoot, graphAutosaveRelativePath);
  const cleanupTargets = new Set<string>([graphSnapshotAbsolutePath, graphAutosaveAbsolutePath]);

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
      const parsed = parseToolResponseText(generateCall.response).parsed as Partial<GraphGenerateResult> | undefined;
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

    // Apply a follow-up mutation to register the generated graph in the
    // transaction manager. Bulk operations rely on this baseline so we add a new
    // QA node, connect it to the critical path and decorate the entry node with
    // an explicit priority attribute.
    const mutateCall = await callAndRecord(
      session,
      'graph_mutate',
      {
        graph: generatedGraph,
        operations: [
          {
            op: 'add_node',
            node: {
              id: 'qa',
              label: 'Quality assurance',
              attributes: { kind: 'task', duration: 1, weight: 1 },
            },
          },
          {
            op: 'add_edge',
            edge: {
              from: lastNode,
              to: 'qa',
              weight: 1,
              attributes: { kind: 'handoff', label: 'handoff' },
            },
          },
          { op: 'set_node_attribute', id: firstNode, key: 'priority', value: 'high' },
        ],
      },
      { scenario: 'graph_mutate_expand_flow' },
      calls,
    );

    if (mutateCall?.response.structuredContent) {
      const structured = mutateCall.response.structuredContent as { graph?: GraphDescriptorPayload };
      if (structured.graph) {
        generatedGraph = structured.graph;
      }
    } else if (mutateCall?.response.content) {
      const parsed = parseToolResponseText(mutateCall.response).parsed as { graph?: GraphDescriptorPayload } | undefined;
      if (parsed?.graph) {
        generatedGraph = parsed.graph;
      }
    }

    await callAndRecord(
      session,
      'logs_tail',
      {},
      { scenario: 'valid' },
      calls,
    );

    await callAndRecord(
      session,
      'mcp_info',
      {},
      { scenario: 'introspection_info' },
      calls,
    );

    await callAndRecord(
      session,
      'mcp_capabilities',
      {},
      { scenario: 'introspection_capabilities' },
      calls,
    );

    const resourcesCall = await callAndRecord(
      session,
      'resources_list',
      { limit: 50 },
      { scenario: 'resources_list_baseline' },
      calls,
    );

    let firstResourceUri: string | null = null;
    if (resourcesCall) {
      const structured = resourcesCall.response.structuredContent as { items?: Array<{ uri?: unknown }> } | undefined;
      const parsed = structured ?? (parseToolResponseText(resourcesCall.response).parsed as { items?: Array<{ uri?: unknown }> } | undefined);
      const items = parsed?.items ?? [];
      const first = items.find((entry) => typeof entry?.uri === 'string');
      if (first && typeof first.uri === 'string') {
        firstResourceUri = first.uri;
      }
    }

    if (firstResourceUri) {
      await callAndRecord(
        session,
        'resources_read',
        { uri: firstResourceUri },
        { scenario: 'resources_read_first' },
        calls,
      );

      await callAndRecord(
        session,
        'resources_watch',
        { uri: firstResourceUri, limit: 5 },
        { scenario: 'resources_watch_first' },
        calls,
      );
    }

    await callAndRecord(
      session,
      'events_subscribe',
      { limit: 5 },
      { scenario: 'events_subscribe_baseline' },
      calls,
    );

    await callAndRecord(
      session,
      'events_view',
      { limit: 10 },
      { scenario: 'events_view_recent' },
      calls,
    );

    await callAndRecord(
      session,
      'events_view_live',
      { limit: 10 },
      { scenario: 'events_view_live' },
      calls,
    );

    await callAndRecord(
      session,
      'agent_autoscale_set',
      { min: 0, max: 2, cooldown_ms: 1_000 },
      { scenario: 'agent_autoscale_bounds' },
      calls,
    );

    // --- Blackboard coordination primitives ---------------------------------
    // Establish a deterministic namespace so later stages (children, plans,
    // final report) can reason about the exact entries created during Stage 2.
    const blackboardNamespace = 'stage02/baseTools';

    const bbSetCall = await callAndRecord(
      session,
      'bb_set',
      {
        key: `${blackboardNamespace}/status`,
        value: { stage: 'base-tools', status: 'ok' },
        tags: ['stage02', 'baseline'],
        ttl_ms: 60_000,
      },
      { scenario: 'bb_set_baseline' },
      calls,
    );

    // Capture the version emitted by the first mutation so we can request a
    // stable slice of the event stream regardless of the output format returned
    // by the tool (structured vs. textual JSON).
    const bbSetVersion = (() => {
      if (!bbSetCall) {
        return null;
      }
      if (!bbSetCall.response.structuredContent) {
        const parsed = parseToolResponseText(bbSetCall.response).parsed as { version?: number } | undefined;
        return typeof parsed?.version === 'number' ? parsed.version : null;
      }
      const structured = bbSetCall.response.structuredContent as { version?: number };
      return typeof structured.version === 'number' ? structured.version : null;
    })();

    await callAndRecord(
      session,
      'bb_get',
      { key: `${blackboardNamespace}/status` },
      { scenario: 'bb_get_existing' },
      calls,
    );

    await callAndRecord(
      session,
      'bb_batch_set',
      {
        entries: [
          {
            key: `${blackboardNamespace}/metrics`,
            value: { totalCalls: calls.length },
            tags: ['stage02', 'metrics'],
          },
          {
            key: `${blackboardNamespace}/notes`,
            value: 'Stage 2 captured baseline coordination primitives.',
            tags: ['stage02'],
          },
        ],
      },
      { scenario: 'bb_batch_set_metrics' },
      calls,
    );

    await callAndRecord(
      session,
      'bb_query',
      {
        keys: [`${blackboardNamespace}/status`, `${blackboardNamespace}/metrics`],
        tags: ['stage02'],
        limit: 5,
      },
      { scenario: 'bb_query_namespace' },
      calls,
    );

    await callAndRecord(
      session,
      'bb_watch',
      {
        start_version: Math.max(0, (bbSetVersion ?? 0) - 1),
        limit: 10,
      },
      { scenario: 'bb_watch_recent' },
      calls,
    );

    // --- Graph state management and diagnostics ---------------------------------
    await callAndRecord(
      session,
      'graph_export',
      {
        format: 'json',
        inline: true,
        truncate: 1_024,
      },
      { scenario: 'graph_export_inline' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_state_stats',
      {},
      { scenario: 'graph_state_stats_overview' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_state_metrics',
      {},
      { scenario: 'graph_state_metrics_summary' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_state_inactivity',
      {
        scope: 'children',
        limit: 5,
        include_children_without_messages: true,
        format: 'json',
      },
      { scenario: 'graph_state_inactivity_children' },
      calls,
    );

    // Tune retention knobs to ensure transcript/event quotas surface deterministic
    // payloads for the report, then restore the runtime default after the probe.
    await callAndRecord(
      session,
      'graph_config_retention',
      {
        max_transcript_per_child: 16,
        max_event_nodes: 128,
      },
      { scenario: 'graph_config_retention_bounds' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_config_runtime',
      {
        runtime: 'python',
      },
      { scenario: 'graph_config_runtime_override' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_config_runtime',
      {
        reset: true,
      },
      { scenario: 'graph_config_runtime_reset' },
      calls,
    );

    // Exercise both pruning modes: event compaction and transcript trimming for a
    // missing child to assert no-op behaviour remains well-formed.
    await callAndRecord(
      session,
      'graph_prune',
      {
        action: 'events',
        max_events: 25,
      },
      { scenario: 'graph_prune_events' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_prune',
      {
        action: 'transcript',
        child_id: `${blackboardNamespace}/missing-child`,
        keep_last: 2,
      },
      { scenario: 'graph_prune_transcript_missing' },
      calls,
    );

    // Collect a filtered slice of child nodes to confirm the query surface stays
    // operational even when the orchestrator hosts an empty child index.
    await callAndRecord(
      session,
      'graph_query',
      {
        kind: 'filter',
        select: 'nodes',
        where: { type: 'child' },
        limit: 5,
      },
      { scenario: 'graph_query_filter_children' },
      calls,
    );

    // --- Graph state persistence utilities -------------------------------------
    // Persist the orchestrator state to a workspace path so we can exercise the
    // load flow and archive the snapshot alongside the validation artefacts.
    await callAndRecord(
      session,
      'graph_state_save',
      { path: graphSnapshotRelativePath },
      { scenario: 'graph_state_save_snapshot' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_state_load',
      { path: graphSnapshotRelativePath },
      { scenario: 'graph_state_load_snapshot' },
      calls,
    );

    // Toggle the autosave loop on and off to confirm the scheduler acknowledges
    // bounded intervals and produces a deterministic acknowledgement payload.
    await callAndRecord(
      session,
      'graph_state_autosave',
      { action: 'start', path: graphAutosaveRelativePath, interval_ms: 1_000 },
      { scenario: 'graph_state_autosave_start' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_state_autosave',
      { action: 'stop' },
      { scenario: 'graph_state_autosave_stop' },
      calls,
    );

    // Copy the saved snapshot into the validation run for long term auditing.
    try {
      const snapshotPayload = await readFile(graphSnapshotAbsolutePath, 'utf8');
      const snapshotTarget = path.join(options.context.directories.resources, 'stage02-graph-state.json');
      await writeFile(snapshotTarget, snapshotPayload, 'utf8');
    } catch (error) {
      await options.recorder.appendLogEntry({
        level: 'warn',
        message: 'graph_state_snapshot_copy_failed',
        details: {
          path: graphSnapshotAbsolutePath,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    // --- Hierarchical graph tooling --------------------------------------------
    const hierarchicalGraph: GraphDescriptorPayload = {
      name: 'stage02_hierarchical',
      nodes: [
        { id: 'root', label: 'Root task', attributes: { kind: 'task' } },
        { id: 'gateway', label: 'Gateway', attributes: { kind: 'task' } },
        {
          id: 'subgraph',
          label: 'Embedded flow',
          attributes: { kind: 'subgraph', ref: 'stage02-subflow' },
        },
        { id: 'after', label: 'Completion', attributes: { kind: 'task' } },
      ],
      edges: [
        { from: 'root', to: 'gateway', attributes: { role: 'sequence' } },
        { from: 'gateway', to: 'subgraph', attributes: { role: 'handoff' } },
        { from: 'subgraph', to: 'after', attributes: { role: 'resume' } },
      ],
      metadata: {
        [SUBGRAPH_REGISTRY_KEY]: JSON.stringify({
          'stage02-subflow': {
            graph: {
              nodes: [
                { id: 'entry', label: 'Entry', attributes: { kind: 'task' } },
                { id: 'work', label: 'Work', attributes: { kind: 'task' } },
                { id: 'exit', label: 'Exit', attributes: { kind: 'task' } },
              ],
              edges: [
                { from: 'entry', to: 'work', attributes: { role: 'sequence' } },
                { from: 'work', to: 'exit', attributes: { role: 'sequence' } },
              ],
              metadata: {},
            },
            entryPoints: ['entry'],
            exitPoints: ['exit'],
          },
        }),
      },
    };

    const subgraphCall = await callAndRecord(
      session,
      'graph_subgraph_extract',
      {
        graph: hierarchicalGraph,
        node_id: 'subgraph',
        run_id: options.context.runId,
        directory: 'stage02-subgraphs',
      },
      { scenario: 'graph_subgraph_extract_hierarchy' },
      calls,
    );

    if (subgraphCall?.response.structured) {
      const structured = subgraphCall.response.structured as { absolute_path?: unknown };
      const absolute = typeof structured.absolute_path === 'string' ? structured.absolute_path : null;
      if (absolute) {
        cleanupTargets.add(absolute);
        try {
          const descriptorPayload = await readFile(absolute, 'utf8');
          const descriptorTarget = path.join(
            options.context.directories.resources,
            'stage02-subgraph-descriptor.json',
          );
          await writeFile(descriptorTarget, descriptorPayload, 'utf8');
        } catch (error) {
          await options.recorder.appendLogEntry({
            level: 'warn',
            message: 'graph_subgraph_descriptor_copy_failed',
            details: {
              path: absolute,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }

    await callAndRecord(
      session,
      'graph_hyper_export',
      {
        id: 'stage02-hyper',
        nodes: [
          { id: 'alpha', attributes: { kind: 'task' } },
          { id: 'beta', attributes: { kind: 'task' } },
          { id: 'gamma', attributes: { kind: 'task' } },
        ],
        hyper_edges: [
          {
            id: 'alpha-beta',
            sources: ['alpha'],
            targets: ['beta', 'gamma'],
            attributes: { mode: 'fanout' },
          },
        ],
        metadata: {},
      },
      { scenario: 'graph_hyper_export_projection' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_rewrite_apply',
      {
        graph: hierarchicalGraph,
        mode: 'manual',
        rules: ['inline_subgraph'],
        options: { stop_on_no_change: true },
      },
      { scenario: 'graph_rewrite_apply_inline' },
      calls,
    );

    // --- Graph analytics & optimisation probes ---------------------------------
    const analyticsGraph: GraphDescriptorPayload = {
      name: 'stage02_analytics',
      metadata: { stage: 'base-tools', focus: 'analytics' },
      nodes: [
        {
          id: 'ingest',
          label: 'Ingest dataset',
          attributes: { duration: 2, cost: 3, risk: 0.2 },
        },
        {
          id: 'plan',
          label: 'Plan pipeline',
          attributes: { duration: 3, cost: 2, risk: 0.1 },
        },
        {
          id: 'build',
          label: 'Build artefacts',
          attributes: { duration: 4, cost: 4, risk: 0.4 },
        },
        {
          id: 'test',
          label: 'Test suite',
          attributes: { duration: 2, cost: 2, risk: 0.15 },
        },
        {
          id: 'deploy',
          label: 'Deploy release',
          attributes: { duration: 1, cost: 1, risk: 0.05 },
        },
        {
          id: 'monitor',
          label: 'Monitor',
          attributes: { duration: 1, cost: 1, risk: 0.05 },
        },
      ],
      edges: [
        {
          from: 'ingest',
          to: 'plan',
          weight: 1,
          attributes: { weight: 1, cost: 1 },
        },
        {
          from: 'plan',
          to: 'build',
          weight: 2,
          attributes: { weight: 2, cost: 2 },
        },
        {
          from: 'plan',
          to: 'test',
          weight: 4,
          attributes: { weight: 4, cost: 2 },
        },
        {
          from: 'build',
          to: 'test',
          weight: 3,
          attributes: { weight: 3, cost: 3 },
        },
        {
          from: 'test',
          to: 'deploy',
          weight: 1,
          attributes: { weight: 1, cost: 1 },
        },
        {
          from: 'deploy',
          to: 'monitor',
          weight: 1,
          attributes: { weight: 1, cost: 1 },
        },
      ],
    };

    await callAndRecord(
      session,
      'graph_paths_constrained',
      {
        graph: analyticsGraph,
        from: 'ingest',
        to: 'deploy',
        weight_attribute: 'weight',
        cost: { attribute: 'cost', default_value: 1 },
        avoid_nodes: ['monitor'],
        avoid_edges: [{ from: 'plan', to: 'test' }],
        max_cost: 12,
      },
      { scenario: 'graph_paths_constrained_budget' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_paths_constrained',
      {
        graph: analyticsGraph,
        from: 'missing',
        to: 'deploy',
        weight_attribute: 'weight',
      },
      { scenario: 'graph_paths_constrained_missing' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_centrality_betweenness',
      {
        graph: analyticsGraph,
        weighted: true,
        weight_attribute: 'weight',
        cost: { attribute: 'cost', scale: 0.5 },
        top_k: 3,
      },
      { scenario: 'graph_centrality_betweenness_weighted' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_partition',
      {
        graph: analyticsGraph,
        k: 2,
        objective: 'community',
        seed: 42,
      },
      { scenario: 'graph_partition_community' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_critical_path',
      {
        graph: analyticsGraph,
        duration_attribute: 'duration',
        default_duration: 1,
      },
      { scenario: 'graph_critical_path_baseline' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_simulate',
      {
        graph: analyticsGraph,
        parallelism: 2,
        duration_attribute: 'duration',
        default_duration: 1,
      },
      { scenario: 'graph_simulate_parallel' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_optimize',
      {
        graph: analyticsGraph,
        parallelism: 2,
        max_parallelism: 3,
        explore_parallelism: [1, 2, 3],
        duration_attribute: 'duration',
        objective: { type: 'cost', attribute: 'cost', default_value: 1, parallel_penalty: 0.2 },
      },
      { scenario: 'graph_optimize_cost_objective' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_optimize',
      {
        graph: analyticsGraph,
        parallelism: 4,
        max_parallelism: 2,
        duration_attribute: 'duration',
      },
      { scenario: 'graph_optimize_invalid_parallelism' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_optimize_moo',
      {
        graph: analyticsGraph,
        parallelism_candidates: [1, 2, 3],
        objectives: [
          { type: 'makespan', label: 'makespan' },
          { type: 'cost', label: 'cost', attribute: 'cost', default_value: 1 },
        ],
        duration_attribute: 'duration',
        scalarization: { method: 'weighted_sum', weights: { makespan: 0.6, cost: 0.4 } },
      },
      { scenario: 'graph_optimize_moo_weighted_sum' },
      calls,
    );

    await callAndRecord(
      session,
      'graph_causal_analyze',
      {
        graph: analyticsGraph,
        max_cycles: 10,
        include_transitive_closure: true,
        compute_min_cut: true,
      },
      { scenario: 'graph_causal_analyze_baseline' },
      calls,
    );

    // --- Bulk tooling -----------------------------------------------------------
    const batchGraphId = generatedGraph.graph_id;
    const batchGraphVersion = generatedGraph.graph_version ?? 1;
    if (!batchGraphId) {
      throw new Error('graph_mutate did not expose a graph_id for batch operations');
    }

    const batchMutateCall = await callAndRecord(
      session,
      'graph_batch_mutate',
      {
        graph_id: batchGraphId,
        expected_version: batchGraphVersion,
        operations: [
          { op: 'set_node_attribute', id: 'qa', key: 'status', value: 'pending' },
          {
            op: 'patch_metadata',
            set: { stage: 'base-tools', revision: 'bulk' },
          },
        ],
        note: 'stage02-batch-mutate',
        idempotency_key: 'stage02-graph-batch',
      },
      { scenario: 'graph_batch_mutate_attributes' },
      calls,
    );

    if (batchMutateCall?.response.structuredContent) {
      const structured = batchMutateCall.response.structuredContent as { graph?: GraphDescriptorPayload };
      if (structured.graph) {
        generatedGraph = structured.graph;
      }
    } else if (batchMutateCall?.response.content) {
      const parsed = parseToolResponseText(batchMutateCall.response).parsed as { graph?: GraphDescriptorPayload } | undefined;
      if (parsed?.graph) {
        generatedGraph = parsed.graph;
      }
    }

    await callAndRecord(
      session,
      'graph_batch_mutate',
      {
        graph_id: batchGraphId,
        expected_version: batchGraphVersion,
        operations: [
          { op: 'set_node_attribute', id: 'qa', key: 'status', value: 'approved' },
        ],
        owner: 'stage02-conflict-probe',
      },
      { scenario: 'graph_batch_mutate_conflict' },
      calls,
    );

    // --- Graph Forge DSL compilation ----------------------------------------
    // Exercise the embedded Graph Forge interpreter with a concise pipeline
    // description so we persist both the compiled graph summary and the
    // resolved analysis reports. The DSL mirrors the official README example
    // while keeping the payload compact for deterministic fixtures.
    const graphForgeSource = [
      'graph Stage02Pipeline {',
      '  directive allowCycles false;',
      '  node Fetch    { label: "Fetch dependencies" cost: 2 }',
      '  node Build    { label: "Compile" cost: 3 }',
      '  node Test     { label: "Test" cost: 1 }',
      '  edge Fetch -> Build { weight: 1 }',
      '  edge Build -> Test  { weight: 1 }',
      '  @analysis shortestPath Fetch Test;',
      '  @analysis criticalPath;',
      '}',
    ].join('\n');

    await callAndRecord(
      session,
      'graph_forge_analyze',
      {
        source: graphForgeSource,
        entry_graph: 'Stage02Pipeline',
        use_defined_analyses: true,
      },
      { scenario: 'graph_forge_analyze_pipeline' },
      calls,
    );

    // --- Job management surfaces -------------------------------------------
    // Even without active jobs, the orchestrator should list an empty catalogue
    // and reject lookups with a deterministic NOT_FOUND payload. Exercising
    // these tools now prevents Stage 8 from flagging missing coverage.
    await callAndRecord(
      session,
      'status',
      {},
      { scenario: 'status_list_jobs' },
      calls,
    );

    await callAndRecord(
      session,
      'status',
      { job_id: 'job_missing_stage02' },
      { scenario: 'status_missing_job' },
      calls,
    );

    await callAndRecord(
      session,
      'job_view',
      { job_id: 'job_missing_stage02', per_child_limit: 5 },
      { scenario: 'job_view_missing_job' },
      calls,
    );

    await callAndRecord(
      session,
      'conversation_view',
      { child_id: 'child_missing_stage02', limit: 5, format: 'json' },
      { scenario: 'conversation_view_missing_child' },
      calls,
    );

    await callAndRecord(
      session,
      'start',
      { job_id: 'job_missing_stage02' },
      { scenario: 'start_missing_job' },
      calls,
    );

    await callAndRecord(
      session,
      'aggregate',
      { job_id: 'job_missing_stage02', strategy: 'concat', include_system: true },
      { scenario: 'aggregate_missing_job' },
      calls,
    );

    await callAndRecord(
      session,
      'kill',
      { job_id: 'job_missing_stage02' },
      { scenario: 'kill_missing_job' },
      calls,
    );
  } finally {
    await session.close();
    await Promise.all(
      Array.from(cleanupTargets).map(async (target) => {
        await rm(target, { force: true }).catch(() => {});
      }),
    );
  }

  const report = omitUndefinedEntries({
    runId: options.context.runId,
    completedAt: new Date().toISOString(),
    calls,
    metrics: {
      totalCalls: calls.length,
      errorCount: calls.filter((entry) => entry.response.isError).length,
    },
    generatedGraphId:
      typeof generatedGraph?.graph_id === 'string' && generatedGraph.graph_id.trim().length > 0
        ? generatedGraph.graph_id
        : undefined,
  }) as BaseToolsStageReport;

  const reportPath = path.join(options.context.directories.report, 'step02-base-tools.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  let generatedGraphPath: string | undefined;
  if (generatedGraph) {
    generatedGraphPath = path.join(options.context.directories.resources, 'stage02-base-graph.json');
    await writeFile(generatedGraphPath, `${JSON.stringify(generatedGraph, null, 2)}\n`, 'utf8');
  }

  return omitUndefinedEntries({ reportPath, generatedGraphPath, calls }) as BaseToolsStageResult;
}
