#!/usr/bin/env node
/**
 * Boots the dockerised search stack and executes the end-to-end mocha suite
 * against the real services. The script delegates orchestration to
 * {@link createSearchStackManager} so other tools (smoke tests, CI jobs) can
 * reuse the same lifecycle helpers without duplicating the Docker logic.
 */
import { createSearchStackManager } from "./lib/searchStack.js";

const manager = createSearchStackManager();

async function runMochaSuite(): Promise<void> {
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
  const env = { ...process.env, TSX_EXTENSIONS: "ts", SEARCH_E2E_ALLOW_RUN: "1" };
  await manager.runCommand("node", mochaArgs, { env });
}

async function main(): Promise<void> {
  const available = await manager.isDockerAvailable();
  if (!available) {
    console.warn("Docker is not available on this host, skipping search e2e suite.");
    return;
  }
  await manager.bringUpStack();
  try {
    await manager.waitForSearxReady();
    await manager.waitForUnstructuredReady();
    await runMochaSuite();
  } finally {
    await manager.tearDownStack({ allowFailure: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
