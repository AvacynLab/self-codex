/**
 * Agrège la durée totale et moyenne par catégorie d'étapes afin d'identifier
 * le groupe le plus coûteux.
 * @param {{ runs: Array<{ stage: string, duration: number }> }} input
 * @returns {{ aggregates: Record<string, { totalDuration: number, meanDuration: number, occurrences: number }>, slowest: { stage: string, meanDuration: number } | null }}
 */
export function transform(input) {
  if (!input || !Array.isArray(input.runs)) {
    throw new TypeError('Expected input.runs to be an array of stage duration entries.');
  }
  const aggregates = new Map();
  for (const run of input.runs) {
    const stage = String(run.stage);
    const duration = Number(run.duration);
    const current = aggregates.get(stage) ?? { totalDuration: 0, occurrences: 0 };
    current.totalDuration += duration;
    current.occurrences += 1;
    aggregates.set(stage, current);
  }
  let slowest = null;
  for (const [stage, info] of aggregates.entries()) {
    info.meanDuration = info.totalDuration / info.occurrences;
    if (!slowest || info.meanDuration > slowest.meanDuration) {
      slowest = { stage, meanDuration: info.meanDuration };
    }
  }
  const serialised = Object.fromEntries(aggregates.entries());
  return { aggregates: serialised, slowest };
}

export default transform;
