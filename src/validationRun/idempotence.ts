import { readFile } from "node:fs/promises";

import { ensureValidationRunLayout, type ValidationRunLayout } from "./layout.js";
import {
  formatScenarioSlug,
  initialiseScenarioRun,
  resolveScenarioById,
  type ScenarioRunPaths,
  type ValidationScenarioDefinition,
} from "./scenario.js";

/** Possible verdicts returned when comparing two scenario executions. */
export type IdempotenceStatus = "pass" | "fail" | "unknown";

/**
 * Options accepted when comparing two scenario executions for idempotence.
 * The helper defaults to the canonical S01 (base) and S05 (rerun) scenarios
 * but supports arbitrary identifiers so reruns can be assessed as well.
 */
export interface CompareScenarioIdempotenceOptions {
  /** Scenario identifier considered the source of truth (defaults to S01). */
  readonly baseScenarioId?: number;
  /** Scenario identifier representing the rerun under scrutiny (defaults to S05). */
  readonly rerunScenarioId?: number;
  /** Optional precomputed layout, forwarded to {@link initialiseScenarioRun}. */
  readonly layout?: ValidationRunLayout;
  /** Optional base directory forwarded to {@link ensureValidationRunLayout}. */
  readonly baseRoot?: string;
}

/**
 * Diff produced while comparing the identifiers extracted from the base and
 * rerun scenarios. Each set is deduplicated before computing the symmetric
 * difference so duplicate entries are handled separately.
 */
export interface IdempotenceDiff {
  /** Identifiers present in the base scenario but missing from the rerun. */
  readonly baseOnly: readonly string[];
  /** Identifiers present in the rerun but absent from the base scenario. */
  readonly rerunOnly: readonly string[];
  /** Identifiers shared by both scenarios. */
  readonly shared: readonly string[];
}

/**
 * Snapshot of the artefacts relevant to the idempotence comparison for a single
 * scenario. The structure highlights missing inputs so callers can surface
 * actionable remediation guidance.
 */
export interface ScenarioIdempotenceSnapshot {
  readonly scenario: ValidationScenarioDefinition;
  readonly runPaths: ScenarioRunPaths;
  readonly documentIds: readonly string[] | null;
  readonly documentDuplicates: readonly string[];
  readonly eventDocIds: readonly string[] | null;
  readonly eventDuplicates: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Result returned when comparing the canonical S01 and S05 executions. The
 * report powers both the CLI (`validation:idempotence`) and the acceptance
 * checks surfaced in the aggregated validation report.
 */
export interface ScenarioIdempotenceComparison {
  readonly base: ScenarioIdempotenceSnapshot;
  readonly rerun: ScenarioIdempotenceSnapshot;
  readonly documentDiff: IdempotenceDiff;
  readonly eventDiff: IdempotenceDiff;
  readonly status: IdempotenceStatus;
  readonly notes: readonly string[];
}

/**
 * Compares the artefacts collected for two scenarios (defaults to S01 vs S05)
 * and evaluates whether the rerun introduced duplicate document ingestions or
 * diverging event streams. The helper remains defensive: whenever a required
 * artefact is missing or unreadable the verdict falls back to `"unknown"` so
 * operators are nudged to populate the data set first.
 */
export async function compareScenarioIdempotence(
  options: CompareScenarioIdempotenceOptions = {},
): Promise<ScenarioIdempotenceComparison> {
  const baseScenario = resolveScenarioById(options.baseScenarioId ?? 1);
  const rerunScenario = resolveScenarioById(options.rerunScenarioId ?? 5);

  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const baseRun = await loadScenarioSnapshot(baseScenario, layout);
  const rerunRun = await loadScenarioSnapshot(rerunScenario, layout);

  const documentDiff = computeDiff(baseRun.documentIds, rerunRun.documentIds);
  const eventDiff = computeDiff(baseRun.eventDocIds, rerunRun.eventDocIds);

  const blockingNotes: string[] = [];
  let status: IdempotenceStatus = "pass";

  const hasDocumentData = baseRun.documentIds !== null && rerunRun.documentIds !== null;
  const hasEventData = baseRun.eventDocIds !== null && rerunRun.eventDocIds !== null;

  if (!hasDocumentData) {
    status = "unknown";
    blockingNotes.push("Données documents indisponibles pour l'une des exécutions.");
  } else if (baseRun.documentDuplicates.length > 0 || rerunRun.documentDuplicates.length > 0) {
    status = "fail";
    blockingNotes.push("DocIds dupliqués détectés dans les artefacts.");
  } else if (documentDiff.baseOnly.length > 0 || documentDiff.rerunOnly.length > 0) {
    status = "fail";
    blockingNotes.push("Les docIds diffèrent entre S01 et la ré-exécution.");
  }

  if (!hasEventData) {
    if (status === "pass") {
      status = "unknown";
    }
    blockingNotes.push("Les événements `search:doc_ingested` sont incomplets ou manquants.");
  } else if (baseRun.eventDuplicates.length > 0 || rerunRun.eventDuplicates.length > 0) {
    status = "fail";
    blockingNotes.push("Des événements `search:doc_ingested` contiennent des docIds dupliqués.");
  } else if (hasDocumentData && (eventDiff.baseOnly.length > 0 || eventDiff.rerunOnly.length > 0)) {
    status = "fail";
    blockingNotes.push("Les événements `search:doc_ingested` ne correspondent pas entre les scénarios.");
  }

  const mergedNotes = dedupeNotes([
    ...baseRun.notes,
    ...rerunRun.notes,
    ...blockingNotes,
    describeDiff("documents", documentDiff, baseScenario, rerunScenario),
    describeDiff("événements", eventDiff, baseScenario, rerunScenario),
  ]);

  return {
    base: baseRun,
    rerun: rerunRun,
    documentDiff,
    eventDiff,
    status,
    notes: mergedNotes.filter((note) => note.length > 0),
  };
}

/**
 * Loads the artefacts required to verify idempotence for the provided scenario.
 * When a file is missing or unreadable the snapshot records the issue in the
 * notes array so higher level tooling can surface actionable guidance.
 */
async function loadScenarioSnapshot(
  scenario: ValidationScenarioDefinition,
  layout: ValidationRunLayout,
): Promise<ScenarioIdempotenceSnapshot> {
  const runPaths = await initialiseScenarioRun(scenario, { layout });
  const notes: string[] = [];

  const response = await readJsonFile(runPaths.response, "response.json", notes);
  const documentIds = response ? extractDocumentIds(response, notes) : null;
  const documentDuplicates = documentIds ? findDuplicates(documentIds) : [];

  const events = await readNdjsonFile(runPaths.events, "events.ndjson", notes);
  const eventDocIds = events ? extractEventDocIds(events, notes) : null;
  const eventDuplicates = eventDocIds ? findDuplicates(eventDocIds) : [];

  return {
    scenario,
    runPaths,
    documentIds,
    documentDuplicates,
    eventDocIds,
    eventDuplicates,
    notes,
  };
}

/** Reads and parses a JSON file, annotating `notes` when the content is invalid. */
async function readJsonFile(
  targetPath: string,
  label: string,
  notes: string[],
): Promise<unknown | null> {
  try {
    const content = await readFile(targetPath, "utf8");
    if (!content.trim()) {
      notes.push(`${label} vide`);
      return null;
    }
    try {
      return JSON.parse(content);
    } catch (error) {
      notes.push(`${label} invalide: ${(error as Error).message}`);
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      notes.push(`${label} manquant`);
      return null;
    }
    notes.push(`${label} illisible: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Reads and parses an NDJSON file into a list of plain objects. Lines that fail
 * to parse are skipped but noted so operators can inspect the artefact.
 */
async function readNdjsonFile(
  targetPath: string,
  label: string,
  notes: string[],
): Promise<readonly Record<string, unknown>[] | null> {
  try {
    const content = await readFile(targetPath, "utf8");
    if (!content.trim()) {
      notes.push(`${label} vide`);
      return [];
    }
    const entries: Record<string, unknown>[] = [];
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") {
          entries.push(parsed as Record<string, unknown>);
        } else {
          notes.push(`${label} ligne ${index + 1}: contenu ignoré (structure inattendue)`);
        }
      } catch (error) {
        notes.push(`${label} ligne ${index + 1}: JSON invalide (${(error as Error).message})`);
      }
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      notes.push(`${label} manquant`);
      return null;
    }
    notes.push(`${label} illisible: ${(error as Error).message}`);
    return null;
  }
}

/** Extracts document identifiers from `response.json`, appending notes if missing. */
function extractDocumentIds(response: unknown, notes: string[]): readonly string[] | null {
  if (!response || typeof response !== "object") {
    notes.push("response.json: structure inattendue");
    return null;
  }

  const documents = (response as Record<string, unknown>).documents;
  if (!Array.isArray(documents)) {
    notes.push("response.json: propriété `documents` absente ou invalide");
    return null;
  }

  const ids: string[] = [];
  documents.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      notes.push(`response.json: documents[${index}] ignoré (structure inattendue)`);
      return;
    }
    const id = (entry as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim().length > 0) {
      ids.push(id);
    } else {
      notes.push(`response.json: documents[${index}] sans docId`);
    }
  });

  return ids;
}

/**
 * Extracts the `doc_id` field from each `search:doc_ingested` event. When a
 * docId is missing the line is skipped and annotated so operators can inspect
 * the underlying event payload.
 */
function extractEventDocIds(
  events: readonly Record<string, unknown>[],
  notes: string[],
): readonly string[] | null {
  const docIds: string[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }
    const kind = event.kind;
    if (kind !== "search:doc_ingested") {
      continue;
    }
    const payload = (event as Record<string, unknown>).payload;
    if (!payload || typeof payload !== "object") {
      notes.push("events.ndjson: événement doc_ingested sans payload structuré");
      continue;
    }
    const docId = (payload as Record<string, unknown>).doc_id;
    if (typeof docId === "string" && docId.trim().length > 0) {
      docIds.push(docId);
    } else {
      notes.push("events.ndjson: événement doc_ingested sans doc_id");
    }
  }

  if (docIds.length === 0) {
    notes.push("events.ndjson: aucun événement doc_ingested trouvé");
  }

  return docIds;
}

/** Computes duplicates by retaining identifiers that appear more than once. */
function findDuplicates(ids: readonly string[]): readonly string[] {
  const counts = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    const count = counts.get(id) ?? 0;
    counts.set(id, count + 1);
    if (count >= 1) {
      duplicates.add(id);
    }
  }
  return [...duplicates].sort();
}

/** Computes the symmetric difference between the base and rerun identifier sets. */
function computeDiff(
  base: readonly string[] | null,
  rerun: readonly string[] | null,
): IdempotenceDiff {
  if (!base || !rerun) {
    return { baseOnly: [], rerunOnly: [], shared: [] };
  }

  const baseSet = new Set(base);
  const rerunSet = new Set(rerun);

  const shared: string[] = [];
  const baseOnly: string[] = [];
  const rerunOnly: string[] = [];

  for (const id of baseSet) {
    if (rerunSet.has(id)) {
      shared.push(id);
    } else {
      baseOnly.push(id);
    }
  }
  for (const id of rerunSet) {
    if (!baseSet.has(id)) {
      rerunOnly.push(id);
    }
  }

  shared.sort();
  baseOnly.sort();
  rerunOnly.sort();

  return { baseOnly, rerunOnly, shared };
}

/** Deduplicates and sanitises the note list before exposing it to callers. */
function dedupeNotes(notes: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const note of notes) {
    if (!note || !note.trim()) {
      continue;
    }
    if (seen.has(note)) {
      continue;
    }
    seen.add(note);
    result.push(note);
  }
  return result;
}

/**
 * Formats a short diff summary so operators can see how the two executions
 * diverge. The helper returns an empty string when both sides match.
 */
function describeDiff(
  label: string,
  diff: IdempotenceDiff,
  baseScenario: ValidationScenarioDefinition,
  rerunScenario: ValidationScenarioDefinition,
): string | undefined {
  if (diff.baseOnly.length === 0 && diff.rerunOnly.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  if (diff.baseOnly.length > 0) {
    parts.push(
      `${formatScenarioSlug(baseScenario)} uniquement: ${diff.baseOnly.join(", ")}`,
    );
  }
  if (diff.rerunOnly.length > 0) {
    parts.push(
      `${formatScenarioSlug(rerunScenario)} uniquement: ${diff.rerunOnly.join(", ")}`,
    );
  }
  return `Différence ${label}: ${parts.join(" | ")}`;
}
