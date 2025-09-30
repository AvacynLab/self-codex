/**
 * Filtre les métriques qui ne respectent pas les contraintes de couverture
 * minimale et de durée maximale, puis synthétise les compteurs associés.
 * @param {{ metrics: Array<{ name: string, coverage: number, runtime: number }>, constraints: { minCoverage: number, maxRuntime: number } }} input
 * @returns {{ flagged: Array<{ name: string, coverage: number, runtime: number, issues: string[] }>, summary: { total: number, failingCoverage: number, failingRuntime: number } }}
 */
export function transform(input) {
  if (!input || !Array.isArray(input.metrics)) {
    throw new TypeError('Expected input.metrics to be an array of metric objects.');
  }
  const minCoverage = Number(input.constraints?.minCoverage ?? 0);
  const maxRuntime = Number(input.constraints?.maxRuntime ?? Number.POSITIVE_INFINITY);
  const flagged = [];
  let failingCoverage = 0;
  let failingRuntime = 0;
  for (const metric of input.metrics) {
    const issues = [];
    const coverage = Number(metric.coverage);
    const runtime = Number(metric.runtime);
    if (coverage < minCoverage) {
      issues.push('coverage');
      failingCoverage += 1;
    }
    if (runtime > maxRuntime) {
      issues.push('runtime');
      failingRuntime += 1;
    }
    if (issues.length > 0) {
      flagged.push({
        name: String(metric.name),
        coverage,
        runtime,
        issues
      });
    }
  }
  return {
    flagged,
    summary: {
      total: input.metrics.length,
      failingCoverage,
      failingRuntime
    }
  };
}

export default transform;
