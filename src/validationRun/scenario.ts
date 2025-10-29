import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { ensureValidationRunLayout, type ValidationRunLayout } from "./layout.js";

/** Map of mandatory artefact filenames per scenario, mirroring the checklist. */
export const SCENARIO_ARTEFACT_FILENAMES = {
  input: "input.json",
  response: "response.json",
  events: "events.ndjson",
  timings: "timings.json",
  errors: "errors.json",
  kgChanges: "kg_changes.ndjson",
  vectorUpserts: "vector_upserts.json",
  serverLog: "server.log",
} as const satisfies Record<string, string>;

/**
 * Structured description of a validation scenario. Each entry contains the
 * canonical identifier, the human readable label, and the request payload to be
 * stored in `input.json` when bootstrapping the run directory.
 */
export interface ValidationScenarioDefinition {
  /** Numeric identifier used for ordering (S01, S02, ...). */
  readonly id: number;
  /** Human friendly title of the scenario (kept for reports). */
  readonly label: string;
  /** Optional slug hint overriding the label when generating folder names. */
  readonly slugHint?: string;
  /** JSON serialisable payload describing the MCP request. */
  readonly input: unknown;
  /** Short summary copied to documentation to ease navigation. */
  readonly description: string;
}

/**
 * Runtime representation of a scenario directory with resolved artefact paths.
 */
export interface ScenarioRunPaths {
  /** Absolute path to the per-scenario root folder. */
  readonly root: string;
  /** Absolute path to the scenario input payload (`input.json`). */
  readonly input: string;
  /** Absolute path to the orchestrator response (`response.json`). */
  readonly response: string;
  /** Absolute path to the event log stream (`events.ndjson`). */
  readonly events: string;
  /** Absolute path to per-step timing metrics (`timings.json`). */
  readonly timings: string;
  /** Absolute path to structured error taxonomy (`errors.json`). */
  readonly errors: string;
  /** Absolute path to KG update feed (`kg_changes.ndjson`). */
  readonly kgChanges: string;
  /** Absolute path to vector upsert summaries (`vector_upserts.json`). */
  readonly vectorUpserts: string;
  /** Absolute path to the trimmed server log excerpt (`server.log`). */
  readonly serverLog: string;
}

/** List of scenarios mandated by the validation playbook (section 4). */
export const VALIDATION_SCENARIOS: readonly ValidationScenarioDefinition[] = [
  {
    id: 1,
    label: "PDF scientifique",
    slugHint: "pdf_science",
    description: "Recherche ciblée de PDF scientifiques sur arXiv (S01).",
    input: {
      query: "site:arxiv.org multimodal LLM evaluation 2025 filetype:pdf",
      categories: ["files", "general"],
      maxResults: 4,
      fetchContent: true,
      injectGraph: true,
      injectVector: true,
    },
  },
  {
    id: 2,
    label: "HTML long + images",
    description: "Contenu HTML riche avec images pour valider l'extraction (S02).",
    input: {
      query: "site:towardsdatascience.com RAG evaluation metrics",
      categories: ["general", "images"],
      maxResults: 6,
    },
  },
  {
    id: 3,
    label: "Actualités (fraîcheur)",
    description: "Suivi de l'actualité récente pour tester la fraîcheur (S03).",
    input: {
      query: "actualité LLM Europe 2025",
      categories: ["news", "general"],
      maxResults: 5,
    },
  },
  {
    id: 4,
    label: "Multilingue (FR/EN)",
    description: "Comparaison FR/EN sur ACL Anthology pour la couverture multilingue (S04).",
    input: {
      query: "évaluation RAG comparaison méthodes site:aclanthology.org",
      categories: ["files", "general"],
      maxResults: 4,
    },
  },
  {
    id: 5,
    label: "Idempotence (rejouer S01)",
    slugHint: "idempotence",
    description: "Double exécution de S01 pour vérifier l'idempotence (S05).",
    input: {
      query: "site:arxiv.org multimodal LLM evaluation 2025 filetype:pdf",
      categories: ["files", "general"],
      maxResults: 4,
      fetchContent: true,
      injectGraph: true,
      injectVector: true,
    },
  },
  {
    id: 6,
    label: "robots & taille max",
    slugHint: "robots_taille_max",
    description: "Test de respect des robots.txt et limites de taille (S06).",
    input: {
      query: "dataset large download pdf",
      categories: ["files"],
      maxResults: 6,
    },
  },
  {
    id: 7,
    label: "Sources instables (5xx/timeout)",
    slugHint: "sources_instables",
    description: "Gestion des sources sujettes aux erreurs 5xx ou timeouts (S07).",
    input: {
      query: "site:example.com unavailable test",
      categories: ["general"],
      maxResults: 3,
    },
  },
  {
    id: 8,
    label: "Indexation directe (sans Searx)",
    slugHint: "indexation_directe",
    description: "Ingestion directe d'URLs pour bypasser Searx (S08).",
    input: {
      url: [
        "https://arxiv.org/pdf/2407.12345.pdf",
        "https://research.facebook.com/publications/...",
      ],
      injectGraph: true,
      injectVector: true,
    },
  },
  {
    id: 9,
    label: "Charge modérée (K=12)",
    slugHint: "charge_moderee",
    description: "Charge accrue avec 12 résultats pour mesurer les performances (S09).",
    input: {
      query: "graph-based rag knowledge graphs 2025",
      categories: ["general", "files", "images"],
      maxResults: 12,
    },
  },
  {
    id: 10,
    label: "Qualité RAG (sanity)",
    slugHint: "qualite_rag",
    description: "Validation qualitative du RAG sans web avec citations (S10).",
    input: {
      query: "Synthétise les points clés du dernier rapport RAG ingéré",
      categories: [],
      maxResults: 0,
      injectGraph: true,
      injectVector: true,
    },
  },
] as const;

/** Options controlling how scenario run folders are initialised. */
export interface InitialiseScenarioOptions {
  /** Optional layout (skips re-computing the root directory). */
  readonly layout?: ValidationRunLayout;
  /** Optional base root forwarded to {@link ensureValidationRunLayout}. */
  readonly baseRoot?: string;
  /**
   * When `true`, overwrites `input.json` even if it already exists. Useful for
   * refreshing scenarios after updating the canonical payload.
   */
  readonly overwriteInput?: boolean;
  /** Optional override for the folder slug (used for reruns/iterations). */
  readonly slugOverride?: string;
}

/**
 * Creates (if necessary) the per-scenario folder and ensures every artefact file
 * exists. The helper pre-populates `input.json` with the canonical payload and
 * leaves placeholders for the remaining files so operators immediately know what
 * to fill in during the validation run.
 */
export async function initialiseScenarioRun(
  scenario: ValidationScenarioDefinition,
  options: InitialiseScenarioOptions = {},
): Promise<ScenarioRunPaths> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const slug = options.slugOverride ?? formatScenarioSlug(scenario);
  const root = path.join(layout.runsDir, slug);
  await mkdir(root, { recursive: true });

  const artefactPaths: ScenarioRunPaths = {
    root,
    input: path.join(root, SCENARIO_ARTEFACT_FILENAMES.input),
    response: path.join(root, SCENARIO_ARTEFACT_FILENAMES.response),
    events: path.join(root, SCENARIO_ARTEFACT_FILENAMES.events),
    timings: path.join(root, SCENARIO_ARTEFACT_FILENAMES.timings),
    errors: path.join(root, SCENARIO_ARTEFACT_FILENAMES.errors),
    kgChanges: path.join(root, SCENARIO_ARTEFACT_FILENAMES.kgChanges),
    vectorUpserts: path.join(root, SCENARIO_ARTEFACT_FILENAMES.vectorUpserts),
    serverLog: path.join(root, SCENARIO_ARTEFACT_FILENAMES.serverLog),
  };

  await ensureInputFile(artefactPaths.input, scenario.input, options.overwriteInput ?? false);
  await Promise.all([
    ensurePlaceholderFile(artefactPaths.response, "{}\n"),
    ensurePlaceholderFile(artefactPaths.events, ""),
    ensurePlaceholderFile(artefactPaths.timings, "{}\n"),
    ensurePlaceholderFile(artefactPaths.errors, "[]\n"),
    ensurePlaceholderFile(artefactPaths.kgChanges, ""),
    ensurePlaceholderFile(artefactPaths.vectorUpserts, "[]\n"),
    ensurePlaceholderFile(artefactPaths.serverLog, ""),
  ]);

  return artefactPaths;
}

/**
 * Convenience helper that prepares every scenario listed in
 * {@link VALIDATION_SCENARIOS}. The function resolves once all folders have been
 * initialised and returns their respective paths for optional logging.
 */
export async function initialiseAllScenarios(
  options: InitialiseScenarioOptions = {},
): Promise<readonly ScenarioRunPaths[]> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const runs: ScenarioRunPaths[] = [];
  for (const scenario of VALIDATION_SCENARIOS) {
    runs.push(await initialiseScenarioRun(scenario, { ...options, layout }));
  }
  return runs;
}

/**
 * Options accepted when preparing a rerun directory. The helper inherits all
 * {@link InitialiseScenarioOptions} knobs while allowing operators to specify
 * a custom iteration label.
 */
export interface InitialiseScenarioRerunOptions
  extends Omit<InitialiseScenarioOptions, "slugOverride"> {
  /**
   * Optional human friendly label describing the rerun (e.g. `hotfix_1`). The
   * value is sanitised to remain filesystem safe. When omitted the helper will
   * create `rerun1`, `rerun2`, ... depending on the existing folders.
   */
  readonly iteration?: string;
}

/**
 * Prepares a rerun directory for the provided scenario identifier. The
 * resulting structure mirrors the canonical run but appends the iteration
 * suffix (`S0X_slug_rerun1`) to keep remediation attempts neatly separated.
 */
export async function initialiseScenarioRerun(
  scenarioRef: number | ValidationScenarioDefinition,
  options: InitialiseScenarioRerunOptions = {},
): Promise<ScenarioRunPaths> {
  const scenario =
    typeof scenarioRef === "number" ? resolveScenarioById(scenarioRef) : scenarioRef;
  const { iteration, ...baseOptions } = options;
  const layout = baseOptions.layout ?? (await ensureValidationRunLayout(baseOptions.baseRoot));
  const baseSlug = formatScenarioSlug(scenario);
  const iterationSegment = iteration
    ? normaliseIterationLabel(iteration)
    : await computeNextRerunSegment(layout.runsDir, baseSlug);
  const slugOverride = `${baseSlug}_${iterationSegment}`;

  return initialiseScenarioRun(scenario, { ...baseOptions, layout, slugOverride });
}

/**
 * Formats a rerun slug by appending a sanitised iteration label to the base
 * scenario slug. Useful for documentation and tooling that need to reference a
 * specific remediation attempt.
 */
export function formatScenarioIterationSlug(
  scenario: Pick<ValidationScenarioDefinition, "id" | "label" | "slugHint">,
  iteration: string,
): string {
  const baseSlug = formatScenarioSlug(scenario);
  const iterationSegment = normaliseIterationLabel(iteration);
  return `${baseSlug}_${iterationSegment}`;
}

/**
 * Generates the canonical folder slug (e.g. `S01_pdf_science`) from the scenario
 * identifier and label. Diacritics are stripped and whitespace is converted to
 * underscores to keep the paths portable across filesystems.
 */
export function formatScenarioSlug(scenario: Pick<ValidationScenarioDefinition, "id" | "label" | "slugHint">): string {
  if (!Number.isInteger(scenario.id) || scenario.id <= 0) {
    throw new Error(`invalid scenario id: ${scenario.id}`);
  }

  const paddedId = scenario.id.toString().padStart(2, "0");
  const base = scenario.slugHint ?? scenario.label;
  const normalised = base
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  const suffix = normalised ? `_${normalised}` : "";
  return `S${paddedId}${suffix}`;
}

/** Resolves a scenario definition from the canonical list by identifier. */
export function resolveScenarioById(id: number): ValidationScenarioDefinition {
  const scenario = VALIDATION_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Unknown validation scenario id: ${id}`);
  }
  return scenario;
}

/** Normalises a free-form iteration label into a filesystem safe slug. */
function normaliseIterationLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new Error("iteration label cannot be empty");
  }
  const normalised = trimmed
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
  if (!normalised) {
    throw new Error(`unable to normalise iteration label: ${label}`);
  }
  return normalised;
}

/**
 * Determines the next available rerun suffix (`rerun1`, `rerun2`, ...) by
 * scanning the existing scenario folders on disk.
 */
async function computeNextRerunSegment(runsDir: string, baseSlug: string): Promise<string> {
  let highestIndex = 0;
  const prefix = `${baseSlug}_rerun`;
  const entries = await readRunDirectories(runsDir);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith(prefix)) {
      continue;
    }
    const match = entry.name.slice(prefix.length).match(/^(\d+)$/);
    if (!match) {
      continue;
    }
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value)) {
      highestIndex = Math.max(highestIndex, value);
    }
  }
  return `rerun${highestIndex + 1}`;
}

/** Safely reads the runs directory, returning an empty list on errors. */
async function readRunDirectories(
  runsDir: string,
): Promise<readonly import("node:fs").Dirent[]> {
  try {
    return await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Ensures the input payload is materialised on disk, optionally overwriting it. */
async function ensureInputFile(targetPath: string, payload: unknown, overwrite: boolean): Promise<void> {
  if (!overwrite && (await exists(targetPath))) {
    return;
  }
  const serialised = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(targetPath, serialised, { encoding: "utf8" });
}

/** Writes an empty placeholder file only when it does not exist yet. */
async function ensurePlaceholderFile(targetPath: string, defaultContent: string): Promise<void> {
  if (await exists(targetPath)) {
    return;
  }
  await writeFile(targetPath, defaultContent, { encoding: "utf8" });
}

/** Checks whether a file is present and readable. */
async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}
