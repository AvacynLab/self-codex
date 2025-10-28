import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Structure of the coverage summary emitted by c8 when using the json-summary reporter.
 */
interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

/**
 * Coverage summary keyed by file path as produced by c8.
 */
export interface CoverageSummary {
  [key: string]: {
    lines: CoverageMetric;
    statements: CoverageMetric;
    functions: CoverageMetric;
    branches: CoverageMetric;
  };
}

/**
 * Minimum acceptable coverage ratio for search module files.
 * The task backlog requires at least 90% coverage for the search module.
 */
export const SEARCH_COVERAGE_THRESHOLD = 0.9;

/**
 * Reads the coverage summary JSON written by c8 and returns it as a typed object.
 *
 * @param summaryPath absolute or relative path to the json summary file.
 */
export async function loadCoverageSummary(summaryPath: string): Promise<CoverageSummary> {
  // Resolve the summary path relative to the current working directory so CI runs behave consistently.
  const resolvedPath = path.resolve(summaryPath);
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf8');
  } catch (error) {
    // Provide a focused error message that explains what went wrong.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Coverage summary not found at ${resolvedPath}. Run c8 with the json-summary reporter first.`);
    }
    throw error;
  }
  return JSON.parse(raw) as CoverageSummary;
}

/**
 * Throws an error when at least one search module file fails to reach the expected coverage threshold.
 *
 * @param summary parsed coverage summary.
 * @param threshold minimum ratio (between 0 and 1) required for each metric.
 */
const METRICS_TO_ENFORCE = ['lines', 'statements', 'functions'] as const;

type EnforcedMetric = typeof METRICS_TO_ENFORCE[number];

interface AggregatedCoverage {
  [metric: string]: number;
}

/**
 * Aggregates coverage ratios for the search module across the enforced metrics.
 * The backlog requires ≥90% coverage for the module, which we interpret as the aggregate
 * ratio for lines/statements/functions across every file in src/search/.
 */
export function computeSearchCoverage(summary: CoverageSummary): AggregatedCoverage {
  const totals: Record<EnforcedMetric, { total: number; covered: number }> = {
    lines: { total: 0, covered: 0 },
    statements: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
  };

  for (const [filePath, metrics] of Object.entries(summary)) {
    if (filePath === 'total' || !filePath.replace(/\\/g, '/').includes('src/search/')) {
      continue;
    }
    METRICS_TO_ENFORCE.forEach((metricKey) => {
      totals[metricKey].total += metrics[metricKey].total;
      totals[metricKey].covered += metrics[metricKey].covered;
    });
  }

  if (Object.values(totals)[0].total === 0) {
    throw new Error('No search coverage entries were found in the summary.');
  }

  return Object.fromEntries(
    METRICS_TO_ENFORCE.map((metricKey) => {
      const { total, covered } = totals[metricKey];
      const pct = total === 0 ? 100 : (covered / total) * 100;
      return [metricKey, pct];
    }),
  );
}

export function assertSearchCoverage(summary: CoverageSummary, threshold = SEARCH_COVERAGE_THRESHOLD): void {
  const aggregated = computeSearchCoverage(summary);
  const failing = Object.entries(aggregated)
    .filter(([, pct]) => pct / 100 < threshold)
    .map(([metric, pct]) => `${metric}=${pct.toFixed(2)}%`);

  if (failing.length > 0) {
    throw new Error(
      `Search coverage below ${(threshold * 100).toFixed(0)}% for aggregate metrics: ${failing.join(', ')}`,
    );
  }
}

async function main(): Promise<void> {
  const summaryPath = path.resolve('coverage', 'coverage-summary.json');
  const summary = await loadCoverageSummary(summaryPath);
  assertSearchCoverage(summary);
  const aggregated = computeSearchCoverage(summary);
  const formatted = METRICS_TO_ENFORCE.map((metric) => `${metric} ${aggregated[metric].toFixed(2)}%`).join(', ');
  // Log once so CI output makes it obvious the check ran successfully.
  process.stdout.write(`Search coverage check passed (${formatted}).\n`);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
