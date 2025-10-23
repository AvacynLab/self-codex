/**
 * Type declarations for the environment helper utilities so TypeScript scripts
 * and tests can consume the shared logic without falling back to implicit any
 * types. The definitions stay light-weight while mirroring the runtime API
 * exposed by {@link env-helpers.mjs}.
 */
export const PROHIBITED_BRANCH_PATTERNS: ReadonlyArray<RegExp>;
export function normaliseBranchName(rawName?: string): string;
export function isBranchBlocked(branchName: string): boolean;
export function ensureBranchAllowed(
  resolveBranchName: () => string | Promise<string>,
): Promise<string>;
export function selectInstallArguments(hasLockFile: boolean): string[];
export function buildCommandPlan(
  hasLockFile: boolean,
  options?: { includeGraphForge?: boolean },
): ReadonlyArray<{
  readonly description: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}>;
export function ensureSourceMapNodeOptions(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function cloneDefinedEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function assertNodeVersion(minMajor?: number): string;
export function createCommandRunner(params: {
  readonly projectRoot: string;
  readonly dryRun: boolean;
}): {
  readonly runCommand: (
    command: string,
    args: ReadonlyArray<string>,
    options?: { captureOutput?: boolean },
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly recordedCommands: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly captureOutput: boolean;
    readonly nodeOptions?: string;
  }>;
};
