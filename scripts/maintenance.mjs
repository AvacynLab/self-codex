#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  buildCommandPlan,
  createCommandRunner,
  ensureBranchAllowed,
} from "./lib/env-helpers.mjs";

/**
 * Refreshes an existing Codex deployment while guaranteeing that the
 * repository workspace remains untouched. The same "no-write" policy used for
 * environment setup applies here so operators can safely rebuild in CI.
 */
const projectRoot = dirname(fileURLToPath(new URL("../", import.meta.url)));
const scriptPath = fileURLToPath(import.meta.url);
const isTestEnvironment = process.env.CODEX_SCRIPT_TEST === "1";
const isDryRun = process.env.CODEX_SCRIPT_DRY_RUN === "1";
const invokedDirectly = (() => {
  try {
    return process.argv.length > 1 && resolve(process.argv[1]) === scriptPath;
  } catch {
    return false;
  }
})();

async function main() {
  const { runCommand, recordedCommands } = createCommandRunner({
    projectRoot,
    dryRun: isDryRun,
  });

  await ensureBranchAllowed(async () => {
    const result = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      captureOutput: true,
    });
    return result.stdout;
  });

  const hasLockFile =
    existsSync(join(projectRoot, "package-lock.json")) ||
    existsSync(join(projectRoot, "npm-shrinkwrap.json"));

  for (const step of buildCommandPlan(hasLockFile)) {
    console.log(`[maintenance] ${step.description}`);
    await runCommand(step.command, step.args);
  }

  const configDir = resolve(process.env.HOME ?? "", ".codex");
  if (!isDryRun) {
    mkdirSync(configDir, { recursive: true });
  }

  const serverPath = join(projectRoot, "dist", "server.js");
  const tomlPath = join(configDir, "config.toml");
  const tomlContent = `[[servers]]
name = "self-fork"
command = "node"
args = ["${serverPath.replace(/\\/g, "\\\\")}"]
transport = "stdio"
# Pour HTTP, préférez un adaptateur et le script npm run start:http.
`;

  if (isDryRun) {
    console.log(`[maintenance] (dry-run) would write ${tomlPath}`);
  } else {
    writeFileSync(tomlPath, tomlContent, "utf8");
    console.log(`[maintenance] Configuration Codex rafraîchie (${tomlPath})`);
  }

  if (isDryRun) {
    globalThis.CODEX_SCRIPT_COMMANDS = recordedCommands;
  }
}

if (!isTestEnvironment && invokedDirectly) {
  await main();
}

export { main as runMaintenance };
