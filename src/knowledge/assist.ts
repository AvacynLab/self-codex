import type { HierGraph } from "../graph/hierarchy.js";
import { coerceNullToUndefined } from "../utils/object.js";
import type {
  KnowledgeGraph,
  KnowledgePlanPattern,
  KnowledgePlanTask,
  KnowledgeTripleSnapshot,
} from "./knowledgeGraph.js";
import type { HybridRetriever, HybridRetrieverHit } from "../memory/retriever.js";
import {
  mergeProvenance,
  normaliseProvenanceList,
  type Provenance,
} from "../types/provenance.js";

/**
 * Context supplied when asking the knowledge graph for plan suggestions. The
 * fields align with the payload accepted by the MCP tool `kg_suggest_plan`.
 */
export interface PlanAssistContext {
  /** List of preferred sources (case insensitive) to prioritise. */
  preferredSources?: string[];
  /** Tasks that should be ignored when building fragments. */
  excludeTasks?: string[];
  /** Maximum number of fragments returned (defaults to 3, clamps to [1,5]). */
  maxFragments?: number;
}

/**
 * Result returned when the assistant composes hierarchical plan fragments from
 * the knowledge graph. The response keeps a concise summary so MCP clients can
 * explain why a fragment was suggested without inspecting the full graph.
 */
export interface PlanAssistSuggestion {
  /** Normalised goal identifier used to query the knowledge graph. */
  goal: string;
  /** Hierarchical plan fragments derived from the stored triples. */
  fragments: HierGraph[];
  /** Human readable explanations describing how the fragments were built. */
  rationale: string[];
  /**
   * Coverage metrics describing which tasks were considered and which
   * dependencies could not be satisfied.
   */
  coverage: {
    total_tasks: number;
    suggested_tasks: string[];
    excluded_tasks: string[];
    missing_dependencies: Array<{ task: string; dependencies: string[] }>;
    unknown_dependencies: Array<{ task: string; dependencies: string[] }>;
    /** Number of RAG passages surfaced as part of the fallback workflow. */
    rag_hits: number;
  };
  /** Aggregated counts per source for the tasks covered by the fragments. */
  sources: Array<{ source: string; tasks: number }>;
  /** Preferred sources that contributed to at least one fragment. */
  preferred_sources_applied: string[];
  /** Preferred sources provided in the context but not matched by any task. */
  preferred_sources_ignored: string[];
  /** Optional RAG passages complementing the graph coverage. */
  rag_evidence?: KnowledgeAssistRagEvidence[];
  /** Normalised query forwarded to the RAG retriever when fallback triggers. */
  rag_query?: string;
  /** Domain tags enforced on the retriever search. */
  rag_domain_tags?: string[];
  /** Minimum cosine similarity requested from the retriever. */
  rag_min_score?: number;
  /** Allow structural compatibility with `Record<string, unknown>`. */
  [key: string]: unknown;
}

interface NormalisedAssistContext {
  preferredSources: Array<{ key: string; label: string }>;
  preferredSourceSet: Set<string>;
  excludeTasks: Set<string>;
  maxFragments: number;
}

interface TaskGroup {
  id: string;
  label: string;
  seeds: KnowledgePlanTask[];
  kind: "preferred" | "remainder" | "default";
  preferredSourceKey?: string;
}

interface FragmentBuildResult {
  graph: HierGraph;
  selectedTaskIds: Set<string>;
  seedIds: Set<string>;
}

/** Maximum number of fragment descriptions included in rationale details. */
const RATIONALE_LIST_LIMIT = 5;

/** Helper rounding numeric values to keep payloads compact. */
function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Normalises a source string for comparisons while preserving a display label. */
function normaliseSourceValue(source: string | null | undefined): { key: string; label: string } {
  if (typeof source === "string" && source.trim().length > 0) {
    const trimmed = source.trim();
    return { key: trimmed.toLowerCase(), label: trimmed };
  }
  return { key: "unknown", label: "unknown" };
}

/** Normalises the user provided context into a deterministic representation. */
function normaliseContext(context: PlanAssistContext | undefined): NormalisedAssistContext {
  const preferredSources: Array<{ key: string; label: string }> = [];
  const preferredSourceSet = new Set<string>();
  for (const raw of context?.preferredSources ?? []) {
    if (typeof raw !== "string") {
      continue;
    }
    const candidate = raw.trim();
    if (!candidate) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (preferredSourceSet.has(key)) {
      continue;
    }
    preferredSourceSet.add(key);
    preferredSources.push({ key, label: candidate });
  }

  const excludeTasks = new Set<string>();
  for (const raw of context?.excludeTasks ?? []) {
    if (typeof raw !== "string") {
      continue;
    }
    const candidate = raw.trim();
    if (!candidate) {
      continue;
    }
    excludeTasks.add(candidate);
  }

  let maxFragments = context?.maxFragments ?? 3;
  if (!Number.isFinite(maxFragments)) {
    maxFragments = 3;
  }
  maxFragments = Math.min(5, Math.max(1, Math.floor(maxFragments)));

  return { preferredSources, preferredSourceSet, excludeTasks, maxFragments };
}

/** Converts a map of missing dependencies into a serialisable array. */
function serialiseDependencyMap(map: Map<string, Set<string>>): Array<{ task: string; dependencies: string[] }> {
  return Array.from(map.entries())
    .map(([task, deps]) => ({ task, dependencies: Array.from(deps).sort() }))
    .sort((left, right) => left.task.localeCompare(right.task));
}

/** Formats an array for rationale strings, trimming overly long lists. */
function formatList(values: string[], limit = RATIONALE_LIST_LIMIT): string {
  if (values.length === 0) {
    return "aucun";
  }
  if (values.length <= limit) {
    return values.join(", ");
  }
  const visible = values.slice(0, limit).join(", ");
  return `${visible} (+${values.length - limit} autres)`;
}

/**
 * Build deterministic groups of tasks (per preferred source + remainder) so
 * fragments stay concise and targeted.
 */
function groupTasks(
  pattern: KnowledgePlanPattern,
  includedTasks: KnowledgePlanTask[],
  context: NormalisedAssistContext,
): TaskGroup[] {
  if (!context.preferredSources.length) {
    return [
      {
        id: `${pattern.plan}-all`,
        label: "plan complet",
        seeds: includedTasks,
        kind: "default",
      },
    ];
  }

  const groups: TaskGroup[] = [];
  for (const preferred of context.preferredSources) {
    const seeds = includedTasks.filter((task) => normaliseSourceValue(task.source).key === preferred.key);
    if (seeds.length === 0) {
      continue;
    }
    groups.push({
      id: `${pattern.plan}-preferred-${preferred.key}`,
      label: `source ${preferred.label}`,
      seeds,
      kind: "preferred",
      preferredSourceKey: preferred.key,
    });
  }

  const remainder = includedTasks.filter(
    (task) => !context.preferredSourceSet.has(normaliseSourceValue(task.source).key),
  );
  if (remainder.length > 0) {
    groups.push({
      id: `${pattern.plan}-remainder`,
      label: "sources complémentaires",
      seeds: remainder,
      kind: "remainder",
    });
  }
  return groups;
}

/**
 * Builds a hierarchical fragment starting from the provided seed tasks. The
 * closure ensures dependencies present in the knowledge graph are included in
 * the fragment, preserving ordering for downstream BT compilation.
 */
function buildFragment(
  goal: string,
  fragmentId: string,
  groupLabel: string,
  seeds: KnowledgePlanTask[],
  includedTaskMap: Map<string, KnowledgePlanTask>,
): FragmentBuildResult {
  const selected = new Map<string, KnowledgePlanTask>();
  const queue: KnowledgePlanTask[] = [];
  const seedIds = new Set<string>();

  for (const seed of seeds) {
    if (selected.has(seed.id)) {
      seedIds.add(seed.id);
      continue;
    }
    selected.set(seed.id, seed);
    seedIds.add(seed.id);
    queue.push(seed);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependencyId of current.dependsOn) {
      const dependency = includedTaskMap.get(dependencyId);
      if (!dependency || selected.has(dependency.id)) {
        continue;
      }
      selected.set(dependency.id, dependency);
      queue.push(dependency);
    }
  }

  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();

  const computeDepth = (taskId: string): number => {
    if (depthCache.has(taskId)) {
      return depthCache.get(taskId)!;
    }
    if (visiting.has(taskId)) {
      return 1; // break cycles defensively
    }
    visiting.add(taskId);
    const record = selected.get(taskId);
    if (!record) {
      visiting.delete(taskId);
      depthCache.set(taskId, 1);
      return 1;
    }
    let maxDepth = 0;
    for (const dependencyId of record.dependsOn) {
      if (!selected.has(dependencyId)) {
        continue;
      }
      const depth = computeDepth(dependencyId);
      if (depth > maxDepth) {
        maxDepth = depth;
      }
    }
    visiting.delete(taskId);
    const finalDepth = maxDepth + 1;
    depthCache.set(taskId, finalDepth);
    return finalDepth;
  };

  const orderedTasks = Array.from(selected.values()).sort((left, right) => {
    const depthDelta = computeDepth(left.id) - computeDepth(right.id);
    if (depthDelta !== 0) {
      return depthDelta;
    }
    return left.id.localeCompare(right.id);
  });

  const nodes: HierGraph["nodes"] = orderedTasks.map((task) => {
    const { label: sourceLabel } = normaliseSourceValue(task.source);
    const attributes: Record<string, string | number | boolean> = {
      bt_tool: "noop",
      bt_input_key: `kg:${task.id}`,
      kg_goal: goal,
      kg_source: sourceLabel,
      kg_confidence: round(task.confidence),
      kg_seed: seedIds.has(task.id),
      kg_group: groupLabel,
    };
    if (typeof task.duration === "number" && Number.isFinite(task.duration)) {
      attributes.kg_duration = round(task.duration);
    }
    if (typeof task.weight === "number" && Number.isFinite(task.weight)) {
      attributes.kg_weight = round(task.weight);
    }
    return {
      id: task.id,
      kind: "task" as const,
      label: coerceNullToUndefined(task.label),
      attributes,
    };
  });

  let edgeIndex = 0;
  const edges: HierGraph["edges"] = [];
  const seenPairs = new Set<string>();
  for (const task of orderedTasks) {
    for (const dependencyId of task.dependsOn) {
      if (!selected.has(dependencyId)) {
        continue;
      }
      const key = `${dependencyId}->${task.id}`;
      if (seenPairs.has(key)) {
        continue;
      }
      seenPairs.add(key);
      edges.push({
        id: `${fragmentId}-edge-${++edgeIndex}`,
        from: { nodeId: dependencyId },
        to: { nodeId: task.id },
        label: "depends_on",
        attributes: { kg_dependency: true },
      });
    }
  }

  return {
    graph: {
      id: fragmentId,
      nodes,
      edges,
    },
    selectedTaskIds: new Set(selected.keys()),
    seedIds,
  };
}

/**
 * Analyse the knowledge graph and return plan fragments suitable for
 * orchestrator ingestion. The function never throws: the rationale explains
 * why no fragment could be produced instead of surfacing a transport error.
 */
export function suggestPlanFragments(
  knowledgeGraph: KnowledgeGraph,
  options: { goal: string; context?: PlanAssistContext },
): PlanAssistSuggestion {
  const goal = options.goal.trim();
  const context = normaliseContext(options.context);

  if (!goal) {
    throw new Error("Plan goal must not be empty");
  }

  const pattern = knowledgeGraph.buildPlanPattern(goal);
  if (!pattern) {
    return {
      goal,
      fragments: [],
      rationale: [
        `Aucun plan connu pour '${goal}'. Utilise 'kg_insert' pour enregistrer des fragments avant de demander une suggestion.`,
      ],
      coverage: {
        total_tasks: 0,
        suggested_tasks: [],
        excluded_tasks: [],
        missing_dependencies: [],
        unknown_dependencies: [],
        rag_hits: 0,
      },
      sources: [],
      preferred_sources_applied: [],
      preferred_sources_ignored: context.preferredSources.map((source) => source.label),
    };
  }

  const patternTaskMap = new Map(pattern.tasks.map((task) => [task.id, task]));
  const includedTasks = pattern.tasks.filter((task) => !context.excludeTasks.has(task.id));
  const includedTaskMap = new Map(includedTasks.map((task) => [task.id, task]));
  const excludedTasks = pattern.tasks
    .filter((task) => context.excludeTasks.has(task.id))
    .map((task) => task.id)
    .sort();

  const missingDependencies = new Map<string, Set<string>>();
  const unknownDependencies = new Map<string, Set<string>>();
  for (const task of includedTasks) {
    for (const dependencyId of task.dependsOn) {
      if (includedTaskMap.has(dependencyId)) {
        continue;
      }
      if (patternTaskMap.has(dependencyId)) {
        const list = missingDependencies.get(task.id) ?? new Set<string>();
        list.add(dependencyId);
        missingDependencies.set(task.id, list);
      } else {
        const list = unknownDependencies.get(task.id) ?? new Set<string>();
        list.add(dependencyId);
        unknownDependencies.set(task.id, list);
      }
    }
  }

  if (!includedTasks.length) {
    return {
      goal,
      fragments: [],
      rationale: [
        `Le graphe de connaissances contient ${pattern.tasks.length} tâche(s) pour '${goal}', mais elles ont été exclues par le contexte.`,
      ],
      coverage: {
        total_tasks: pattern.tasks.length,
        suggested_tasks: [],
        excluded_tasks: excludedTasks,
        missing_dependencies: serialiseDependencyMap(missingDependencies),
        unknown_dependencies: serialiseDependencyMap(unknownDependencies),
        rag_hits: 0,
      },
      sources: [],
      preferred_sources_applied: [],
      preferred_sources_ignored: context.preferredSources.map((source) => source.label),
    };
  }

  const groups = groupTasks(pattern, includedTasks, context);
  const fragments: HierGraph[] = [];
  const rationale: string[] = [];
  const suggestedTaskIds = new Set<string>();
  const globalSourceCounter = new Map<string, { label: string; count: number }>();
  const appliedPreferred = new Set<string>();

  const registerTask = (task: KnowledgePlanTask) => {
    if (suggestedTaskIds.has(task.id)) {
      return;
    }
    suggestedTaskIds.add(task.id);
    const { key, label } = normaliseSourceValue(task.source);
    const counter = globalSourceCounter.get(key) ?? { label, count: 0 };
    counter.count += 1;
    globalSourceCounter.set(key, counter);
  };

  let processedGroups = 0;
  for (const group of groups) {
    if (fragments.length >= context.maxFragments) {
      break;
    }
    const fragmentId = `${goal}-fragment-${fragments.length + 1}`;
    const fragment = buildFragment(goal, fragmentId, group.label, group.seeds, includedTaskMap);
    fragments.push(fragment.graph);
    processedGroups += 1;

    for (const taskId of fragment.selectedTaskIds) {
      const task = includedTaskMap.get(taskId);
      if (task) {
        registerTask(task);
      }
    }

    if (group.preferredSourceKey) {
      appliedPreferred.add(group.preferredSourceKey);
    }

    const seedCount = fragment.seedIds.size;
    const dependencyOnlyCount = fragment.selectedTaskIds.size - seedCount;
    let fragmentRationale = `Fragment ${fragments.length} – ${group.label} : ${seedCount} tâche(s)`;
    if (dependencyOnlyCount > 0) {
      fragmentRationale += ` et ${dependencyOnlyCount} dépendance(s) de soutien`;
    }
    fragmentRationale += ".";
    rationale.push(fragmentRationale);
  }

  const omittedGroups = groups.length - processedGroups;
  if (omittedGroups > 0) {
    rationale.push(
      `${omittedGroups} groupe(s) supplémentaire(s) ignoré(s) en raison de la limite max_fragments=${context.maxFragments}.`,
    );
  }

  const coverageSuggested = Array.from(suggestedTaskIds).sort();
  const sources = Array.from(globalSourceCounter.values())
    .map((entry) => ({ source: entry.label, tasks: entry.count }))
    .sort((left, right) => {
      if (right.tasks !== left.tasks) {
        return right.tasks - left.tasks;
      }
      return left.source.localeCompare(right.source);
    });

  const preferredSourcesApplied = context.preferredSources
    .filter((source) => appliedPreferred.has(source.key))
    .map((source) => source.label);
  const preferredSourcesIgnored = context.preferredSources
    .filter((source) => !appliedPreferred.has(source.key))
    .map((source) => source.label);

  const missingSerialised = serialiseDependencyMap(missingDependencies);
  const unknownSerialised = serialiseDependencyMap(unknownDependencies);

  const summary = `Plan '${goal}' : ${coverageSuggested.length}/${pattern.tasks.length} tâche(s) suggérées.`;
  rationale.unshift(summary);

  if (excludedTasks.length) {
    rationale.push(`Exclus par le contexte : ${formatList(excludedTasks)}.`);
  }
  if (missingSerialised.length) {
    const formatted = formatList(
      missingSerialised.map((entry) => `${entry.task} -> ${entry.dependencies.join(", ")}`),
    );
    rationale.push(`Dépendances ignorées (présentes mais exclues) : ${formatted}.`);
  }
  if (unknownSerialised.length) {
    const formatted = formatList(
      unknownSerialised.map((entry) => `${entry.task} -> ${entry.dependencies.join(", ")}`),
    );
    rationale.push(`Dépendances inconnues dans le graphe : ${formatted}.`);
  }
  if (!sources.length) {
    rationale.push("Aucune source associée aux tâches suggérées : toutes les tâches ont une provenance inconnue.");
  }

  return {
    goal,
    fragments,
    rationale,
    coverage: {
      total_tasks: pattern.tasks.length,
      suggested_tasks: coverageSuggested,
      excluded_tasks: excludedTasks,
      missing_dependencies: missingSerialised,
      unknown_dependencies: unknownSerialised,
      rag_hits: 0,
    },
    sources,
    preferred_sources_applied: preferredSourcesApplied,
    preferred_sources_ignored: preferredSourcesIgnored,
  };
}

/**
 * Input payload accepted by {@link assistKnowledgeQuery}. The structure mirrors the
 * expectations of the `kg_assist` tool handler and captures both knowledge graph
 * and RAG fallback knobs.
 */
export interface KnowledgeAssistOptions {
  /** End-user query the assistant must answer. */
  query: string;
  /** Optional context or background provided by the client. */
  context?: string;
  /** Maximum number of knowledge graph facts to surface. */
  limit?: number;
  /** Minimum cosine score accepted when requesting RAG complements. */
  ragMinScore?: number;
  /** Optional retriever used when the knowledge graph lacks coverage. */
  ragRetriever?: HybridRetriever;
  /** Maximum number of RAG passages returned by the retriever. */
  ragLimit?: number;
  /** Semantic tags constraining the RAG search domain. */
  domainTags?: string[];
}

/** Summary of a knowledge graph fact contributing to the final answer. */
export interface KnowledgeAssistEvidence extends Record<string, unknown> {
  triple: {
    id: string;
    subject: string;
    predicate: string;
    object: string;
    source: string | null;
    confidence: number;
  };
  summary: string;
  score: number;
  lexical_score: number;
  matched_terms: string[];
  provenance: Provenance[];
}

/** Summary of a RAG passage leveraged to complement the knowledge graph. */
export interface KnowledgeAssistRagEvidence extends Record<string, unknown> {
  id: string;
  text: string;
  score: number;
  vector_score: number;
  lexical_score: number;
  tags: string[];
  matched_tags: string[];
  matched_terms: string[];
  provenance: Provenance[];
}

/** Final structured response produced when assisting a knowledge query. */
export interface KnowledgeAssistResult extends Record<string, unknown> {
  query: string;
  context?: string;
  answer: string;
  citations: Provenance[];
  rationale: string[];
  coverage: {
    knowledge_hits: number;
    rag_hits: number;
    query_terms: number;
    matched_terms: number;
  };
  knowledge_evidence: KnowledgeAssistEvidence[];
  rag_evidence: KnowledgeAssistRagEvidence[];
}

/** Default number of knowledge graph facts to surface per answer. */
const DEFAULT_ASSIST_LIMIT = 3;
/** Maximum number of fragments/answers accepted by the assistant. */
const MAX_ASSIST_LIMIT = 6;
/** Minimum lexical overlap required to keep a knowledge fact. */
const MIN_KNOWLEDGE_LEXICAL_SCORE = 0.1;
/** Maximum number of characters preserved when quoting RAG passages. */
const RAG_SNIPPET_MAX_LENGTH = 220;

/**
 * Builds an answer grounded in the knowledge graph while optionally falling back
 * to RAG passages when local coverage is insufficient. The helper keeps the
 * output deterministic so MCP clients can surface consistent explanations.
 */
export async function assistKnowledgeQuery(
  knowledgeGraph: KnowledgeGraph,
  options: KnowledgeAssistOptions,
): Promise<KnowledgeAssistResult> {
  const query = options.query.trim();
  const context = options.context?.trim() ?? "";
  const limit = clampAssistLimit(options.limit);
  const ragLimit = clampAssistLimit(options.ragLimit ?? Math.max(limit, DEFAULT_ASSIST_LIMIT));
  const ragMinScore = clampScore(options.ragMinScore ?? 0.1);
  const domainTags = normaliseTags(options.domainTags);

  const queryTokens = lexicalTokenise(query);
  const scoringTokens = lexicalTokenise(`${query} ${context}`.trim());
  const knowledgeEvidence = collectKnowledgeEvidence(
    knowledgeGraph.exportAll(),
    scoringTokens,
    queryTokens,
    limit,
  );

  const knowledgeMatchedTerms = new Set<string>();
  for (const evidence of knowledgeEvidence) {
    for (const token of evidence.matched_terms) {
      knowledgeMatchedTerms.add(token);
    }
  }

  let ragEvidence: KnowledgeAssistRagEvidence[] = [];
  if (options.ragRetriever && knowledgeEvidence.length < limit) {
    ragEvidence = await collectRagEvidence(
      options.ragRetriever,
      query,
      context,
      queryTokens,
      ragLimit,
      ragMinScore,
      domainTags,
    );
  }

  const matchedTerms = new Set<string>(knowledgeMatchedTerms);
  for (const evidence of ragEvidence) {
    for (const token of evidence.matched_terms) {
      matchedTerms.add(token);
    }
  }

  const citations = aggregateCitations(knowledgeEvidence, ragEvidence);
  const answer = buildAssistAnswer(knowledgeEvidence, ragEvidence);
  const rationale = buildAssistRationale(
    knowledgeEvidence,
    ragEvidence,
    queryTokens.length,
    matchedTerms.size,
    domainTags,
    Boolean(options.ragRetriever),
  );

  return {
    query,
    context: context || undefined,
    answer,
    citations,
    rationale,
    coverage: {
      knowledge_hits: knowledgeEvidence.length,
      rag_hits: ragEvidence.length,
      query_terms: queryTokens.length,
      matched_terms: matchedTerms.size,
    },
    knowledge_evidence: knowledgeEvidence,
    rag_evidence: ragEvidence,
  };
}

/** Keeps the assist limit within defensive bounds. */
function clampAssistLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_ASSIST_LIMIT;
  }
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ASSIST_LIMIT;
  }
  return Math.min(MAX_ASSIST_LIMIT, Math.max(1, parsed));
}

/** Keeps min-score thresholds within the inclusive [0, 1] range. */
function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.1;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value);
}

/** Tokenises a string into lowercase words for lexical comparisons. */
function lexicalTokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

/** Computes lexical coverage between query tokens and the provided text. */
function computeLexicalScore(queryTokens: string[], text: string): { score: number; matches: string[] } {
  if (queryTokens.length === 0) {
    return { score: 0, matches: [] };
  }
  const documentTokens = new Set(lexicalTokenise(text));
  if (documentTokens.size === 0) {
    return { score: 0, matches: [] };
  }
  const matches: string[] = [];
  for (const token of queryTokens) {
    if (documentTokens.has(token) && !matches.includes(token)) {
      matches.push(token);
    }
  }
  return { score: matches.length / queryTokens.length, matches };
}

/** Extracts the knowledge graph facts most relevant to the query. */
function collectKnowledgeEvidence(
  triples: KnowledgeTripleSnapshot[],
  scoringTokens: string[],
  queryTokens: string[],
  limit: number,
): KnowledgeAssistEvidence[] {
  if (triples.length === 0) {
    return [];
  }

  const candidates: Array<{
    triple: KnowledgeTripleSnapshot;
    summary: string;
    lexical: number;
    matched: string[];
    score: number;
  }> = [];

  for (const triple of triples) {
    const summary = `${triple.subject} ${triple.predicate} ${triple.object}`;
    const { score: lexicalScore, matches } = computeLexicalScore(scoringTokens, summary);
    if (lexicalScore < MIN_KNOWLEDGE_LEXICAL_SCORE || matches.length === 0) {
      continue;
    }
    const confidence = Number.isFinite(triple.confidence) ? Math.max(0, Math.min(1, triple.confidence)) : 0;
    const combinedScore = lexicalScore * 0.7 + confidence * 0.3;
    candidates.push({
      triple,
      summary,
      lexical: lexicalScore,
      matched: matches.filter((token) => queryTokens.includes(token)),
      score: combinedScore,
    });
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.triple.updatedAt - left.triple.updatedAt ||
      right.triple.confidence - left.triple.confidence,
  );

  return candidates.slice(0, limit).map((candidate) => ({
    triple: {
      id: candidate.triple.id,
      subject: candidate.triple.subject,
      predicate: candidate.triple.predicate,
      object: candidate.triple.object,
      source: candidate.triple.source,
      confidence: candidate.triple.confidence,
    },
    summary: candidate.summary,
    score: round(candidate.score, 4),
    lexical_score: round(candidate.lexical, 4),
    matched_terms: candidate.matched,
    provenance: collectKnowledgeProvenance(candidate.triple),
  }));
}

/** Derives provenance for a knowledge triple, falling back to the triple id. */
function collectKnowledgeProvenance(triple: KnowledgeTripleSnapshot): Provenance[] {
  const fromTriple = normaliseProvenanceList(triple.provenance);
  if (fromTriple.length > 0) {
    return fromTriple;
  }
  const confidence = Number.isFinite(triple.confidence) ? Math.max(0, Math.min(1, triple.confidence)) : undefined;
  const fallback: Provenance = { sourceId: `kg:${triple.id}`, type: "kg" };
  if (confidence !== undefined) {
    fallback.confidence = confidence;
  }
  return [fallback];
}

/** Executes the RAG retriever and maps hits to evidence summaries. */
async function collectRagEvidence(
  retriever: HybridRetriever,
  query: string,
  context: string,
  queryTokens: string[],
  limit: number,
  minScore: number,
  domainTags: string[],
): Promise<KnowledgeAssistRagEvidence[]> {
  const ragQuery = context ? `${context}\n${query}` : query;
  const hits: HybridRetrieverHit[] = await retriever.search(ragQuery, {
    limit,
    minScore,
    requiredTags: domainTags.length > 0 ? domainTags : undefined,
  });
  if (hits.length === 0) {
    return [];
  }

  const evidence: KnowledgeAssistRagEvidence[] = [];
  for (const hit of hits) {
    const { score: lexicalScore, matches } = computeLexicalScore(queryTokens, hit.text);
    const snippet = truncateSnippet(hit.text);
    evidence.push({
      id: hit.id,
      text: snippet,
      score: round(hit.score, 4),
      vector_score: round(hit.vectorScore, 4),
      lexical_score: round(lexicalScore, 4),
      tags: [...hit.tags],
      matched_tags: [...hit.matchedTags],
      matched_terms: matches,
      provenance: normaliseProvenanceList(hit.provenance),
    });
  }
  return evidence;
}

/** Truncates RAG passages while preserving sentence readability. */
function truncateSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= RAG_SNIPPET_MAX_LENGTH) {
    return trimmed;
  }
  const slice = trimmed.slice(0, RAG_SNIPPET_MAX_LENGTH - 1);
  return `${slice.trimEnd()}…`;
}

/** Combines provenance coming from the knowledge graph and RAG hits. */
function aggregateCitations(
  knowledge: KnowledgeAssistEvidence[],
  rag: KnowledgeAssistRagEvidence[],
): Provenance[] {
  let citations: Provenance[] = [];
  for (const entry of knowledge) {
    citations = mergeProvenance(citations, entry.provenance);
  }
  for (const entry of rag) {
    citations = mergeProvenance(citations, entry.provenance);
  }
  return citations;
}

/** Builds a readable answer combining knowledge facts and RAG snippets. */
function buildAssistAnswer(
  knowledge: KnowledgeAssistEvidence[],
  rag: KnowledgeAssistRagEvidence[],
): string {
  const sections: string[] = [];
  if (knowledge.length > 0) {
    const bullets = knowledge
      .map((entry) => `• ${entry.summary}${entry.triple.source ? ` (source : ${entry.triple.source})` : ""}`)
      .join("\n");
    sections.push(`Synthèse du graphe de connaissances :\n${bullets}`);
  }
  if (rag.length > 0) {
    const bullets = rag
      .map((entry) => {
        const tags = entry.matched_tags.length ? ` [tags : ${entry.matched_tags.join(", ")}]` : "";
        return `• ${entry.text}${tags}`;
      })
      .join("\n");
    sections.push(`Compléments de la mémoire vectorielle :\n${bullets}`);
  }
  if (sections.length === 0) {
    return "Aucune connaissance enregistrée ne répond à la question. Pense à enrichir le graphe (kg_insert) ou la mémoire vectorielle (rag_ingest).";
  }
  return sections.join("\n\n");
}

/** Builds rationale strings summarising coverage and fallbacks. */
function buildAssistRationale(
  knowledge: KnowledgeAssistEvidence[],
  rag: KnowledgeAssistRagEvidence[],
  totalQueryTokens: number,
  matchedTokens: number,
  domainTags: string[],
  ragEnabled: boolean,
): string[] {
  const rationale: string[] = [];
  if (knowledge.length > 0) {
    const avgConfidence =
      knowledge.reduce((acc, entry) => acc + entry.triple.confidence, 0) / knowledge.length;
    rationale.push(
      `Connaissances mobilisées : ${knowledge.length} fait(s) (confiance moyenne ${round(avgConfidence, 3)}).`,
    );
  } else {
    rationale.push("Aucun fait direct dans le graphe n'a été identifié pour cette requête.");
  }

  if (rag.length > 0) {
    const domainNote = domainTags.length ? ` (domaine ${domainTags.join(", ")})` : "";
    rationale.push(`Compléments RAG : ${rag.length} extrait(s)${domainNote}.`);
  } else if (ragEnabled && knowledge.length < totalQueryTokens) {
    rationale.push("RAG activé mais aucune correspondance pertinente n'a été trouvée avec les filtres fournis.");
  }

  if (totalQueryTokens > 0) {
    rationale.push(`Couverture de la requête : ${matchedTokens}/${totalQueryTokens} terme(s) retrouvés.`);
  }
  return rationale;
}

/** Normalises optional tag arrays into a deduplicated lowercase list. */
function normaliseTags(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) {
    return [];
  }
  const unique = new Set<string>();
  for (const entry of raw) {
    if (!entry) continue;
    const normalised = entry.trim().toLowerCase();
    if (normalised) {
      unique.add(normalised);
    }
  }
  return Array.from(unique).slice(0, 32);
}
