import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeChildrenCli,
  parseChildrenCliOptions,
} from "../../src/validation/childrenCli.js";
import { CHILDREN_JSONL_FILES } from "../../src/validation/children.js";

/** CLI-level tests ensuring the Stage 5 workflow remains ergonomic. */
describe("children validation CLI", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-children-cli-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parseChildrenCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--goal",
      "Collect telemetry",
      "--prompt",
      "Status?",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      goal: "Collect telemetry",
      prompt: "Status?",
    });
  });

  it("executes the CLI workflow and surfaces artefact locations", async () => {
    const responses = [
      {
        jsonrpc: "2.0",
        result: {
          child: {
            id: "child-cli",
            goal: "Custom goal",
            limits: { cpu_ms: 4000, memory_mb: 128, wall_ms: 120000 },
          },
          events: [{ type: "child.spawned" }],
        },
      },
      { jsonrpc: "2.0", result: { events: [] } },
      {
        jsonrpc: "2.0",
        result: {
          limits: { cpu_ms: 2000, memory_mb: 96, wall_ms: 60000 },
          events: [{ type: "child.limit.updated" }],
        },
      },
      {
        jsonrpc: "2.0",
        result: {
          reply: {
            role: "assistant",
            content: [{ type: "text", text: "All systems go." }],
          },
        },
      },
      { jsonrpc: "2.0", result: { events: [] } },
    ];

    globalThis.fetch = (async () => {
      const payload = responses.shift() ?? { jsonrpc: "2.0", result: {} };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const logs: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => logs.push(args) };

    const { runRoot, result } = await executeChildrenCli(
      { baseDir: workingDir, runId: "validation_cli", goal: "Custom goal", prompt: "All good?" },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9999",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      logger,
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.summary.goal).to.equal("Custom goal");
    expect(result.summary.prompt).to.equal("All good?");

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.artefacts.requestsJsonl).to.equal(join(runRoot, CHILDREN_JSONL_FILES.inputs));

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(CHILDREN_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain("Conversation transcript");
  });
});
