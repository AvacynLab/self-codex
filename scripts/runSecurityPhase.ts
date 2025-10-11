#!/usr/bin/env node
import process from "node:process";
import { join } from "node:path";

import { executeSecurityCli, parseSecurityCliOptions } from "../src/validation/securityCli.js";
import { SECURITY_JSONL_FILES } from "../src/validation/security.js";

/**
 * CLI entrypoint for the Stage 11 security validation workflow. The script
 * mirrors the ergonomics of previous stages so operators can chain the runs
 * without memorising new conventions or artefact locations.
 */
async function main(): Promise<void> {
  const options = parseSecurityCliOptions(process.argv.slice(2));
  const { runRoot, result } = await executeSecurityCli(options, process.env, console);

  console.log("🛡️  Security validation summary:");
  for (const check of result.summary.checks) {
    console.log(
      `   • ${check.scenario}/${check.name}: status=${check.status} expected=${
        check.expectedStatus ?? "n/a"
      } auth=${check.requireAuth ? "auth" : "no-auth"}`,
    );
  }

  if (result.summary.redaction) {
    const probe = result.summary.redaction;
    const leaks = probe.calls.filter((call) => call.leakedInResponse || call.leakedInEvents);
    console.log(
      `   • redaction probe (${probe.secret}) leaks=${leaks.length}/${probe.calls.length} -> inspect logs if >0`,
    );
  }

  if (result.summary.unauthorized) {
    const blocked = result.summary.unauthorized.calls.filter((call) => call.success);
    console.log(`   • unauthorized blocked: ${blocked.length}/${result.summary.unauthorized.calls.length}`);
  }

  if (result.summary.pathValidation) {
    for (const probe of result.summary.pathValidation.calls) {
      console.log(`   • path probe ${probe.name}: status=${probe.status} target=${probe.attemptedPath}`);
    }
  }

  console.log(`🧾 Requests log: ${join(runRoot, SECURITY_JSONL_FILES.inputs)}`);
  console.log(`📤 Responses log: ${join(runRoot, SECURITY_JSONL_FILES.outputs)}`);
  console.log(`📡 Events log: ${join(runRoot, SECURITY_JSONL_FILES.events)}`);
  console.log(`🗂️ HTTP snapshots: ${join(runRoot, SECURITY_JSONL_FILES.log)}`);
  console.log(`📝 Summary: ${result.summaryPath}`);
}

main().catch((error) => {
  console.error("Failed to execute security validation workflow:", error);
  process.exitCode = 1;
});
