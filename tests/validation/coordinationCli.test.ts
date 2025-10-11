import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeCoordinationCli,
  parseCoordinationCliOptions,
} from "../../src/validation/coordinationCli.js";
import { COORDINATION_JSONL_FILES } from "../../src/validation/coordination.js";

/** CLI-level tests ensuring the Stage 7 workflow remains ergonomic. */
describe("coordination validation CLI", () => {
  const originalFetch = globalThis.fetch;
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "codex-coordination-cli-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(workingDir, { recursive: true, force: true });
  });

  it("parses CLI flags with sensible defaults", () => {
    const options = parseCoordinationCliOptions([
      "--run-id",
      "validation_cli",
      "--base-dir",
      "custom-runs",
      "--run-root",
      "explicit/path",
      "--bb-key",
      "custom:key",
      "--stig-domain",
      "custom-domain",
      "--contract-topic",
      "custom-topic",
      "--consensus-topic",
      "custom-consensus",
    ]);

    expect(options).to.deep.equal({
      runId: "validation_cli",
      baseDir: "custom-runs",
      runRoot: "explicit/path",
      blackboardKey: "custom:key",
      stigDomain: "custom-domain",
      contractTopic: "custom-topic",
      consensusTopic: "custom-consensus",
    });
  });

  it("executes the CLI workflow and surfaces artefact locations", async () => {
    const responses = [
      { jsonrpc: "2.0", result: { key: "bb", value: {} } },
      { jsonrpc: "2.0", result: { key: "bb", value: {} } },
      { jsonrpc: "2.0", result: { items: [] } },
      { jsonrpc: "2.0", result: { watch_id: "watch-1", events: [] } },
      { jsonrpc: "2.0", result: { events: [] } },
      { jsonrpc: "2.0", result: { mark_id: "mark-1" } },
      { jsonrpc: "2.0", result: { marks: [] } },
      { jsonrpc: "2.0", result: { remaining: [] } },
      { jsonrpc: "2.0", result: { announcement_id: "announce-1", proposals: [{ id: "proposal-1" }] } },
      { jsonrpc: "2.0", result: { proposals: [{ id: "proposal-1" }] } },
      { jsonrpc: "2.0", result: { announcement_id: "announce-1" } },
      { jsonrpc: "2.0", result: { decision: "plan_a" } },
      { jsonrpc: "2.0", result: { decision: "plan_a", ballots: [] } },
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

    const { runRoot, result } = await executeCoordinationCli(
      { baseDir: workingDir, runId: "validation_cli" },
      {
        MCP_HTTP_HOST: "127.0.0.1",
        MCP_HTTP_PORT: "9000",
        MCP_HTTP_PATH: "/mcp",
        MCP_HTTP_TOKEN: "cli-token",
      } as NodeJS.ProcessEnv,
      logger,
    );

    expect(runRoot).to.equal(join(workingDir, "validation_cli"));
    expect(result.summary.blackboard.eventCount).to.equal(0);
    expect(result.summary.consensus.outcome).to.equal("plan_a");

    const summaryDocument = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summaryDocument.artefacts.eventsJsonl).to.equal(join(runRoot, COORDINATION_JSONL_FILES.events));

    const flattenedLogs = logs.flat().join(" ");
    expect(flattenedLogs).to.contain(COORDINATION_JSONL_FILES.inputs);
    expect(flattenedLogs).to.contain("Summary");
  });
});
