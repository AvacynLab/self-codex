#!/usr/bin/env tsx

import process from "node:process";

import {
  ensureValidationRuntime,
  probeSearx,
  probeUnstructured,
  validateSearchEnvironment,
  verifyHttpHealth,
} from "../src/validationRun/runtime";

async function main(): Promise<void> {
  const runtime = await ensureValidationRuntime({ createChildrenDir: true });
  console.log(`✔ validation layout ready at ${runtime.layout.root}`);
  console.log(`✔ logs directory: ${runtime.layout.logsDir}`);
  if (runtime.childrenDir) {
    console.log(`✔ children workspace: ${runtime.childrenDir}`);
  }

  console.log("\nRecommended MCP environment variables:");
  for (const [key, value] of Object.entries(runtime.env)) {
    console.log(`  ${key}=${value}`);
  }

  const envValidation = validateSearchEnvironment(process.env);
  if (!envValidation.ok) {
    console.error("\n✖ Search/Unstructured environment validation failed:");
    if (envValidation.missingKeys.length > 0) {
      console.error(`  Missing keys: ${envValidation.missingKeys.join(", ")}`);
    }
    if (envValidation.emptyKeys.length > 0) {
      console.error(`  Empty values: ${envValidation.emptyKeys.join(", ")}`);
    }
    if (envValidation.invalidNumericKeys.length > 0) {
      const formatted = envValidation.invalidNumericKeys
        .map((entry) => `${entry.key}=${entry.value}`)
        .join(", ");
      console.error(`  Invalid numeric values: ${formatted}`);
    }
    if (envValidation.expectedTrueKeys.length > 0) {
      const formatted = envValidation.expectedTrueKeys
        .map((entry) => `${entry.key}=${entry.value}`)
        .join(", ");
      console.error(`  Keys expected to be true: ${formatted}`);
    }
  } else {
    console.log("\n✔ Search/Unstructured environment variables look correct.");
  }

  if (envValidation.recommendations.length > 0) {
    console.warn("\n⚠ Recommendations:");
    for (const recommendation of envValidation.recommendations) {
      if (recommendation.actual) {
        console.warn(`  ${recommendation.key} should be ${recommendation.expected} (currently ${recommendation.actual})`);
      } else {
        console.warn(`  ${recommendation.key} should be set to ${recommendation.expected}`);
      }
    }
  }

  const issues: string[] = [];

  const httpHost = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const httpPort = process.env.MCP_HTTP_PORT ?? "8765";
  const httpPath = process.env.MCP_HTTP_PATH ?? "/mcp";
  const httpToken = process.env.MCP_HTTP_TOKEN;

  const baseUrl = new URL(addTrailingSlash(httpPath), `http://${httpHost}:${httpPort}`);
  const healthUrl = new URL("health", baseUrl);
  const healthResult = await verifyHttpHealth(healthUrl.toString(), { token: httpToken, expectStatus: 200 });
  if (healthResult.ok) {
    console.log(`\n✔ MCP health endpoint reachable at ${healthUrl.toString()}`);
  } else {
    issues.push(`health check failed (${healthResult.error ?? `status ${healthResult.statusCode}`})`);
    console.error(`\n✖ MCP health endpoint unavailable (${healthResult.error ?? `status ${healthResult.statusCode}`})`);
  }

  const searxBase = process.env.SEARCH_SEARX_BASE_URL;
  const searxPath = process.env.SEARCH_SEARX_API_PATH;
  if (searxBase && searxPath) {
    const searxResult = await probeSearx(searxBase, searxPath);
    if (searxResult.ok) {
      console.log(`✔ SearxNG probe succeeded (${searxResult.statusCode ?? "unknown status"})`);
    } else {
      issues.push(`Searx probe failed (${searxResult.error ?? `status ${searxResult.statusCode}`})`);
      console.error(`✖ SearxNG probe failed (${searxResult.error ?? `status ${searxResult.statusCode}`})`);
    }
  } else {
    issues.push("Searx environment variables missing for probe");
    console.warn("⚠ Skipping SearxNG probe because SEARCH_SEARX_* variables are undefined.");
  }

  const unstructuredBase = process.env.UNSTRUCTURED_BASE_URL;
  if (unstructuredBase) {
    const unstructuredResult = await probeUnstructured(unstructuredBase);
    if (unstructuredResult.ok) {
      console.log(`✔ Unstructured health responded (${unstructuredResult.statusCode ?? "unknown status"})`);
    } else {
      issues.push(`Unstructured probe failed (${unstructuredResult.error ?? `status ${unstructuredResult.statusCode}`})`);
      console.error(`✖ Unstructured health probe failed (${unstructuredResult.error ?? `status ${unstructuredResult.statusCode}`})`);
    }
  } else {
    issues.push("UNSTRUCTURED_BASE_URL missing for probe");
    console.warn("⚠ Skipping Unstructured probe because UNSTRUCTURED_BASE_URL is undefined.");
  }

  if (!envValidation.ok) {
    issues.push("Search/Unstructured environment invalid");
  }

  if (issues.length > 0) {
    console.error("\nValidation runtime preparation completed with issues:");
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("\n✔ Validation runtime ready.");
}

function addTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

void main().catch((error) => {
  console.error("Unexpected failure while preparing validation runtime:", error);
  process.exitCode = 1;
});
