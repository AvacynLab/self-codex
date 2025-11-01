#!/usr/bin/env node
/**
 * Boots the dockerised search stack and executes the end-to-end mocha suite
 * against the real services. The script delegates orchestration to
 * {@link createSearchStackManager} so other tools (smoke tests, CI jobs) can
 * reuse the same lifecycle helpers without duplicating the Docker logic.
 */
import { fileURLToPath } from "node:url";

import { createSearchStackManager } from "./lib/searchStack.js";
import { ensureValidationRunLayout } from "../src/validationRun/layout.js";
import {
  formatScenarioSlug,
  type ValidationScenarioDefinition,
} from "../src/validationRun/scenario.js";
import { persistSearchScenarioArtefacts } from "./lib/searchArtifacts.js";

const manager = createSearchStackManager();

/**
 * Synthetic scenario definition mirroring the mocha end-to-end run. We keep the identifier
 * outside of the formal S01–S10 range so artefacts can coexist with manual campaigns without
 * clashing with canonical slugs.
 */
const E2E_SCENARIO: ValidationScenarioDefinition = {
  id: 91,
  label: "Recherche (e2e)",
  slugHint: "search_e2e",
  description: "Mocha integration exercising the dockerised stack.",
  input: {},
};

async function runMochaSuite(): Promise<readonly string[]> {
  const mochaArgs = [
    "--import",
    "tsx",
    "./node_modules/mocha/bin/mocha.js",
    "--reporter",
    "tap",
    "--file",
    "tests/setup.ts",
    "tests/e2e/search/search_run.e2e.test.ts",
  ];
  const env = {
    ...process.env,
    TSX_EXTENSIONS: "ts",
    SEARCH_E2E_ALLOW_RUN: "1",
    // Allow the mocha harness to reach the local stub servers (Searx + HTTP
    // fixture) exposed on the loopback interface. The generic test bootstrap
    // denies network traffic by default, so we have to opt-in explicitly for
    // end-to-end scenarios that rely on in-process HTTP fixtures.
    MCP_TEST_ALLOW_LOOPBACK: "yes",
  };
  await manager.runCommand("node", mochaArgs, { env });
  return mochaArgs;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const available = await manager.isDockerAvailable();
  if (!available) {
    console.warn("Docker is not available on this host, skipping search e2e suite.");
    return;
  }
  await manager.bringUpStack();
  try {
    await manager.waitForSearxReady();
    await manager.waitForUnstructuredReady();
    const mochaArgs = await runMochaSuite();
    const finishedAt = Date.now();
    await persistE2EArtefacts({
      startedAt,
      finishedAt,
      mochaArgs,
      composeFile: manager.composeFile,
    });
  } finally {
    await manager.tearDownStack({ allowFailure: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}

interface PersistE2EArtefactOptions {
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly mochaArgs?: readonly string[];
  readonly composeFile: string;
  /** Optional override for the validation root, primarily used in tests. */
  readonly validationRootOverride?: string;
}

/**
 * Records minimal artefacts for the e2e scenario so operators find the command arguments and
 * timing metadata under `validation_run/`. The helper executes on best-effort basis and skips
 * secondary writes when the validation layout is unavailable.
 */
async function persistE2EArtefacts(options: PersistE2EArtefactOptions): Promise<void> {
  try {
    const layout = await ensureValidationRunLayout(options.validationRootOverride);
    const slug = formatScenarioSlug(E2E_SCENARIO);
    const startedAt = options.startedAt ?? Date.now();
    const finishedAt = options.finishedAt ?? startedAt;
    const tookMs = Math.max(0, finishedAt - startedAt);

    await persistSearchScenarioArtefacts(
      {
        input: {
          mochaArgs: options.mochaArgs ?? [],
          composeFile: options.composeFile,
        },
        response: {
          ok: true,
          tookMs,
        },
        events: [],
        timings: {
          jobId: "search-e2e", // placeholder job identifier for dashboards.
          startedAt,
          completedAt: finishedAt,
          tookMs,
          eventCount: 0,
        },
        errors: [],
        kgChanges: [],
        vectorUpserts: [],
        serverLog:
          `# ${slug}\nNo orchestrator logs were captured during the mocha run.\n` +
          `Re-run with: docker compose -f ${options.composeFile} logs --tail=200\n`,
      },
      {
        scenario: E2E_SCENARIO,
        baseRoot: layout.root,
        slugOverride: slug,
      },
    );
  } catch (error) {
    console.warn("Failed to persist search e2e artefacts:", error);
  }
}

export const __testing = {
  persistE2EArtefacts,
};
