import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeSecurityCli,
  parseSecurityCliOptions,
  type SecurityCliOverrides,
} from "../../src/validation/securityCli.js";
import { SECURITY_JSONL_FILES, type SecurityPhaseOptions } from "../../src/validation/security.js";

/** CLI coverage for the Stage 11 security workflow. */
describe("security validation CLI", () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-security-cli-"));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parseSecurityCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--secret-text",
      "probe",
      "--redaction-tool",
      "echo",
      "--unauthorized-method",
      "mcp_info",
      "--path-tool",
      "fs/write",
      "--path-attempt",
      "../escape",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      secretText: "probe",
      redactionTool: "echo",
      unauthorizedMethod: "mcp_info",
      pathTool: "fs/write",
      pathAttempt: "../escape",
    });
  });

  it("executes the CLI workflow and advertises artefact locations", async () => {
    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    let capturedOptions: SecurityPhaseOptions | undefined;

    const summary = {
      artefacts: {
        inputsJsonl: SECURITY_JSONL_FILES.inputs,
        outputsJsonl: SECURITY_JSONL_FILES.outputs,
        eventsJsonl: SECURITY_JSONL_FILES.events,
        httpSnapshotLog: SECURITY_JSONL_FILES.log,
      },
      checks: [],
      redaction: {
        secret: "probe",
        description: "",
        calls: [],
      },
      unauthorized: { calls: [] },
      pathValidation: { calls: [] },
    };

    const overrides = {
      runner: async (
        runRoot: string,
        _environment: unknown,
        options: SecurityPhaseOptions,
      ) => {
        capturedOptions = options;
        const summaryPath = join(runRoot, "report", "security_summary.json");
        await writeFile(summaryPath, JSON.stringify(summary, null, 2));
        return {
          outcomes: [],
          summary,
          summaryPath,
        };
      },
    } satisfies SecurityCliOverrides;

    const { runRoot, result } = await executeSecurityCli(
      {
        baseDir: workingDir,
        runId: "validation_cli",
        secretText: "cli-secret",
        redactionTool: "cli-echo",
        unauthorizedMethod: "mcp/cli-info",
        pathTool: "fs/cli-write",
        pathAttempt: "../cli",
      },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9000",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "token",
      } as NodeJS.ProcessEnv,
      logger,
      overrides,
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.summaryPath).to.equal(join(runRoot, "report", "security_summary.json"));
    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.artefacts.inputsJsonl).to.equal(SECURITY_JSONL_FILES.inputs);

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(SECURITY_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain("Summary");

    expect(capturedOptions?.defaults?.secretText).to.equal("cli-secret");
    expect(capturedOptions?.defaults?.redactionTool).to.equal("cli-echo");
    expect(capturedOptions?.defaults?.unauthorizedMethod).to.equal("mcp/cli-info");
    expect(capturedOptions?.defaults?.pathTool).to.equal("fs/cli-write");
    expect(capturedOptions?.defaults?.pathAttempt).to.equal("../cli");
  });
});
