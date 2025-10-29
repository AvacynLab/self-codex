import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { ensureValidationRunLayout, type ValidationRunLayout } from "./layout.js";
import {
  SCENARIO_ARTEFACT_FILENAMES,
  VALIDATION_SCENARIOS,
  formatScenarioSlug,
} from "./scenario.js";

/**
 * Set of artefact filenames that must exist for every scenario. The constant is
 * expanded from {@link SCENARIO_ARTEFACT_FILENAMES} to ease iteration.
 */
const REQUIRED_ARTEFACTS = Object.values(SCENARIO_ARTEFACT_FILENAMES);

/**
 * Timing buckets that should be recorded inside `timings.json`. They mirror the
 * structure enforced by {@link ScenarioTimingReport} in `artefacts.ts`.
 */
const TIMING_BUCKET_NAMES = [
  "searxQuery",
  "fetchUrl",
  "extractWithUnstructured",
  "ingestToGraph",
  "ingestToVector",
] as const;

/** Numeric fields required on the root of the timing report. */
const TIMING_SCALAR_FIELDS = ["tookMs", "documentsIngested"] as const;

/**
 * RegExp catalogue used to detect obvious credential leaks in artefacts.
 * Patterns intentionally focus on explicit tokens (e.g. `MCP_HTTP_TOKEN` or
 * literal "api key") to minimise false positives while still catching the
 * secrets listed in the checklist.
 */
const SECRET_PATTERNS: readonly { regexp: RegExp; description: string }[] = [
  { regexp: /\bMCP_[A-Z0-9_]*TOKEN\b/, description: "Variable MCP_*TOKEN exposée" },
  { regexp: /\bBearer\s+[A-Za-z0-9\-_.+/=]{16,}\b/, description: "Jeton Bearer en clair" },
  { regexp: /\bapi[-_]?key\b[\s:=]+[\w\-_.]{12,}/i, description: "API key potentielle" },
  { regexp: /\bsecret\b[\s:=]+['\"]?[\w\-_.]{8,}/i, description: "Secret assigné en clair" },
] as const;

/**
 * Report returned by {@link auditValidationRun}. It lists the per-scenario
 * findings as well as any potential secret exposure.
 */
export interface ValidationAuditReport {
  /** Layout resolved for the audit (useful for follow-up logging). */
  readonly layout: ValidationRunLayout;
  /** Findings grouped by scenario identifier. */
  readonly scenarios: readonly ScenarioAuditResult[];
  /** Potential secrets discovered while scanning artefacts. */
  readonly secretFindings: readonly SecretFinding[];
  /** Convenience flag that flips to `true` when any blocking issue is found. */
  readonly hasBlockingIssues: boolean;
}

/**
 * Granular outcome for a given scenario directory. Missing artefacts or invalid
 * timing metrics are surfaced via dedicated arrays to help the operator focus on
 * the remediation steps.
 */
export interface ScenarioAuditResult {
  /** Numeric identifier of the scenario (S01 → 1, ...). */
  readonly scenarioId: number;
  /** Canonical slug resolved from the scenario definition. */
  readonly slug: string;
  /** Absolute path to the scenario run directory. */
  readonly runPath: string;
  /** List of artefact filenames that could not be located. */
  readonly missingArtefacts: readonly string[];
  /** Human friendly messages describing issues with `timings.json`. */
  readonly timingIssues: readonly string[];
}

/**
 * Description of a potential secret identified in the artefacts. The snippet is
 * intentionally short so it can be logged without leaking the full secret.
 */
export interface SecretFinding {
  /** Absolute path to the file containing the suspicious string. */
  readonly file: string;
  /** 1-based line number indicating where the pattern was matched. */
  readonly line: number;
  /** Short message explaining the detection rule. */
  readonly description: string;
  /** Excerpt of the offending line to guide manual inspection. */
  readonly snippet: string;
}

/** Options accepted by {@link auditValidationRun}. */
export interface AuditValidationRunOptions {
  /** Optional pre-resolved layout. */
  readonly layout?: ValidationRunLayout;
  /** Optional root forwarded to {@link ensureValidationRunLayout}. */
  readonly baseRoot?: string;
  /**
   * When `false`, disables the secret scanning stage. Defaults to `true` to
   * honour the checklist requirement around `events.ndjson`, `server.log` and
   * `summary.json`.
   */
  readonly scanForSecrets?: boolean;
}

/**
 * Audits the current validation run folder by checking that each scenario
 * exposes the full artefact set, validates the timing schema and scans the
 * sensitive files for leaked credentials.
 */
export async function auditValidationRun(
  options: AuditValidationRunOptions = {},
): Promise<ValidationAuditReport> {
  const layout =
    options.layout ?? (await ensureValidationRunLayout(options.baseRoot));

  const scenarioReports: ScenarioAuditResult[] = [];
  for (const scenario of VALIDATION_SCENARIOS) {
    const slug = formatScenarioSlug(scenario);
    const runPath = path.join(layout.runsDir, slug);
    const missingArtefacts = await listMissingArtefacts(runPath);
    const timingIssues = await inspectTimingMetrics(runPath, missingArtefacts);

    scenarioReports.push({
      scenarioId: scenario.id,
      slug,
      runPath,
      missingArtefacts,
      timingIssues,
    });
  }

  const secretFindings = options.scanForSecrets === false
    ? []
    : await collectSecretFindings(layout, scenarioReports);

  const hasBlockingIssues =
    scenarioReports.some(
      (report) =>
        report.missingArtefacts.length > 0 || report.timingIssues.length > 0,
    ) || secretFindings.length > 0;

  return {
    layout,
    scenarios: scenarioReports,
    secretFindings,
    hasBlockingIssues,
  };
}

/**
 * Returns the list of artefact filenames that do not exist for the given run
 * directory. When the directory itself is missing, the sentinel value
 * `"<directory>"` is returned to guide the operator.
 */
async function listMissingArtefacts(runPath: string): Promise<string[]> {
  const missing: string[] = [];
  if (!(await exists(runPath))) {
    missing.push("<directory>");
    return missing;
  }

  for (const filename of REQUIRED_ARTEFACTS) {
    const artefactPath = path.join(runPath, filename);
    if (!(await exists(artefactPath))) {
      missing.push(filename);
    }
  }
  return missing;
}

/**
 * Validates the content of `timings.json`. The helper only performs the checks
 * when the artefact exists, otherwise missing files are surfaced elsewhere.
 */
async function inspectTimingMetrics(
  runPath: string,
  missingArtefacts: readonly string[],
): Promise<string[]> {
  if (missingArtefacts.includes("<directory>")) {
    return [];
  }
  if (missingArtefacts.includes(SCENARIO_ARTEFACT_FILENAMES.timings)) {
    return [];
  }

  const timingPath = path.join(runPath, SCENARIO_ARTEFACT_FILENAMES.timings);
  try {
    const raw = await readFile(timingPath, "utf8");
    const issues: string[] = [];
    let parsed: unknown;
    try {
      parsed = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      issues.push(`timings.json invalide: ${(error as Error).message}`);
      return issues;
    }

    if (typeof parsed !== "object" || parsed === null) {
      issues.push("timings.json doit contenir un objet JSON");
      return issues;
    }

    for (const scalar of TIMING_SCALAR_FIELDS) {
      if (!isFiniteNumber((parsed as Record<string, unknown>)[scalar])) {
        issues.push(`champ ${scalar} manquant ou non numérique`);
      }
    }

    for (const bucketName of TIMING_BUCKET_NAMES) {
      const bucket = (parsed as Record<string, unknown>)[bucketName];
      if (typeof bucket !== "object" || bucket === null) {
        issues.push(`bucket ${bucketName} manquant ou invalide`);
        continue;
      }
      const record = bucket as Record<string, unknown>;
      for (const percentile of ["p50", "p95", "p99"] as const) {
        if (!isFiniteNumber(record[percentile])) {
          issues.push(
            `bucket ${bucketName} → ${percentile} manquant ou non numérique`,
          );
        }
      }
    }

    const errorsField = (parsed as Record<string, unknown>).errors;
    if (!isPlainObject(errorsField)) {
      issues.push("champ errors doit être un objet clé → compteur");
    }

    return issues;
  } catch (error) {
    return [`lecture de timings.json échouée: ${(error as Error).message}`];
  }
}

/** Aggregates potential secret leaks across scenarios and final reports. */
async function collectSecretFindings(
  layout: ValidationRunLayout,
  scenarioReports: readonly ScenarioAuditResult[],
): Promise<SecretFinding[]> {
  const targets = new Set<string>();
  for (const report of scenarioReports) {
    if (!(await exists(report.runPath))) {
      continue;
    }
    targets.add(path.join(report.runPath, SCENARIO_ARTEFACT_FILENAMES.events));
    targets.add(path.join(report.runPath, SCENARIO_ARTEFACT_FILENAMES.serverLog));
  }
  targets.add(path.join(layout.reportsDir, "summary.json"));

  const findings: SecretFinding[] = [];
  for (const target of targets) {
    if (!(await exists(target))) {
      continue;
    }
    findings.push(...(await scanFileForSecrets(target)));
  }
  return findings;
}

/** Detects whether a value is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Checks that a value is a plain object (record). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lightweight existence check using read access semantics. */
async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scans a file line by line using {@link SECRET_PATTERNS}. The detection keeps a
 * short snippet (max 120 chars) to help the operator inspect without revealing
 * full credentials.
 */
async function scanFileForSecrets(filePath: string): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    findings.push({
      file: filePath,
      line: 0,
      description: `lecture impossible: ${(error as Error).message}`,
      snippet: "",
    });
    return findings;
  }

  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regexp.test(line)) {
        findings.push({
          file: filePath,
          line: index + 1,
          description: pattern.description,
          snippet: line.slice(0, 120),
        });
      }
    }
  });
  return findings;
}
