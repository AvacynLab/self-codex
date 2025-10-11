#!/usr/bin/env node
import process from "process";
import { join } from "path";

import {
  appendHttpCheckArtefacts,
  buildContextDocument,
  collectHttpEnvironment,
  ensureRunStructure,
  generateValidationRunId,
  performHttpCheck,
  persistContextDocument,
  type HttpCheckRequestSnapshot,
} from "../src/validation/runSetup.js";

interface CliOptions {
  runId?: string;
  baseDir: string;
}

/** Parses the CLI flags manually to avoid pulling a dependency for a single script. */
function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { baseDir: "runs" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--run-id" && index + 1 < argv.length) {
      options.runId = argv[index + 1];
      index += 1;
    } else if (token === "--base-dir" && index + 1 < argv.length) {
      options.baseDir = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

function buildJsonRpcRequest(url: string, authorization?: string): HttpCheckRequestSnapshot {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (authorization) {
    headers.authorization = authorization;
  }
  return {
    method: "POST",
    url,
    headers,
    body: { jsonrpc: "2.0", id: "preflight", method: "tools/list" },
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const runId = options.runId ?? generateValidationRunId();
  const environment = collectHttpEnvironment(process.env);
  const runRoot = await ensureRunStructure(options.baseDir, runId);

  console.log(`✅ Validation run directory ready: ${join(options.baseDir, runId)}`);
  console.log(`→ HTTP target: ${environment.baseUrl}`);

  const checks = [];

  const unauthorisedRequest = buildJsonRpcRequest(environment.baseUrl);
  const unauthorised = await performHttpCheck("http_unauthorised", unauthorisedRequest);
  await appendHttpCheckArtefacts(runRoot, unauthorised);
  checks.push(unauthorised);
  console.log(`   • Unauthorised status: ${unauthorised.response.status}`);

  const authorisationHeader = environment.token ? `Bearer ${environment.token}` : undefined;
  const authorisedRequest = buildJsonRpcRequest(environment.baseUrl, authorisationHeader);
  const authorised = await performHttpCheck("http_authorised", authorisedRequest);
  await appendHttpCheckArtefacts(runRoot, authorised);
  checks.push(authorised);
  console.log(`   • Authorised status: ${authorised.response.status}`);

  const context = buildContextDocument(runId, environment, checks);
  await persistContextDocument(runRoot, context);

  console.log(`📝 Context saved to ${join(runRoot, "report", "context.json")}`);
}

main().catch((error) => {
  console.error("Preflight initialisation failed:", error);
  process.exitCode = 1;
});
