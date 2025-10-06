import { afterEach, beforeEach, describe, it } from "mocha";
import { expect } from "chai";
import sinon from "sinon";

import {
  parseSchedulerBenchConfigFromEnv,
  renderSchedulerBenchmarkTable,
  compareSchedulerBenchmarks,
} from "./scheduler.bench.js";
import {
  DEFAULT_SCHEDULER_BENCH_CONFIG,
  type SchedulerBenchConfig,
  type SchedulerBenchResult,
} from "./scheduler.micro-bench.js";

/**
 * Unit tests covering the scheduler benchmark CLI utilities. The scenarios focus
 * on deterministic env parsing and delta computation so regressions in the
 * human-readable diagnostics are caught before shipping the tool.
 */
describe("scheduler benchmark utilities", () => {
  const envKeys = ["SCHED_BENCH_ITERATIONS", "SCHED_BENCH_NODES", "SCHED_BENCH_STEP_MS"] as const;
  let previousEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(() => {
    previousEnv = {} as Record<(typeof envKeys)[number], string | undefined>;
    for (const key of envKeys) {
      previousEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    sinon.restore();
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("parseSchedulerBenchConfigFromEnv", () => {
    it("resolves numeric overrides from the environment", () => {
      process.env.SCHED_BENCH_ITERATIONS = "42";
      process.env.SCHED_BENCH_NODES = "12";
      process.env.SCHED_BENCH_STEP_MS = "7";

      const config = parseSchedulerBenchConfigFromEnv();

      expect(config.iterations).to.equal(42);
      expect(config.uniqueNodes).to.equal(12);
      expect(config.logicalStepMs).to.equal(7);
    });

    it("falls back to sane defaults when overrides are invalid", () => {
      process.env.SCHED_BENCH_ITERATIONS = "not-a-number";
      process.env.SCHED_BENCH_NODES = "0";
      process.env.SCHED_BENCH_STEP_MS = "-3";

      const config = parseSchedulerBenchConfigFromEnv();

      expect(config.iterations).to.equal(DEFAULT_SCHEDULER_BENCH_CONFIG.iterations);
      expect(config.uniqueNodes).to.equal(1);
      expect(config.logicalStepMs).to.equal(0);
    });
  });

  describe("renderSchedulerBenchmarkTable", () => {
    it("produces an aligned table including the delta row", () => {
      const comparison = {
        baseline: {
          scenario: "baseline",
          ticks: 100,
          elapsedMs: 200.5,
          averageMsPerTick: 2.005,
          tracesCaptured: 15,
        },
        stigmergy: {
          scenario: "stigmergy",
          ticks: 100,
          elapsedMs: 150.25,
          averageMsPerTick: 1.5025,
          tracesCaptured: 18,
        },
        deltaElapsedMs: 50.25,
        deltaAverageMsPerTick: 0.5025,
        relativeAverageImprovementPct: 25.062344139650876,
      } satisfies {
        baseline: SchedulerBenchResult;
        stigmergy: SchedulerBenchResult;
        deltaElapsedMs: number;
        deltaAverageMsPerTick: number;
        relativeAverageImprovementPct: number;
      };

      const table = renderSchedulerBenchmarkTable(comparison);

      const expected = [
        "scenario         | ticks            | elapsed_ms       | avg_ms_per_tick  | traces          ",
        "--------------------------------------------------------------------------------------------",
        "baseline         | 100              | 200.50           | 2.0050           | 15              ",
        "stigmergy        | 100              | 150.25           | 1.5025           | 18              ",
        "delta            |                  | 50.25            | 0.5025           | 25.06%          ",
      ].join("\n");

      expect(table).to.equal(expected);
    });
  });

  describe("compareSchedulerBenchmarks", () => {
    it("derives delta metrics consistently across both scenarios", async () => {
      const config: SchedulerBenchConfig = { iterations: 16, uniqueNodes: 3, logicalStepMs: 1 };
      const comparison = await compareSchedulerBenchmarks(config);

      expect(comparison.baseline.scenario).to.equal("baseline");
      expect(comparison.stigmergy.scenario).to.equal("stigmergy");
      expect(comparison.baseline.ticks).to.be.greaterThan(0);
      expect(comparison.stigmergy.ticks).to.be.at.least(comparison.baseline.ticks);
      expect(comparison.baseline.ticks).to.be.at.least(config.iterations);
      expect(comparison.deltaElapsedMs).to.equal(
        comparison.baseline.elapsedMs - comparison.stigmergy.elapsedMs,
      );
      expect(comparison.deltaAverageMsPerTick).to.equal(
        comparison.baseline.averageMsPerTick - comparison.stigmergy.averageMsPerTick,
      );
      const expectedRelative =
        comparison.baseline.averageMsPerTick > 0
          ? (comparison.deltaAverageMsPerTick / comparison.baseline.averageMsPerTick) * 100
          : 0;
      expect(comparison.relativeAverageImprovementPct).to.be.closeTo(expectedRelative, 1e-6);
      expect(comparison.baseline.tracesCaptured).to.be.greaterThan(0);
      expect(comparison.stigmergy.tracesCaptured).to.be.greaterThan(0);
    });
  });
});
