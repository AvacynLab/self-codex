import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { expect } from "chai";

import {
  computeValidationBuildCommands,
  type CommandRunner,
  runValidationBuild,
} from "../../src/validationRun/build";

function createNowSequence(base: number, offsets: readonly number[]): () => Date {
  let index = 0;
  return () => {
    const offset = offsets[Math.min(index, offsets.length - 1)];
    index += 1;
    return new Date(base + offset);
  };
}

describe("validationRun/build", () => {
  it("defines the expected build command sequence", () => {
    const commands = computeValidationBuildCommands({ npmExecutable: "npm-custom" });
    expect(commands).to.deep.equal([
      {
        command: "npm-custom",
        args: ["ci", "--include=dev"],
        env: { NODE_ENV: "development" },
      },
      {
        command: "npm-custom",
        args: ["run", "build"],
      },
    ]);
  });

  it("runs the validation build and records logs", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "validation-build-success-"));
    const root = path.join(sandbox, "validation_run");
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const invocations: Array<{ command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const runner: CommandRunner = async (command, args, options) => {
      invocations.push({ command, args, cwd: options.cwd, env: options.env });
      return {
        exitCode: 0,
        stdout: `stdout:${command}:${args.join("_")}`,
        stderr: "",
      };
    };

    const baseTime = Date.UTC(2025, 0, 1, 12, 0, 0);
    const now = createNowSequence(baseTime, [0, 10, 20, 30, 40, 50]);

    try {
      const result = await runValidationBuild({
        root,
        logFileName: "custom-build.log",
        npmExecutable: "npm-custom",
        runner,
        now,
      });

      expect(result.success).to.equal(true);
      expect(result.steps).to.have.lengthOf(2);
      expect(result.steps[0].command).to.equal("npm-custom");
      expect(result.steps[0].args).to.deep.equal(["ci", "--include=dev"]);
      expect(result.steps[0].durationMs).to.equal(10);
      expect(result.steps[0].stdout).to.include("stdout:npm-custom:ci_--include=dev");
      expect(result.steps[1].args).to.deep.equal(["run", "build"]);
      expect(result.steps[1].durationMs).to.equal(10);
      expect(result.logFile).to.equal(path.join(root, "logs", "custom-build.log"));

      expect(invocations).to.have.lengthOf(2);
      expect(invocations[0].cwd).to.equal(path.resolve(root, ".."));
      expect(invocations[0].env.NODE_ENV).to.equal("development");

      const logContent = await readFile(result.logFile, "utf8");
      expect(logContent).to.include("Validation build sequence completed");
      expect(logContent).to.include("> npm-custom ci --include=dev");
      expect(logContent).to.include("[stdout]");
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it("stops after a failing command", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "validation-build-failure-"));
    const root = path.join(sandbox, "validation_run");

    const invocations: string[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      invocations.push(`${command} ${args.join(" ")}`.trim());
      return {
        exitCode: 1,
        stdout: "",
        stderr: "failure",
      };
    };

    const baseTime = Date.UTC(2025, 0, 1, 15, 0, 0);
    const now = createNowSequence(baseTime, [0, 5, 10, 15, 20, 25, 30]);

    try {
      const result = await runValidationBuild({ root, runner, now });
      expect(result.success).to.equal(false);
      expect(result.steps).to.have.lengthOf(1);
      expect(result.steps[0].exitCode).to.equal(1);
      expect(invocations).to.have.lengthOf(1);

      const logContent = await readFile(path.join(root, "logs", "build.log"), "utf8");
      expect(logContent).to.include("command failed");
      expect(logContent).to.include("Validation build sequence incomplete");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
