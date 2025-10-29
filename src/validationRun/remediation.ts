import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  ensureValidationRunLayout,
  type ValidationRunLayout,
} from "./layout.js";
import {
  generateValidationSummary,
  type GenerateValidationSummaryOptions,
  type ValidationSummaryReport,
} from "./reports.js";

/**
 * Levels describing how urgently an operator should address a remediation
 * action. The scale mirrors the language used in the checklist where some
 * issues block the validation (critical) while others simply require
 * follow-up (attention) or can be logged for traceability (info).
 */
export type RemediationSeverity = "info" | "attention" | "critical";

/**
 * Status returned by {@link RemediationPlan} once all actions have been
 * derived. The status helps reviewers decide whether the validation campaign
 * can proceed ("clear"), requires manual adjustments ("attention"), or must
 * be paused until blocking items are solved ("blocked").
 */
export type RemediationStatus = "clear" | "attention" | "blocked";

/** Structured representation for a remediation action. */
export interface RemediationAction {
  readonly criterion: string;
  readonly severity: RemediationSeverity;
  readonly description: string;
  readonly recommendations: readonly string[];
  readonly scenarios?: readonly string[];
}

/** Final remediation plan consolidating all actionable items. */
export interface RemediationPlan {
  readonly generatedAt: string;
  readonly status: RemediationStatus;
  readonly actions: readonly RemediationAction[];
  readonly notes: readonly string[];
}

/** Options accepted when generating remediation guidance. */
export interface GenerateRemediationPlanOptions {
  readonly layout?: ValidationRunLayout;
  readonly baseRoot?: string;
  readonly now?: Date;
  readonly summary?: ValidationSummaryReport;
}

/** Result returned when persisting the remediation artefacts. */
export interface PersistedRemediationPlan {
  readonly plan: RemediationPlan;
  readonly jsonPath: string;
  readonly markdownPath: string;
}

/**
 * Generates a remediation plan by analysing the aggregated validation
 * summary. The logic mirrors section 7 of the checklist by proposing
 * concrete adjustments for each failed or unknown acceptance criterion and
 * surfacing recurring error categories (robots, taille maximale, latence…).
 */
export async function generateRemediationPlan(
  options: GenerateRemediationPlanOptions = {},
): Promise<RemediationPlan> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const summaryOptions: GenerateValidationSummaryOptions = {
    layout,
    ...(options.baseRoot !== undefined ? { baseRoot: options.baseRoot } : {}),
    ...(options.now ? { now: options.now } : {}),
  };

  const summary = options.summary ?? (await generateValidationSummary(summaryOptions));

  const actions: RemediationAction[] = [];
  const notes: string[] = [];

  actions.push(
    ...collectAcceptanceRemediations(summary.acceptance),
    ...collectScenarioNotes(summary),
    ...collectErrorBasedRemediations(summary),
  );

  if (actions.length === 0) {
    notes.push("Aucune action corrective détectée – la campagne peut être archivée.");
  }

  const severityOrder: RemediationSeverity[] = ["critical", "attention", "info"];
  actions.sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity));

  const status: RemediationStatus = actions.some((action) => action.severity === "critical")
    ? "blocked"
    : actions.some((action) => action.severity === "attention")
      ? "attention"
      : "clear";

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    status,
    actions,
    notes,
  };
}

/**
 * Persists the remediation plan to both JSON and Markdown files under the
 * `validation_run/reports/` directory so that operators can attach the
 * summary to change logs or incident reports.
 */
export async function writeRemediationPlan(
  options: GenerateRemediationPlanOptions = {},
): Promise<PersistedRemediationPlan> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const plan = await generateRemediationPlan({ ...options, layout });
  const jsonPath = path.join(layout.reportsDir, "remediation_plan.json");
  const markdownPath = path.join(layout.reportsDir, "REMEDIATION_PLAN.md");

  await writeFile(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderRemediationMarkdown(plan), "utf8");

  return { plan, jsonPath, markdownPath };
}

/**
 * Renders a human readable Markdown representation of the remediation plan.
 * Each action is listed with its severity, the impacted criteria, and the
 * concrete recommendations that operators can apply before relaunching a
 * scenario or the full validation campaign.
 */
export function renderRemediationMarkdown(plan: RemediationPlan): string {
  const lines: string[] = [];
  lines.push("# Plan de remédiation");
  lines.push("");
  lines.push(`Généré le : ${plan.generatedAt}`);
  lines.push("");
  lines.push(`Statut global : ${plan.status}`);
  lines.push("");

  if (plan.actions.length === 0) {
    lines.push("Aucune action requise – tous les critères sont conformes.");
  } else {
    lines.push("## Actions");
    lines.push("| Critère | Sévérité | Description | Scénarios | Recommandations |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const action of plan.actions) {
      const scenarios = action.scenarios?.join(", ") ?? "—";
      const recommendations = action.recommendations.length > 0
        ? action.recommendations.join("<br />")
        : "—";
      lines.push(
        `| ${action.criterion} | ${action.severity} | ${action.description} | ${scenarios} | ${recommendations} |`,
      );
    }
  }

  if (plan.notes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    for (const note of plan.notes) {
      lines.push(`- ${note}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/** Collects remediation actions derived from acceptance criteria. */
function collectAcceptanceRemediations(acceptance: ValidationSummaryReport["acceptance"]): RemediationAction[] {
  const actions: RemediationAction[] = [];

  const mapping: Record<keyof ValidationSummaryReport["acceptance"], RemediationBlueprint> = {
    functional: {
      severityOnFail: "critical",
      severityOnUnknown: "attention",
      recommendations: [
        "Réexécuter les scénarios incomplets en identifiant les manques dans timings.json et errors.json.",
        "Vérifier que `recordScenarioRun` a bien été appelé après chaque run pour capturer les artefacts.",
      ],
    },
    idempotence: {
      severityOnFail: "critical",
      severityOnUnknown: "attention",
      recommendations: [
        "Relancer S01 et S05 en s'assurant que les mêmes sources sont ré-ingérées (docIds identiques).",
        "Inspecter `validation_run/runs/S05_idempotence/events.ndjson` pour repérer les doublons.",
      ],
    },
    extraction: {
      severityOnFail: "attention",
      severityOnUnknown: "attention",
      recommendations: [
        "Renforcer la normalisation Unicode/espaces avant hash pour augmenter le ratio de segments uniques.",
        "Réduire le chunking ou ajuster l'algorithme de découpe si trop de doublons persistent.",
      ],
    },
    language: {
      severityOnFail: "attention",
      severityOnUnknown: "attention",
      recommendations: [
        "Inspecter `documents_summary.json` pour identifier les documents sans langue détectée.",
        "Ajuster la détection (modèle/langue de fallback) puis regénérer les artefacts via `validation:metrics`.",
      ],
    },
    ragQuality: {
      severityOnFail: "attention",
      severityOnUnknown: "attention",
      recommendations: [
        "Relire la réponse S10 et vérifier que les citations renvoient aux documents ingérés.",
        "Ajuster le chunking ou enrichir les métadonnées avant de rejouer `validation:scenario:run --scenario S10`.",
      ],
    },
    performance: {
      severityOnFail: "critical",
      severityOnUnknown: "attention",
      recommendations: [
        "Réduire `maxResults` ou le nombre de moteurs Searx si la latence est trop élevée.",
        "Adapter `SEARCH_SEARX_TIMEOUT_MS`/`SEARCH_FETCH_TIMEOUT_MS` et relancer `validation:metrics`.",
      ],
    },
    robustness: {
      severityOnFail: "attention",
      severityOnUnknown: "attention",
      recommendations: [
        "Classer les erreurs par type et vérifier qu'elles sont non bloquantes (`errors.json`).",
        "Documenter les remédiations appliquées et rejouer le scénario concerné (`S0X_rerun1/`).",
      ],
    },
  };

  for (const [criterion, blueprint] of Object.entries(mapping)) {
    const key = criterion as keyof ValidationSummaryReport["acceptance"];
    const check = acceptance[key];
    if (!check) {
      continue;
    }

    if (check.status === "pass") {
      continue;
    }

    const severity = check.status === "fail" ? blueprint.severityOnFail : blueprint.severityOnUnknown;
    const description = `${check.details}`;
    actions.push({
      criterion: key,
      severity,
      description,
      recommendations: blueprint.recommendations,
      ...(check.scenarios && check.scenarios.length > 0 ? { scenarios: check.scenarios } : {}),
    });
  }

  return actions;
}

/** Template describing default recommendations for a criterion. */
interface RemediationBlueprint {
  readonly severityOnFail: RemediationSeverity;
  readonly severityOnUnknown: RemediationSeverity;
  readonly recommendations: readonly string[];
}

/** Builds remediation actions derived from scenario-level notes. */
function collectScenarioNotes(summary: ValidationSummaryReport): RemediationAction[] {
  const actions: RemediationAction[] = [];

  for (const snapshot of summary.scenarios) {
    if (snapshot.notes.length === 0) {
      continue;
    }

    actions.push({
      criterion: snapshot.slug,
      severity: "attention",
      description:
        "Des notes subsistent pour ce scénario (fichiers manquants, journaux incomplets ou artefacts partiels).",
      recommendations: snapshot.notes,
      scenarios: [snapshot.slug],
    });
  }

  return actions;
}

/**
 * Groups recurring error categories so operators can apply the mitigation
 * strategies described in section 7 of the checklist.
 */
function collectErrorBasedRemediations(summary: ValidationSummaryReport): RemediationAction[] {
  const categoryAggregate = new Map<string, { count: number; scenarios: Set<string> }>();

  for (const snapshot of summary.scenarios) {
    for (const [category, count] of Object.entries(snapshot.errorCounts)) {
      if (count <= 0) {
        continue;
      }
      const existing = categoryAggregate.get(category);
      if (existing) {
        existing.count += count;
        snapshot.slug && existing.scenarios.add(snapshot.slug);
      } else {
        categoryAggregate.set(category, { count, scenarios: new Set([snapshot.slug]) });
      }
    }
  }

  const recommendations: Record<string, { description: string; suggestions: readonly string[] }> = {
    network_error: {
      description: "Erreurs réseau détectées lors de la collecte (timeouts/5xx).",
      suggestions: [
        "Stabiliser les sources instables ou réduire le parallélisme (`SEARCH_PARALLEL_FETCH`).",
        "Consigner les URLs fautives dans `errors.json` puis envisager un rerun ciblé.",
      ],
    },
    robots_denied: {
      description: "Des robots.txt ont refusé l'accès à certaines ressources.",
      suggestions: [
        "Activer `SEARCH_FETCH_RESPECT_ROBOTS=1` et ajouter un throttle par domaine si nécessaire.",
        "Documenter les domaines bloqués et ajuster la stratégie de crawling.",
      ],
    },
    max_size_exceeded: {
      description: "Des contenus ont dépassé la taille maximale autorisée.",
      suggestions: [
        "Augmenter `SEARCH_FETCH_MAX_BYTES` pour les scénarios nécessitant de gros fichiers.",
        "Filtrer les requêtes ou limiter les domaines renvoyant des archives volumineuses.",
      ],
    },
    parse_error: {
      description: "Échecs de parsing détectés (HTML/PDF non traités).",
      suggestions: [
        "Inspecter les payloads dans `artifacts/` et ajuster la stratégie Unstructured.",
        "Relancer l'extraction après correction pour vérifier la résilience.",
      ],
    },
  };

  const actions: RemediationAction[] = [];

  for (const [category, aggregate] of categoryAggregate.entries()) {
    const remediation = recommendations[category];
    if (!remediation) {
      continue;
    }

    const scenarios = Array.from(aggregate.scenarios).sort();
    actions.push({
      criterion: `erreur:${category}`,
      severity: "attention",
      description: `${remediation.description} (${aggregate.count} occurrences).`,
      recommendations: remediation.suggestions,
      scenarios,
    });
  }

  return actions;
}
