#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeIntrospectionCli,
  parseIntrospectionCliOptions,
} from "../src/validation/introspectionCli.js";
import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/**
 * CLI entrypoint that wires the minimal option parser to the reusable
 * introspection executor. Keeping the orchestration inside TypeScript ensures
 * future operators benefit from type safety and inline documentation when
 * extending the workflow (e.g. injecting extra probes).
 */

/**
 * Normalises the argv/env tuple for the introspection stage so strict optional
 * semantics are preserved when forwarding process state to the validation
 * runner.
 */
export function prepareIntrospectionCliInvocation(
  rawArgs: readonly string[] = process.argv.slice(2),
  rawEnv: NodeJS.ProcessEnv = process.env,
) {
  const options = parseIntrospectionCliOptions(Array.from(rawArgs));
  const env = cloneDefinedEnv(rawEnv) as NodeJS.ProcessEnv;
  return { options, env };
}

async function main(): Promise<void> {
  const { options, env } = prepareIntrospectionCliInvocation(
    process.argv.slice(2),
    process.env,
  );

  const { runRoot, outcomes } = await executeIntrospectionCli(options, env, console);

  console.log("📊 Introspection call summary:");
  for (const outcome of outcomes) {
    console.log(
      `   • ${outcome.call.name} → HTTP ${outcome.check.response.status} (duration ${outcome.check.durationMs.toFixed(1)} ms)`,
    );
  }

  console.log(`🧾 Detailed log: ${join(runRoot, "logs", "introspection_http.json")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href) {
  main().catch((error) => {
    console.error("Failed to execute introspection phase:", error);
    process.exitCode = 1;
  });
}
