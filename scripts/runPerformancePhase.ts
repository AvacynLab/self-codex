#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";

import { executePerformanceCli, parsePerformanceCliOptions } from "../src/validation/performanceCli.js";
import { PERFORMANCE_JSONL_FILES } from "../src/validation/performance.js";

/**
 * CLI entrypoint for the Stage 10 performance validation workflow. The script
 * mirrors the ergonomics of previous stages so operators can chain executions
 * without memorising new conventions.
 */
async function main(): Promise<void> {
  const options = parsePerformanceCliOptions(process.argv.slice(2));

  const { runRoot, result } = await executePerformanceCli(options, process.env, console);

  console.log("⚙️  Performance validation summary:");
  console.log(
    `   • latency samples: ${result.summary.latency.samples} (tool=${
      result.summary.latency.toolName ?? "unknown"
    })`,
  );
  if (result.summary.latency.samples > 0) {
    console.log(
      `   • p50=${formatMs(result.summary.latency.p50Ms)} | p95=${formatMs(
        result.summary.latency.p95Ms,
      )} | p99=${formatMs(result.summary.latency.p99Ms)}`,
    );
  }
  if (result.summary.concurrency.groups.length) {
    for (const group of result.summary.concurrency.groups) {
      console.log(
        `   • concurrency[${group.group}] success=${group.success}/${group.totalCalls} failure=${group.failure}`,
      );
    }
  }
  console.log(
    `   • log growth: ${formatBytes(result.summary.logs.growthBytes)} (rotated=${result.summary.logs.rotated})`,
  );

  console.log(`🧾 Requests log: ${join(runRoot, PERFORMANCE_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, PERFORMANCE_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, PERFORMANCE_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, PERFORMANCE_JSONL_FILES.log)}`);
  console.log(`📝 Summary: ${result.summaryPath}`);
}

function formatMs(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value.toFixed(2)}ms`;
}

function formatBytes(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value.toFixed(0)}B`;
}

main().catch((error) => {
  console.error("Failed to execute performance validation workflow:", error);
  process.exitCode = 1;
});
