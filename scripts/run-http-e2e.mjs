import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import { cloneDefinedEnv } from "./lib/env-helpers.mjs";

/**
 * Resolves the repository root.  The helper keeps the rest of the script tidy
 * when the file is moved or symlinked in the future.
 */
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to Mocha's executable. */
const MOCHA_BIN = resolve(ROOT_DIR, "node_modules", "mocha", "bin", "mocha.js");
/** Absolute path to the Mocha bootstrap shared across all tests. */
const MOCHA_BOOTSTRAP = resolve(ROOT_DIR, "tests", "setup.ts");

/**
 * Builds the command-line invocation used to execute the HTTP end-to-end
 * suites.  Exposed for unit tests to guarantee the helper keeps
 * `MCP_TEST_ALLOW_LOOPBACK` enabled and forwards any additional Mocha flags.
 */
export function createHttpE2ERunner(extraMochaArgs = []) {
  const env = cloneDefinedEnv();
  // Clone the base environment while omitting `undefined` entries so child
  // processes never receive placeholder variables under
  // `exactOptionalPropertyTypes`.
  env.MCP_TEST_ALLOW_LOOPBACK = "yes";
  // Disable request throttling to avoid interfering with stress-heavy suites.
  env.MCP_HTTP_RATE_LIMIT_DISABLE = "1";

  return {
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      MOCHA_BIN,
      "--reporter",
      "tap",
      "--file",
      MOCHA_BOOTSTRAP,
      "tests/e2e/**/*.test.ts",
      ...extraMochaArgs,
    ],
    env,
  };
}

/** Guard matching utility to detect when the file is executed directly. */
function isMain() {
  const scriptArg = process.argv[1];
  if (!scriptArg) {
    return false;
  }
  return import.meta.url === pathToFileURL(scriptArg).href;
}

/**
 * Spawns Mocha with the correct environment so all HTTP suites run against the
 * local server on loopback.  The helper preserves the exit status to keep CI
 * diagnostics accurate.
 */
async function run() {
  const { command, args, env } = createHttpE2ERunner(process.argv.slice(2));
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        if (code !== 0) {
          const error = new Error(`HTTP end-to-end tests exited with status ${code}`);
          error.code = code;
          reject(error);
          return;
        }
        resolve();
        return;
      }
      reject(new Error(`HTTP end-to-end tests terminated via signal ${signal ?? "unknown"}`));
    });
  });
}

if (isMain()) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(typeof error?.code === "number" ? error.code : 1);
  });
}
