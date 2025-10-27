/**
 * Snapshot returned by the smoke validation routine. Breaking the shape into a
 * dedicated interface keeps the evaluation logic pure and trivial to test.
 */
export interface SmokeRunSnapshot {
  /** Number of structured documents returned by the search pipeline. */
  readonly documents: number;
  /** Number of knowledge graph triples produced during the run. */
  readonly graphTriples: number;
  /** Number of vector embeddings created during the run. */
  readonly vectorEmbeddings: number;
}

/** Result returned after analysing a smoke run outcome. */
export interface SmokeAssessment {
  readonly ok: boolean;
  readonly message: string;
  readonly missing: readonly string[];
}

/** Human-readable labels associated with each tracked signal. */
const SIGNAL_LABELS: Record<keyof SmokeRunSnapshot, string> = {
  documents: "structured documents",
  graphTriples: "knowledge graph triples",
  vectorEmbeddings: "vector embeddings",
};

/**
 * Evaluates whether the smoke run produced enough output to consider the stack
 * healthy. The helper returns a structured assessment so callers can decide how
 * to surface the failure (throw, warn, retry…).
 */
export function assessSmokeRun(snapshot: SmokeRunSnapshot): SmokeAssessment {
  const missingSignals: string[] = [];
  for (const [key, label] of Object.entries(SIGNAL_LABELS)) {
    const value = snapshot[key as keyof SmokeRunSnapshot];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      missingSignals.push(label);
    }
  }
  if (missingSignals.length === 0) {
    return { ok: true, message: "Search smoke run completed successfully.", missing: [] };
  }
  const message = `Search smoke run did not produce: ${missingSignals.join(", ")}.`;
  return { ok: false, message, missing: missingSignals };
}
