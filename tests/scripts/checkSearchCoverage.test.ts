import { expect } from 'chai';
import {
  assertSearchCoverage,
  computeSearchCoverage,
  SEARCH_COVERAGE_THRESHOLD,
  type CoverageSummary,
} from '../../scripts/checkSearchCoverage.ts';

describe('checkSearchCoverage', () => {
  it('passes when all search files meet the threshold', () => {
    const summary: CoverageSummary = {
      total: {
        lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
        statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
        functions: { total: 5, covered: 5, skipped: 0, pct: 100 },
        branches: { total: 2, covered: 2, skipped: 0, pct: 100 },
      },
      'src/search/example.ts': {
        lines: { total: 20, covered: 19, skipped: 0, pct: 95 },
        statements: { total: 20, covered: 19, skipped: 0, pct: 95 },
        functions: { total: 4, covered: 4, skipped: 0, pct: 100 },
        branches: { total: 6, covered: 6, skipped: 0, pct: 100 },
      },
      'src/search/other.ts': {
        lines: { total: 30, covered: 28, skipped: 0, pct: 93.33 },
        statements: { total: 30, covered: 28, skipped: 0, pct: 93.33 },
        functions: { total: 6, covered: 6, skipped: 0, pct: 100 },
        branches: { total: 8, covered: 5, skipped: 0, pct: 62.5 },
      },
    };

    expect(() => assertSearchCoverage(summary)).not.to.throw();
    const aggregated = computeSearchCoverage(summary);
    expect(aggregated.lines).to.be.closeTo(94, 0.01);
    expect(aggregated.statements).to.be.closeTo(94, 0.01);
    expect(aggregated.functions).to.be.closeTo(100, 0.01);
  });

  it('throws when any search file falls below the threshold', () => {
    const summary: CoverageSummary = {
      total: {
        lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
        statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
        functions: { total: 5, covered: 5, skipped: 0, pct: 100 },
        branches: { total: 2, covered: 2, skipped: 0, pct: 100 },
      },
      'src/search/failing.ts': {
        lines: { total: 20, covered: 17, skipped: 0, pct: 85 },
        statements: { total: 20, covered: 17, skipped: 0, pct: 85 },
        functions: { total: 4, covered: 3, skipped: 0, pct: 75 },
        branches: { total: 6, covered: 6, skipped: 0, pct: 100 },
      },
    };

    expect(() => assertSearchCoverage(summary)).to.throw(
      `Search coverage below ${(SEARCH_COVERAGE_THRESHOLD * 100).toFixed(0)}%`,
    );
  });

  it('ignores non search entries', () => {
    const summary: CoverageSummary = {
      total: {
        lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
        statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
        functions: { total: 5, covered: 5, skipped: 0, pct: 100 },
        branches: { total: 2, covered: 2, skipped: 0, pct: 100 },
      },
      'src/other/module.ts': {
        lines: { total: 20, covered: 10, skipped: 0, pct: 50 },
        statements: { total: 20, covered: 10, skipped: 0, pct: 50 },
        functions: { total: 4, covered: 2, skipped: 0, pct: 50 },
        branches: { total: 6, covered: 3, skipped: 0, pct: 50 },
      },
      'src/search/passing.ts': {
        lines: { total: 40, covered: 40, skipped: 0, pct: 100 },
        statements: { total: 40, covered: 40, skipped: 0, pct: 100 },
        functions: { total: 10, covered: 10, skipped: 0, pct: 100 },
        branches: { total: 8, covered: 4, skipped: 0, pct: 50 },
      },
    };

    expect(() => assertSearchCoverage(summary)).not.to.throw();
  });
});
