import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
// NOTE: Node built-in modules are imported with the explicit `node:` prefix to guarantee ESM resolution in Node.js.

const DEFAULT_THRESHOLD = 0.6;

/**
 * Hard safety limits applied to value graph operations. The caps keep the
 * in-memory representation predictable so hostile configurations cannot blow
 * through memory (for instance by loading tens of thousands of values or
 * impacts in a single plan evaluation).
 */
export const VALUE_GRAPH_LIMITS = Object.freeze({
  /** Maximum number of values accepted in a single configuration update. */
  maxValues: 128,
  /** Global cap on relationships across every value. */
  maxRelationships: 2048,
  /** Maximum number of outgoing relationships per value. */
  maxRelationshipsPerValue: 64,
  /** Maximum number of impacts processed when scoring a plan. */
  maxImpactsPerPlan: 256,
  /** Highest allowed weight for a single value (arbitrary large values offer no benefit). */
  maxValueWeight: 100,
} as const);

/** Allowed relationship kinds between value nodes. */
export type ValueRelationshipKind = "supports" | "conflicts";

/** Directional edge describing how a source value influences a target one. */
export interface ValueRelationshipInput {
  from: string;
  to: string;
  kind: ValueRelationshipKind;
  weight?: number | undefined;
}

/** Declarative description of a value node accepted when configuring the graph. */
export interface ValueNodeInput {
  id: string;
  label?: string | undefined;
  description?: string | undefined;
  weight?: number | undefined;
  tolerance?: number | undefined;
}

/** Fully normalised value node stored internally by the graph. */
interface ValueNode {
  id: string;
  label?: string | undefined;
  description?: string | undefined;
  weight: number;
  tolerance: number;
}

/** Internal representation of a relationship once normalised. */
interface ValueRelationship {
  from: string;
  to: string;
  kind: ValueRelationshipKind;
  weight: number;
}

/** Declarative impact payload plugged into the value guard. */
export interface ValueImpactInput {
  value: string;
  impact: "support" | "risk";
  severity?: number | undefined;
  rationale?: string | undefined;
  source?: string | undefined;
  /** Optional identifier of the plan node producing this impact. */
  nodeId?: string | undefined;
}

/** Contribution captured when computing the score for a single value node. */
interface ValueContribution {
  type: "support" | "risk";
  amount: number;
  impact: ValueImpactInput;
  propagatedFrom?: string | undefined;
  relationKind?: ValueRelationshipKind | undefined;
}

interface ValueContributionBucket {
  node: ValueNode;
  support: number;
  risk: number;
  contributions: ValueContribution[];
}

interface ValueEvaluationResult {
  perValue: Map<string, ValueContributionBucket>;
  breakdown: ValueScoreBreakdown[];
  violations: ValueViolation[];
  score: number;
  totalWeight: number;
}

/** Serializable breakdown entry returned for each value node. */
export interface ValueScoreBreakdown extends Record<string, unknown> {
  value: string;
  weight: number;
  support: number;
  risk: number;
  residual: number;
  satisfaction: number;
}

/** Serializable violation surfaced when the residual risk exceeds the tolerance. */
/**
 * Detailed contribution entry recorded for violations. The amount captures the
 * absolute weight added by the impact once normalised and propagated across the
 * relationship graph.
 */
export interface ValueViolationContributorDetails extends Record<string, unknown> {
  impact: ValueImpactInput;
  amount: number;
  type: "support" | "risk";
  propagated: boolean;
  via?: ValueRelationshipKind | undefined;
  from?: string | undefined;
}

export interface ValueViolation extends Record<string, unknown> {
  value: string;
  severity: number;
  tolerance: number;
  message: string;
  contributors: ValueViolationContributorDetails[];
}

/** Result returned when evaluating a plan against the value graph. */
export interface ValueScoreResult extends Record<string, unknown> {
  score: number;
  total: number;
  breakdown: ValueScoreBreakdown[];
  violations: ValueViolation[];
}

/** Decision returned by {@link ValueGraph.filter}. */
export interface ValueFilterDecision extends ValueScoreResult {
  allowed: boolean;
  threshold: number;
}

/**
 * Enriched violation returned by {@link ValueGraph.explain}. It preserves the
 * original violation payload while adding correlation hints and human readable
 * guidance that downstream tooling can surface directly to operators.
 */
export interface ValueViolationInsight extends ValueViolation {
  nodeId: string | null;
  nodeLabel: string | null;
  hint: string;
  primaryContributor: ValueViolationContributorDetails | null;
}

/** Result returned by {@link ValueGraph.explain}. */
export interface ValueExplanationResult extends Record<string, unknown> {
  decision: ValueFilterDecision;
  violations: ValueViolationInsight[];
}

/** Input payload accepted when scoring or filtering a plan. */
export interface ValueScoreInput {
  id: string;
  label?: string | undefined;
  impacts: ValueImpactInput[];
}

/** Extended input accepted when filtering with an override threshold. */
export interface ValueFilterInput extends ValueScoreInput {
  threshold?: number | undefined;
}

/** Configuration accepted when initialising or replacing the value graph. */
export interface ValueGraphConfig {
  values: ValueNodeInput[];
  relationships?: ValueRelationshipInput[] | undefined;
  defaultThreshold?: number | undefined;
}

/** Summary returned after updating the value graph configuration. */
export interface ValueGraphSummary extends Record<string, unknown> {
  version: number;
  values: number;
  relationships: number;
  default_threshold: number;
}

/** Options accepted when constructing a {@link ValueGraph}. */
export interface ValueGraphOptions {
  /** Optional deterministic clock used to timestamp emitted events. */
  now?: () => number;
}

/**
 * Optional correlation metadata attached to plan evaluation events so downstream
 * observers can associate guard decisions with orchestrator runs/operations.
 */
export interface ValueGraphCorrelationHints {
  runId?: string | null;
  opId?: string | null;
  jobId?: string | null;
  graphId?: string | null;
  nodeId?: string | null;
  childId?: string | null;
}

/** Options accepted when evaluating a plan (score/filter/explain). */
export interface ValuePlanEvaluationOptions {
  /** Optional correlation hints propagated to emitted telemetry events. */
  correlation?: ValueGraphCorrelationHints | null;
}

/** Base metadata emitted for every value guard event. */
export interface ValueGraphEventBase {
  /** Kind of event being emitted. */
  kind: "config_updated" | "plan_scored" | "plan_filtered" | "plan_explained";
  /** Millisecond timestamp recorded when the event was produced. */
  at: number;
  /** Optional correlation metadata propagated from the caller. */
  correlation?: ValueGraphCorrelationHints | null;
}

/** Event raised whenever the graph configuration changes. */
export interface ValueGraphConfigUpdatedEvent extends ValueGraphEventBase {
  kind: "config_updated";
  summary: ValueGraphSummary;
}

/** Base shape shared by plan evaluation events. */
export interface ValueGraphPlanEventBase extends ValueGraphEventBase {
  planId: string;
  planLabel: string | null;
  impacts: ValueImpactInput[];
}

/** Event raised after computing the raw score for a plan. */
export interface ValueGraphPlanScoredEvent extends ValueGraphPlanEventBase {
  kind: "plan_scored";
  result: ValueScoreResult;
}

/** Event raised after deciding whether a plan passes the guard. */
export interface ValueGraphPlanFilteredEvent extends ValueGraphPlanEventBase {
  kind: "plan_filtered";
  decision: ValueFilterDecision;
}

/** Event raised after generating a detailed explanation for a plan. */
export interface ValueGraphPlanExplainedEvent extends ValueGraphPlanEventBase {
  kind: "plan_explained";
  result: ValueExplanationResult;
}

/** Union of events emitted by {@link ValueGraph}. */
export type ValueGraphEvent =
  | ValueGraphConfigUpdatedEvent
  | ValueGraphPlanScoredEvent
  | ValueGraphPlanFilteredEvent
  | ValueGraphPlanExplainedEvent;

/** Listener signature used when subscribing to value guard events. */
export type ValueGraphEventListener = (event: ValueGraphEvent) => void;

/** Deterministic helper capping a number within the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Normalises an optional severity value to the closed interval `[0, 1]`. */
function normaliseSeverity(severity: number | undefined): number {
  if (severity === undefined) return 1;
  return clamp(severity, 0, 1);
}

/** Normalises a tolerance value, falling back to a sane default. */
function normaliseTolerance(tolerance: number | undefined): number {
  if (tolerance === undefined) {
    return 0.35;
  }
  return clamp(tolerance, 0, 1);
}

/** Normalises the weight associated with a value node. */
function normaliseWeight(weight: number | undefined): number {
  if (weight === undefined) {
    return 1;
  }
  const clamped = clamp(weight, 0, VALUE_GRAPH_LIMITS.maxValueWeight);
  return clamped === 0 ? 1 : clamped;
}

/** Normalises relationship weights to the `[0, 1]` interval. */
function normaliseRelationshipWeight(weight: number | undefined): number {
  if (weight === undefined) {
    return 0.5;
  }
  return clamp(weight, 0, 1);
}

/** Utility ensuring a map contains a record for the provided key. */
function ensureRecord<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const next = create();
  map.set(key, next);
  return next;
}

/** Internal event channel identifier used by the value graph emitter. */
const VALUE_EVENT = "value_event";

/** Create defensive copies of impacts so emitted events remain immutable. */
function cloneImpacts(impacts: ValueImpactInput[]): ValueImpactInput[] {
  return impacts.map((impact) => ({ ...impact }));
}

/**
 * Produces a defensive copy of correlation hints so downstream listeners cannot
 * mutate the metadata stored alongside emitted events.
 */
function cloneCorrelationHints(
  hints: ValueGraphCorrelationHints | null | undefined,
): ValueGraphCorrelationHints | null {
  if (!hints) {
    return null;
  }

  const clone: ValueGraphCorrelationHints = {};
  if (hints.runId !== undefined) clone.runId = hints.runId ?? null;
  if (hints.opId !== undefined) clone.opId = hints.opId ?? null;
  if (hints.jobId !== undefined) clone.jobId = hints.jobId ?? null;
  if (hints.graphId !== undefined) clone.graphId = hints.graphId ?? null;
  if (hints.nodeId !== undefined) clone.nodeId = hints.nodeId ?? null;
  if (hints.childId !== undefined) clone.childId = hints.childId ?? null;

  return Object.keys(clone).length > 0 ? clone : null;
}

/**
 * Stores the value definitions declared by operators and exposes scoring
 * utilities to guard plans before launching expensive fan-outs.
 */
export class ValueGraph {
  /** Incremental version incremented on every successful configuration update. */
  private version = 0;

  /** Default threshold applied when filtering plans. */
  private defaultThreshold = DEFAULT_THRESHOLD;

  /** Normalised nodes keyed by their identifier. */
  private readonly nodes = new Map<string, ValueNode>();

  /** Directed adjacency list describing how values influence each other. */
  private readonly adjacency = new Map<string, ValueRelationship[]>();

  /** Internal event emitter broadcasting value guard telemetry. */
  private readonly emitter = new EventEmitter();

  /** Clock used to timestamp emitted events. */
  private readonly now: () => number;

  constructor(options: ValueGraphOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Subscribe to value guard events. Returns a disposer unregistering the listener. */
  subscribe(listener: ValueGraphEventListener): () => void {
    this.emitter.on(VALUE_EVENT, listener);
    return () => {
      this.emitter.off(VALUE_EVENT, listener);
    };
  }

  /** Dispatch an event to every registered listener. */
  private emitEvent(event: ValueGraphEvent): void {
    this.emitter.emit(VALUE_EVENT, event);
  }

  /** Replace the entire graph configuration with the provided specification. */
  set(config: ValueGraphConfig): ValueGraphSummary {
    assert(config.values.length > 0, "value graph requires at least one value definition");

    if (config.values.length > VALUE_GRAPH_LIMITS.maxValues) {
      throw new RangeError(
        `value graph supports at most ${VALUE_GRAPH_LIMITS.maxValues} values per configuration (received ${config.values.length})`,
      );
    }

    const nextNodes = new Map<string, ValueNode>();
    for (const value of config.values) {
      assert(value.id.trim().length > 0, "value id must not be empty");
      const id = value.id.trim();
      if (nextNodes.has(id)) {
        throw new Error(`duplicate value id '${id}' in configuration`);
      }
      nextNodes.set(id, {
        id,
        label: value.label?.trim() || undefined,
        description: value.description?.trim() || undefined,
        weight: normaliseWeight(value.weight),
        tolerance: normaliseTolerance(value.tolerance),
      });
    }

    const nextAdjacency = new Map<string, ValueRelationship[]>();
    let relationshipCount = 0;

    if (config.relationships) {
      for (const relationship of config.relationships) {
        const from = relationship.from.trim();
        const to = relationship.to.trim();
        if (!nextNodes.has(from)) {
          throw new Error(`relationship source '${from}' is not declared as a value`);
        }
        if (!nextNodes.has(to)) {
          throw new Error(`relationship target '${to}' is not declared as a value`);
        }
        if (from === to) {
          continue; // Self-influence does not bring any signal, ignore silently.
        }
        const entry: ValueRelationship = {
          from,
          to,
          kind: relationship.kind,
          weight: normaliseRelationshipWeight(relationship.weight),
        };
        if (entry.weight === 0) {
          continue; // Zero-weight edges would not influence the score anyway.
        }
        if (relationshipCount + 1 > VALUE_GRAPH_LIMITS.maxRelationships) {
          throw new RangeError(
            `value graph supports at most ${VALUE_GRAPH_LIMITS.maxRelationships} relationships (received ${relationshipCount + 1})`,
          );
        }
        const bucket = ensureRecord(nextAdjacency, entry.from, () => []);
        if (bucket.length >= VALUE_GRAPH_LIMITS.maxRelationshipsPerValue) {
          throw new RangeError(
            `value '${entry.from}' declares more than ${VALUE_GRAPH_LIMITS.maxRelationshipsPerValue} outgoing relationships (received ${bucket.length + 1})`,
          );
        }
        bucket.push(entry);
        relationshipCount += 1;
      }
    }

    const nextDefaultThreshold = clamp(config.defaultThreshold ?? this.defaultThreshold, 0, 1);

    this.nodes.clear();
    this.adjacency.clear();
    for (const [id, node] of nextNodes) {
      this.nodes.set(id, node);
    }
    for (const [source, edges] of nextAdjacency) {
      this.adjacency.set(source, edges);
    }
    this.defaultThreshold = nextDefaultThreshold;
    this.version += 1;

    const summary: ValueGraphSummary = {
      version: this.version,
      values: this.nodes.size,
      relationships: Array.from(this.adjacency.values()).reduce((acc, list) => acc + list.length, 0),
      default_threshold: this.defaultThreshold,
    };

    this.emitEvent({
      kind: "config_updated",
      at: this.now(),
      summary,
    });

    return summary;
  }

  /**
   * Removes every configured value and relationship, restoring the default
   * threshold. The version counter is incremented so downstream listeners can
   * observe the reset through the emitted configuration event.
   */
  clear(): void {
    this.nodes.clear();
    this.adjacency.clear();
    this.defaultThreshold = DEFAULT_THRESHOLD;
    this.version += 1;

    const summary: ValueGraphSummary = {
      version: this.version,
      values: 0,
      relationships: 0,
      default_threshold: this.defaultThreshold,
    };

    this.emitEvent({
      kind: "config_updated",
      at: this.now(),
      summary,
    });
  }

  /**
   * Produces a serialisable configuration describing the current state of the
   * graph. Returning `null` keeps callers aware that no values have been
   * declared yet.
   */
  exportConfiguration(): ValueGraphConfig | null {
    if (this.nodes.size === 0) {
      return null;
    }

    const values = Array.from(this.nodes.values()).map((node) => ({
      id: node.id,
      label: node.label,
      description: node.description,
      weight: node.weight,
      tolerance: node.tolerance,
    }));

    const relationships: ValueRelationshipInput[] = [];
    for (const entries of this.adjacency.values()) {
      for (const relation of entries) {
        relationships.push({
          from: relation.from,
          to: relation.to,
          kind: relation.kind,
          weight: relation.weight,
        });
      }
    }

    const config: ValueGraphConfig = {
      values,
      defaultThreshold: this.defaultThreshold,
    };
    if (relationships.length > 0) {
      config.relationships = relationships;
    }
    return config;
  }

  /**
   * Restores the graph configuration captured via {@link exportConfiguration}.
   * When no configuration is provided the graph falls back to an empty state
   * to avoid leaking values across tests.
   */
  restoreConfiguration(config: ValueGraphConfig | null): void {
    if (!config || config.values.length === 0) {
      this.clear();
      return;
    }
    this.set(config);
  }

  /** Retrieve the current default threshold guarding plan execution. */
  getDefaultThreshold(): number {
    return this.defaultThreshold;
  }

  /** Evaluate the impacts of a plan without applying the threshold. */
  score(input: ValueScoreInput, options: ValuePlanEvaluationOptions = {}): ValueScoreResult {
    const evaluation = this.evaluatePlan(input);
    const result: ValueScoreResult = {
      score: evaluation.score,
      total: Number(evaluation.totalWeight.toFixed(6)),
      breakdown: evaluation.breakdown,
      violations: evaluation.violations,
    };

    this.emitEvent({
      kind: "plan_scored",
      at: this.now(),
      planId: input.id,
      planLabel: input.label ?? null,
      impacts: cloneImpacts(input.impacts),
      result,
      correlation: cloneCorrelationHints(options.correlation),
    });

    return result;
  }

  /**
   * Evaluate a plan and return whether it satisfies the configured threshold.
   * Violations are preserved in the result so operators can review the
   * contributing impacts when diagnosing a rejection.
   */
  filter(input: ValueFilterInput, options: ValuePlanEvaluationOptions = {}): ValueFilterDecision {
    const evaluation = this.evaluatePlan(input);
    const threshold = clamp(input.threshold ?? this.defaultThreshold, 0, 1);
    const allowed = evaluation.score >= threshold && evaluation.violations.length === 0;
    const decision: ValueFilterDecision = {
      score: evaluation.score,
      total: Number(evaluation.totalWeight.toFixed(6)),
      breakdown: evaluation.breakdown,
      violations: evaluation.violations,
      allowed,
      threshold,
    };

    this.emitEvent({
      kind: "plan_filtered",
      at: this.now(),
      planId: input.id,
      planLabel: input.label ?? null,
      impacts: cloneImpacts(input.impacts),
      decision,
      correlation: cloneCorrelationHints(options.correlation),
    });

    return decision;
  }

  /**
   * Provides a human readable explanation for each violation. The returned
   * payload mirrors the filtering decision and adds actionable hints so
   * operators can quickly identify the dominant risk contributors.
   */
  explain(input: ValueFilterInput, options: ValuePlanEvaluationOptions = {}): ValueExplanationResult {
    const evaluation = this.evaluatePlan(input);
    const threshold = clamp(input.threshold ?? this.defaultThreshold, 0, 1);
    const allowed = evaluation.score >= threshold && evaluation.violations.length === 0;
    const decision: ValueFilterDecision = {
      score: evaluation.score,
      total: Number(evaluation.totalWeight.toFixed(6)),
      breakdown: evaluation.breakdown,
      violations: evaluation.violations,
      allowed,
      threshold,
    };
    const violations = this.buildViolationInsights(decision, evaluation);
    const result: ValueExplanationResult = { decision, violations };

    this.emitEvent({
      kind: "plan_explained",
      at: this.now(),
      planId: input.id,
      planLabel: input.label ?? null,
      impacts: cloneImpacts(input.impacts),
      result,
      correlation: cloneCorrelationHints(options.correlation),
    });

    return result;
  }

  /** Compute the full evaluation for a plan, including intermediate metrics. */
  private evaluatePlan(input: ValueScoreInput): ValueEvaluationResult {
    if (input.impacts.length > VALUE_GRAPH_LIMITS.maxImpactsPerPlan) {
      throw new RangeError(
        `value graph can only evaluate up to ${VALUE_GRAPH_LIMITS.maxImpactsPerPlan} impacts per plan (received ${input.impacts.length})`,
      );
    }

    const perValue: Map<string, ValueContributionBucket> = new Map();
    for (const node of this.nodes.values()) {
      perValue.set(node.id, { node, support: 0, risk: 0, contributions: [] });
    }

    const unknownImpacts: ValueImpactInput[] = [];

    const recordContribution = (targetId: string, contribution: ValueContribution) => {
      const bucket = perValue.get(targetId);
      if (!bucket) {
        unknownImpacts.push(contribution.impact);
        return;
      }
      if (contribution.type === "support") {
        bucket.support += contribution.amount;
      } else {
        bucket.risk += contribution.amount;
      }
      bucket.contributions.push(contribution);
    };

    for (const impact of input.impacts) {
      const severity = normaliseSeverity(impact.severity);
      const node = this.nodes.get(impact.value);
      if (!node) {
        unknownImpacts.push(impact);
        continue;
      }
      const amount = node.weight * severity;
      recordContribution(node.id, { type: impact.impact, amount, impact });
      const neighbours = this.adjacency.get(node.id);
      if (!neighbours?.length) {
        continue;
      }
      for (const relation of neighbours) {
        const propagatedAmount = amount * relation.weight;
        const propagatedType = this.resolvePropagatedType(impact.impact, relation.kind);
        recordContribution(relation.to, {
          type: propagatedType,
          amount: propagatedAmount,
          impact,
          propagatedFrom: node.id,
          relationKind: relation.kind,
        });
      }
    }

    let totalWeight = 0;
    let weightedScoreSum = 0;
    const breakdown: ValueScoreBreakdown[] = [];
    const violations: ValueViolation[] = [];

    for (const bucket of perValue.values()) {
      const { node, support, risk, contributions } = bucket;
      const mitigatedRisk = Math.max(0, risk - support);
      const satisfaction = node.weight === 0 ? 1 : 1 - clamp(mitigatedRisk / node.weight, 0, 1);
      totalWeight += node.weight;
      weightedScoreSum += satisfaction * node.weight;

      breakdown.push({
        value: node.id,
        weight: Number(node.weight.toFixed(6)),
        support: Number(support.toFixed(6)),
        risk: Number(risk.toFixed(6)),
        residual: Number(mitigatedRisk.toFixed(6)),
        satisfaction: Number(satisfaction.toFixed(6)),
      });

      const severityRatio = node.weight === 0 ? 0 : mitigatedRisk / node.weight;
      if (severityRatio > node.tolerance + 1e-6) {
        violations.push({
          value: node.id,
          severity: Number(severityRatio.toFixed(6)),
          tolerance: node.tolerance,
          message: `residual risk ${severityRatio.toFixed(2)} exceeds tolerance ${node.tolerance.toFixed(2)}`,
          contributors: contributions.map((entry) => ({
            impact: entry.impact,
            amount: Number(entry.amount.toFixed(6)),
            type: entry.type,
            propagated: entry.propagatedFrom !== undefined,
            via: entry.relationKind,
            from: entry.propagatedFrom,
          })),
        });
      }
    }

    for (const impact of unknownImpacts) {
      violations.push({
        value: impact.value,
        severity: 1,
        tolerance: 0,
        message: `referenced value '${impact.value}' is not declared in the graph`,
        contributors: [
          {
            impact,
            amount: 1,
            type: "risk",
            propagated: false,
          },
        ],
      });
    }

    const score = totalWeight === 0 ? 1 : clamp(weightedScoreSum / totalWeight, 0, 1);

    return {
      perValue,
      breakdown,
      violations,
      score,
      totalWeight,
    };
  }

  /** Builds enriched violation payloads suitable for MCP responses. */
  private buildViolationInsights(
    decision: ValueFilterDecision,
    evaluation: ValueEvaluationResult,
  ): ValueViolationInsight[] {
    const insights: ValueViolationInsight[] = [];
    for (const violation of decision.violations) {
      const dominant = this.pickDominantContributor(violation.contributors);
      const bucket = evaluation.perValue.get(violation.value);
      const nodeLabel = bucket?.node.label ?? null;
      const nodeId = dominant?.impact.nodeId ?? null;
      const hint = this.composeHint(violation, dominant, nodeLabel);
      insights.push({
        ...violation,
        nodeId,
        nodeLabel,
        hint,
        primaryContributor: dominant ?? null,
      });
    }
    return insights;
  }

  /** Selects the dominant risk contribution driving a violation. */
  private pickDominantContributor(
    contributors: ValueViolationContributorDetails[],
  ): ValueViolationContributorDetails | null {
    let candidate: ValueViolationContributorDetails | null = null;
    for (const entry of contributors) {
      if (entry.type !== "risk") {
        continue;
      }
      if (!candidate || entry.amount > candidate.amount) {
        candidate = entry;
      }
    }
    return candidate;
  }

  /**
   * Generates a human readable hint summarising why the violation triggered and
   * how operators could mitigate it.
   */
  private composeHint(
    violation: ValueViolation,
    dominant: ValueViolationContributorDetails | null,
    nodeLabel: string | null,
  ): string {
    const severityPercent = (violation.severity * 100).toFixed(1);
    const tolerancePercent = (violation.tolerance * 100).toFixed(1);
    const base = `Residual risk ${severityPercent}% exceeds tolerance ${tolerancePercent}% for value '${violation.value}'.`;

    if (violation.message.includes("not declared")) {
      return `${base} Declare the missing value in the graph or remove the unknown impact.`;
    }

    if (!dominant) {
      return `${base} Review the contributing impacts to restore compliance.`;
    }

    const origin = dominant.propagated
      ? `Risk propagated from value '${dominant.from ?? "unknown"}'` + (dominant.via ? ` via ${dominant.via}` : "")
      : "Direct risk impact";
    const location = dominant.impact.nodeId
      ? `on plan node '${dominant.impact.nodeId}'`
      : "within the evaluated plan";
    const rationale = dominant.impact.rationale ?? dominant.impact.source ?? `impact '${dominant.impact.value}'`;
    const labelPart = nodeLabel ? ` (value label: ${nodeLabel})` : "";
    return `${base}${labelPart} ${origin} ${location}: ${rationale}. Mitigate or reduce this contribution to pass the guard.`;
  }

  /** Derive the propagated contribution type from the original impact. */
  private resolvePropagatedType(
    impact: "support" | "risk",
    relation: ValueRelationshipKind,
  ): "support" | "risk" {
    if (relation === "supports") {
      return impact;
    }
    return impact === "support" ? "risk" : "support";
  }
}
