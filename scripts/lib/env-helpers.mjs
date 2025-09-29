import { spawn } from "node:child_process";

/**
 * Shared utilities consumed by the environment and maintenance scripts.
 *
 * The production guidelines require these scripts to avoid mutating the
 * repository workspace (no lockfile regeneration, no dist/ cleanup) while
 * still preparing a usable runtime. The helpers below codify those
 * invariants so we can test them in isolation from the script entrypoints.
 */

/**
 * Branch name patterns that indicate an agent is currently applying a patch.
 * Executing the install/build scripts in that state would interfere with the
 * generated diff, so we defensively block those branches.
 */
export const PROHIBITED_BRANCH_PATTERNS = [
  /apply[-_]?patch/i,
  /codex[-/]?patch/i,
];

/**
 * Normalises the branch name by trimming whitespace and removing trailing
 * newline characters produced by Git commands.
 */
export function normaliseBranchName(rawName = "") {
  return rawName.trim();
}

/**
 * Determines whether the provided branch name violates the patch-protection
 * policy. The check is case-insensitive to capture variations produced by
 * different Git hosts.
 */
export function isBranchBlocked(branchName) {
  const normalised = normaliseBranchName(branchName);
  return PROHIBITED_BRANCH_PATTERNS.some((pattern) => pattern.test(normalised));
}

/**
 * Ensures the current branch is allowed to run maintenance scripts. The
 * caller injects a resolver so that we can unit test the guard without
 * spawning Git processes.
 */
export async function ensureBranchAllowed(resolveBranchName) {
  const branchName = normaliseBranchName(await resolveBranchName());
  if (branchName.length === 0) {
    return branchName;
  }
  if (isBranchBlocked(branchName)) {
    throw new Error(
      `Maintenance scripts are disabled on patch branches (detected: ${branchName}).`,
    );
  }
  return branchName;
}

/**
 * Computes the npm arguments for dependency installation while respecting the
 * "no lockfile writes" policy. When a lockfile is present we defer to
 * `npm ci`, otherwise we request a read-only install with production-only
 * dependencies.
 */
export function selectInstallArguments(hasLockFile) {
  return hasLockFile
    ? ["ci"]
    : ["install", "--omit=dev", "--no-save", "--no-package-lock"];
}

/**
 * Builds the ordered list of commands required to prepare the runtime. The
 * sequence mirrors the checklist from AGENTS.md and is reused by both the
 * setup and maintenance scripts.
 */
export function buildCommandPlan(hasLockFile) {
  const installArgs = selectInstallArguments(hasLockFile);
  return [
    {
      description: `npm ${installArgs.join(" ")}`,
      command: "npm",
      args: installArgs,
    },
    {
      description:
        "npm install @types/node@latest --no-save --no-package-lock",
      command: "npm",
      args: [
        "install",
        "@types/node@latest",
        "--no-save",
        "--no-package-lock",
      ],
    },
    {
      description: "npm run build",
      command: "npm",
      args: ["run", "build"],
    },
  ];
}

/**
 * Provides a reusable command runner that honours the dry-run mode exposed to
 * the test suite. The helper emits the same data structure for both scripts so
 * that assertions can inspect the captured calls.
 */
export function createCommandRunner({ projectRoot, dryRun }) {
  const recordedCommands = [];

  const runCommand = (command, args, { captureOutput = false } = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      if (dryRun) {
        recordedCommands.push({ command, args, captureOutput });
        resolvePromise({ stdout: "", stderr: "" });
        return;
      }

      const child = spawn(command, args, {
        cwd: projectRoot,
        stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      });

      let stdout = "";
      let stderr = "";

      if (captureOutput) {
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
      }

      child.on("error", (error) => {
        rejectPromise(error);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolvePromise({ stdout, stderr });
        } else {
          rejectPromise(new Error(`${command} exited with code ${code}`));
        }
      });
    });

  return { runCommand, recordedCommands };
}
