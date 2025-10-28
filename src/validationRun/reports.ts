import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ensureValidationRunLayout,
  type ValidationRunLayout,
} from "./layout.js";
import type { DocumentSummary } from "./execution.js";
import {
  formatScenarioSlug,
  initialiseScenarioRun,
  VALIDATION_SCENARIOS,
  type ValidationScenarioDefinition,
} from "./scenario.js";
import {
  type ScenarioErrorEntry,
  type ScenarioTimingBucket,
  type ScenarioTimingReport,
} from "./artefacts.js";
import { compareScenarioIdempotence } from "./idempotence.js";

/** Possible evaluation outcomes for the acceptance criteria. */
export type AcceptanceStatus = "pass" | "fail" | "unknown";

/**
 * Result returned for each acceptance criterion. The optional `scenarios` field
 * highlights which scenarios informed the verdict to simplify operator reviews.
 */
export interface AcceptanceCheck {
  readonly status: AcceptanceStatus;
  readonly details: string;
  readonly scenarios?: readonly string[];
}

/** Structured list of acceptance checks mirroring the checklist section 6. */
export interface AcceptanceSummary {
  readonly functional: AcceptanceCheck;
  readonly idempotence: AcceptanceCheck;
  readonly extraction: AcceptanceCheck;
  readonly language: AcceptanceCheck;
  readonly ragQuality: AcceptanceCheck;
  readonly performance: AcceptanceCheck;
  readonly robustness: AcceptanceCheck;
}

/**
 * Snapshot of the artefacts collected for a scenario. The object consolidates
 * counts (documents, errors, events) and highlights missing data so operators
 * can close the gaps before publishing the final report.
 */
export interface ScenarioSnapshot {
  readonly id: number;
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly timings?: ScenarioTimingReport;
  readonly errorEntries: readonly ScenarioErrorEntry[];
  readonly errorCounts: Record<string, number>;
  readonly documentsIngested?: number;
  readonly tookMs?: number;
  readonly eventsCount?: number;
  readonly kgChangesCount?: number;
  readonly vectorUpsertsCount?: number;
  readonly serverLogLines?: number;
  readonly notes: readonly string[];
}

/**
 * Aggregated metrics computed across the campaign. All counters default to zero
 * so the JSON summary remains easy to diff across reruns.
 */
export interface DomainDistributionEntry {
  readonly domain: string;
  readonly count: number;
  readonly percentage: number;
}

export interface ContentTypeDistributionEntry {
  readonly mimeType: string;
  readonly count: number;
  readonly percentage: number;
}

export interface ValidationTotals {
  readonly documentsIngested: number;
  readonly events: number;
  readonly kgChanges: number;
  readonly vectorUpserts: number;
  readonly errors: Record<string, number>;
  readonly topDomains: readonly DomainDistributionEntry[];
  readonly contentTypes: readonly ContentTypeDistributionEntry[];
}

/**
 * Final summary serialised to `validation_run/reports/summary.json`.
 */
export interface ValidationSummaryReport {
  readonly generatedAt: string;
  readonly scenarios: readonly ScenarioSnapshot[];
  readonly totals: ValidationTotals;
  readonly acceptance: AcceptanceSummary;
}

/** Options accepted when generating a summary. */
export interface GenerateValidationSummaryOptions {
  readonly layout?: ValidationRunLayout;
  readonly baseRoot?: string;
  readonly now?: Date;
}

/** Result returned when persisting the summary and markdown report. */
export interface PersistedValidationReport {
  readonly summary: ValidationSummaryReport;
  readonly summaryPath: string;
  readonly reportPath: string;
}

/**
 * Computes the validation summary across every scenario directory. The
 * resulting structure feeds both the JSON summary and the markdown report.
 */
export async function generateValidationSummary(
  options: GenerateValidationSummaryOptions = {},
): Promise<ValidationSummaryReport> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const snapshots: ScenarioSnapshot[] = [];

  for (const scenario of VALIDATION_SCENARIOS) {
    snapshots.push(await collectScenarioSnapshot(scenario, layout));
  }

  const totals = await computeTotals(snapshots, layout);
  const acceptance = await evaluateAcceptance(snapshots, layout);
  const generatedAt = (options.now ?? new Date()).toISOString();

  return { generatedAt, scenarios: snapshots, totals, acceptance };
}

/**
 * Generates the JSON and markdown reports under `validation_run/reports/`.
 */
export async function writeValidationReport(
  options: GenerateValidationSummaryOptions = {},
): Promise<PersistedValidationReport> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const summary = await generateValidationSummary({ ...options, layout });
  const summaryPath = path.join(layout.reportsDir, "summary.json");
  const reportPath = path.join(layout.reportsDir, "REPORT.md");

  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
  });
  await writeFile(reportPath, renderMarkdownReport(summary), { encoding: "utf8" });

  return { summary, summaryPath, reportPath };
}

/**
 * Produces a human readable markdown report consolidating metrics, acceptance
 * decisions, and outstanding gaps. The sections mirror the checklist so the
 * report can be attached to change logs without further formatting.
 */
export function renderMarkdownReport(summary: ValidationSummaryReport): string {
  const lines: string[] = [];
  lines.push("# Validation Report");
  lines.push("");
  lines.push(`Généré le : ${summary.generatedAt}`);
  lines.push("");

  lines.push("## Synthèse des scénarios");
  lines.push("| Scénario | Durée (ms) | Docs ingérés | Erreurs | Notes |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const scenario of summary.scenarios) {
    const totalErrors = sumErrorCounts(scenario.errorCounts);
    const notes = scenario.notes.length > 0 ? scenario.notes.join("; ") : "—";
    lines.push(
      `| ${scenario.slug} | ${scenario.tookMs ?? "—"} | ${
        scenario.documentsIngested ?? "—"
      } | ${totalErrors} | ${notes} |`,
    );
  }
  lines.push("");

  lines.push("## Totaux agrégés");
  lines.push("- Documents ingérés : " + summary.totals.documentsIngested);
  lines.push("- Événements collectés : " + summary.totals.events);
  lines.push("- KG diffs : " + summary.totals.kgChanges);
  lines.push("- Vector upserts : " + summary.totals.vectorUpserts);
  if (summary.totals.topDomains.length > 0) {
    lines.push(
      "- Top domaines : " +
        formatDomainDistribution(summary.totals.topDomains),
    );
  }
  if (summary.totals.contentTypes.length > 0) {
    lines.push(
      "- Types de contenu : " +
        formatContentTypeDistribution(summary.totals.contentTypes),
    );
  }
  if (Object.keys(summary.totals.errors).length > 0) {
    const formattedErrors = Object.entries(summary.totals.errors)
      .map(([category, count]) => `${category}: ${count}`)
      .join(", ");
    lines.push("- Erreurs classées : " + formattedErrors);
  } else {
    lines.push("- Erreurs classées : 0");
  }
  lines.push("");

  lines.push("## Critères d'acceptation");
  for (const [criterion, check] of Object.entries(summary.acceptance)) {
    const label = formatCriterionLabel(criterion);
    const status = formatAcceptanceStatus(check.status);
    const scope = check.scenarios && check.scenarios.length > 0 ? ` (${check.scenarios.join(", ")})` : "";
    lines.push(`- ${label} : ${status}${scope} – ${check.details}`);
  }
  lines.push("");

  lines.push("## Synthèse thématique");
  lines.push("### Forces");
  for (const strength of collectStrengths(summary)) {
    lines.push(`- ${strength}`);
  }
  lines.push("");
  lines.push("### Faiblesses");
  for (const weakness of collectWeaknesses(summary)) {
    lines.push(`- ${weakness}`);
  }
  lines.push("");
  lines.push("### Recommandations");
  for (const recommendation of collectRecommendations(summary)) {
    lines.push(`- ${recommendation}`);
  }
  lines.push("");
  lines.push("### Décisions");
  for (const decision of collectDecisionHighlights(summary)) {
    lines.push(`- ${decision}`);
  }
  lines.push("");
  lines.push("### État des critères d'acceptation");
  for (const statusLine of summariseScenarioAcceptance(summary.scenarios)) {
    lines.push(`- ${statusLine}`);
  }
  lines.push("");

  lines.push("## Observations détaillées");
  for (const scenario of summary.scenarios) {
    lines.push(`### ${scenario.slug} – ${scenario.label}`);
    lines.push(scenario.description);
    lines.push("");
    if (scenario.timings) {
      lines.push("Timings (p95) :");
      lines.push(
        `- searxQuery=${scenario.timings.searxQuery.p95} ms, fetchUrl=${scenario.timings.fetchUrl.p95} ms, ` +
          `extract=${scenario.timings.extractWithUnstructured.p95} ms`,
      );
      lines.push(
        `- ingestGraph=${scenario.timings.ingestToGraph.p95} ms, ingestVector=${scenario.timings.ingestToVector.p95} ms`,
      );
    } else {
      lines.push("- Timings indisponibles");
    }
    lines.push(`- Documents ingérés : ${scenario.documentsIngested ?? "—"}`);
    lines.push(`- Erreurs classées : ${sumErrorCounts(scenario.errorCounts)}`);
    if (scenario.vectorUpsertsCount !== undefined) {
      lines.push(`- Vector upserts : ${scenario.vectorUpsertsCount}`);
    }
    if (scenario.kgChangesCount !== undefined) {
      lines.push(`- KG diffs : ${scenario.kgChangesCount}`);
    }
    if (scenario.eventsCount !== undefined) {
      lines.push(`- Événements : ${scenario.eventsCount}`);
    }
    if (scenario.notes.length > 0) {
      lines.push(`- Notes : ${scenario.notes.join("; ")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Identifie automatiquement les points forts observés pendant la campagne de
 * validation. L'objectif est d'offrir une base factuelle avant relecture
 * manuelle : scénarios complétés, critères validés et agrégats positifs.
 */
function collectStrengths(summary: ValidationSummaryReport): readonly string[] {
  const strengths: string[] = [];

  // Valorise les critères explicitement validés par l'automatisation.
  for (const [key, check] of Object.entries(summary.acceptance)) {
    if (check.status === "pass") {
      const label = formatCriterionLabel(key);
      const scope = check.scenarios && check.scenarios.length > 0 ? ` (${check.scenarios.join(", ")})` : "";
      strengths.push(`${label} validé${scope} – ${check.details}`);
    }
  }

  // Met en avant les scénarios qui ont ingéré des documents sans erreurs.
  for (const scenario of summary.scenarios) {
    const docs = scenario.documentsIngested ?? 0;
    const errors = sumErrorCounts(scenario.errorCounts);
    if (docs > 0 && errors === 0) {
      strengths.push(`${scenario.slug} : ${docs} documents ingérés sans erreur classée.`);
    }
  }

  if (summary.totals.documentsIngested > 0) {
    strengths.push(
      `Couverture globale : ${summary.totals.documentsIngested} documents ingérés et ${summary.totals.events} événements collectés.`,
    );
  }

  if (strengths.length === 0) {
    strengths.push("Aucun point fort automatique détecté – compléter après analyse.");
  }

  return strengths;
}

/**
 * Synthétise les faiblesses remontées automatiquement : critères en échec,
 * métriques manquantes ou erreurs récurrentes observées dans les artefacts.
 */
function collectWeaknesses(summary: ValidationSummaryReport): readonly string[] {
  const weaknesses: string[] = [];

  for (const [key, check] of Object.entries(summary.acceptance)) {
    if (check.status === "fail") {
      const label = formatCriterionLabel(key);
      const scope = check.scenarios && check.scenarios.length > 0 ? ` (${check.scenarios.join(", ")})` : "";
      weaknesses.push(`${label} en échec${scope} – ${check.details}`);
    } else if (check.status === "unknown") {
      const label = formatCriterionLabel(key);
      const scope = check.scenarios && check.scenarios.length > 0 ? ` (${check.scenarios.join(", ")})` : "";
      weaknesses.push(`${label} non conclu${scope} – ${check.details}`);
    }
  }

  for (const scenario of summary.scenarios) {
    const docs = scenario.documentsIngested ?? 0;
    const errors = sumErrorCounts(scenario.errorCounts);
    if (docs === 0 && errors === 0) {
      weaknesses.push(`${scenario.slug} : aucun document ni erreur enregistrés.`);
    } else if (errors > docs) {
      weaknesses.push(`${scenario.slug} : ${errors} erreurs pour ${docs} documents (analyser la robustesse).`);
    }
    const blockingNote = scenario.notes.find((note) => isBlockingNote(note));
    if (blockingNote) {
      weaknesses.push(`${scenario.slug} : ${blockingNote}.`);
    }
  }

  if (weaknesses.length === 0) {
    weaknesses.push("Aucune faiblesse détectée automatiquement – vérifier manuellement les artefacts.");
  }

  return dedupeLines(weaknesses);
}

/**
 * Propose des recommandations opérationnelles à partir des constats
 * automatisés afin de guider l'agent qui finalise la revue.
 */
function collectRecommendations(summary: ValidationSummaryReport): readonly string[] {
  const recommendations: string[] = [];

  for (const [key, check] of Object.entries(summary.acceptance)) {
    if (check.status === "fail") {
      const label = formatCriterionLabel(key);
      const scope = check.scenarios && check.scenarios.length > 0 ? ` (${check.scenarios.join(", ")})` : "";
      recommendations.push(`Corriger le critère ${label}${scope} puis rejouer les scénarios concernés.`);
    } else if (check.status === "unknown") {
      const label = formatCriterionLabel(key);
      if (check.scenarios && check.scenarios.length > 0) {
        recommendations.push(
          `Compléter les artefacts manquants pour ${label} (${check.scenarios.join(", ")}) afin de conclure l'évaluation.`,
        );
      } else {
        recommendations.push(`Documenter les éléments nécessaires pour conclure le critère ${label}.`);
      }
    }
  }

  for (const scenario of summary.scenarios) {
    const docs = scenario.documentsIngested ?? 0;
    const errors = sumErrorCounts(scenario.errorCounts);
    if (docs === 0 && errors === 0) {
      recommendations.push(`Récupérer les artefacts d'ingestion pour ${scenario.slug} (timings, documents, erreurs).`);
    }
    const blockingNote = scenario.notes.find((note) => isBlockingNote(note));
    if (blockingNote) {
      recommendations.push(`Résoudre ${blockingNote} pour ${scenario.slug} puis régénérer le rapport.`);
    }
  }

  if (recommendations.length === 0) {
    recommendations.push("Aucune recommandation automatique – finaliser après relecture humaine.");
  }

  return dedupeLines(recommendations);
}

/**
 * Résume la décision de validation proposée en fonction des critères et de la
 * couverture des scénarios. Les messages sont volontairement prescriptifs afin
 * de servir de conclusion dans `REPORT.md`.
 */
function collectDecisionHighlights(summary: ValidationSummaryReport): readonly string[] {
  const decisions: string[] = [];
  const acceptanceStatuses = Object.values(summary.acceptance).map((check) => check.status);
  const hasFailure = acceptanceStatuses.includes("fail");
  const hasUnknown = acceptanceStatuses.includes("unknown");

  if (hasFailure) {
    const failingLabels = Object.entries(summary.acceptance)
      .filter(([, check]) => check.status === "fail")
      .map(([key]) => formatCriterionLabel(key))
      .join(", ");
    decisions.push(`Validation bloquée : corriger les critères ${failingLabels} avant diffusion.`);
  } else if (hasUnknown) {
    decisions.push(
      "Validation conditionnelle : compléter les artefacts manquants et confirmer manuellement les critères restants.",
    );
  } else {
    decisions.push("Validation recommandée : tous les critères suivis sont au vert.");
  }

  decisions.push(
    `Synthèse quantitative : ${summary.totals.documentsIngested} documents, ${summary.totals.events} événements, ${summary.totals.vectorUpserts} vector upserts.`,
  );

  return decisions;
}

/**
 * Présente un état par scénario (✅/⚠️/❌) pour refléter la complétion locale
 * des artefacts et faciliter la vérification des critères d'acceptation.
 */
function summariseScenarioAcceptance(
  scenarios: readonly ScenarioSnapshot[],
): readonly string[] {
  if (scenarios.length === 0) {
    return ["⚠️ Aucun scénario chargé – exécuter la préparation avant conclusion."];
  }

  return scenarios
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((scenario) => {
      const evaluation = evaluateScenarioReadiness(scenario);
      const symbol = evaluation.status === "pass" ? "✅" : evaluation.status === "fail" ? "❌" : "⚠️";
      return `${symbol} ${scenario.slug} : ${evaluation.details}`;
    });
}

/**
 * Analyse un scénario individuel pour déterminer s'il dispose des artefacts
 * nécessaires à une conclusion et produit un message synthétique.
 */
function evaluateScenarioReadiness(
  scenario: ScenarioSnapshot,
): { readonly status: AcceptanceStatus; readonly details: string } {
  const docs = scenario.documentsIngested ?? 0;
  const errors = sumErrorCounts(scenario.errorCounts);
  const hasTimings = scenario.timings !== undefined;
  const blockingNote = scenario.notes.find((note) => isBlockingNote(note));

  if (blockingNote) {
    return { status: "unknown", details: blockingNote };
  }

  if (!hasTimings) {
    return { status: "unknown", details: "timings.json manquant" };
  }

  if (docs === 0 && errors === 0) {
    return { status: "fail", details: "aucun document ni erreur classée" };
  }

  if (errors > docs && docs > 0) {
    return {
      status: "unknown",
      details: `${docs} documents pour ${errors} erreurs – confirmer la robustesse`,
    };
  }

  const parts: string[] = [`docs=${docs}`];
  if (errors > 0) {
    parts.push(`erreurs=${errors}`);
  }
  if (scenario.serverLogLines !== undefined) {
    parts.push(`log=${scenario.serverLogLines} lignes`);
  }
  return { status: "pass", details: parts.join(", ") };
}

/** Identifie les notes qui bloquent une conclusion automatique. */
function isBlockingNote(note: string): boolean {
  const lower = note.toLowerCase();
  return (
    lower.includes("timings.json") ||
    lower.includes("events.ndjson") ||
    lower.includes("vector_upserts") ||
    lower.includes("kg_changes")
  );
}

/** Supprime les doublons tout en conservant l'ordre d'apparition. */
function dedupeLines(lines: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (!seen.has(line)) {
      seen.add(line);
      result.push(line);
    }
  }
  return result;
}

/** Collects artefact metrics for a specific scenario. */
async function collectScenarioSnapshot(
  scenario: ValidationScenarioDefinition,
  layout: ValidationRunLayout,
): Promise<ScenarioSnapshot> {
  const run = await initialiseScenarioRun(scenario, { layout });
  const slug = formatScenarioSlug(scenario);
  const notes: string[] = [];

  const timingsResult = await readJsonFile<unknown>(run.timings);
  if (timingsResult.note) {
    notes.push(`timings.json: ${timingsResult.note}`);
  }
  const timingsValidation = normaliseTimingReport(timingsResult.data);
  if (timingsValidation.note) {
    notes.push(`timings.json: ${timingsValidation.note}`);
  }
  const timings = timingsValidation.timings;

  const errorsResult = await readJsonArrayFile<ScenarioErrorEntry>(run.errors);
  if (errorsResult.note) {
    notes.push(`errors.json: ${errorsResult.note}`);
  }
  const errorEntries = errorsResult.data ?? [];

  const errorCounts = aggregateErrorCounts(timings?.errors ?? {}, errorEntries);

  const eventsCount = await countNdjsonEntries(run.events, "events.ndjson", notes);
  const kgChangesCount = await countNdjsonEntries(run.kgChanges, "kg_changes.ndjson", notes);
  const vectorUpserts = await readJsonArrayFile<Record<string, unknown>>(run.vectorUpserts);
  if (vectorUpserts.note) {
    notes.push(`vector_upserts.json: ${vectorUpserts.note}`);
  }
  const vectorUpsertsCount = vectorUpserts.data?.length;

  const serverLogLines = await countLogLines(run.serverLog, notes);

  return {
    id: scenario.id,
    slug,
    label: scenario.label,
    description: scenario.description,
    timings,
    errorEntries,
    errorCounts,
    documentsIngested: timings?.documentsIngested,
    tookMs: timings?.tookMs,
    eventsCount,
    kgChangesCount,
    vectorUpsertsCount,
    serverLogLines,
    notes,
  };
}

/**
 * Aggregates totals across all scenario snapshots and derives the domain /
 * content-type distributions required by the checklist deliverables.
 */
async function computeTotals(
  snapshots: readonly ScenarioSnapshot[],
  layout: ValidationRunLayout,
): Promise<ValidationTotals> {
  const totals: ValidationTotals = {
    documentsIngested: 0,
    events: 0,
    kgChanges: 0,
    vectorUpserts: 0,
    errors: {},
    topDomains: [],
    contentTypes: [],
  };

  const domainCounters = new Map<string, number>();
  const contentTypeCounters = new Map<string, number>();
  let documentsCount = 0;

  for (const snapshot of snapshots) {
    totals.documentsIngested += snapshot.documentsIngested ?? 0;
    totals.events += snapshot.eventsCount ?? 0;
    totals.kgChanges += snapshot.kgChangesCount ?? 0;
    totals.vectorUpserts += snapshot.vectorUpsertsCount ?? 0;
    for (const [category, count] of Object.entries(snapshot.errorCounts)) {
      totals.errors[category] = (totals.errors[category] ?? 0) + count;
    }

    const documentsPath = path.join(
      layout.artifactsDir,
      snapshot.slug,
      "documents_summary.json",
    );
    const documents = await readJsonArrayFile<DocumentSummary>(documentsPath);
    if (!documents.data) {
      continue;
    }

    for (const entry of documents.data) {
      documentsCount += 1;
      const domain = extractDocumentDomain(entry.url);
      incrementCounter(domainCounters, domain);

      const mimeType = normaliseMimeTypeValue(entry.mimeType);
      incrementCounter(contentTypeCounters, mimeType);
    }
  }

  totals.topDomains = computeDistribution(domainCounters, documentsCount, (domain, count, percentage) => ({
    domain,
    count,
    percentage,
  }));

  totals.contentTypes = computeDistribution(
    contentTypeCounters,
    documentsCount,
    (mimeType, count, percentage) => ({
      mimeType,
      count,
      percentage,
    }),
  );

  return totals;
}

/** Extracts and normalises the domain associated with a document URL. */
function extractDocumentDomain(url: string | null | undefined): string {
  if (!url) {
    return "unknown";
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

/** Increments a counter stored in a map, initialising it when necessary. */
function incrementCounter(target: Map<string, number>, key: string): void {
  target.set(key, (target.get(key) ?? 0) + 1);
}

/** Normalises the MIME type captured for a document. */
function normaliseMimeTypeValue(mimeType: string | null | undefined): string {
  const value = (mimeType ?? "").trim().toLowerCase();
  return value.length > 0 ? value : "unknown";
}

/** Shape of the callback producing distribution entries. */
type DistributionFormatter<T> = (key: string, count: number, percentage: number) => T;

/**
 * Converts the provided counters to a sorted distribution limited to 10 entries.
 * Percentages are rounded to a single decimal so they remain readable in reports.
 */
function computeDistribution<T>(
  counters: Map<string, number>,
  total: number,
  formatter: DistributionFormatter<T>,
): readonly T[] {
  if (total === 0 || counters.size === 0) {
    return [];
  }

  const entries = [...counters.entries()];
  entries.sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return a[0].localeCompare(b[0]);
  });

  const limited = entries.slice(0, 10);
  return limited.map(([key, count]) => formatter(key, count, computePercentage(count, total)));
}

/** Computes a rounded percentage with a single decimal precision. */
function computePercentage(count: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return Math.round((count / total) * 1_000) / 10;
}

/** Formats the domain distribution for the markdown report. */
function formatDomainDistribution(entries: readonly DomainDistributionEntry[]): string {
  return entries
    .map((entry) => `${entry.domain} (${entry.percentage.toFixed(1)}%, ${entry.count})`)
    .join(" ; ");
}

/** Formats the content-type distribution for the markdown report. */
function formatContentTypeDistribution(
  entries: readonly ContentTypeDistributionEntry[],
): string {
  return entries
    .map((entry) => `${entry.mimeType} (${entry.percentage.toFixed(1)}%, ${entry.count})`)
    .join(" ; ");
}

/** Evaluates the acceptance criteria using the collected snapshots. */
async function evaluateAcceptance(
  snapshots: readonly ScenarioSnapshot[],
  layout: ValidationRunLayout,
): Promise<AcceptanceSummary> {
  return {
    functional: evaluateFunctional(snapshots),
    idempotence: await evaluateIdempotence(layout),
    extraction: await evaluateExtractionQuality(snapshots, layout),
    language: await evaluateLanguageDetection(snapshots, layout),
    ragQuality: await evaluateRagQuality(snapshots, layout),
    performance: evaluatePerformance(snapshots),
    robustness: evaluateRobustness(snapshots),
  };
}

/** Functional criterion: each scenario with timings must expose docs or errors. */
function evaluateFunctional(snapshots: readonly ScenarioSnapshot[]): AcceptanceCheck {
  const instrumented = snapshots.filter((snapshot) => snapshot.timings !== undefined);
  if (instrumented.length === 0) {
    return {
      status: "unknown",
      details: "Aucun timings.json n'a été collecté pour vérifier la complétion fonctionnelle.",
    };
  }

  const failing = instrumented.filter((snapshot) => {
    const docs = snapshot.documentsIngested ?? 0;
    const errors = sumErrorCounts(snapshot.errorCounts);
    return docs === 0 && errors === 0;
  });

  if (failing.length > 0) {
    return {
      status: "fail",
      details: "Absence de documents ou d'erreurs classées pour certains scénarios.",
      scenarios: failing.map((snapshot) => snapshot.slug),
    };
  }

  return {
    status: "pass",
    details: "Chaque scénario instrumenté expose des documents ingérés ou des erreurs classées.",
    scenarios: instrumented.map((snapshot) => snapshot.slug),
  };
}

/** Idempotence criterion: relies on the dedicated comparison helper. */
async function evaluateIdempotence(layout: ValidationRunLayout): Promise<AcceptanceCheck> {
  try {
    const comparison = await compareScenarioIdempotence({ layout });
    const baseSlug = formatScenarioSlug(comparison.base.scenario);
    const rerunSlug = formatScenarioSlug(comparison.rerun.scenario);
    const scenarios: readonly string[] = [baseSlug, rerunSlug];
    const noteSummary = comparison.notes.slice(0, 2).join(" ; ");

    if (comparison.status === "pass") {
      return {
        status: "pass",
        details:
          "Les docIds et événements doc_ingested sont identiques entre " +
          baseSlug +
          " et " +
          rerunSlug +
          ".",
        scenarios,
      };
    }

    if (comparison.status === "fail") {
      return {
        status: "fail",
        details:
          noteSummary ||
          ("Des divergences d'idempotence ont été détectées entre " +
            baseSlug +
            " et " +
            rerunSlug +
            "."),
        scenarios,
      };
    }

    return {
      status: "unknown",
      details:
        noteSummary ||
        ("Les artefacts nécessaires pour vérifier l'idempotence (" +
          baseSlug +
          " vs " +
          rerunSlug +
          ") sont incomplets."),
      scenarios,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unknown",
      details: "Vérification d'idempotence impossible : " + message + ".",
    };
  }
}

/** Extraction criterion: ensures ≥85% unique segments across vector chunks. */
async function evaluateExtractionQuality(
  snapshots: readonly ScenarioSnapshot[],
  layout: ValidationRunLayout,
): Promise<AcceptanceCheck> {
  const uniqueSegments = new Set<string>();
  let totalSegments = 0;
  let invalidEntries = 0;
  const scenariosWithData: string[] = [];
  const missingArtefacts: string[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.id === 10) {
      continue;
    }
    const slug = snapshot.slug;
    const vectorPath = path.join(layout.artifactsDir, slug, "vector_chunks.json");
    const vectors = await readJsonArrayFile<Record<string, unknown>>(vectorPath);
    if (!vectors.data) {
      if (vectors.note) {
        missingArtefacts.push(`${slug} (${vectors.note})`);
      }
      continue;
    }

    let scenarioSegments = 0;
    for (const entry of vectors.data) {
      const segmentIds = normaliseSegmentIds(entry);
      if (!segmentIds) {
        invalidEntries += 1;
        continue;
      }
      scenarioSegments += segmentIds.length;
      for (const segmentId of segmentIds) {
        uniqueSegments.add(segmentId);
      }
    }

    if (scenarioSegments > 0) {
      totalSegments += scenarioSegments;
      scenariosWithData.push(slug);
    }
  }

  if (totalSegments === 0) {
    const detailParts = [
      "Aucun segment n'a été trouvé dans les artefacts vectoriels pour évaluer le ratio.",
    ];
    if (missingArtefacts.length > 0) {
      detailParts.push(`Artefacts manquants: ${missingArtefacts.join(", ")}`);
    }
    return {
      status: "unknown",
      details: detailParts.join(" "),
    };
  }

  const ratio = uniqueSegments.size / totalSegments;
  const ratioPercent = (ratio * 100).toFixed(1);
  const detailParts = [
    `Segments uniques: ${ratioPercent}% (${uniqueSegments.size}/${totalSegments})`,
  ];
  if (missingArtefacts.length > 0) {
    detailParts.push(`Artefacts manquants: ${missingArtefacts.join(", ")}`);
  }
  if (invalidEntries > 0) {
    detailParts.push(`${invalidEntries} entrées ignorées (segmentIds manquants).`);
  }

  return {
    status: ratio >= 0.85 ? "pass" : "fail",
    details: detailParts.join(" ; "),
    scenarios: scenariosWithData,
  };
}

/** Language criterion: requires ≥90% recognised language codes across documents. */
async function evaluateLanguageDetection(
  snapshots: readonly ScenarioSnapshot[],
  layout: ValidationRunLayout,
): Promise<AcceptanceCheck> {
  let totalDocuments = 0;
  let recognisedDocuments = 0;
  let invalidEntries = 0;
  const languageCounters = new Map<string, number>();
  const scenariosWithData: string[] = [];
  const missingArtefacts: string[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.id === 10) {
      continue;
    }
    const slug = snapshot.slug;
    const documentsPath = path.join(layout.artifactsDir, slug, "documents_summary.json");
    const documents = await readJsonArrayFile<Record<string, unknown>>(documentsPath);
    if (!documents.data) {
      if (documents.note) {
        missingArtefacts.push(`${slug} (${documents.note})`);
      }
      continue;
    }

    let scenarioDocuments = 0;
    for (const entry of documents.data) {
      const language = normaliseLanguageCode(entry);
      if (language) {
        recognisedDocuments += 1;
        languageCounters.set(language, (languageCounters.get(language) ?? 0) + 1);
      } else {
        invalidEntries += 1;
      }
      scenarioDocuments += 1;
    }

    if (scenarioDocuments > 0) {
      totalDocuments += scenarioDocuments;
      scenariosWithData.push(slug);
    }
  }

  if (totalDocuments === 0) {
    const detailParts = [
      "Aucun document n'est disponible pour vérifier la détection de langue.",
    ];
    if (missingArtefacts.length > 0) {
      detailParts.push(`Artefacts manquants: ${missingArtefacts.join(", ")}`);
    }
    return {
      status: "unknown",
      details: detailParts.join(" "),
    };
  }

  const ratio = recognisedDocuments / totalDocuments;
  const ratioPercent = (ratio * 100).toFixed(1);
  const detailParts = [
    `Détections valides: ${ratioPercent}% (${recognisedDocuments}/${totalDocuments})`,
  ];
  if (languageCounters.size > 0) {
    detailParts.push(`Top langues: ${formatTopLanguages(languageCounters)}`);
  }
  if (missingArtefacts.length > 0) {
    detailParts.push(`Artefacts manquants: ${missingArtefacts.join(", ")}`);
  }
  if (invalidEntries > 0) {
    detailParts.push(`${invalidEntries} documents sans code langue normalisé.`);
  }

  return {
    status: ratio >= 0.9 ? "pass" : "fail",
    details: detailParts.join(" ; "),
    scenarios: scenariosWithData,
  };
}

/** RAG quality criterion: expects citations in scenario S10. */
async function evaluateRagQuality(
  snapshots: readonly ScenarioSnapshot[],
  layout: ValidationRunLayout,
): Promise<AcceptanceCheck> {
  const scenario = snapshots.find((entry) => entry.id === 10);
  if (!scenario) {
    return {
      status: "unknown",
      details: "Le scénario S10 est introuvable dans la configuration.",
    };
  }

  const definition = VALIDATION_SCENARIOS.find((entry) => entry.id === 10);
  if (!definition) {
    return {
      status: "unknown",
      details: "La définition du scénario S10 est introuvable.",
      scenarios: [scenario.slug],
    };
  }

  const run = await initialiseScenarioRun(definition, { layout });
  const responseResult = await readJsonFile<Record<string, unknown>>(run.response);
  if (responseResult.note || !responseResult.data) {
    return {
      status: "unknown",
      details: "response.json est manquant ou invalide pour S10.",
      scenarios: [scenario.slug],
    };
  }

  const response = responseResult.data;
  const citations = Array.isArray(response.citations) ? response.citations : [];
  if (citations.length === 0) {
    return {
      status: "fail",
      details: "La réponse S10 n'inclut aucune citation ingérée.",
      scenarios: [scenario.slug],
    };
  }

  return {
    status: "pass",
    details: "La réponse S10 cite les sources ingérées (≥1 citation).",
    scenarios: [scenario.slug],
  };
}

/** Performance criterion specific to scenario S09. */
function evaluatePerformance(snapshots: readonly ScenarioSnapshot[]): AcceptanceCheck {
  const scenario = snapshots.find((entry) => entry.id === 9);
  if (!scenario) {
    return {
      status: "unknown",
      details: "Le scénario S09 est introuvable dans la configuration.",
    };
  }
  if (!scenario.timings) {
    return {
      status: "unknown",
      details: "Les timings de S09 sont manquants pour évaluer la performance.",
      scenarios: [scenario.slug],
    };
  }

  const searxOk = scenario.timings.searxQuery.p95 < 3000;
  const extractOk = scenario.timings.extractWithUnstructured.p95 < 8000;
  const tookOk = (scenario.timings.tookMs ?? Number.POSITIVE_INFINITY) < 60000;

  const ok = searxOk && extractOk && tookOk;
  return {
    status: ok ? "pass" : "fail",
    details: ok
      ? "Les seuils de latence (p95) et la durée totale respectent les contraintes de S09."
      : "Les seuils de latence ou la durée totale dépassent les limites attendues.",
    scenarios: [scenario.slug],
  };
}

/** Robustness criterion: require classified errors when they exist. */
function evaluateRobustness(snapshots: readonly ScenarioSnapshot[]): AcceptanceCheck {
  const withErrors = snapshots.filter((snapshot) => snapshot.errorEntries.length > 0);
  if (withErrors.length === 0) {
    return {
      status: "unknown",
      details: "Aucune erreur capturée ; impossible de vérifier la robustesse.",
    };
  }
  const unclassified = withErrors.filter((snapshot) =>
    snapshot.errorEntries.some((entry) => !entry.category || entry.category.trim() === ""),
  );
  if (unclassified.length > 0) {
    return {
      status: "fail",
      details: "Certaines erreurs ne possèdent pas de catégorie normalisée.",
      scenarios: unclassified.map((snapshot) => snapshot.slug),
    };
  }
  return {
    status: "pass",
    details: "Toutes les erreurs présentes sont classées et non bloquantes.",
    scenarios: withErrors.map((snapshot) => snapshot.slug),
  };
}

/** Extracts and sanitises segment identifiers from a vector summary entry. */
function normaliseSegmentIds(entry: Record<string, unknown>): readonly string[] | null {
  const raw = entry.segmentIds;
  if (!Array.isArray(raw)) {
    return null;
  }

  const segments: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" || typeof value === "number") {
      const segment = String(value).trim();
      if (segment) {
        segments.push(segment);
      }
    }
  }

  return segments.length > 0 ? segments : null;
}

/** Normalises a language code extracted from `documents_summary.json`. */
function normaliseLanguageCode(entry: Record<string, unknown>): string | null {
  const raw = entry.language;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidate = trimmed.toLowerCase();
  const isValid = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/.test(candidate);
  return isValid ? candidate.replace(/_/g, "-") : null;
}

/** Formats the three most frequent language codes for inclusion in details. */
function formatTopLanguages(counters: Map<string, number>): string {
  return [...counters.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ");
}

/** Reads and parses a JSON file, returning a note when the file is missing. */
async function readJsonFile<T>(targetPath: string): Promise<{ data?: T; note?: string }> {
  try {
    const content = await readFile(targetPath, "utf8");
    if (!content.trim()) {
      return { note: "fichier vide" };
    }
    return { data: JSON.parse(content) as T };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { note: "fichier absent" };
    }
    return { note: `lecture impossible: ${(error as Error).message}` };
  }
}

/** Reads and parses a JSON array file, validating the payload. */
async function readJsonArrayFile<T>(targetPath: string): Promise<{ data?: readonly T[]; note?: string }> {
  const result = await readJsonFile<unknown>(targetPath);
  if (result.note || result.data === undefined) {
    return { note: result.note };
  }
  if (!Array.isArray(result.data)) {
    return { note: "format inattendu (attendu: tableau)" };
  }
  return { data: result.data as readonly T[] };
}

/** Valide la structure du rapport de timings exporté par scénario. */
function normaliseTimingReport(
  raw: unknown,
): { readonly timings?: ScenarioTimingReport; readonly note?: string } {
  if (raw === undefined) {
    return {};
  }
  if (typeof raw !== "object" || raw === null) {
    return { note: "format inattendu (attendu: objet)" };
  }

  const candidate = raw as Record<string, unknown>;
  const bucketNames: (keyof Omit<ScenarioTimingReport, "tookMs" | "documentsIngested" | "errors">)[] = [
    "searxQuery",
    "fetchUrl",
    "extractWithUnstructured",
    "ingestToGraph",
    "ingestToVector",
  ];
  const buckets: Partial<Record<string, ScenarioTimingBucket>> = {};
  for (const name of bucketNames) {
    const value = candidate[name as string];
    if (!isTimingBucket(value)) {
      return { note: `bucket ${name as string} incomplet` };
    }
    buckets[name as string] = value;
  }

  const tookMs = candidate.tookMs;
  if (typeof tookMs !== "number" || !Number.isFinite(tookMs)) {
    return { note: "champ tookMs manquant" };
  }
  const documentsIngested = candidate.documentsIngested;
  if (typeof documentsIngested !== "number" || documentsIngested < 0) {
    return { note: "champ documentsIngested manquant" };
  }

  const errorsValue = candidate.errors;
  const errors: Record<string, number> = {};
  if (errorsValue !== undefined) {
    if (typeof errorsValue !== "object" || errorsValue === null) {
      return { note: "champ errors invalide" };
    }
    for (const [key, value] of Object.entries(errorsValue)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { note: `compteur d'erreurs invalide pour ${key}` };
      }
      errors[key] = value;
    }
  }

  const timings: ScenarioTimingReport = {
    searxQuery: buckets.searxQuery!,
    fetchUrl: buckets.fetchUrl!,
    extractWithUnstructured: buckets.extractWithUnstructured!,
    ingestToGraph: buckets.ingestToGraph!,
    ingestToVector: buckets.ingestToVector!,
    tookMs,
    documentsIngested,
    errors,
  };

  return { timings };
}

/** Type guard verifying that an object matches {@link ScenarioTimingBucket}. */
function isTimingBucket(value: unknown): value is ScenarioTimingBucket {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const bucket = value as Record<string, unknown>;
  return (
    typeof bucket.p50 === "number" &&
    Number.isFinite(bucket.p50) &&
    typeof bucket.p95 === "number" &&
    Number.isFinite(bucket.p95) &&
    typeof bucket.p99 === "number" &&
    Number.isFinite(bucket.p99)
  );
}

/** Counts NDJSON lines, appending notes when the file is missing or empty. */
async function countNdjsonEntries(
  targetPath: string,
  label: string,
  notes: string[],
): Promise<number | undefined> {
  try {
    const content = await readFile(targetPath, "utf8");
    if (!content.trim()) {
      notes.push(`${label} vide`);
      return 0;
    }
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      notes.push(`${label} manquant`);
      return undefined;
    }
    notes.push(`${label} illisible: ${(error as Error).message}`);
    return undefined;
  }
}

/** Counts the number of meaningful log lines in server.log. */
async function countLogLines(targetPath: string, notes: string[]): Promise<number | undefined> {
  try {
    const content = await readFile(targetPath, "utf8");
    if (!content.trim()) {
      notes.push("server.log vide");
      return 0;
    }
    return content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      notes.push("server.log manquant");
      return undefined;
    }
    notes.push(`server.log illisible: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Merges the structured error counts from timings.json with the raw error
 * entries written to errors.json.
 */
function aggregateErrorCounts(
  baseCounts: Record<string, number>,
  entries: readonly ScenarioErrorEntry[],
): Record<string, number> {
  const counts: Record<string, number> = { ...baseCounts };
  for (const entry of entries) {
    if (!entry.category) {
      continue;
    }
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  }
  return counts;
}

/** Utility computing the sum of all error buckets. */
function sumErrorCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

/** Maps internal acceptance keys to human friendly labels. */
function formatCriterionLabel(key: string): string {
  switch (key) {
    case "functional":
      return "Fonctionnel";
    case "idempotence":
      return "Idempotence";
    case "extraction":
      return "Extraction";
    case "language":
      return "Langue";
    case "ragQuality":
      return "RAG";
    case "performance":
      return "Performance";
    case "robustness":
      return "Robustesse";
    default:
      return key;
  }
}

/** Formats acceptance statuses with emojis for readability. */
function formatAcceptanceStatus(status: AcceptanceStatus): string {
  switch (status) {
    case "pass":
      return "✅ OK";
    case "fail":
      return "❌ KO";
    default:
      return "❓ À vérifier";
  }
}
