import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";

import { ensureValidationRunLayout } from "./layout";

/**
 * Description of a command executed during the validation build preparation. We
 * keep the structure simple so the sequence can be easily unit-tested and, when
 * required, rendered in the build logs.
 */
export interface ValidationBuildCommand {
  /** Binary executed for the build step (e.g. `npm`). */
  readonly command: string;
  /** Arguments passed to the command. */
  readonly args: readonly string[];
  /** Additional environment variables provided for the command. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Options accepted by {@link computeValidationBuildCommands}. Allow operators to
 * customise the npm executable – useful in hermetic environments.
 */
export interface ComputeValidationBuildCommandsOptions {
  /** Path to the npm executable. Defaults to `npm`. */
  readonly npmExecutable?: string;
}

/**
 * Returns the canonical command sequence required by the checklist to compile
 * the project before starting the validation scenarios.
 */
export function computeValidationBuildCommands(
  options: ComputeValidationBuildCommandsOptions = {},
): readonly ValidationBuildCommand[] {
  const npmExecutable = options.npmExecutable ?? "npm";
  return [
    {
      command: npmExecutable,
      args: ["ci", "--include=dev"],
      env: { NODE_ENV: "development" } as NodeJS.ProcessEnv,
    },
    {
      command: npmExecutable,
      args: ["run", "build"],
    },
  ];
}

/**
 * Result returned by a {@link CommandRunner} execution.
 */
export interface CommandExecutionResult {
  /** Exit status of the spawned command. */
  readonly exitCode: number;
  /** Standard output collected for the command. */
  readonly stdout: string;
  /** Standard error collected for the command. */
  readonly stderr: string;
}

/**
 * Shape of the runner function responsible for executing build commands.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<CommandExecutionResult>;

/**
 * Summary of each build step recorded by {@link runValidationBuild}.
 */
export interface ValidationBuildStepResult extends CommandExecutionResult {
  /** Binary executed for the step. */
  readonly command: string;
  /** Arguments used during the step. */
  readonly args: readonly string[];
  /** Execution time in milliseconds. */
  readonly durationMs: number;
  /** Optional fatal error captured when the command could not be spawned. */
  readonly error?: string;
}

/**
 * Result returned after executing the complete build sequence.
 */
export interface ValidationBuildResult {
  /** Absolute path to the build log file. */
  readonly logFile: string;
  /** Array of step results recorded in execution order. */
  readonly steps: readonly ValidationBuildStepResult[];
  /** Whether every command exited successfully. */
  readonly success: boolean;
}

/**
 * Options accepted by {@link runValidationBuild}.
 */
export interface RunValidationBuildOptions {
  /** Optional override for the validation layout root. */
  readonly root?: string;
  /** Optional npm executable to use for the commands. */
  readonly npmExecutable?: string;
  /** Custom name for the build log file under the logs directory. */
  readonly logFileName?: string;
  /** Custom runner implementation, mainly used in unit tests. */
  readonly runner?: CommandRunner;
  /** Hook returning the current time, useful for deterministic tests. */
  readonly now?: () => Date;
}

/**
 * Executes the checklist-mandated build commands and records their output under
 * `validation_run/logs/`. The helper is careful to keep the implementation
 * streaming-friendly while still exposing enough details for unit tests.
 */
export async function runValidationBuild(
  options: RunValidationBuildOptions = {},
): Promise<ValidationBuildResult> {
  const layout = await ensureValidationRunLayout(options.root);
  const projectRoot = path.resolve(layout.root, "..");
  const logFileName = options.logFileName ?? "build.log";
  const logFile = path.join(layout.logsDir, logFileName);

  await mkdir(path.dirname(logFile), { recursive: true });
  const logStream = createWriteStream(logFile, { flags: "a" });

  const runner = options.runner ?? defaultRunner;
  const now = options.now ?? (() => new Date());

  const commands = computeValidationBuildCommands(
    options.npmExecutable ? { npmExecutable: options.npmExecutable } : {},
  );
  const steps: ValidationBuildStepResult[] = [];
  let success = true;

  try {
    await writeLine(logStream, header("Validation build sequence started", now()));

    for (const command of commands) {
      await writeLine(logStream, sectionTitle(command));
      const start = now().getTime();
      try {
        const result = await runner(command.command, command.args, {
          cwd: projectRoot,
          env: buildEnv(command.env),
        });
        const durationMs = now().getTime() - start;
        await recordCommandOutput(logStream, result);
        await writeLine(logStream, `durationMs=${durationMs}`);

        const stepResult: ValidationBuildStepResult = {
          ...result,
          command: command.command,
          args: command.args,
          durationMs,
        };
        steps.push(stepResult);

        if (result.exitCode !== 0) {
          success = false;
          await writeLine(logStream, footer("command failed", now()));
          break;
        }
      } catch (error) {
        const message = formatError(error);
        const durationMs = now().getTime() - start;
        await writeLine(logStream, `error=${message}`);

        steps.push({
          command: command.command,
          args: command.args,
          stdout: "",
          stderr: "",
          exitCode: -1,
          durationMs,
          error: message,
        });
        success = false;
        await writeLine(logStream, footer("command threw", now()));
        break;
      }
    }

    const statusMessage = success ? "Validation build sequence completed" : "Validation build sequence incomplete";
    await writeLine(logStream, footer(statusMessage, now()));
  } finally {
    logStream.end();
    await finished(logStream);
  }

  return { logFile, steps, success };
}

function buildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
  };
}

async function recordCommandOutput(stream: ReturnType<typeof createWriteStream>, result: CommandExecutionResult): Promise<void> {
  if (result.stdout.trim() !== "") {
    await writeLine(stream, "[stdout]");
    await writeLine(stream, result.stdout.trim());
    await writeLine(stream, "[/stdout]");
  }
  if (result.stderr.trim() !== "") {
    await writeLine(stream, "[stderr]");
    await writeLine(stream, result.stderr.trim());
    await writeLine(stream, "[/stderr]");
  }
  await writeLine(stream, `exitCode=${result.exitCode}`);
}

function sectionTitle(command: ValidationBuildCommand): string {
  const renderedArgs = command.args.join(" ");
  return `> ${command.command} ${renderedArgs}`.trim();
}

function header(message: string, timestamp: Date): string {
  return `[${timestamp.toISOString()}] ${message}`;
}

function footer(message: string, timestamp: Date): string {
  return `[${timestamp.toISOString()}] ${message}`;
}

async function writeLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(`${line}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

async function defaultRunner(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandExecutionResult> {
  const { spawn } = await import("node:child_process");
  return new Promise<CommandExecutionResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}
