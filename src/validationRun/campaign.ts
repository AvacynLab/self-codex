import {
  captureValidationSnapshots,
  type CaptureValidationSnapshotsOptions,
  type ValidationSnapshotPaths,
} from "./snapshots.js";
import {
  runValidationBuild,
  type RunValidationBuildOptions,
  type ValidationBuildResult,
} from "./build.js";
import {
  ensureValidationRuntime,
  type EnsureValidationRuntimeOptions,
  type ValidationRuntimeContext,
} from "./runtime.js";
import {
  executeSearchScenario,
  type ExecuteSearchScenarioOptions,
  type ExecuteSearchScenarioResult,
  type SearchScenarioDependencyOverrides,
} from "./execution.js";
import {
  writeValidationReport,
  type GenerateValidationSummaryOptions,
  type PersistedValidationReport,
} from "./reports.js";
import {
  compareScenarioIdempotence,
  type CompareScenarioIdempotenceOptions,
  type ScenarioIdempotenceComparison,
} from "./idempotence.js";
import {
  auditValidationRun,
  type AuditValidationRunOptions,
  type ValidationAuditReport,
} from "./audit.js";
import {
  writeRemediationPlan,
  type GenerateRemediationPlanOptions,
  type PersistedRemediationPlan,
} from "./remediation.js";
import {
  ensureValidationRunLayout,
  type ValidationRunLayout,
} from "./layout.js";
import {
  VALIDATION_SCENARIOS,
  formatScenarioSlug,
  resolveScenarioById,
  type ValidationScenarioDefinition,
} from "./scenario.js";

/**
 * Internal helper describing the optional hooks used by {@link runValidationCampaign}.
 * Tests inject these hooks to capture the orchestration flow without touching the
 * real network or filesystem.
 */
export interface ValidationCampaignHooks {
  readonly captureSnapshots?: (options: CaptureValidationSnapshotsOptions) => Promise<ValidationSnapshotPaths>;
  readonly runBuild?: (options: RunValidationBuildOptions) => Promise<ValidationBuildResult>;
  readonly ensureRuntime?: (options: EnsureValidationRuntimeOptions) => Promise<ValidationRuntimeContext>;
  readonly executeScenario?: (options: ExecuteSearchScenarioOptions) => Promise<ExecuteSearchScenarioResult>;
  readonly writeReport?: (options: GenerateValidationSummaryOptions) => Promise<PersistedValidationReport>;
  readonly compareIdempotence?: (options: CompareScenarioIdempotenceOptions) => Promise<ScenarioIdempotenceComparison>;
  readonly audit?: (options: AuditValidationRunOptions) => Promise<ValidationAuditReport>;
  readonly writeRemediationPlan?: (options: GenerateRemediationPlanOptions) => Promise<PersistedRemediationPlan>;
}

/**
 * Options accepted by {@link runValidationCampaign}. Each flag mirrors a section of
 * the validation checklist so operators can pick a subset of steps when iterating
 * on a remediation.
 */
export interface ValidationCampaignOptions {
  /** Optional override for the validation root (defaults to `validation_run/`). */
  readonly baseRoot?: string;
  /** Pre-resolved layout injected by tests or advanced callers. */
  readonly layout?: ValidationRunLayout;
  /** Subset of scenarios to run, defaults to all entries in {@link VALIDATION_SCENARIOS}. */
  readonly scenarioIds?: readonly number[];
  /** When false, skips the snapshot capture stage. */
  readonly captureSnapshots?: boolean;
  /** When false, skips the `npm ci` + `npm run build` stage. */
  readonly runBuild?: boolean;
  /** When false, skips the runtime directory preparation. */
  readonly ensureRuntime?: boolean;
  /** When false, skips the JSON/Markdown report generation. */
  readonly generateReport?: boolean;
  /** When false, skips the S01/S05 idempotence comparison. */
  readonly runIdempotence?: boolean;
  /** When false, skips the artefact audit. */
  readonly runAudit?: boolean;
  /** When false, skips the remediation plan generation. */
  readonly runRemediation?: boolean;
  /** Controls whether scenario artefacts under `validation_run/artifacts/` are persisted. */
  readonly persistArtifacts?: boolean;
  /** When true, stops executing additional scenarios after the first failure. */
  readonly stopOnScenarioFailure?: boolean;
  /** Optional prefix injected in the job identifier for each scenario run. */
  readonly scenarioJobIdPrefix?: string;
  /** Dependency overrides forwarded to {@link executeSearchScenario}. */
  readonly scenarioOverrides?: SearchScenarioDependencyOverrides;
  /** Optional knob ensuring the `children/` directory exists. */
  readonly createChildrenDir?: boolean;
  /** Additional options forwarded to {@link captureValidationSnapshots}. */
  readonly snapshotOptions?: Omit<CaptureValidationSnapshotsOptions, "layout" | "baseRoot">;
  /** Additional options forwarded to {@link runValidationBuild}. */
  readonly buildOptions?: Omit<RunValidationBuildOptions, "root">;
  /** Additional options forwarded to {@link ensureValidationRuntime}. */
  readonly runtimeOptions?: Omit<EnsureValidationRuntimeOptions, "root">;
  /** Additional options forwarded to {@link writeValidationReport}. */
  readonly reportOptions?: Omit<GenerateValidationSummaryOptions, "layout" | "baseRoot">;
  /** Additional options forwarded to {@link compareScenarioIdempotence}. */
  readonly idempotenceOptions?: Omit<CompareScenarioIdempotenceOptions, "layout" | "baseRoot">;
  /** Additional options forwarded to {@link auditValidationRun}. */
  readonly auditOptions?: Omit<AuditValidationRunOptions, "layout" | "baseRoot">;
  /** Additional options forwarded to {@link writeRemediationPlan}. */
  readonly remediationOptions?: Omit<GenerateRemediationPlanOptions, "layout" | "baseRoot">;
  /**
   * Internal hooks primarily used by the unit suite. Real executions rely on the
   * concrete implementations exported by the validation modules.
   */
  readonly hooks?: ValidationCampaignHooks;
}

/** Result returned for each orchestrated step (snapshots, build, audit, ...). */
export interface ValidationCampaignStepResult<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly error?: string;
}

/** Specialisation of {@link ValidationCampaignStepResult} for scenario executions. */
export interface ValidationCampaignScenarioResult extends ValidationCampaignStepResult<ExecuteSearchScenarioResult> {
  readonly scenarioId: number;
  readonly slug: string;
}

/**
 * Aggregated outcome returned by {@link runValidationCampaign}. The structure is
 * intentionally verbose so the CLI can surface detailed logs without poking the
 * filesystem again.
 */
export interface ValidationCampaignResult {
  readonly layout: ValidationRunLayout;
  readonly snapshots?: ValidationCampaignStepResult<ValidationSnapshotPaths>;
  readonly build?: ValidationCampaignStepResult<ValidationBuildResult>;
  readonly runtime?: ValidationCampaignStepResult<ValidationRuntimeContext>;
  readonly scenarios: readonly ValidationCampaignScenarioResult[];
  readonly report?: ValidationCampaignStepResult<PersistedValidationReport>;
  readonly idempotence?: ValidationCampaignStepResult<ScenarioIdempotenceComparison>;
  readonly audit?: ValidationCampaignStepResult<ValidationAuditReport>;
  readonly remediation?: ValidationCampaignStepResult<PersistedRemediationPlan>;
  readonly success: boolean;
  readonly notes: readonly string[];
  readonly skipped: readonly string[];
}

/** Default list of scenario identifiers executed when no filter is provided. */
const DEFAULT_SCENARIO_IDS = VALIDATION_SCENARIOS.map((scenario) => scenario.id);

/** Human readable message returned when a step fails. */
const STEP_FAILURE_MESSAGES: Record<string, string> = {
  build: "La compilation npm a signalé des erreurs. Consultez validation_run/logs/build.log.",
  idempotence: "La comparaison S01/S05 n'est pas conforme.",
  audit: "L'audit a détecté des problèmes bloquants.",
};

/**
 * Executes the validation checklist end-to-end (or a user-provided subset) by
 * orchestrating the modules implemented under `src/validationRun/`. The helper is
 * idempotent and safe to re-run: every step writes to deterministic files under
 * `validation_run/`, ensuring artefacts remain inspectable across reruns.
 */
export async function runValidationCampaign(
  options: ValidationCampaignOptions = {},
): Promise<ValidationCampaignResult> {
  const layout = options.layout ?? (await ensureValidationRunLayout(options.baseRoot));
  const hooks = options.hooks ?? {};

  let snapshots: ValidationCampaignStepResult<ValidationSnapshotPaths> | undefined;
  let build: ValidationCampaignStepResult<ValidationBuildResult> | undefined;
  let runtime: ValidationCampaignStepResult<ValidationRuntimeContext> | undefined;
  const scenarioResults: ValidationCampaignScenarioResult[] = [];
  let report: ValidationCampaignStepResult<PersistedValidationReport> | undefined;
  let idempotence: ValidationCampaignStepResult<ScenarioIdempotenceComparison> | undefined;
  let audit: ValidationCampaignStepResult<ValidationAuditReport> | undefined;
  let remediation: ValidationCampaignStepResult<PersistedRemediationPlan> | undefined;

  const notes: string[] = [];
  const skipped: string[] = [];

  // Snapshots capture (section 1 of the checklist).
  if (options.captureSnapshots === false) {
    skipped.push("snapshots");
  } else {
    const snapshotArgs: CaptureValidationSnapshotsOptions = {
      ...options.snapshotOptions,
      layout,
      ...(options.baseRoot !== undefined ? { baseRoot: options.baseRoot } : {}),
    };
    snapshots = await executeStep(
      () => (hooks.captureSnapshots ?? captureValidationSnapshots)(snapshotArgs),
    );
  }

  // Build stage (section 2 – compiler step).
  if (options.runBuild === false) {
    skipped.push("build");
  } else {
    const buildArgs: RunValidationBuildOptions = {
      ...options.buildOptions,
      root: layout.root,
    };
    build = await executeStep(
      () => (hooks.runBuild ?? runValidationBuild)(buildArgs),
      {
        validate: (result) => result.success,
        describeFailure: () => STEP_FAILURE_MESSAGES.build,
      },
    );
  }

  // Runtime preparation (section 2 – runtime directories & env vars).
  if (options.ensureRuntime === false) {
    skipped.push("runtime");
  } else {
    const runtimeArgs: EnsureValidationRuntimeOptions = {
      ...options.runtimeOptions,
      root: layout.root,
      ...(options.createChildrenDir !== undefined
        ? { createChildrenDir: options.createChildrenDir }
        : {}),
    };
    runtime = await executeStep(
      () => (hooks.ensureRuntime ?? ensureValidationRuntime)(runtimeArgs),
    );
  }

  // Scenario executions (section 4).
  const scenarioIds = normaliseScenarioIds(options.scenarioIds ?? DEFAULT_SCENARIO_IDS);
  for (const scenarioId of scenarioIds) {
    const scenario = resolveScenarioById(scenarioId);
    const slug = formatScenarioSlug(scenario);
    const jobId = buildScenarioJobId(scenario, options.scenarioJobIdPrefix);

    const scenarioArgs: ExecuteSearchScenarioOptions = {
      scenarioId,
      layout,
      persistArtifacts: options.persistArtifacts ?? true,
      ...(options.baseRoot !== undefined ? { baseRoot: options.baseRoot } : {}),
      ...(jobId ? { jobId } : {}),
      ...(options.scenarioOverrides ? { overrides: options.scenarioOverrides } : {}),
    };

    const result = await executeStep(
      () => (hooks.executeScenario ?? executeSearchScenario)(scenarioArgs),
    );

    if (result.result?.timingNotes) {
      for (const note of result.result.timingNotes) {
        notes.push(`${slug}: ${note}`);
      }
    }

    scenarioResults.push({ ...result, scenarioId, slug });

    if (!result.ok && options.stopOnScenarioFailure) {
      break;
    }
  }

  // Summary report (section 8).
  if (options.generateReport === false) {
    skipped.push("report");
  } else {
    const reportArgs: GenerateValidationSummaryOptions = {
      ...options.reportOptions,
      layout,
      ...(options.baseRoot !== undefined ? { baseRoot: options.baseRoot } : {}),
    };
    report = await executeStep(
      () => (hooks.writeReport ?? writeValidationReport)(reportArgs),
    );
  }

  // Idempotence check (section 6).
  if (options.runIdempotence === false) {
    skipped.push("idempotence");
  } else {
    const idempotenceArgs: CompareScenarioIdempotenceOptions = {
      ...options.idempotenceOptions,
      layout,
      ...(options.baseRoot !== undefined ? { baseRoot: options.baseRoot } : {}),
    };
    idempotence = await executeStep(
      () => (hooks.compareIdempotence ?? compareScenarioIdempotence)(idempotenceArgs),
      {
        validate: (comparison) => comparison.status === "pass",
        describeFailure: (comparison) => {
          if (comparison.status === "unknown") {
            return "La comparaison S01/S05 est incomplète (statut unknown).";
          }
          return STEP_FAILURE_MESSAGES.idempotence;
        },
      },
    );
    if (idempotence?.result) {
      for (const note of idempotence.result.notes) {
        notes.push(`Idempotence: ${note}`);
      }
    }
  }

  // Audit stage (section 5 & 9).
  if (options.runAudit === false) {
    skipped.push("audit");
  } else {
    const auditArgs: AuditValidationRunOptions = {
      ...options.auditOptions,
      layout,
      ...(options.baseRoot !== undefined ? { baseRoot: options.baseRoot } : {}),
    };
    audit = await executeStep(
      () => (hooks.audit ?? auditValidationRun)(auditArgs),
      {
        validate: (report) => !report.hasBlockingIssues,
        describeFailure: () => STEP_FAILURE_MESSAGES.audit,
      },
    );
    if (audit?.result?.secretFindings.length) {
      notes.push(
        `Audit: ${audit.result.secretFindings.length} indice(s) de secret à vérifier.`,
      );
    }
  }

  // Remediation plan (section 7).
  if (options.runRemediation === false) {
    skipped.push("remediation");
  } else {
    const remediationArgs: GenerateRemediationPlanOptions = {
      ...options.remediationOptions,
      layout,
      ...(options.baseRoot !== undefined ? { baseRoot: options.baseRoot } : {}),
    };
    remediation = await executeStep(
      () => (hooks.writeRemediationPlan ?? writeRemediationPlan)(remediationArgs),
    );
  }

  const success = computeOverallSuccess({
    ...(snapshots ? { snapshots } : {}),
    ...(build ? { build } : {}),
    ...(runtime ? { runtime } : {}),
    scenarios: scenarioResults,
    ...(report ? { report } : {}),
    ...(idempotence ? { idempotence } : {}),
    ...(audit ? { audit } : {}),
    ...(remediation ? { remediation } : {}),
  });

  return {
    layout,
    ...(snapshots ? { snapshots } : {}),
    ...(build ? { build } : {}),
    ...(runtime ? { runtime } : {}),
    scenarios: scenarioResults,
    ...(report ? { report } : {}),
    ...(idempotence ? { idempotence } : {}),
    ...(audit ? { audit } : {}),
    ...(remediation ? { remediation } : {}),
    success,
    notes,
    skipped,
  };
}

/** Normalises scenario identifiers while preserving their relative order. */
function normaliseScenarioIds(ids: readonly number[]): readonly number[] {
  const seen = new Set<number>();
  const resolved: number[] = [];
  for (const id of ids) {
    const parsed = Number.parseInt(String(id), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      continue;
    }
    if (seen.has(parsed)) {
      continue;
    }
    seen.add(parsed);
    resolved.push(parsed);
  }
  return resolved;
}

/**
 * Wraps an asynchronous step and converts thrown errors into structured results
 * while preserving the successful payload when available.
 */
async function executeStep<T>(
  callback: () => Promise<T>,
  options: {
    readonly validate?: (result: T) => boolean;
    readonly describeFailure?: (result: T) => string | undefined;
  } = {},
): Promise<ValidationCampaignStepResult<T>> {
  try {
    const result = await callback();
    const ok = options.validate ? options.validate(result) : true;
    if (!ok) {
      const error = options.describeFailure?.(result);
      return error ? { ok, result, error } : { ok, result };
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

/** Formats unknown errors into human readable strings. */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Builds a deterministic job identifier when a prefix is provided. */
function buildScenarioJobId(
  scenario: ValidationScenarioDefinition,
  prefix: string | undefined,
): string | undefined {
  if (!prefix) {
    return undefined;
  }
  const slug = formatScenarioSlug(scenario);
  return `${prefix}_${slug}`;
}

/** Computes the overall success flag across every orchestrated step. */
function computeOverallSuccess(steps: {
  readonly snapshots?: ValidationCampaignStepResult<ValidationSnapshotPaths>;
  readonly build?: ValidationCampaignStepResult<ValidationBuildResult>;
  readonly runtime?: ValidationCampaignStepResult<ValidationRuntimeContext>;
  readonly scenarios: readonly ValidationCampaignScenarioResult[];
  readonly report?: ValidationCampaignStepResult<PersistedValidationReport>;
  readonly idempotence?: ValidationCampaignStepResult<ScenarioIdempotenceComparison>;
  readonly audit?: ValidationCampaignStepResult<ValidationAuditReport>;
  readonly remediation?: ValidationCampaignStepResult<PersistedRemediationPlan>;
}): boolean {
  const booleans: boolean[] = [];
  if (steps.snapshots) booleans.push(steps.snapshots.ok);
  if (steps.build) booleans.push(steps.build.ok);
  if (steps.runtime) booleans.push(steps.runtime.ok);
  booleans.push(...steps.scenarios.map((scenario) => scenario.ok));
  if (steps.report) booleans.push(steps.report.ok);
  if (steps.idempotence) booleans.push(steps.idempotence.ok);
  if (steps.audit) booleans.push(steps.audit.ok);
  if (steps.remediation) booleans.push(steps.remediation.ok);
  return booleans.every((value) => value);
}

