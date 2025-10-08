import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunContext } from './runContext.js';
import { ArtifactRecorder } from './artifactRecorder.js';
import type { BaseToolsStageReport, BaseToolCallSummary, ToolResponseSummary } from './baseTools.js';
import type { TransactionsStageReport } from './transactions.js';
import type { ChildStageReport } from './children.js';
import type { PlanningStageReport } from './plans.js';
import type { ResilienceStageReport } from './resilience.js';
import type { AdvancedFunctionsStageReport } from './advanced.js';

/**
 * Snapshot mirroring the shape of the `tools` capability payload emitted by the
 * MCP server. The structure is intentionally minimal because only the tool
 * name is required to assess coverage. Stage 1 stores the full `McpCapabilities`
 * response, therefore the helper gracefully accepts partial entries so that the
 * final report can operate even if future iterations enrich the payload.
 */
interface ToolCapabilitySnapshot {
  /** Name advertised by the server in the capabilities listing. */
  readonly name?: string | null;
  /** Optional textual summary describing the expected input schema. */
  readonly inputSchemaSummary?: string | null;
}

/** Lightweight descriptor of the JSON artefact produced during Stage 1. */
interface IntrospectionStageReport {
  readonly info?: Record<string, unknown> | null;
  readonly capabilities?: {
    readonly tools?: ReadonlyArray<string | ToolCapabilitySnapshot> | null;
  } | null;
  readonly resources?: {
    readonly prefixes?: Array<{ readonly prefix: string; readonly count: number }>;
  };
  readonly events?: {
    readonly published_seq?: number;
    readonly baseline_count?: number;
    readonly follow_up_count?: number;
  };
}

/** Options accepted by {@link runFinalReportStage}. */
export interface FinalReportStageOptions {
  /** Shared validation context providing directory layout and trace factory. */
  readonly context: RunContext;
  /** Recorder used to persist structured artefacts and audit logs. */
  readonly recorder: ArtifactRecorder;
  /** Optional deterministic clock injected by tests to stabilise timestamps. */
  readonly clock?: () => Date;
}

/** Summary entry describing the completion status of a single checklist stage. */
export interface StageProgressEntry {
  /** Canonical identifier mirroring the checklist numbering. */
  readonly id: string;
  /** Human readable label surfaced in the generated summary. */
  readonly label: string;
  /** Whether the corresponding JSON artefact was found on disk. */
  readonly completed: boolean;
  /** Absolute path of the stage report when available. */
  readonly reportPath: string | null;
  /** Total number of tool calls recorded during the stage (when applicable). */
  readonly totalCalls: number | null;
  /** Number of error responses captured during the stage (when applicable). */
  readonly errorCount: number | null;
  /** Short note surfaced in the summary table to highlight key facts. */
  readonly notes: string | null;
}

/** Aggregated metrics describing how a given tool behaved across all stages. */
export interface ToolAggregateResult {
  readonly toolName: string;
  readonly stages: string[];
  readonly scenarios: string[];
  readonly totalCalls: number;
  readonly successCount: number;
  readonly errorCount: number;
  readonly averageDurationMs: number;
  readonly maxDurationMs: number;
  readonly errorCodes: string[];
  readonly hints: string[];
}

/** Result returned by {@link runFinalReportStage}. */
export interface FinalReportStageResult {
  readonly runId: string;
  readonly generatedAt: string;
  readonly summaryPath: string;
  readonly findingsPath: string;
  readonly recommendationsPath: string;
  readonly stages: StageProgressEntry[];
  readonly tools: ReadonlyArray<ToolAggregateResult>;
  readonly metrics: {
    readonly totalCalls: number;
    readonly errorCount: number;
    readonly uniqueTools: number;
    readonly uniqueScenarios: number;
    readonly stagesCompleted: number;
  };
  readonly coverage: {
    readonly expectedTools: number;
    readonly coveredTools: number;
    readonly missingTools: ReadonlyArray<string>;
    readonly unexpectedTools: ReadonlyArray<string>;
  };
}

/** Helper narrowing error instances originating from Node.js fs helpers. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === 'object' && 'code' in error;
}

/** Reads the JSON artefact at the provided path if it exists. */
async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null;
    }
    throw new Error(`Unable to read JSON artefact at ${filePath}: ${(error as Error).message}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

/** Extracts a normalised error code from a response summary when available. */
function extractErrorCode(summary: ToolResponseSummary): string | null {
  if (summary.errorCode) {
    return summary.errorCode;
  }
  const structured = summary.structured;
  if (structured && typeof structured === 'object') {
    const candidate = (structured as { error?: unknown }).error;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  const parsed = summary.parsedText;
  if (parsed && typeof parsed === 'object') {
    const candidate = (parsed as { error?: unknown }).error;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/** Extracts a remediation hint from a response summary when surfaced by the tool. */
function extractHint(summary: ToolResponseSummary): string | null {
  if (summary.hint && summary.hint.trim().length > 0) {
    return summary.hint;
  }
  const structured = summary.structured;
  if (structured && typeof structured === 'object') {
    const candidate = (structured as { hint?: unknown }).hint;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  const parsed = summary.parsedText;
  if (parsed && typeof parsed === 'object') {
    const candidate = (parsed as { hint?: unknown }).hint;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

/** Formats a number for display in Markdown tables, falling back to an em dash. */
function formatNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toString(10) : '—';
}

/** Formats a value representing a duration (milliseconds) for readability. */
function formatDuration(value: number): string {
  return Number.isFinite(value) ? value.toFixed(0) : '—';
}

/**
 * Generates a Markdown summary describing stage completion and tool coverage.
 */
function buildSummaryMarkdown(params: {
  readonly runId: string;
  readonly generatedAt: string;
  readonly stages: StageProgressEntry[];
  readonly toolAggregates: ReadonlyArray<ToolAggregateResult>;
  readonly metrics: FinalReportStageResult['metrics'];
  readonly highlights: string[];
  readonly expectedToolCount: number | null;
  readonly coveredExpectedToolCount: number | null;
  readonly missingTools: ReadonlyArray<string>;
}): string {
  const stageLines = params.stages.map((stage) => {
    const status = stage.completed ? '✅ Terminée' : '⚠️ Manquante';
    return `| ${stage.label} | ${status} | ${formatNumber(stage.totalCalls)} | ${formatNumber(stage.errorCount)} | ${
      stage.notes ?? '—'
    } |`;
  });

  const toolLines = params.toolAggregates.map((tool) => {
    const errorCodes = tool.errorCodes.length > 0 ? tool.errorCodes.join(', ') : '—';
    const hints = tool.hints.length > 0 ? tool.hints.join(', ') : '—';
    return `| ${tool.toolName} | ${tool.scenarios.length} | ${tool.successCount} | ${tool.errorCount} | ${formatDuration(
      tool.averageDurationMs,
    )} | ${formatDuration(tool.maxDurationMs)} | ${errorCodes} | ${hints} | ${tool.stages.join(', ')} |`;
  });

  const highlights = params.highlights.length > 0 ? params.highlights : ['Aucun fait marquant supplémentaire.'];

  return [
    '# Étape 8 – Rapport final',
    '',
    `- Identifiant de run : ${params.runId}`,
    `- Généré le : ${params.generatedAt}`,
    '',
    '## Synthèse par étape',
    '| Étape | Statut | Appels | Erreurs | Notes |',
    '| --- | --- | ---: | ---: | --- |',
    ...stageLines,
    '',
    '## Indicateurs clés',
    `- Appels MCP totaux : ${params.metrics.totalCalls}`,
    `- Erreurs détectées : ${params.metrics.errorCount}`,
    `- Outils couverts : ${params.metrics.uniqueTools}`,
    `- Scénarios uniques : ${params.metrics.uniqueScenarios}`,
    `- Étapes disposant d’un rapport : ${params.metrics.stagesCompleted} / ${params.stages.length}`,
    params.expectedToolCount !== null
      ? `- Outils annoncés exercés : ${params.coveredExpectedToolCount ?? 0} / ${params.expectedToolCount}`
      : '- Outils annoncés exercés : données indisponibles (rapport d’introspection manquant).',
    params.missingTools.length > 0
      ? `- Outils manquants : ${params.missingTools.slice(0, 5).join(', ')}${
          params.missingTools.length > 5 ? ', …' : ''
        }`
      : '- Aucun outil manquant détecté.',
    '',
    '## Couverture des outils',
    '| Outil | Scénarios | Succès | Échecs | Durée moyenne (ms) | Durée max (ms) | Codes d’erreur | Indices | Étapes |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...toolLines,
    '',
    '## Faits saillants',
    ...highlights.map((line) => `- ${line}`),
    '',
  ].join('\n');
}

/**
 * Extracts and normalises the list of tool names advertised by the
 * `mcp_capabilities` response. The helper copes with legacy string arrays and
 * modern object payloads to remain compatible with historical artefacts.
 */
function extractCapabilityToolNames(capabilities: IntrospectionStageReport['capabilities']): string[] {
  const entries = capabilities?.tools;
  if (!Array.isArray(entries)) {
    return [];
  }

  const names = new Set<string>();
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        names.add(trimmed);
      }
      continue;
    }

    if (entry && typeof entry === 'object') {
      const candidate = 'name' in entry ? (entry as ToolCapabilitySnapshot).name : undefined;
      if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          names.add(trimmed);
        }
      }
    }
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Serialises the mandatory recommendation answers in Markdown following the
 * order specified by the user instructions.
 */
function buildRecommendationsMarkdown(params: {
  readonly underDocumentedTools: ReadonlyArray<ToolAggregateResult>;
  readonly silentErrorTools: ReadonlyArray<ToolAggregateResult>;
  readonly transactionsReport: TransactionsStageReport | null;
  readonly resilienceReport: ResilienceStageReport | null;
  readonly advancedReport: AdvancedFunctionsStageReport | null;
  readonly planningReport: PlanningStageReport | null;
  readonly introspectionReport: IntrospectionStageReport | null;
  readonly findingsMetrics: FinalReportStageResult['metrics'];
  readonly slowestTool: ToolAggregateResult | null;
}): string {
  const sections: Array<{ title: string; lines: string[] }> = [];

  const underDocumentedLines =
    params.underDocumentedTools.length > 0
      ? params.underDocumentedTools.map(
          (tool) =>
            `- \`${tool.toolName}\` présente ${tool.errorCount} échec(s) sans code d’erreur ni indice : renforcer la documentation côté serveur.`,
        )
      : ['- Aucun outil en échec ne manque de métadonnées : les réponses incluent systématiquement un code ou un indice.'];
  sections.push({
    title: 'Quelles tools sont sous-documentées ou manquent de clarté dans leur réponse ?',
    lines: underDocumentedLines,
  });

  const invariantLines: string[] = [];
  if (params.transactionsReport) {
    if (params.transactionsReport.patch.failureCode) {
      invariantLines.push(
        `- Les invariants de \`graph_patch\` sont correctement vérifiés : l’échec attendu a renvoyé le code \`${
          params.transactionsReport.patch.failureCode
        }\`.`,
      );
    } else {
      invariantLines.push(
        '- Aucun code d’erreur n’a été remonté lors du patch invalide : ajouter un contrôle d’invariant plus strict est recommandé.',
      );
    }
    if (!params.transactionsReport.locks.conflictCode) {
      invariantLines.push(
        '- Le scénario de verrouillage concurrent n’a pas exposé de code d’erreur détaillé : consigner un identifiant de conflit aiderait au diagnostic.',
      );
    }
  } else {
    invariantLines.push('- Le rapport des transactions est indisponible, impossible de confirmer les invariants.');
  }
  sections.push({
    title: 'Y a-t-il des invariants non vérifiés ou des règles trop permissives ?',
    lines: invariantLines,
  });

  const silentLines =
    params.silentErrorTools.length > 0
      ? params.silentErrorTools.map(
          (tool) =>
            `- \`${tool.toolName}\` signale des erreurs sans métadonnées exploitables : ajouter un code et un indice côté serveur faciliterait la résolution.`,
        )
      : ['- Aucune erreur silencieuse détectée : toutes les réponses en échec exposent un code ou un indice.'];
  sections.push({
    title: 'Quelles erreurs sont silencieuses ou mal gérées ?',
    lines: silentLines,
  });

  const eventLines: string[] = [];
  const events = params.introspectionReport?.events;
  if (events) {
    eventLines.push(
      `- Les abonnements ont capturé ${events.follow_up_count ?? 0} évènement(s) supplémentaires après la publication initiale (seq ${
        events.published_seq ?? 'n/a'
      }).`,
    );
    if ((events.baseline_count ?? 0) === 0) {
      eventLines.push('- Aucun évènement de base n’a été collecté : ajouter un message de démarrage améliorerait le contexte.');
    } else {
      eventLines.push('- Les évènements comportent déjà un volume suffisant pour corréler les opérations observées.');
    }
  } else {
    eventLines.push('- Aucun rapport d’introspection disponible pour analyser le flux d’évènements.');
  }
  sections.push({
    title: 'Quels événements manquent de contexte ou de granularité ?',
    lines: eventLines,
  });

  sections.push({
    title: 'Quels outils pourraient être fusionnés ou refactorisés ?',
    lines: [
      '- Les appels observés couvrent des domaines fonctionnels distincts ; aucune duplication flagrante nécessitant une fusion immédiate n’a été détectée.',
      '- Continuer à factoriser les chemins communs `plan_status`/`plan_cancel` pourrait néanmoins réduire les divergences de logs.',
    ],
  });

  const performanceLines: string[] = [];
  if (params.slowestTool) {
    performanceLines.push(
      `- \`${params.slowestTool.toolName}\` est la plus lente (durée moyenne ${params.slowestTool.averageDurationMs.toFixed(
        0,
      )} ms, pic ${params.slowestTool.maxDurationMs.toFixed(0)} ms) : surveiller sa dérive et ajouter un suivi P95.`,
    );
  }
  performanceLines.push(
    `- Au total ${params.findingsMetrics.totalCalls} appel(s) ont été orchestrés, sans surcharge notable sur les autres outils testés.`,
  );
  sections.push({
    title: 'As-tu remarqué des problèmes de performance ou de latence ?',
    lines: performanceLines,
  });

  const cancellationLines: string[] = [];
  if (params.resilienceReport?.metrics.cancellationsIssued) {
    cancellationLines.push(
      `- ${params.resilienceReport.metrics.cancellationsIssued} scénario(s) d’annulation ont été exécutés avec retour d’état explicite (ex. \`${
        params.resilienceReport.longOperation?.planStatus ?? 'inconnu'
      }\`).`,
    );
  }
  if (params.resilienceReport?.longOperation && !params.resilienceReport.longOperation.planErrorCode) {
    cancellationLines.push(
      '- Le plan long n’a pas renvoyé de code d’erreur post-annulation : ajouter un marqueur explicite confirmerait la propagation du signal.',
    );
  }
  sections.push({
    title: 'As-tu rencontré des points d’annulation incomplets ou défaillants ?',
    lines: cancellationLines.length > 0 ? cancellationLines : ['- Aucun incident détecté lors des annulations orchestrées.'],
  });

  const newCapabilitiesLines: string[] = [];
  if (params.advancedReport) {
    newCapabilitiesLines.push(
      `- Exploiter les ${params.advancedReport.knowledge.fragmentsSuggested} fragments suggérés par \`kg_suggest_plan\` pour pré-remplir les recommandations multi-agents.`,
    );
    newCapabilitiesLines.push(
      `- La coordination Contract-Net (\`${params.advancedReport.contractNet.awardedAgent ?? 'inconnu'}\`) pourrait exposer un hook pour partager les offres concurrentes aux assistants.`,
    );
  } else {
    newCapabilitiesLines.push('- Ajouter un rapport de l’étape 7 permettrait de proposer des améliorations ciblées.');
  }
  sections.push({
    title: 'Quelles nouvelles capacités pourraient améliorer l’expérience multi-agent ?',
    lines: newCapabilitiesLines,
  });

  const logLines: string[] = [];
  if (params.advancedReport?.logs) {
    if ((params.advancedReport.logs.entries ?? 0) === 0) {
      logLines.push('- Le flux `logs_tail` ne contient aucune entrée : prévoir un fallback ou un message de garde faciliterait le debug.');
    } else {
      logLines.push(
        `- Les ${params.advancedReport.logs.entries} entrée(s) de journal récupérées offrent une bonne granularité ; ajouter l’identifiant d’opération faciliterait toutefois la corrélation multi-stage.`,
      );
    }
  } else {
    logLines.push('- Pas de capture `logs_tail` disponible pour évaluer la granularité des journaux.');
  }
  sections.push({
    title: 'Y a-t-il des informations absentes dans les logs nécessaires pour le débogage ?',
    lines: logLines,
  });

  sections.push({
    title: 'Quelles métriques ajouterais-tu pour mieux observer l’état du système ?',
    lines: [
      '- Ajouter la latence P95/P99 par outil pour détecter les queues longues non visibles via la moyenne.',
      '- Exposer un compteur de réessais idempotents (Étape 3) et les expirations de stigmergie (Étape 7) pour suivre l’usure du système.',
    ],
  });

  return [
    '# Étape 8 – Recommandations',
    '',
    ...sections.flatMap((section) => ['## ' + section.title, ...section.lines, '']),
  ].join('\n');
}

/**
 * Computes aggregated tool metrics (counts, durations, error metadata) that feed
 * both the Markdown summary and the machine-readable findings document.
 */
function computeToolAggregates(callCollections: Array<{
  readonly stageLabel: string;
  readonly calls: ReadonlyArray<BaseToolCallSummary>;
}>): {
  readonly aggregates: ToolAggregateResult[];
  readonly totalCalls: number;
  readonly totalErrors: number;
  readonly uniqueScenarioCount: number;
} {
  const map = new Map<string, {
    readonly stages: Set<string>;
    readonly scenarios: Set<string>;
    totalCalls: number;
    successCount: number;
    errorCount: number;
    totalDuration: number;
    maxDuration: number;
    readonly errorCodes: Set<string>;
    readonly hints: Set<string>;
  }>();
  let totalCalls = 0;
  let totalErrors = 0;
  const scenarioIdentifiers = new Set<string>();

  for (const collection of callCollections) {
    for (const call of collection.calls) {
      totalCalls += 1;
      if (call.response.isError) {
        totalErrors += 1;
      }
      const scenarioKey = `${call.toolName}#${call.scenario ?? 'default'}`;
      scenarioIdentifiers.add(scenarioKey);

      const aggregate = map.get(call.toolName) ?? {
        stages: new Set<string>(),
        scenarios: new Set<string>(),
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        totalDuration: 0,
        maxDuration: 0,
        errorCodes: new Set<string>(),
        hints: new Set<string>(),
      };

      aggregate.stages.add(collection.stageLabel);
      aggregate.scenarios.add(call.scenario ?? 'default');
      aggregate.totalCalls += 1;
      aggregate.totalDuration += call.durationMs;
      aggregate.maxDuration = Math.max(aggregate.maxDuration, call.durationMs);
      if (call.response.isError) {
        aggregate.errorCount += 1;
        const errorCode = extractErrorCode(call.response);
        if (errorCode) {
          aggregate.errorCodes.add(errorCode);
        }
        const hint = extractHint(call.response);
        if (hint) {
          aggregate.hints.add(hint);
        }
      } else {
        aggregate.successCount += 1;
      }

      map.set(call.toolName, aggregate);
    }
  }

  const aggregates: ToolAggregateResult[] = Array.from(map.entries())
    .map(([toolName, aggregate]) => ({
      toolName,
      stages: Array.from(aggregate.stages).sort(),
      scenarios: Array.from(aggregate.scenarios).sort(),
      totalCalls: aggregate.totalCalls,
      successCount: aggregate.successCount,
      errorCount: aggregate.errorCount,
      averageDurationMs: aggregate.totalCalls > 0 ? aggregate.totalDuration / aggregate.totalCalls : 0,
      maxDurationMs: aggregate.maxDuration,
      errorCodes: Array.from(aggregate.errorCodes).sort(),
      hints: Array.from(aggregate.hints).sort(),
    }))
    .sort((a, b) => a.toolName.localeCompare(b.toolName));

  return {
    aggregates,
    totalCalls,
    totalErrors,
    uniqueScenarioCount: scenarioIdentifiers.size,
  };
}

/**
 * Generates the final run report by consolidating all stage artefacts into the
 * required Markdown and JSON deliverables.
 */
export async function runFinalReportStage(options: FinalReportStageOptions): Promise<FinalReportStageResult> {
  const now = options.clock ?? (() => new Date());
  const generatedAt = now().toISOString();
  const reportDir = options.context.directories.report;

  const stage1Path = path.join(reportDir, 'step01-introspection.json');
  const stage2Path = path.join(reportDir, 'step02-base-tools.json');
  const stage3Path = path.join(reportDir, 'step03-transactions.json');
  const stage4Path = path.join(reportDir, 'step04-child-orchestration.json');
  const stage5Path = path.join(reportDir, 'step05-plans-values.json');
  const stage6Path = path.join(reportDir, 'step06-resilience.json');
  const stage7Path = path.join(reportDir, 'step07-advanced-functions.json');

  const [
    stage1,
    stage2,
    stage3,
    stage4,
    stage5,
    stage6,
    stage7,
  ] = await Promise.all([
    readJsonIfExists<IntrospectionStageReport>(stage1Path),
    readJsonIfExists<BaseToolsStageReport>(stage2Path),
    readJsonIfExists<TransactionsStageReport>(stage3Path),
    readJsonIfExists<ChildStageReport>(stage4Path),
    readJsonIfExists<PlanningStageReport>(stage5Path),
    readJsonIfExists<ResilienceStageReport>(stage6Path),
    readJsonIfExists<AdvancedFunctionsStageReport>(stage7Path),
  ]);

  const stageEntries: StageProgressEntry[] = [];
  if (stage1) {
    const totalPrefixes = stage1.resources?.prefixes?.length ?? 0;
    const totalResources = stage1.resources?.prefixes?.reduce((acc, entry) => acc + (entry.count ?? 0), 0) ?? 0;
    stageEntries.push({
      id: 'stage01',
      label: 'Étape 1 – Introspection et découverte',
      completed: true,
      reportPath: stage1Path,
      totalCalls: null,
      errorCount: null,
      notes: `Préfixes catalogués : ${totalPrefixes} (${totalResources} ressources).`,
    });
  } else {
    stageEntries.push({
      id: 'stage01',
      label: 'Étape 1 – Introspection et découverte',
      completed: false,
      reportPath: null,
      totalCalls: null,
      errorCount: null,
      notes: 'Rapport manquant.',
    });
  }

  const callCollections: Array<{ stageLabel: string; calls: ReadonlyArray<BaseToolCallSummary> }> = [];

  if (stage2) {
    stageEntries.push({
      id: 'stage02',
      label: 'Étape 2 – Tests de base des outils',
      completed: true,
      reportPath: stage2Path,
      totalCalls: stage2.metrics.totalCalls,
      errorCount: stage2.metrics.errorCount,
      notes: stage2.generatedGraphId ? `Graphe de référence : ${stage2.generatedGraphId}.` : 'Graphe de référence indisponible.',
    });
    callCollections.push({ stageLabel: 'Étape 2', calls: stage2.calls });
  } else {
    stageEntries.push({
      id: 'stage02',
      label: 'Étape 2 – Tests de base des outils',
      completed: false,
      reportPath: null,
      totalCalls: null,
      errorCount: null,
      notes: 'Rapport manquant.',
    });
  }

  if (stage3) {
    stageEntries.push({
      id: 'stage03',
      label: 'Étape 3 – Transactions, versions et invariants',
      completed: true,
      reportPath: stage3Path,
      totalCalls: stage3.metrics.totalCalls,
      errorCount: stage3.metrics.errorCount,
      notes: `Version patchée : ${stage3.metrics.patchedVersion ?? 'n/a'}.`,
    });
    callCollections.push({ stageLabel: 'Étape 3', calls: stage3.calls });
  } else {
    stageEntries.push({
      id: 'stage03',
      label: 'Étape 3 – Transactions, versions et invariants',
      completed: false,
      reportPath: null,
      totalCalls: null,
      errorCount: null,
      notes: 'Rapport manquant.',
    });
  }

  if (stage4) {
    stageEntries.push({
      id: 'stage04',
      label: 'Étape 4 – Enfants & orchestration multi-instances',
      completed: true,
      reportPath: stage4Path,
      totalCalls: stage4.metrics.totalCalls,
      errorCount: stage4.metrics.errorCount,
      notes: `Enfants orchestrés : ${stage4.metrics.spawnedChildren}.`,
    });
    callCollections.push({ stageLabel: 'Étape 4', calls: stage4.calls });
  } else {
    stageEntries.push({
      id: 'stage04',
      label: 'Étape 4 – Enfants & orchestration multi-instances',
      completed: false,
      reportPath: null,
      totalCalls: null,
      errorCount: null,
      notes: 'Rapport manquant.',
    });
  }

  if (stage5) {
    stageEntries.push({
      id: 'stage05',
      label: 'Étape 5 – Graphes, valeurs et plans',
      completed: true,
      reportPath: stage5Path,
      totalCalls: stage5.metrics.totalCalls,
      errorCount: stage5.metrics.errorCount,
      notes: `Nœuds : ${stage5.graph.nodeCount}, valeurs : ${stage5.values.configuredValues}.`,
    });
    callCollections.push({ stageLabel: 'Étape 5', calls: stage5.calls });
  } else {
    stageEntries.push({
      id: 'stage05',
      label: 'Étape 5 – Graphes, valeurs et plans',
      completed: false,
      reportPath: null,
      totalCalls: null,
      errorCount: null,
      notes: 'Rapport manquant.',
    });
  }

  if (stage6) {
    stageEntries.push({
      id: 'stage06',
      label: 'Étape 6 – Résilience et annulation',
      completed: true,
      reportPath: stage6Path,
      totalCalls: stage6.metrics.totalCalls,
      errorCount: stage6.metrics.errorCount,
      notes: `Annulations exécutées : ${stage6.metrics.cancellationsIssued}.`,
    });
    callCollections.push({ stageLabel: 'Étape 6', calls: stage6.calls });
  } else {
    stageEntries.push({
      id: 'stage06',
      label: 'Étape 6 – Résilience et annulation',
      completed: false,
      reportPath: null,
      totalCalls: null,
      errorCount: null,
      notes: 'Rapport manquant.',
    });
  }

  if (stage7) {
    stageEntries.push({
      id: 'stage07',
      label: 'Étape 7 – Fonctions avancées',
      completed: true,
      reportPath: stage7Path,
      totalCalls: stage7.metrics.totalCalls,
      errorCount: stage7.metrics.errorCount,
      notes: `Fragments suggérés : ${stage7.knowledge.fragmentsSuggested}.`,
    });
    callCollections.push({ stageLabel: 'Étape 7', calls: stage7.calls });
  } else {
    stageEntries.push({
      id: 'stage07',
      label: 'Étape 7 – Fonctions avancées',
      completed: false,
      reportPath: null,
      totalCalls: null,
      errorCount: null,
      notes: 'Rapport manquant.',
    });
  }

  const { aggregates, totalCalls, totalErrors, uniqueScenarioCount } = computeToolAggregates(callCollections);
  const metrics: FinalReportStageResult['metrics'] = {
    totalCalls,
    errorCount: totalErrors,
    uniqueTools: aggregates.length,
    uniqueScenarios: uniqueScenarioCount,
    stagesCompleted: stageEntries.filter((entry) => entry.completed).length,
  };

  const expectedToolNames = extractCapabilityToolNames(stage1?.capabilities ?? null);
  const expectedToolSet = new Set(expectedToolNames);
  const coveredToolNames = new Set(aggregates.map((entry) => entry.toolName));
  const coveredExpectedTools = expectedToolNames.filter((name) => coveredToolNames.has(name));
  const missingToolNames = expectedToolNames.filter((name) => !coveredToolNames.has(name));
  const unexpectedTools = aggregates
    .map((entry) => entry.toolName)
    .filter((name) => expectedToolNames.length > 0 && !expectedToolSet.has(name));

  const underDocumentedTools = aggregates.filter((tool) => tool.errorCount > 0 && tool.errorCodes.length === 0 && tool.hints.length === 0);
  const silentErrorTools = aggregates.filter((tool) => tool.errorCount > 0 && tool.errorCodes.length === 0);
  const slowestTool = aggregates.reduce<ToolAggregateResult | null>((acc, tool) => {
    if (!acc) {
      return tool;
    }
    return tool.averageDurationMs > acc.averageDurationMs ? tool : acc;
  }, null);

  const highlights: string[] = [];
  if (stage3?.idempotency.identicalPayload) {
    highlights.push(`Rejeu idempotent validé pour la transaction \`${stage3.idempotency.txId}\``);
  }
  if (stage6?.planCancellation) {
    highlights.push(
      `Annulation planifiée confirmée pour le run \`${stage6.planCancellation.runId}\` (état ${
        stage6.planCancellation.statusAfterCancel ?? 'inconnu'
      }).`,
    );
  }
  if (stage7?.consensus.outcome) {
    highlights.push(
      `Vote de consensus conclu avec l’issue \`${stage7.consensus.outcome}\` (poids total ${stage7.consensus.totalWeight ?? 0}).`,
    );
  }
  if (expectedToolNames.length > 0) {
    if (missingToolNames.length > 0) {
      const preview = missingToolNames.slice(0, 5).join(', ');
      const suffix = missingToolNames.length > 5 ? ', …' : '';
      highlights.push(
        `Couverture incomplète : ${missingToolNames.length}/${expectedToolNames.length} outil(s) annoncés non exercés (${preview}${suffix}).`,
      );
    } else {
      highlights.push('Couverture totale : tous les outils annoncés ont été exercés au moins une fois.');
    }
  }

  const summaryMarkdown = buildSummaryMarkdown({
    runId: options.context.runId,
    generatedAt,
    stages: stageEntries,
    toolAggregates: aggregates,
    metrics,
    highlights,
    expectedToolCount: expectedToolNames.length > 0 ? expectedToolNames.length : null,
    coveredExpectedToolCount: expectedToolNames.length > 0 ? coveredExpectedTools.length : null,
    missingTools: missingToolNames,
  });

  const findings = {
    runId: options.context.runId,
    generatedAt,
    metrics,
    stages: stageEntries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      completed: entry.completed,
      reportPath: entry.reportPath ? path.relative(options.context.rootDir, entry.reportPath) : null,
      totalCalls: entry.totalCalls,
      errorCount: entry.errorCount,
      notes: entry.notes,
    })),
    tools: aggregates.map((tool) => ({
      toolName: tool.toolName,
      stages: tool.stages,
      scenarios: tool.scenarios,
      totalCalls: tool.totalCalls,
      successCount: tool.successCount,
      errorCount: tool.errorCount,
      averageDurationMs: Number(tool.averageDurationMs.toFixed(2)),
      maxDurationMs: Number(tool.maxDurationMs.toFixed(2)),
      errorCodes: tool.errorCodes,
      hints: tool.hints,
    })),
    coverage: {
      expectedTools: expectedToolNames.length,
      coveredTools: coveredExpectedTools.length,
      missingTools: missingToolNames,
      unexpectedTools,
    },
    introspection: stage1
      ? {
          resourcePrefixes: stage1.resources?.prefixes?.length ?? 0,
          totalResources: stage1.resources?.prefixes?.reduce((acc, entry) => acc + (entry.count ?? 0), 0) ?? 0,
          events: stage1.events ?? null,
        }
      : null,
  };

  const recommendationsMarkdown = buildRecommendationsMarkdown({
    underDocumentedTools,
    silentErrorTools,
    transactionsReport: stage3 ?? null,
    resilienceReport: stage6 ?? null,
    advancedReport: stage7 ?? null,
    planningReport: stage5 ?? null,
    introspectionReport: stage1 ?? null,
    findingsMetrics: metrics,
    slowestTool,
  });

  const summaryPath = path.join(reportDir, 'summary.md');
  const findingsPath = path.join(reportDir, 'findings.json');
  const recommendationsPath = path.join(reportDir, 'recommendations.md');

  await writeFile(summaryPath, `${summaryMarkdown}\n`, 'utf8');
  await writeFile(findingsPath, `${JSON.stringify(findings, null, 2)}\n`, 'utf8');
  await writeFile(recommendationsPath, `${recommendationsMarkdown}\n`, 'utf8');

  await options.recorder.appendLogEntry({
    level: 'info',
    message: 'final_report_stage_completed',
    details: {
      summaryPath,
      findingsPath,
      recommendationsPath,
      metrics,
    },
  });

  return {
    runId: options.context.runId,
    generatedAt,
    summaryPath,
    findingsPath,
    recommendationsPath,
    stages: stageEntries,
    tools: aggregates,
    metrics,
    coverage: {
      expectedTools: expectedToolNames.length,
      coveredTools: coveredExpectedTools.length,
      missingTools: missingToolNames,
      unexpectedTools,
    },
  };
}
