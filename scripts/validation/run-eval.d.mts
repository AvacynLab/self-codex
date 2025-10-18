export type EvaluationOperationStatus = "ok" | "error" | "unexpected_success" | "expected_error";

export interface EvaluationOperation {
  /** Human readable label describing the operation exercised by the harness. */
  label: string;
  /** Expected outcome ("ok" or "error") recorded when issuing the operation. */
  expected: "ok" | "error";
  /** Final status recorded after execution. */
  status: EvaluationOperationStatus;
  /** Duration of the operation in milliseconds. */
  durationMs: number;
  /** Trace identifier emitted by the orchestrator if available. */
  traceId: string | null;
  /** Optional diagnostic details captured when the operation fails. */
  details: string | null;
}

export interface EvaluationRunResult {
  /** Identifier associated with the validation campaign. */
  runId: string;
  /** Absolute path where artefacts are persisted. */
  runRoot: string;
  /** Markdown summary describing status counts and latency percentiles. */
  summaryPath: string;
  /** Chronological list of operations executed during the harness run. */
  operations: EvaluationOperation[];
}

export interface EvaluationRunOptions {
  runId?: string;
  runRoot?: string;
  workspaceRoot?: string;
  timestamp?: string | Date;
  graphId?: string;
  traceSeed?: string;
  featureOverrides?: Record<string, unknown>;
}

export interface EvaluationCliOptions {
  runId?: string;
  runRoot?: string;
  workspaceRoot?: string;
  timestamp?: string;
  graphId?: string;
  traceSeed?: string;
  featureOverrides: Record<string, unknown>;
}

export interface EvaluationCliParseResult {
  options: EvaluationCliOptions;
  errors: string[];
  helpRequested: boolean;
}

export declare function run(options?: EvaluationRunOptions): Promise<EvaluationRunResult>;
export declare function parseCliArgs(argv: readonly string[]): EvaluationCliParseResult;
