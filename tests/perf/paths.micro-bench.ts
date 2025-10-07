import { performance } from "node:perf_hooks";
import path from "node:path";

import { safeJoin, sanitizeFilename } from "../../src/paths.js";

/**
 * Target average execution time per invocation (in milliseconds) for the
 * filesystem hygiene helpers. The checklist requirement specifies that both
 * helpers should stay below 5ms on a developer workstation.
 */
const TARGET_MS = 5;

/**
 * Number of iterations executed for each benchmark. A higher iteration count
 * lowers the influence of the event loop jitter while still keeping the
 * overall runtime well under a second on the reference hardware.
 */
const ITERATIONS = 50_000;

interface BenchSample {
  readonly label: string;
  readonly averageMs: number;
}

/**
 * Runs a benchmark for the provided callback and returns the average runtime
 * in milliseconds. The callback receives the iteration index so it can vary
 * its inputs and avoid JIT over-optimisations that would not occur in real
 * workloads.
 */
function runBenchmark(label: string, callback: (iteration: number) => void): BenchSample {
  const start = performance.now();
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    callback(iteration);
  }
  const end = performance.now();
  const totalMs = end - start;
  const averageMs = totalMs / ITERATIONS;
  return { label, averageMs };
}

/**
 * Formats the benchmark samples as a human readable table that developers can
 * copy into performance notes when running the micro-bench locally.
 */
function formatSamples(samples: BenchSample[]): string {
  const header = "| benchmark | average (ms) | target (ms) |\n|-----------|--------------|-------------|";
  const rows = samples.map((sample) => {
    return `| ${sample.label} | ${sample.averageMs.toFixed(4)} | ${TARGET_MS.toFixed(2)} |`;
  });
  return [header, ...rows].join("\n");
}

/**
 * Ensures the benchmark results stay within the target bound. Throwing keeps
 * the script honest when called from CI or a pre-commit hook even though it is
 * primarily intended for manual execution.
 */
function assertWithinTarget(sample: BenchSample): void {
  if (sample.averageMs > TARGET_MS) {
    throw new Error(
      `${sample.label} average ${sample.averageMs.toFixed(4)}ms exceeds target ${TARGET_MS.toFixed(2)}ms`,
    );
  }
}

/**
 * Executes the benchmarks when the file is run directly via tsx or ts-node.
 * The samples cover the sanitiser and the safe join helper using realistic
 * inputs that mimic common agent workloads.
 */
async function main(): Promise<void> {
  const samples: BenchSample[] = [];

  samples.push(
    runBenchmark("sanitizeFilename", (iteration) => {
      const suffix = iteration.toString(16);
      // The input injects characters that must be stripped as well as unicode
      // normalisation, mirroring worst-case prompts produced by child agents.
      sanitizeFilename(`../rùn-${suffix}\u0000.json`);
    }),
  );

  const baseDir = path.resolve(process.cwd(), "runs");
  samples.push(
    runBenchmark("safeJoin", (iteration) => {
      const child = `child-${iteration % 100}`;
      // Mixing whitespace and traversal attempts matches the sanitisation
      // scenarios covered by the unit suite.
      safeJoin(baseDir, " ../", child, "logs", `${iteration}.json`);
    }),
  );

  for (const sample of samples) {
    assertWithinTarget(sample);
  }

  // eslint-disable-next-line no-console -- developer feedback for manual runs.
  console.log(formatSamples(samples));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { main as runPathsBench, TARGET_MS };
