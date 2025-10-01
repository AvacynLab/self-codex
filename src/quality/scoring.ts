import { z } from "zod";

/** Result returned by each scoring helper. */
export interface QualityScoreResult {
  score: number;
  rubric: Record<string, number>;
}

/**
 * Ensures numeric components stay within the 0-100 interval to simplify
 * downstream consumption.
 */
function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

const CodeScoreSchema = z
  .object({
    testsPassed: z.number().min(0).max(10).optional(),
    lintErrors: z.number().min(0).max(50).optional(),
    complexity: z.number().min(0).max(100).optional(),
  })
  .strict();

const TextScoreSchema = z
  .object({
    factsOK: z.number().min(0).max(1).optional(),
    readability: z.number().min(0).max(100).optional(),
    structure: z.number().min(0).max(1).optional(),
  })
  .strict();

const PlanScoreSchema = z
  .object({
    coherence: z.number().min(0).max(1).optional(),
    coverage: z.number().min(0).max(1).optional(),
    risk: z.number().min(0).max(1).optional(),
  })
  .strict();

export type ScoreCodeInput = z.infer<typeof CodeScoreSchema>;
export type ScoreTextInput = z.infer<typeof TextScoreSchema>;
export type ScorePlanInput = z.infer<typeof PlanScoreSchema>;

/**
 * Scores code deliverables by combining tests, linting quality and perceived
 * complexity. The heuristics intentionally favour well tested, low complexity
 * changes.
 */
export function scoreCode(params: ScoreCodeInput): QualityScoreResult {
  const input = CodeScoreSchema.parse(params);
  const testsPassed = input.testsPassed ?? 0;
  const lintErrors = input.lintErrors ?? 0;
  const complexity = input.complexity ?? 0;

  const testsContribution = Math.min(testsPassed * 18, 45);
  const lintPenalty = Math.min(lintErrors * 12, 50);
  const complexityPenalty = Math.min(Math.max(complexity - 10, 0) * 2.5, 35);

  const rawScore = 55 + testsContribution - lintPenalty - complexityPenalty;
  const score = clampScore(rawScore);

  const rubric = {
    tests: clampScore((testsContribution / 45) * 100),
    lint: clampScore(100 - (lintPenalty / 50) * 100),
    complexity: clampScore(100 - (complexityPenalty / 35) * 100),
  };

  return { score, rubric };
}

/**
 * Scores textual deliverables based on factual accuracy, readability and
 * structural clarity.
 */
export function scoreText(params: ScoreTextInput): QualityScoreResult {
  const input = TextScoreSchema.parse(params);
  const factsOK = input.factsOK ?? 0;
  const readability = input.readability ?? 60;
  const structure = input.structure ?? 0;

  const factualContribution = Math.min(factsOK * 100, 40);
  const readabilityContribution = Math.min((readability / 100) * 35, 35);
  const structureContribution = Math.min(structure * 100, 25);

  const rawScore = factualContribution + readabilityContribution + structureContribution;
  const score = clampScore(rawScore);

  const rubric = {
    facts: clampScore((factualContribution / 40) * 100),
    readability: clampScore((readabilityContribution / 35) * 100),
    structure: clampScore((structureContribution / 25) * 100),
  };

  return { score, rubric };
}

/**
 * Scores plans by rewarding coherent, well covered steps and penalising high
 * residual risk.
 */
export function scorePlan(params: ScorePlanInput): QualityScoreResult {
  const input = PlanScoreSchema.parse(params);
  const coherence = input.coherence ?? 0;
  const coverage = input.coverage ?? 0;
  const risk = input.risk ?? 0.5;

  const coherenceWeight = 0.35;
  const coverageWeight = 0.35;
  const mitigationWeight = 0.3;

  const rawScore =
    coherence * coherenceWeight * 100 +
    coverage * coverageWeight * 100 +
    (1 - risk) * mitigationWeight * 100;
  const score = clampScore(rawScore);

  const rubric = {
    coherence: clampScore(coherence * 100),
    coverage: clampScore(coverage * 100),
    mitigation: clampScore((1 - risk) * 100),
  };

  return { score, rubric };
}
