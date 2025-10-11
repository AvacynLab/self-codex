#!/usr/bin/env node
import process from "process";
import { join } from "path";

import {
  executeIntrospectionCli,
  parseIntrospectionCliOptions,
} from "../src/validation/introspectionCli.js";

/**
 * CLI entrypoint that wires the minimal option parser to the reusable
 * introspection executor. Keeping the orchestration inside TypeScript ensures
 * future operators benefit from type safety and inline documentation when
 * extending the workflow (e.g. injecting extra probes).
 */

async function main(): Promise<void> {
  const options = parseIntrospectionCliOptions(process.argv.slice(2));

  const { runRoot, outcomes } = await executeIntrospectionCli(options, process.env, console);

  console.log("📊 Introspection call summary:");
  for (const outcome of outcomes) {
    console.log(
      `   • ${outcome.call.name} → HTTP ${outcome.check.response.status} (duration ${outcome.check.durationMs.toFixed(1)} ms)`,
    );
  }

  console.log(`🧾 Detailed log: ${join(runRoot, "logs", "introspection_http.json")}`);
}

main().catch((error) => {
  console.error("Failed to execute introspection phase:", error);
  process.exitCode = 1;
});
