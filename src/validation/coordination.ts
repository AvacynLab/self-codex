// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.
/**
 * Stage 7 validation helpers covering the multi-agent coordination surfaces.
 *
 * The workflow focuses on the four primitives highlighted in the operator
 * checklist: Blackboard, Stigmergy, Contract-Net and Consensus. Similar to the
 * previous stages, the runner executes a deterministic JSON-RPC call plan while
 * persisting verbose artefacts (inputs/outputs/events/log snapshots) and a
 * high-level summary to help reviewers confirm that the automation exercised
 * the expected code paths.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  appendHttpCheckArtefactsToFiles,
  performHttpCheck,
  toJsonlLine,
  writeJsonFile,
  type HttpCheckSnapshot,
  type HttpEnvironmentSummary,
  type HttpCheckArtefactTargets,
} from "./runSetup.js";

/** JSONL artefacts dedicated to the coordination validation phase. */
export const COORDINATION_JSONL_FILES = {
  inputs: "inputs/07_coord.jsonl",
  outputs: "outputs/07_coord.jsonl",
  events: "events/07_coord.jsonl",
  log: "logs/coordination_http.json",
} as const;

/** Internal mapping reused when persisting HTTP request/response artefacts. */
const COORDINATION_TARGETS: HttpCheckArtefactTargets = {
  inputs: COORDINATION_JSONL_FILES.inputs,
  outputs: COORDINATION_JSONL_FILES.outputs,
};

/** File persisted under `report/` to expose the aggregated highlights quickly. */
const COORDINATION_SUMMARY_FILENAME = "coordination_summary.json";

/** Default Blackboard key leveraged by the canned validation scenario. */
const DEFAULT_BLACKBOARD_KEY = "validation:coordination:task";

/** Identifier assigned to the Stigmergy surface for repeatability. */
const DEFAULT_STIG_DOMAIN = "validation:stigmergy";

/** Identifier attached to the Contract-Net announcement. */
const DEFAULT_CNP_TOPIC = "validation:contract-net";

/** Identifier used when recording consensus ballots. */
const DEFAULT_CONSENSUS_TOPIC = "validation:consensus";

/**
 * Preferred outcome leveraged when demonstrating deterministic tie-breaking
 * during the consensus validation flow. Keeping the constant close to the
 * other identifiers makes it easy to override when composing custom scenarios.
 */
const DEFAULT_CONSENSUS_PREFERRED_OUTCOME = "validation_tie_break_preference";

/**
 * Manual bids submitted alongside the Contract-Net announcement to guarantee
 * that the poll exposes at least two concrete proposals, satisfying the
 * operator checklist requirements without relying on background heuristics.
 */
const DEFAULT_CONTRACT_NET_MANUAL_BIDS = [
  { agent_id: "agent.alpha", cost: 3.2, metadata: { role: "planner" } },
  { agent_id: "agent.beta", cost: 4.1, metadata: { role: "executor" } },
] as const;

/** Snapshot describing the JSON-RPC payloads executed during the validation. */
export interface CoordinationCallContext {
  /** HTTP environment used to reach the MCP endpoint. */
  readonly environment: HttpEnvironmentSummary;
  /** Chronological collection of outcomes recorded so far. */
  readonly previousCalls: readonly CoordinationCallOutcome[];
}

/** Function signature used to compute dynamic JSON-RPC parameters. */
export type CoordinationParamsFactory = (context: CoordinationCallContext) => unknown;

/**
 * Specification of a JSON-RPC call executed during the coordination workflow.
 * Each entry corresponds to a line appended in the JSONL artefacts.
 */
export interface CoordinationCallSpec {
  /** Logical scenario advertised in the artefacts (blackboard/stig/contract/etc.). */
  readonly scenario: string;
  /** Friendly identifier persisted alongside the request artefacts. */
  readonly name: string;
  /** JSON-RPC method invoked against the MCP endpoint. */
  readonly method: string;
  /** Optional params object or factory invoked before dispatching the request. */
  readonly params?: unknown | CoordinationParamsFactory;
  /** When false, response events are not appended to `events/07_coord.jsonl`. */
  readonly captureEvents?: boolean;
  /** Optional callback invoked after the call completes to persist artefacts. */
  readonly afterExecute?: CoordinationCallAfterHook;
}

/** Representation of a call after parameter factories resolved to JSON values. */
export type ExecutedCoordinationCall = Omit<CoordinationCallSpec, "params"> & {
  readonly params?: unknown;
};

/** Outcome persisted for each JSON-RPC call executed during the workflow. */
export interface CoordinationCallOutcome {
  readonly call: ExecutedCoordinationCall;
  readonly check: HttpCheckSnapshot;
  readonly events: unknown[];
}

/** Context forwarded to {@link CoordinationCallAfterHook}. */
export interface CoordinationCallAfterHookContext {
  readonly runRoot: string;
  readonly environment: HttpEnvironmentSummary;
  readonly outcome: CoordinationCallOutcome;
  readonly previousCalls: readonly CoordinationCallOutcome[];
}

/** Hook signature allowing callers to persist supplementary artefacts. */
export type CoordinationCallAfterHook = (
  context: CoordinationCallAfterHookContext,
) => Promise<void> | void;

/**
 * Configuration accepted by {@link buildDefaultCoordinationCalls}. Callers can
 * override the identifiers/values used by the canned validation scenario
 * without rewriting the entire call plan.
 */
export interface DefaultCoordinationOptions {
  readonly blackboardKey?: string;
  readonly stigDomain?: string;
  readonly contractTopic?: string;
  readonly consensusTopic?: string;
}

/** Options accepted by {@link runCoordinationPhase}. */
export interface CoordinationPhaseOptions {
  readonly calls?: CoordinationCallSpec[];
  readonly coordination?: DefaultCoordinationOptions;
}

/** Result returned by {@link runCoordinationPhase}. */
export interface CoordinationPhaseResult {
  readonly outcomes: readonly CoordinationCallOutcome[];
  readonly summary: CoordinationSummary;
  readonly summaryPath: string;
}

/** Summary structure persisted in `report/coordination_summary.json`. */
export interface CoordinationSummary {
  readonly artefacts: {
    readonly inputsJsonl: string;
    readonly outputsJsonl: string;
    readonly eventsJsonl: string;
    readonly httpSnapshotLog: string;
  };
  readonly blackboard: {
    readonly key?: string;
    readonly lastValue?: unknown;
    readonly queryMatches?: number;
    readonly watchId?: string;
    readonly eventCount: number;
  };
  readonly stigmergy: {
    readonly domain?: string;
    readonly marksApplied: number;
    readonly lastSnapshot?: Record<string, unknown> | null;
  };
  readonly contractNet: {
    readonly topic?: string;
    readonly announcementId?: string;
    readonly proposalCount?: number;
    readonly awardedAgentId?: string;
  };
  readonly consensus: {
    readonly topic?: string;
    readonly outcome?: unknown;
    readonly votes?: number;
    readonly tie?: boolean;
    readonly tally?: Record<string, number> | null;
    readonly preferredOutcome?: string | null;
    readonly tieBreaker?: "null" | "first" | "prefer" | undefined;
    readonly tieDetectedFromTally?: boolean;
  };
}

/**
 * Executes the Stage 7 coordination validation call plan while persisting all
 * artefacts expected by the operator checklist.
 */
export async function runCoordinationPhase(
  runRoot: string,
  environment: HttpEnvironmentSummary,
  options: CoordinationPhaseOptions = {},
): Promise<CoordinationPhaseResult> {
  const calls = options.calls ?? buildDefaultCoordinationCalls(options.coordination);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (environment.token) {
    headers.authorization = `Bearer ${environment.token}`;
  }

  const outcomes: CoordinationCallOutcome[] = [];

  for (let index = 0; index < calls.length; index += 1) {
    const spec = calls[index];
    const params =
      typeof spec.params === "function"
        ? (spec.params as CoordinationParamsFactory)({ environment, previousCalls: outcomes })
        : spec.params;

    const requestBody: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: buildJsonRpcId(index, spec),
      method: spec.method,
    };
    if (params !== undefined) {
      requestBody.params = params;
    }

    const check = await performHttpCheck(`${spec.scenario}:${spec.name}`, {
      method: "POST",
      url: environment.baseUrl,
      headers,
      body: requestBody,
    });

    const executedCall: ExecutedCoordinationCall = {
      scenario: spec.scenario,
      name: spec.name,
      method: spec.method,
      captureEvents: spec.captureEvents,
      params,
    };

    await appendHttpCheckArtefactsToFiles(runRoot, COORDINATION_TARGETS, check, COORDINATION_JSONL_FILES.log);

    const events = spec.captureEvents === false ? [] : extractEvents(check.response.body);
    if (events.length) {
      await appendCoordinationEvents(runRoot, executedCall, events);
    }

    const outcome: CoordinationCallOutcome = { call: executedCall, check, events };
    if (spec.afterExecute) {
      await spec.afterExecute({ runRoot, environment, outcome, previousCalls: outcomes });
    }
    outcomes.push(outcome);
  }

  const summary = buildCoordinationSummary(runRoot, outcomes);
  const summaryPath = join(runRoot, "report", COORDINATION_SUMMARY_FILENAME);
  await writeJsonFile(summaryPath, summary);

  validateCoordinationExpectations(outcomes, summary);

  return { outcomes, summary, summaryPath };
}

/**
 * Builds the default call plan covering Blackboard, Stigmergy, Contract-Net and
 * Consensus flows expected by Stage 7.
 */
export function buildDefaultCoordinationCalls(
  options: DefaultCoordinationOptions = {},
): CoordinationCallSpec[] {
  const blackboardKey = options.blackboardKey ?? DEFAULT_BLACKBOARD_KEY;
  const stigDomain = options.stigDomain ?? DEFAULT_STIG_DOMAIN;
  const contractTopic = options.contractTopic ?? DEFAULT_CNP_TOPIC;
  const consensusTopic = options.consensusTopic ?? DEFAULT_CONSENSUS_TOPIC;
  const preferredConsensusOutcome = DEFAULT_CONSENSUS_PREFERRED_OUTCOME;

  return [
    {
      scenario: "blackboard",
      name: "bb_set_initial_task",
      method: "bb_set",
      params: {
        key: blackboardKey,
        value: {
          title: "Validate multi-agent coordination",
          priority: "high",
          issued_at: new Date().toISOString(),
        },
      },
    },
    {
      scenario: "blackboard",
      name: "bb_get_task",
      method: "bb_get",
      params: { key: blackboardKey },
    },
    {
      scenario: "blackboard",
      name: "bb_query_tasks",
      method: "bb_query",
      params: {
        filter: {
          op: "and",
          operands: [
            { op: "starts_with", field: "key", value: blackboardKey.split(":")[0] ?? blackboardKey },
            { op: "equals", field: "value.priority", value: "high" },
          ],
        },
        limit: 10,
      },
    },
    {
      scenario: "blackboard",
      name: "bb_watch_task",
      method: "bb_watch",
      params: {
        key: blackboardKey,
        include_history: true,
      },
    },
    {
      scenario: "blackboard",
      name: "bb_set_progress_update",
      method: "bb_set",
      params: {
        key: blackboardKey,
        value: {
          title: "Validate multi-agent coordination",
          priority: "high",
          progress: "in-flight",
          updated_at: new Date().toISOString(),
        },
      },
    },
    {
      scenario: "blackboard",
      name: "bb_set_final_status",
      method: "bb_set",
      params: {
        key: blackboardKey,
        value: {
          title: "Validate multi-agent coordination",
          priority: "high",
          status: "complete",
          completed_at: new Date().toISOString(),
        },
      },
    },
    {
      scenario: "blackboard",
      name: "bb_watch_poll_round_1",
      method: "bb_watch_poll",
      params: ({ previousCalls }: CoordinationCallContext) => ({
        watch_id: requireBlackboardWatchId(previousCalls),
        max_events: 10,
        wait_ms: 0,
      }),
    },
    {
      scenario: "blackboard",
      name: "bb_watch_poll_round_2",
      method: "bb_watch_poll",
      params: ({ previousCalls }: CoordinationCallContext) => ({
        watch_id: requireBlackboardWatchId(previousCalls),
        max_events: 10,
        wait_ms: 0,
      }),
    },
    {
      scenario: "stigmergy",
      name: "stig_mark_initial",
      method: "stig_mark",
      params: {
        domain: stigDomain,
        key: "beacon",
        intensity: 0.8,
        metadata: { label: "coordination" },
      },
    },
    {
      scenario: "stigmergy",
      name: "stig_snapshot",
      method: "stig_snapshot",
      params: { domain: stigDomain },
    },
    {
      scenario: "stigmergy",
      name: "stig_decay",
      method: "stig_decay",
      params: { domain: stigDomain, factor: 0.5 },
    },
    {
      scenario: "contract-net",
      name: "cnp_announce",
      method: "cnp_announce",
      params: {
        topic: contractTopic,
        task: {
          id: "coordination_task",
          objective: "Evaluate proposals for cooperative validation",
          deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
        requirements: {
          min_capability: "validation",
          priority: 1,
        },
        manual_bids: DEFAULT_CONTRACT_NET_MANUAL_BIDS.map((bid) => ({
          agent_id: bid.agent_id,
          cost: bid.cost,
          metadata: bid.metadata,
        })),
      },
    },
    {
      scenario: "contract-net",
      name: "cnp_poll",
      method: "cnp_poll",
      params: ({ previousCalls }: CoordinationCallContext) => ({
        topic: contractTopic,
        announcement_id: requireAnnouncementId(previousCalls),
        max_proposals: 5,
      }),
    },
    {
      scenario: "contract-net",
      name: "cnp_award",
      method: "cnp_award",
      params: ({ previousCalls }: CoordinationCallContext) => ({
        topic: contractTopic,
        announcement_id: requireAnnouncementId(previousCalls),
        proposal_id: requireFirstProposalId(previousCalls),
      }),
    },
    {
      scenario: "consensus",
      name: "consensus_vote",
      method: "consensus_vote",
      params: {
        topic: consensusTopic,
        votes: [
          { voter: "agent.alpha", value: "plan_alpha" },
          { voter: "agent.beta", value: "plan_beta" },
        ],
        config: {
          mode: "majority",
          tie_breaker: "prefer",
          prefer_value: preferredConsensusOutcome,
        },
      },
    },
    {
      scenario: "consensus",
      name: "consensus_status",
      method: "consensus_status",
      params: { topic: consensusTopic },
    },
  ];
}

/** Builds a deterministic JSON-RPC identifier for coordination calls. */
function buildJsonRpcId(index: number, call: CoordinationCallSpec): string {
  const scenarioToken = call.scenario.replace(/[^a-zA-Z0-9]+/g, "-");
  const nameToken = call.name.replace(/[^a-zA-Z0-9]+/g, "-");
  return `coord_${index}_${scenarioToken}_${nameToken}`;
}

/** Extracts the `result` payload from a JSON-RPC response when available. */
function extractJsonRpcResult(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  return result as Record<string, unknown>;
}

/** Extracts response events (if any) from a JSON-RPC body. */
function extractEvents(body: unknown): unknown[] {
  const result = extractJsonRpcResult(body);
  if (!result) {
    return [];
  }
  const events = result.events;
  if (Array.isArray(events)) {
    return events;
  }
  return [];
}

/** Appends captured events to the phase-specific `.jsonl` artefact. */
async function appendCoordinationEvents(
  runRoot: string,
  call: ExecutedCoordinationCall,
  events: unknown[],
): Promise<void> {
  if (!events.length) {
    return;
  }
  const capturedAt = new Date().toISOString();
  const payload = events
    .map((event) =>
      toJsonlLine({
        scenario: call.scenario,
        name: call.name,
        capturedAt,
        event,
      }),
    )
    .join("");
  await writeFile(join(runRoot, COORDINATION_JSONL_FILES.events), payload, {
    encoding: "utf8",
    flag: "a",
  });
}

/** Reads the `watch_id` returned by `bb_watch`. */
function requireBlackboardWatchId(previousCalls: readonly CoordinationCallOutcome[]): string {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    if (outcome.call.method !== "bb_watch") {
      continue;
    }
    const result = extractJsonRpcResult(outcome.check.response.body);
    const watchId = result?.watch_id;
    if (typeof watchId === "string" && watchId.length > 0) {
      return watchId;
    }
  }
  throw new Error("Expected bb_watch to return a watch_id before polling");
}

/** Reads the Contract-Net announcement identifier from previous calls. */
function requireAnnouncementId(previousCalls: readonly CoordinationCallOutcome[]): string {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    if (outcome.call.method !== "cnp_announce") {
      continue;
    }
    const result = extractJsonRpcResult(outcome.check.response.body);
    const announcementId = result?.announcement_id;
    if (typeof announcementId === "string" && announcementId.length > 0) {
      return announcementId;
    }
  }
  throw new Error("Expected cnp_announce to provide announcement_id before polling");
}

/** Retrieves the first proposal identifier returned by `cnp_poll`. */
function requireFirstProposalId(previousCalls: readonly CoordinationCallOutcome[]): string {
  for (let index = previousCalls.length - 1; index >= 0; index -= 1) {
    const outcome = previousCalls[index];
    if (outcome.call.method !== "cnp_poll") {
      continue;
    }
    const result = extractJsonRpcResult(outcome.check.response.body);
    const proposals = result?.proposals;
    if (Array.isArray(proposals) && proposals.length > 0) {
      const proposal = proposals[0];
      if (proposal && typeof proposal === "object" && !Array.isArray(proposal)) {
        const proposalId = (proposal as { id?: unknown }).id;
        if (typeof proposalId === "string" && proposalId.length > 0) {
          return proposalId;
        }
      }
    }
  }
  throw new Error("Expected cnp_poll to provide at least one proposal before awarding");
}

/**
 * Aggregates the most relevant datapoints from the coordination workflow. The
 * summary intentionally mirrors the sections found in the operator checklist so
 * reviewers can quickly map automated evidence to the manual validation tasks.
 */
export function buildCoordinationSummary(
  runRoot: string,
  outcomes: readonly CoordinationCallOutcome[],
): CoordinationSummary {
  let blackboardKey: string | undefined;
  let blackboardValue: unknown;
  let blackboardMatches: number | undefined;
  let watchId: string | undefined;
  let watchEvents = 0;

  let stigDomain: string | undefined;
  let marksApplied = 0;
  let lastSnapshot: Record<string, unknown> | null | undefined;

  let announcementTopic: string | undefined;
  let announcementId: string | undefined;
  let proposalCount: number | undefined;
  let awardedAgentId: string | undefined;

  let consensusTopic: string | undefined;
  let consensusOutcome: unknown;
  let consensusVotes: number | undefined;
  let consensusTie: boolean | undefined;
  let consensusTally: Record<string, number> | undefined;
  let consensusPreferred: string | null | undefined;
  let consensusTieBreaker: "null" | "first" | "prefer" | undefined;

  for (const outcome of outcomes) {
    const result = extractJsonRpcResult(outcome.check.response.body);

    switch (outcome.call.method) {
      case "bb_set":
        blackboardKey = result?.key as string | undefined;
        blackboardValue = result?.value ?? outcome.call.params;
        break;
      case "bb_get":
        blackboardKey = typeof result?.key === "string" ? result.key : (outcome.call.params as { key?: string })?.key;
        blackboardValue = result?.value ?? blackboardValue;
        break;
      case "bb_query":
        if (Array.isArray(result?.items)) {
          blackboardMatches = result?.items.length;
        }
        break;
      case "bb_watch":
        if (typeof result?.watch_id === "string") {
          watchId = result.watch_id;
        }
        if (Array.isArray(result?.events)) {
          watchEvents += result.events.length;
        }
        break;
      case "bb_watch_poll":
        if (Array.isArray(result?.events)) {
          watchEvents += result.events.length;
        }
        break;
      case "stig_mark":
        marksApplied += 1;
        stigDomain = (outcome.call.params as { domain?: string })?.domain ?? stigDomain;
        break;
      case "stig_snapshot":
        if (result && typeof result === "object" && !Array.isArray(result)) {
          lastSnapshot = result as Record<string, unknown>;
        }
        break;
      case "stig_decay":
        stigDomain = (outcome.call.params as { domain?: string })?.domain ?? stigDomain;
        break;
      case "cnp_announce":
        announcementTopic = (outcome.call.params as { topic?: string })?.topic ?? announcementTopic;
        if (typeof result?.announcement_id === "string") {
          announcementId = result.announcement_id;
        }
        if (Array.isArray(result?.proposals)) {
          proposalCount = result.proposals.length;
        } else if (Array.isArray(result?.bids)) {
          proposalCount = result.bids.length;
        }
        break;
      case "cnp_poll":
        if (Array.isArray(result?.proposals)) {
          proposalCount = result.proposals.length;
        } else if (Array.isArray(result?.bids)) {
          proposalCount = result.bids.length;
        }
        break;
      case "cnp_award":
        if (typeof result?.announcement_id === "string") {
          announcementId = result.announcement_id;
        }
        if (typeof result?.awarded_agent_id === "string") {
          awardedAgentId = result.awarded_agent_id;
        }
        break;
      case "consensus_vote":
        consensusTopic = (outcome.call.params as { topic?: string })?.topic ?? consensusTopic;
        consensusOutcome = result?.outcome ?? result ?? consensusOutcome;
        if (typeof result?.votes === "number") {
          consensusVotes = result.votes;
        }
        if (typeof result?.tie === "boolean") {
          consensusTie = result.tie;
        }
        if (result?.tally && typeof result.tally === "object" && !Array.isArray(result.tally)) {
          consensusTally = result.tally as Record<string, number>;
        }
        if (
          outcome.call.params &&
          typeof outcome.call.params === "object" &&
          !Array.isArray(outcome.call.params)
        ) {
          const params = outcome.call.params as {
            config?: { tie_breaker?: "null" | "first" | "prefer"; prefer_value?: string | null };
          };
          consensusPreferred = params.config?.prefer_value ?? consensusPreferred;
          consensusTieBreaker = params.config?.tie_breaker ?? consensusTieBreaker;
        }
        break;
      case "consensus_status":
        consensusTopic = (outcome.call.params as { topic?: string })?.topic ?? consensusTopic;
        consensusOutcome = result?.decision ?? result ?? consensusOutcome;
        if (typeof result?.votes === "number") {
          consensusVotes = result.votes;
        }
        if (typeof result?.tie === "boolean") {
          consensusTie = result.tie;
        }
        if (result?.tally && typeof result.tally === "object" && !Array.isArray(result.tally)) {
          consensusTally = result.tally as Record<string, number>;
        }
        break;
      default:
        break;
    }
  }

  return {
    artefacts: {
      inputsJsonl: join(runRoot, COORDINATION_JSONL_FILES.inputs),
      outputsJsonl: join(runRoot, COORDINATION_JSONL_FILES.outputs),
      eventsJsonl: join(runRoot, COORDINATION_JSONL_FILES.events),
      httpSnapshotLog: join(runRoot, COORDINATION_JSONL_FILES.log),
    },
    blackboard: {
      key: blackboardKey,
      lastValue: blackboardValue,
      queryMatches: blackboardMatches,
      watchId,
      eventCount: watchEvents,
    },
    stigmergy: {
      domain: stigDomain,
      marksApplied,
      lastSnapshot: lastSnapshot ?? null,
    },
    contractNet: {
      topic: announcementTopic,
      announcementId,
      proposalCount,
      awardedAgentId,
    },
    consensus: {
      topic: consensusTopic,
      outcome: consensusOutcome,
      votes: consensusVotes,
      tie: consensusTie,
      tally: consensusTally ?? null,
      preferredOutcome: consensusPreferred ?? null,
      tieBreaker: consensusTieBreaker,
      tieDetectedFromTally: detectTieFromTally(consensusTally),
    },
  };
}

/**
 * Ensures the recorded Stage 07 artefacts satisfy the validation checklist.
 * The helper raises a descriptive error listing all unmet expectations so the
 * CLI and unit tests can expose actionable diagnostics to operators.
 */
function validateCoordinationExpectations(
  outcomes: readonly CoordinationCallOutcome[],
  summary: CoordinationSummary,
): void {
  const issues: string[] = [];

  if (summary.blackboard.eventCount < 3) {
    issues.push(
      `Blackboard watch emitted ${summary.blackboard.eventCount} event(s); expected ≥ 3 after successive bb_set updates.`,
    );
  }
  if (!summary.blackboard.watchId) {
    issues.push("Blackboard watch identifier missing from bb_watch response.");
  }

  if (!summary.contractNet.announcementId) {
    issues.push("Contract-Net announcement did not return an announcement_id.");
  }
  if ((summary.contractNet.proposalCount ?? 0) < 2) {
    issues.push(
      `Contract-Net poll exposed ${summary.contractNet.proposalCount ?? 0} proposal(s); expected at least 2 manual bids.`,
    );
  }
  if (!summary.contractNet.awardedAgentId) {
    issues.push("Contract-Net award did not include the awarded agent identifier.");
  }

  if (!summary.consensus.topic) {
    issues.push("Consensus vote did not echo the requested topic.");
  }
  if (typeof summary.consensus.votes !== "number" || summary.consensus.votes < 2) {
    issues.push(
      `Consensus workflow processed ${summary.consensus.votes ?? 0} vote(s); expected at least two ballots for tie-breaking.`,
    );
  }
  if (summary.consensus.tieBreaker === "prefer") {
    if (!summary.consensus.preferredOutcome) {
      issues.push("Consensus tie-breaker configured to 'prefer' but no prefer_value recorded.");
    } else if (summary.consensus.outcome !== summary.consensus.preferredOutcome) {
      issues.push(
        `Consensus outcome ${String(
          summary.consensus.outcome,
        )} does not match prefer_value ${summary.consensus.preferredOutcome}.`,
      );
    }
  }
  if (!summary.consensus.tieDetectedFromTally) {
    issues.push("Consensus tally did not exhibit a tie between top candidates.");
  }

  if (issues.length > 0) {
    const requestIds = outcomes
      .map((outcome) => {
        const body = outcome.check.request.body;
        if (!body || typeof body !== "object") {
          return undefined;
        }
        const candidate = (body as { id?: unknown }).id;
        return typeof candidate === "string" || typeof candidate === "number" ? candidate : undefined;
      })
      .filter((id): id is string | number => id !== undefined);
    const contextHint = requestIds.length
      ? `Captured requests: ${requestIds.map((id) => String(id)).join(", ")}`
      : "No JSON-RPC ids captured.";
    throw new Error(`Stage 07 validation incomplete: ${issues.join(" ")} ${contextHint}`);
  }
}

/**
 * Detects whether the provided tally contains a tie amongst the highest weight
 * candidates. Returning `true` confirms that the tie-breaker logic was
 * exercised while still allowing deterministic outcomes through preferences.
 */
function detectTieFromTally(tally: Record<string, number> | undefined): boolean {
  if (!tally) {
    return false;
  }
  const weights = Object.values(tally).filter((value): value is number => typeof value === "number");
  if (weights.length <= 1) {
    return false;
  }
  const maxWeight = Math.max(...weights);
  return weights.filter((value) => value === maxWeight).length >= 2;
}
